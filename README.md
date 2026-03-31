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

Set `dryRun` to `false` in the stored config for live trading (and set `WALLET_SECRET_KEY`).

## Live Mode Wallet Balance Checks

In live mode, the bot checks wallet balances via Solana RPC:

- **SOL**: used to ensure the wallet can pay transaction fees
- **USDC**: checked before buys to ensure sufficient funds for `positionSizeUsdc`

If the wallet has insufficient SOL/USDC, the bot will throw a clear error (instead of failing later with a low-level RPC error).

## Risk Warning

⚠️ **This software is for educational purposes.** Crypto trading involves significant risk of loss. Use at your own risk. Always start with dry run mode and small amounts.

## Architecture Notes

- **Pure functions**: `indicators.js` and `signals.js` have no I/O
- **Persistence**: Config, open positions, and trade history live in **PostgreSQL** — no `wallet.json` / `positions.json` / `trades.json` at runtime
- **Rate limiting**: 1.5s delay between token scans to respect CoinGecko free tier
- **Error isolation**: Failures on one token don't halt the entire scan loop
