/**
 * Seed bot_config from config.json (repo default). Idempotent upsert.
 */
import 'dotenv/config';
import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

import { ensureSchema, getPool, upsertBotConfig } from '../lib/db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const CONFIG_PATH = resolve(root, 'config.json');

async function main() {
  const raw = readFileSync(CONFIG_PATH, 'utf8');
  const config = JSON.parse(raw);
  await ensureSchema();
  await upsertBotConfig(config);
  console.log(`[seed] bot_config upserted from ${CONFIG_PATH}`);
  await getPool().end();
}

main().catch((e) => {
  console.error('[seed] Failed:', e.message);
  process.exit(1);
});
