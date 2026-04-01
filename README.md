# Sol Scalper Bot 🤖

A Solana scalping bot using **Bollinger Band Mean Reversion** strategy.

## Strategy

- **Timeframe**: 1-hour candles (from CoinGecko free API)
- **Indicators**: Bollinger Bands (20, 2.0) + RSI (14)
- **Buy**: Close ≤ Lower BB **AND** RSI < 38
- **Sell**: Close ≥ Middle BB (SMA) **OR** RSI > 65 **OR** Stop-loss **OR** Take-profit

## Token Universe

SOL, JUP, RAY, ORCA, JTO, PYTH, BONK, WIF

## Quick Start

### 1. Install dependencies

```bash
npm install
```

### 2. PostgreSQL

**Docker (recommended for local dev):**

```bash
docker compose up -d db
```

Postgres is exposed on the host at `${POSTGRES_HOST_PORT:-5432}`. Data is stored in the named volume `pgdata`.

Set `DATABASE_URL` (example for default compose credentials):

```bash
export DATABASE_URL="postgresql://scalper:scalper@127.0.0.1:5432/scalper"
```

Seed the `bot_config` row from [config.json](config.json):

```bash
npm run db:seed
```

### 3. Environment

Create a `.env` file (or export variables). See [example.env](example.env) for placeholders. Compose reads `.env` for substitution.

| Variable | Required | Description |
| -------- | -------- | ----------- |
| `DATABASE_URL` | Yes | Postgres connection string |
| `WALLET_SECRET_KEY` | Live trading only | JSON array of secret key bytes (see wallet step) |
| `TELEGRAM_BOT_TOKEN` | No | Telegram bot token |
| `TELEGRAM_CHAT_ID` | No | Telegram chat id |

### 4. Generate a wallet

```bash
npm run wallet
```

Copy the printed `WALLET_SECRET_KEY=...` line into `.env` or your secrets manager.

Fund the wallet with:

- **SOL** for transaction fees (~0.05 SOL is enough to start)
- **USDC** for trading (at least `positionSizeUsdc × maxOpenPositions` = $150 USDC by default)

### 5. Configure strategy / risk

Defaults live in [config.json](config.json) and are **upserted** into Postgres by `npm run db:seed` (and automatically when the Docker image starts).

After changing [config.json](config.json), run `npm run db:seed` again (or redeploy so the container entrypoint re-seeds).

To change settings without editing the file, update the `bot_config` row and `trading_tokens` table in PostgreSQL.

**Do you need to restart the bot after DB changes?**

- **Usually no**: the bot reloads config from Postgres every cycle, so changes apply on the **next scan**.
- **Exception**: changing **`rpc`** currently requires a **restart**, because the Solana RPC `Connection` is created once at startup.

**Scan frequency (DB-tuneable):** set `scanIntervalMinutes` in `bot_config` (default is 30). The bot reloads config every cycle and schedules the next run using the latest value (clamped to 1–1440 minutes).

### 5.1 Candle history persistence (PostgreSQL)

Hourly candle history is persisted in Postgres (`market_candles_hourly`) so restarts don’t need to re-fetch full history as often. The bot will only call CoinGecko to backfill candles when data is missing or stale.

To prune old candle data:

```bash
# Delete candles older than N days:
npm run db:prune-candles -- 30
```

### 6. Set up Telegram alerts (optional)

Already supported via `.env` or `export`.

### 7. Run the bot

Local:

```bash
npm start
```

**Full stack with Docker Compose** (Postgres + bot):

```bash
docker compose up -d --build
```

The bot container runs `db:seed` on each start, then `node bot.js`. Scans run every 30 minutes.

## Coolify (Docker Compose)

1. Create a **Docker Compose** deployment from this repository.
2. Set secrets/environment to match the table above (`DATABASE_URL` in compose points at the `db` service — see [docker-compose.yml](docker-compose.yml)).
3. Ensure the **`pgdata` volume** is persisted the way Coolify expects for named volumes.
4. Postgres is published on **`${POSTGRES_HOST_PORT:-5432}:5432`** so you can connect from the server or LAN (adjust firewall; use a strong password; avoid exposing `5432` on the public internet without restrictions).

### SSH tunnel for a local database GUI

To use TablePlus, DBeaver, Postico, pgAdmin, etc. on your laptop **without** opening Postgres to the public internet, forward the server’s Postgres port over SSH.

1. Confirm which **host port** Postgres uses on the VPS (default **5432**, or whatever you set as `POSTGRES_HOST_PORT` in Coolify / compose).
2. Pick a **free local port** (e.g. **5433**) so it does not clash with a Postgres already running on your machine.
3. Open a tunnel (keep this terminal open while the GUI is connected):

```bash
ssh -N -L 5433:127.0.0.1:5432 your_ssh_host
```

