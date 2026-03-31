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

export async function ensureSchema() {
  const pool = getPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bot_config (
      id smallint PRIMARY KEY DEFAULT 1,
      config jsonb NOT NULL,
      updated_at timestamptz DEFAULT now(),
      CONSTRAINT bot_config_singleton CHECK (id = 1)
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS open_positions (
      symbol text PRIMARY KEY,
      mint text NOT NULL,
      entry_price double precision NOT NULL,
      size_usdc double precision NOT NULL,
      token_amount double precision NOT NULL,
      opened_at timestamptz NOT NULL
    );
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
      won boolean NOT NULL
    );
  `);
}

/**
 * @returns {Promise<object>} full config object (same shape as legacy config.json)
 */
export async function loadConfig() {
  const res = await getPool().query('SELECT config FROM bot_config WHERE id = 1');
  if (res.rows.length === 0) {
    throw new Error(
      'No bot_config row. Run: npm run db:seed (or ensure DATABASE_URL and Postgres are up).'
    );
  }
  return res.rows[0].config;
}

/**
 * Upsert singleton bot config (used by seed script).
 * @param {object} configObject
 */
export async function upsertBotConfig(configObject) {
  await getPool().query(
    `INSERT INTO bot_config (id, config)
     VALUES (1, $1::jsonb)
     ON CONFLICT (id) DO UPDATE SET
       config = EXCLUDED.config,
       updated_at = now()`,
    [JSON.stringify(configObject)]
  );
}
