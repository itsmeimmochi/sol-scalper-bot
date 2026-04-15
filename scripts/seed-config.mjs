/**
 * Seed bot_config + trading_tokens from config.json (repo default).
 * On first run (no bot_config row): upserts from file. When already initialized, skips unless --force or SEED_FORCE=1.
 */
import 'dotenv/config';
import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

import {
  ensureSchema,
  getPool,
  isBotConfigInitialized,
  upsertBotConfig,
  upsertTradingTokens,
} from '../lib/db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const CONFIG_PATH = resolve(root, 'config.json');

function seedForceFromEnv() {
  const v = process.env.SEED_FORCE;
  if (v === undefined || v === '') {
    return false;
  }
  const lower = String(v).toLowerCase();
  return lower === '1' || lower === 'true' || lower === 'yes';
}

async function main() {
  const force = process.argv.includes('--force') || seedForceFromEnv();
  const raw = readFileSync(CONFIG_PATH, 'utf8');
  const config = JSON.parse(raw);
  await ensureSchema();

  const initialized = await isBotConfigInitialized();
  if (initialized && !force) {
    console.log(
      '[seed] bot_config present — skipping config.json upsert (use --force or SEED_FORCE=1 to overwrite)'
    );
    await getPool().end();
    return;
  }

  await upsertBotConfig(config);
  await upsertTradingTokens(config.tokens);
  console.log(`[seed] bot_config + trading_tokens upserted from ${CONFIG_PATH}`);
  await getPool().end();
}

main().catch((e) => {
  console.error('[seed] Failed:', e.message);
  process.exit(1);
});