- **`your_ssh_host`**: `user@server-ip` or a **`Host` alias** from `~/.ssh/config`.
- **Left side (`5433`)**: connect your GUI to **`127.0.0.1`** and this port.
- **Right side (`5432`)**: the port Postgres listens on **on the server**; change it if your deployment maps a different host port.

In the database client:

| Field | Value |
| ----- | ----- |
| Host | `127.0.0.1` |
| Port | your local port (e.g. `5433`) |
| User / password / database | `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` from Coolify (defaults in [example.env](example.env) are `scalper` / `scalper` / `scalper` only if you did not override them) |
| SSL | Usually off for a tunnel to localhost |

**Connection URL shape:** `postgresql://USER:PASSWORD@127.0.0.1:5433/DBNAME` (URL-encode special characters in the password).

If SSH works but the GUI reports **connection refused**, Postgres may not be published on the server loopback: on the VPS run `ss -lntp | grep 543` or inspect `docker ps` port mappings and adjust the **right-hand** port in `-L` to match.

## Project Structure

```text
  bot.js               ← Main entry + orchestration loop
  config.json          ← Default settings (seeded into Postgres)
  docker-compose.yml   ← Postgres + bot (persistent pgdata volume)
  Dockerfile           ← Bot image
  lib/
    db.js              ← Postgres pool, schema, loadConfig
    market.js          ← CoinGecko fetching + candle building
    indicators.js      ← Pure BB + RSI
    signals.js         ← Pure buy/sell logic
    executor.js        ← Jupiter swap execution
    positions.js       ← Positions + trades in Postgres
    notify.js          ← Telegram
  scripts/
    seed-config.mjs    ← Upsert bot_config from config.json
  test/
```

## Running Tests

```bash
npm test
```

Unit tests do not require a database.

## Dry Run Mode

By default `dryRun` is `true` in the seeded config. In dry run:

- All trade signals are logged to console
- No actual swaps are executed
- Positions are tracked as if trades happened (at current market price)
- Telegram notifications are sent with `[DRY RUN]`

**Starting balance:** dry run does not model an account balance. It assumes unlimited USDC and is only constrained by `positionSizeUsdc` and `maxOpenPositions`.

**Simulated vs live in the database:** Open positions and closed trades store `is_simulated` (defaults to **true**, matching default dry run). Paper opens/closes use `is_simulated = true`. On-chain activity persists with `is_simulated = false`. Stats and open-position counts use **only the lane for the current mode** (simulated when `dryRun`, live when not).

Set `dryRun` to `false` in the stored config for live trading (and set `WALLET_SECRET_KEY`).

## Live Mode Wallet Balance Checks

In live mode, the bot checks wallet balances via Solana RPC:

- **SOL**: used to ensure the wallet can pay transaction fees
- **USDC**: checked before buys to ensure sufficient funds for `positionSizeUsdc`

If the wallet has insufficient SOL/USDC, the bot will throw a clear error (instead of failing later with a low-level RPC error).

### Live scan: paper purge and wallet reconcile

On each **live** scan, after fetching current prices:

1. **Purge simulated opens:** all rows in `open_positions` with `is_simulated = true` are deleted so they cannot block live buys or be mistaken for holdings.
2. **Reconcile live rows with the wallet:** for each **live** open row, if the wallet’s balance for that mint is below ~**$0.50** notional (at the current price) or price is missing, the row is removed (no row inserted into `trades`). For each **tracked** token, if the wallet holds above that threshold and there is no live open row, the bot **adopts** an open row (`is_simulated = false`) using the current price and on-chain balance, up to `maxOpenPositions`.

Adopted positions use **mark price at reconcile time** as `entry_price` (not historical cost basis).

### Migrating existing databases

Adding `is_simulated` backfills existing rows with the column default (**true**). That matches databases that only ran in dry run. If you already had **real** live positions or closed trades before this column existed, run a one-time update to mark those rows as live, for example:

```sql
-- Example only: adjust symbols/dates to match your data
UPDATE open_positions SET is_simulated = false WHERE is_simulated = true AND /* your condition */;
UPDATE trades SET is_simulated = false WHERE is_simulated = true AND /* your condition */;
```

Or clear paper state intentionally: `DELETE FROM open_positions WHERE is_simulated = true;`

## Risk Warning

⚠️ **This software is for educational purposes.** Crypto trading involves significant risk of loss. Use at your own risk. Always start with dry run mode and small amounts.

## Architecture Notes

- **Pure functions**: `indicators.js` and `signals.js` have no I/O
- **Persistence**: Config, open positions, and trade history live in **PostgreSQL** — no `wallet.json` / `positions.json` / `trades.json` at runtime
- **Rate limiting**: 1.5s delay between token scans to respect CoinGecko free tier
- **Error isolation**: Failures on one token don't halt the entire scan loop
