/**
 * db.js — PostgreSQL pool, schema, config load/upsert.
 */

import pg from 'pg';

let _pool = null;

export function getPool() {
  if (!_pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL is not set');
    }
    _pool = new pg.Pool({ connectionString });
  }
  return _pool;
}

function toNumberOrNull(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) {
    return null;
  }
  return n;
}

function toRequiredNumber(v, label) {
  const n = Number(v);
  if (!Number.isFinite(n)) {
    throw new Error(`Invalid number for ${label}`);
  }
  return n;
}

function toRequiredInteger(v, label) {
  const n = toRequiredNumber(v, label);
  if (!Number.isInteger(n)) {
    throw new Error(`Invalid integer for ${label}`);
  }
  return n;
}

function toRequiredNonEmptyString(v, label) {
  if (typeof v !== 'string') {
    throw new Error(`Invalid string for ${label}`);
  }
  const trimmed = v.trim();
  if (!trimmed) {
    throw new Error(`Invalid string for ${label}`);
  }
  return trimmed;
}

function assertConfigShape(configObject) {
  if (!configObject || typeof configObject !== 'object') {
    throw new Error('Config must be an object');
  }
  if (!Array.isArray(configObject.tokens)) {
    throw new Error('Config must include tokens: []');
  }
  if (!configObject.strategy || typeof configObject.strategy !== 'object') {
    throw new Error('Config must include strategy: {}');
  }
  if (!configObject.risk || typeof configObject.risk !== 'object') {
    throw new Error('Config must include risk: {}');
  }
}

function configObjectToBotConfigRow(configObject) {
  assertConfigShape(configObject);

  const scanIntervalMinutes =
    configObject.scanIntervalMinutes === undefined ? null : toNumberOrNull(configObject.scanIntervalMinutes);

  return {
    strategy_bb_period: toRequiredInteger(configObject.strategy.bbPeriod, 'strategy.bbPeriod'),
    strategy_bb_stddev: toRequiredNumber(configObject.strategy.bbStdDev, 'strategy.bbStdDev'),
    strategy_rsi_period: toRequiredInteger(configObject.strategy.rsiPeriod, 'strategy.rsiPeriod'),
    strategy_rsi_buy_threshold: toRequiredInteger(
      configObject.strategy.rsiBuyThreshold,
      'strategy.rsiBuyThreshold'
    ),
    strategy_rsi_sell_threshold: toRequiredInteger(
      configObject.strategy.rsiSellThreshold,
      'strategy.rsiSellThreshold'
    ),

    risk_position_size_usdc: toRequiredNumber(configObject.risk.positionSizeUsdc, 'risk.positionSizeUsdc'),
    risk_take_profit_pct: toRequiredNumber(configObject.risk.takeProfitPct, 'risk.takeProfitPct'),
    risk_stop_loss_pct: toRequiredNumber(configObject.risk.stopLossPct, 'risk.stopLossPct'),
    risk_max_open_positions: toRequiredInteger(configObject.risk.maxOpenPositions, 'risk.maxOpenPositions'),

    rpc: toRequiredNonEmptyString(configObject.rpc, 'rpc'),
    slippage_bps: toRequiredInteger(configObject.slippageBps, 'slippageBps'),
    dry_run: Boolean(configObject.dryRun),
    scan_interval_minutes: scanIntervalMinutes,
  };
}

function rowsToTokens(rows) {
  return rows.map((r) => {
    return { symbol: r.symbol, geckoId: r.gecko_id, mint: r.mint };
  });
}

function botConfigRowToConfigObject(row, tokens) {
  if (!row) {
    throw new Error('bot_config row is missing');
  }

  const strategy = {
    bbPeriod: Number(row.strategy_bb_period),
    bbStdDev: Number(row.strategy_bb_stddev),
    rsiPeriod: Number(row.strategy_rsi_period),
    rsiBuyThreshold: Number(row.strategy_rsi_buy_threshold),
    rsiSellThreshold: Number(row.strategy_rsi_sell_threshold),
  };

  const risk = {
    positionSizeUsdc: Number(row.risk_position_size_usdc),
    takeProfitPct: Number(row.risk_take_profit_pct),
    stopLossPct: Number(row.risk_stop_loss_pct),
    maxOpenPositions: Number(row.risk_max_open_positions),
  };

  return {
    tokens,
    strategy,
    risk,
    rpc: row.rpc,
    slippageBps: Number(row.slippage_bps),
    dryRun: Boolean(row.dry_run),
    ...(row.scan_interval_minutes === null || row.scan_interval_minutes === undefined
      ? {}
      : { scanIntervalMinutes: Number(row.scan_interval_minutes) }),
  };
}

