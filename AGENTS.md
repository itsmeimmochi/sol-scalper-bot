# AGENTS.md

Agent-facing notes for working on `sol-scalper-bot`. This file complements `README.md` with the extra context that helps coding agents build, test, and deploy changes.

## Project overview

- **What it is**: A Solana scalping bot using **Bollinger Bands + RSI** over **1h candles** fetched from CoinGecko.
- **Persistence**: **PostgreSQL** is the source of truth for:
  - runtime config (`bot_config`, `trading_tokens`)
  - candle history (`market_candles_hourly`)
  - open positions + trades (`open_positions`, `trades`)
- **Modes**:
  - **Dry run** (`dry_run=true` in DB): no swaps; simulated opens/closes recorded in DB (`is_simulated=true`)
  - **Live** (`dry_run=false` in DB): swaps via Jupiter; positions/trades recorded as live (`is_simulated=false`)

## Setup commands

- **Install deps**: `npm install`
- **Run unit tests**: `npm test`
- **Run the bot**: `npm start`
- **Generate a wallet secret for live trading**: `npm run wallet`

## Environment & secrets

- **Required**:
  - `DATABASE_URL`: Postgres connection string
- **Required for live trading (when DB has `dry_run=false`)**:
  - `WALLET_SECRET_KEY`: JSON array of secret key bytes printed by `npm run wallet`
- **Optional**:
  - `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`

Security:

- **Never commit** `.env` or any secret material.
- `docker-compose.yml` wires `DATABASE_URL` internally to the `db` service; local runs need `DATABASE_URL` in your shell or `.env`.

## Local development (recommended)

Start Postgres:

```bash
docker compose up -d db
```

Set `DATABASE_URL` (default compose credentials):

```bash
export DATABASE_URL="postgresql://scalper:scalper@127.0.0.1:5432/scalper"
```

Seed config into Postgres from `config.json`:

```bash
npm run db:seed
```

Run the bot:

```bash
npm start
```

Notes:

- Config is **reloaded from Postgres each scan**; most DB changes apply on the **next scan**.
- Changing `rpc` currently requires a **restart** (the Solana `Connection` is created at startup).
- Candle backfill is only done when history is missing/stale; old candles can be pruned with:

```bash
npm run db:prune-candles -- 30
```

## Deployment (Docker / Coolify)

### Docker Compose (bot + Postgres)

```bash
docker compose up -d --build
```

- The `db` service stores data in the named volume `pgdata`.
- The `bot` container runs `node scripts/seed-config.mjs` on each start, then starts `node bot.js`.
- Postgres is published to the host at `${POSTGRES_HOST_PORT:-5432}:5432` (do not expose publicly without network restrictions).

### Coolify checklist

- Use the repository’s `docker-compose.yml` as the deployment definition.
- Provide secrets/env in Coolify:
  - `WALLET_SECRET_KEY` (required if you set `dry_run=false` in DB)
  - `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` (optional)
  - `POSTGRES_*` variables if overriding defaults
- Ensure the `pgdata` named volume is persisted in the way Coolify expects for named volumes.

### SSH tunnel for DB GUI (recommended vs exposing 5432)

```bash
ssh -N -L 5433:127.0.0.1:5432 your_ssh_host
```

- Connect your GUI to `127.0.0.1:5433` using the same `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` as your deployment.

## Runtime behavior / invariants agents should preserve

- **Live trading requires a wallet**: if the DB config says live (`dry_run=false`) and `WALLET_SECRET_KEY` is missing/invalid, the process exits fast (it should not limp along).
- **Simulated vs live lanes**: stats, open-position counts, and position lookups are lane-specific (simulated when dry run; live when not).
- **Reconcile on live scans**:
  - simulated opens are purged from DB so paper state cannot block live buys
  - live open rows are reconciled against wallet balances (drop dust / adopt holdings)

## Code style (project conventions)

- Prefer **declarative**, composable code.
- **Avoid nested `if` statements** when reasonable (early returns and helpers are preferred).
- Avoid removing functionality during refactors unless explicitly requested.

## Tests

- Unit tests: `npm test`
- Tests do **not** require a database.

