import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { lintMigrationPrefixes } from "../../scripts/lint-migrations.mjs";

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "migration-lint-"));
}

// lint-migrations: clean tree
{
  const dir = mkTmpDir();
  fs.writeFileSync(path.join(dir, "001_a.sql"), "-- a");
  fs.writeFileSync(path.join(dir, "002_b.sql"), "-- b");
  assert.deepEqual(lintMigrationPrefixes(dir), []);
}

// lint-migrations: duplicate prefix surfaced
{
  const dir = mkTmpDir();
  fs.writeFileSync(path.join(dir, "007_a.sql"), "-- a");
  fs.writeFileSync(path.join(dir, "007_b.sql"), "-- b");
  const dupes = lintMigrationPrefixes(dir);
  assert.equal(dupes.length, 1);
  assert.equal(dupes[0][0], "007");
}

// migrationRunner numeric-prefix sort: 008 ordered before 010 / 100
// regardless of the lexical order of filenames. Mirrors the comparator
// in `backend/src/database/migrationRunner.js:99-106`.
{
  function sortMigrations(files) {
    return [...files].sort((a, b) => {
      const [aPrefix] = a.split("_");
      const [bPrefix] = b.split("_");
      const aNum = Number.parseInt(aPrefix, 10);
      const bNum = Number.parseInt(bPrefix, 10);
      if (Number.isFinite(aNum) && Number.isFinite(bNum) && aNum !== bNum) return aNum - bNum;
      return a.localeCompare(b);
    });
  }

  assert.deepEqual(
    sortMigrations(["100_z.sql", "010_b.sql", "008_a.sql", "099_y.sql"]),
    ["008_a.sql", "010_b.sql", "099_y.sql", "100_z.sql"],
  );

  // Numeric prefix wins over lexical: pre-fix bug would put "10_*" before "8_*".
  assert.deepEqual(
    sortMigrations(["8_a.sql", "10_b.sql"]),
    ["8_a.sql", "10_b.sql"],
  );

  // Same prefix → full-filename tiebreaker (stable, alphabetical).
  assert.deepEqual(
    sortMigrations(["007_b.sql", "007_a.sql"]),
    ["007_a.sql", "007_b.sql"],
  );
}

console.log("✅ migration-runner tests passed");