async function columnExists(tableName, columnName) {
  const res = await getPool().query(
    `
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2
    LIMIT 1
  `,
    [tableName, columnName]
  );
  return res.rows.length > 0;
}

async function tableExists(tableName) {
  const res = await getPool().query(
    `
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = $1
    LIMIT 1
  `,
    [tableName]
  );
  return res.rows.length > 0;
}

async function migrateFromLegacyJsonbIfPresent() {
  const hasLegacyConfigColumn = await columnExists('bot_config', 'config');
  if (!hasLegacyConfigColumn) {
    return;
  }

  const pool = getPool();
  const res = await pool.query('SELECT config FROM bot_config WHERE id = 1');
  if (res.rows.length === 0) {
    return;
  }

  const legacy = res.rows[0].config;
  if (!legacy || typeof legacy !== 'object') {
    return;
  }

  const hasNewColumns = await columnExists('bot_config', 'strategy_bb_period');
  if (!hasNewColumns) {
    return;
  }

  const newRowRes = await pool.query(
    `SELECT
      strategy_bb_period,
      strategy_bb_stddev,
      strategy_rsi_period,
      strategy_rsi_buy_threshold,
      strategy_rsi_sell_threshold,
      risk_position_size_usdc,
      risk_take_profit_pct,
      risk_stop_loss_pct,
      risk_max_open_positions,
      rpc,
      slippage_bps,
      dry_run
     FROM bot_config WHERE id = 1`
  );
  const row = newRowRes.rows[0];
  const alreadyMigrated = row && row.rpc !== null && row.strategy_bb_period !== null;
  if (alreadyMigrated) {
    return;
  }

  const parsed = configObjectToBotConfigRow(legacy);
  await pool.query(
    `
    UPDATE bot_config SET
      strategy_bb_period = $1,
      strategy_bb_stddev = $2,
      strategy_rsi_period = $3,
      strategy_rsi_buy_threshold = $4,
      strategy_rsi_sell_threshold = $5,
      risk_position_size_usdc = $6,
      risk_take_profit_pct = $7,
      risk_stop_loss_pct = $8,
      risk_max_open_positions = $9,
      rpc = $10,
      slippage_bps = $11,
      dry_run = $12,
      scan_interval_minutes = $13,
      updated_at = now()
    WHERE id = 1
  `,
    [
      parsed.strategy_bb_period,
      parsed.strategy_bb_stddev,
      parsed.strategy_rsi_period,
      parsed.strategy_rsi_buy_threshold,
      parsed.strategy_rsi_sell_threshold,
      parsed.risk_position_size_usdc,
      parsed.risk_take_profit_pct,
      parsed.risk_stop_loss_pct,
      parsed.risk_max_open_positions,
      parsed.rpc,
      parsed.slippage_bps,
      parsed.dry_run,
      parsed.scan_interval_minutes,
    ]
  );

  if (Array.isArray(legacy.tokens) && legacy.tokens.length > 0) {
    await upsertTradingTokens(legacy.tokens);
  }
}

