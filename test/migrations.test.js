import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { listMigrationFiles } from '../lib/migrations.js';

describe('listMigrationFiles', () => {
  test('returns numbered SQL files in order', () => {
    const dir = mkdtempSync(join(tmpdir(), 'migrations-test-'));
    writeFileSync(join(dir, '010_second.sql'), '-- b');
    writeFileSync(join(dir, '002_early.sql'), '-- a');
    writeFileSync(join(dir, 'README.md'), 'skip');
    writeFileSync(join(dir, 'bad.sql'), 'skip');

    expect(listMigrationFiles(dir)).toEqual(['002_early.sql', '010_second.sql']);
  });
});
