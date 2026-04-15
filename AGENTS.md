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

## Strategy parity notes (v1 `main` vs current `production`)

- **Signal logic parity**: `lib/indicators.js` (BB/RSI) and `lib/signals.js` (`shouldBuy`/`shouldSell`) are unchanged vs v1. If performance regressed, it is likely due to **inputs/state** around the strategy (history series construction, scan cadence, persistence, or execution), not the indicator math or rule thresholds.
- **Closes series construction**: `lib/market.js` hydrates hourly closes from Postgres and **appends the latest spot price once per scan** into the in-memory closes cache. This matches v1 behavior (indicators operate on “hourly history + latest price”), but note it means the effective sample spacing is the **scan interval** for the newest points. If the scan runs more than once within the same UTC hour, the in-memory series gains **multiple** recent points for that hour (the DB row for the current hour is updated in place). README “1h candles” refers to CoinGecko’s hourly history plus this per-scan spot behavior, not strictly one sample per scan interval in SQL.
- **Lane safety invariant (critical)**: `open_positions` must support **simulated and live rows simultaneously**. The table primary key is now `(symbol, is_simulated)` (and in-memory position keys include the lane) so dry/live can coexist without collisions.

## Jupiter and token amounts (live trading)

- **`open_positions.token_amount`** is stored in **UI units** (human-readable token amount), consistent with `buy()` output and wallet reconcile adoption.
- **Buys**: `lib/executor.js` `getQuote` converts USDC to atomic units before calling Jupiter.
- **Sells**: Jupiter’s quote `amount` is **always atomic** (smallest units). Live `sell()` must read mint **decimals** from the chain, convert UI → atomic (`lib/tokenAmount.js` `uiAmountToRawFloorBigInt`), then pass that to `getSellQuote({ inputAmountRaw })`. Do not pass UI amount directly as `amount`.
- **FP note**: `uiAmountToRawFloorBigInt` uses `number` math; astronomically large UI balances could lose precision — not expected for this bot’s position sizes.

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

Seed config into Postgres from `config.json` (first run only; see below):

```bash
npm run db:seed
```

To **overwrite** existing `bot_config` and `trading_tokens` from `config.json` after the DB is already initialized:

```bash
node scripts/seed-config.mjs --force
# or: SEED_FORCE=1 npm run db:seed
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
- The `bot` container runs `node scripts/seed-config.mjs` on each start, then starts `node bot.js`. The seed script **always runs `ensureSchema()`** (migrations / new columns). It **only upserts** `bot_config` and `trading_tokens` from `config.json` when there is **no** `bot_config` row yet (fresh database). If the DB is already initialized, Postgres-only settings are **preserved** unless you run seed with `--force` or `SEED_FORCE=1`.
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

- **Live trading requires a wallet at startup**: if the **initial** DB config is live (`dry_run=false`) and `WALLET_SECRET_KEY` is missing/invalid, the process exits immediately. On **later scans**, after config reload, live mode with a missing/invalid key **does not** exit: the bot logs an error and skips live reconcile and swaps for that scan (`wallet` stays null; same path as `cannotExecuteLiveSwaps` in `scanToken`). This avoids sudden termination when toggling `dry_run` or when the wallet env is fixed/broken mid-run.
- **Simulated vs live lanes**: stats, open-position counts, and position lookups are lane-specific (simulated when dry run; live when not).
- **Reconcile on live scans**:
  - simulated opens are purged from DB so paper state cannot block live buys
  - live open rows are reconciled against wallet balances (drop dust / adopt holdings)
  - if purge/reconcile throws (RPC or DB), the bot logs, sends `live-reconcile` via `notify` if configured, and **continues the scan and future schedules** — it does not exit the loop

## Code style (project conventions)

- Prefer **declarative**, composable code.
- **Avoid nested `if` statements** when reasonable (early returns and helpers are preferred).
- Avoid removing functionality during refactors unless explicitly requested.

## Tests

- Unit tests: `npm test`
- Tests do **not** require a database.