export async function ensureSchema() {
  const pool = getPool();

  const hasBotConfig = await tableExists('bot_config');
  if (!hasBotConfig) {
    await pool.query(`
      CREATE TABLE bot_config (
        id smallint PRIMARY KEY DEFAULT 1,

        strategy_bb_period integer NOT NULL,
        strategy_bb_stddev double precision NOT NULL,
        strategy_rsi_period integer NOT NULL,
        strategy_rsi_buy_threshold integer NOT NULL,
        strategy_rsi_sell_threshold integer NOT NULL,

        risk_position_size_usdc double precision NOT NULL,
        risk_take_profit_pct double precision NOT NULL,
        risk_stop_loss_pct double precision NOT NULL,
        risk_max_open_positions integer NOT NULL,

        rpc text NOT NULL,
        slippage_bps integer NOT NULL,
        dry_run boolean NOT NULL,
        scan_interval_minutes integer NULL,

        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT bot_config_singleton CHECK (id = 1)
      );
    `);
  }

  // If legacy bot_config exists (jsonb column), add new columns in-place.
  await pool.query(`
    ALTER TABLE bot_config
      ADD COLUMN IF NOT EXISTS strategy_bb_period integer,
      ADD COLUMN IF NOT EXISTS strategy_bb_stddev double precision,
      ADD COLUMN IF NOT EXISTS strategy_rsi_period integer,
      ADD COLUMN IF NOT EXISTS strategy_rsi_buy_threshold integer,
      ADD COLUMN IF NOT EXISTS strategy_rsi_sell_threshold integer,
      ADD COLUMN IF NOT EXISTS risk_position_size_usdc double precision,
      ADD COLUMN IF NOT EXISTS risk_take_profit_pct double precision,
      ADD COLUMN IF NOT EXISTS risk_stop_loss_pct double precision,
      ADD COLUMN IF NOT EXISTS risk_max_open_positions integer,
      ADD COLUMN IF NOT EXISTS rpc text,
      ADD COLUMN IF NOT EXISTS slippage_bps integer,
      ADD COLUMN IF NOT EXISTS dry_run boolean,
      ADD COLUMN IF NOT EXISTS scan_interval_minutes integer,
      ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS trading_tokens (
      symbol text PRIMARY KEY,
      gecko_id text NOT NULL,
      mint text NOT NULL,
      enabled boolean NOT NULL DEFAULT true,
      sort_order integer NOT NULL DEFAULT 0,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS open_positions (
      symbol text PRIMARY KEY,
      mint text NOT NULL,
      entry_price double precision NOT NULL,
      size_usdc double precision NOT NULL,
      token_amount double precision NOT NULL,
      opened_at timestamptz NOT NULL,
      is_simulated boolean NOT NULL DEFAULT true
    );
  `);
  await pool.query(`
    ALTER TABLE open_positions
      ADD COLUMN IF NOT EXISTS is_simulated boolean NOT NULL DEFAULT true;
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS trades (
      id bigserial PRIMARY KEY,
      symbol text NOT NULL,
      entry_price double precision NOT NULL,
      exit_price double precision NOT NULL,
      size_usdc double precision NOT NULL,
      pnl_pct double precision NOT NULL,
      pnl_usdc double precision NOT NULL,
      reason text NOT NULL,
      opened_at timestamptz NOT NULL,
      closed_at timestamptz NOT NULL,
      won boolean NOT NULL,
      is_simulated boolean NOT NULL DEFAULT true
    );
  `);
  await pool.query(`
    ALTER TABLE trades
      ADD COLUMN IF NOT EXISTS is_simulated boolean NOT NULL DEFAULT true;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS market_candles_hourly (
      gecko_id text NOT NULL,
      ts timestamptz NOT NULL,
      open double precision NOT NULL,
      high double precision NOT NULL,
      low double precision NOT NULL,
      close double precision NOT NULL,
      volume double precision NULL,
      source text NOT NULL DEFAULT 'coingecko',
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (gecko_id, ts)
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS market_candles_hourly_gecko_ts_desc
      ON market_candles_hourly (gecko_id, ts DESC);
  `);

  await migrateFromLegacyJsonbIfPresent();
}

/**
 * @returns {Promise<object>} full config object (same shape as legacy config.json)
 */
export async function loadConfig() {
  const pool = getPool();
  const configRes = await pool.query(
    `SELECT
      strategy_bb_period,
      strategy_bb_stddev,
      strategy_rsi_period,
      strategy_rsi_buy_threshold,
      strategy_rsi_sell_threshold,
      risk_position_size_usdc,
      risk_take_profit_pct,
      risk_stop_loss_pct,
      risk_max_open_positions,
      rpc,
      slippage_bps,
      dry_run,
      scan_interval_minutes
    FROM bot_config
    WHERE id = 1`
  );

  if (configRes.rows.length === 0) {
    throw new Error('No bot_config row. Run: npm run db:seed');
  }

  const tokensRes = await pool.query(
    `SELECT symbol, gecko_id, mint
     FROM trading_tokens
     WHERE enabled = true
     ORDER BY sort_order ASC, symbol ASC`
  );

  const tokens = rowsToTokens(tokensRes.rows);
  if (tokens.length === 0) {
    throw new Error('No enabled tokens in trading_tokens. Run: npm run db:seed');
  }

  return botConfigRowToConfigObject(configRes.rows[0], tokens);
}

