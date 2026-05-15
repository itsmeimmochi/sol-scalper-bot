/**
 * Apply schema + pending SQL migrations (same as bot/seed startup).
 *
 * Usage: npm run db:migrate
 */
import 'dotenv/config';

import { ensureSchema, getPool } from '../lib/db.js';

async function main() {
  await ensureSchema();
  await getPool().end();
}

main().catch((e) => {
  console.error('[migrate] Failed:', e.message);
  process.exit(1);
});
