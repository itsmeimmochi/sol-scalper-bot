/**
 * Prune old candles from Postgres.
 *
 * Usage:
 *   npm run db:prune-candles -- 30
 *   CANDLE_RETENTION_DAYS=30 npm run db:prune-candles
 */
import 'dotenv/config';

import { ensureSchema, getPool } from '../lib/db.js';

function parseRetentionDays() {
  const arg = process.argv.slice(2).find((x) => x && !x.startsWith('-'));
  const raw = arg ?? process.env.CANDLE_RETENTION_DAYS;
  const days = Number(raw);
  if (!Number.isFinite(days) || days <= 0) {
    throw new Error('Retention days must be a positive number (arg or CANDLE_RETENTION_DAYS)');
  }
  return Math.floor(days);
}

async function main() {
  const days = parseRetentionDays();
  await ensureSchema();
  const pool = getPool();
  const res = await pool.query(
    `DELETE FROM market_candles_hourly
     WHERE ts < now() - ($1::int * interval '1 day')`,
    [days]
  );
  console.log(`[prune] Deleted ${res.rowCount ?? 0} candle rows older than ${days} day(s).`);
  await pool.end();
}

main().catch((e) => {
  console.error('[prune] Failed:', e.message);
  process.exit(1);
});