/**
 * Upsert singleton bot config fields (used by seed script).
 * @param {object} configObject
 */
export async function upsertBotConfig(configObject) {
  const row = configObjectToBotConfigRow(configObject);
  await getPool().query(
    `
    INSERT INTO bot_config (
      id,
      strategy_bb_period,
      strategy_bb_stddev,
      strategy_rsi_period,
      strategy_rsi_buy_threshold,
      strategy_rsi_sell_threshold,
      risk_position_size_usdc,
      risk_take_profit_pct,
      risk_stop_loss_pct,
      risk_max_open_positions,
      rpc,
      slippage_bps,
      dry_run,
      scan_interval_minutes
    ) VALUES (
      1, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13
    )
    ON CONFLICT (id) DO UPDATE SET
      strategy_bb_period = EXCLUDED.strategy_bb_period,
      strategy_bb_stddev = EXCLUDED.strategy_bb_stddev,
      strategy_rsi_period = EXCLUDED.strategy_rsi_period,
      strategy_rsi_buy_threshold = EXCLUDED.strategy_rsi_buy_threshold,
      strategy_rsi_sell_threshold = EXCLUDED.strategy_rsi_sell_threshold,
      risk_position_size_usdc = EXCLUDED.risk_position_size_usdc,
      risk_take_profit_pct = EXCLUDED.risk_take_profit_pct,
      risk_stop_loss_pct = EXCLUDED.risk_stop_loss_pct,
      risk_max_open_positions = EXCLUDED.risk_max_open_positions,
      rpc = EXCLUDED.rpc,
      slippage_bps = EXCLUDED.slippage_bps,
      dry_run = EXCLUDED.dry_run,
      scan_interval_minutes = EXCLUDED.scan_interval_minutes,
      updated_at = now()
  `,
    [
      row.strategy_bb_period,
      row.strategy_bb_stddev,
      row.strategy_rsi_period,
      row.strategy_rsi_buy_threshold,
      row.strategy_rsi_sell_threshold,
      row.risk_position_size_usdc,
      row.risk_take_profit_pct,
      row.risk_stop_loss_pct,
      row.risk_max_open_positions,
      row.rpc,
      row.slippage_bps,
      row.dry_run,
      row.scan_interval_minutes,
    ]
  );
}

/**
 * Upsert trading tokens (used by seed script).
 * @param {Array<{symbol: string, geckoId: string, mint: string}>} tokens
 */
export async function upsertTradingTokens(tokens) {
  if (!Array.isArray(tokens)) {
    throw new Error('tokens must be an array');
  }
  const pool = getPool();

  const valid = tokens
    .map((t) => {
      return {
        symbol: typeof t?.symbol === 'string' ? t.symbol.trim() : '',
        geckoId: typeof t?.geckoId === 'string' ? t.geckoId.trim() : '',
        mint: typeof t?.mint === 'string' ? t.mint.trim() : '',
      };
    })
    .filter((t) => {
      return Boolean(t.symbol && t.geckoId && t.mint);
    });

  const normalized = valid.map((t, idx) => {
    return { ...t, sortOrder: idx };
  });

  if (normalized.length === 0) {
    throw new Error('tokens array is empty (or missing symbol/geckoId/mint)');
  }

  await pool.query(
    `UPDATE trading_tokens
     SET enabled = false, updated_at = now()
     WHERE enabled = true`
  );

  for (const t of normalized) {
    await pool.query(
      `INSERT INTO trading_tokens (symbol, gecko_id, mint, enabled, sort_order)
       VALUES ($1, $2, $3, true, $4)
       ON CONFLICT (symbol) DO UPDATE SET
         gecko_id = EXCLUDED.gecko_id,
         mint = EXCLUDED.mint,
         enabled = true,
         sort_order = EXCLUDED.sort_order,
         updated_at = now()`,
      [t.symbol, t.geckoId, t.mint, t.sortOrder]
    );
  }
}
