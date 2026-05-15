/**
 * migrations.js — versioned SQL migrations with schema_migrations tracking.
 *
 * Applied automatically from ensureSchema() on bot/seed start (deploy-safe, idempotent SQL).
 */

import { readFileSync, readdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { getPool } from './db.js';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'migrations');

export function listMigrationFiles(migrationsDir = MIGRATIONS_DIR) {
  return readdirSync(migrationsDir)
    .filter((name) => {
      return /^\d+_.+\.sql$/i.test(name);
    })
    .sort((a, b) => {
      return a.localeCompare(b, undefined, { numeric: true });
    });
}

async function ensureMigrationsTable() {
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    );
  `);
}

async function isMigrationApplied(name) {
  const res = await getPool().query(`SELECT 1 FROM schema_migrations WHERE name = $1 LIMIT 1`, [name]);
  return res.rows.length > 0;
}

async function applyMigrationFile(name, migrationsDir = MIGRATIONS_DIR) {
  const sql = readFileSync(join(migrationsDir, name), 'utf8').trim();
  if (!sql) {
    throw new Error(`Migration ${name} is empty`);
  }

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query(`INSERT INTO schema_migrations (name) VALUES ($1)`, [name]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw new Error(`Migration ${name} failed: ${e.message}`);
  } finally {
    client.release();
  }
}

/**
 * Run pending SQL migrations in lexical order (001_, 002_, …). Each file runs once.
 * @returns {Promise<{ applied: string[], skipped: string[] }>}
 */
export async function runPendingMigrations(migrationsDir = MIGRATIONS_DIR) {
  await ensureMigrationsTable();

  const files = listMigrationFiles(migrationsDir);
  const applied = [];
  const skipped = [];

  for (const name of files) {
    const already = await isMigrationApplied(name);
    if (already) {
      skipped.push(name);
      continue;
    }
    await applyMigrationFile(name, migrationsDir);
    applied.push(name);
    console.log(`[migrations] Applied ${name}`);
  }

  if (applied.length === 0 && files.length > 0) {
    console.log(`[migrations] Up to date (${files.length} migration file(s))`);
  }

  return { applied, skipped };
}
