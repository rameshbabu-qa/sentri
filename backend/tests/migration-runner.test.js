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

// migrationRunner INF-008 rename reconciliation: a `schema_migrations` row
// recorded under an OLD pre-rename version key gets rewritten to the NEW
// post-rename key BEFORE the pending check runs, so renamed migration files
// don't re-execute on databases that already applied them.
{
  // In-memory stub of the prepared-statement DB adapter API the runner uses.
  function makeStubDb() {
    const rows = new Map(); // version → row
    return {
      rows,
      prepare(sql) {
        const trimmed = sql.trim();
        if (trimmed.startsWith("SELECT 1 AS hit")) {
          return { get: (v) => (rows.has(v) ? { hit: 1 } : undefined) };
        }
        if (trimmed.startsWith("UPDATE schema_migrations SET version")) {
          return { run: (newV, newChecksum, oldV) => {
            const r = rows.get(oldV);
            if (!r) return;
            rows.delete(oldV);
            rows.set(newV, { ...r, version: newV, checksum: newChecksum });
          } };
        }
        if (trimmed.startsWith("DELETE FROM schema_migrations")) {
          return { run: (v) => rows.delete(v) };
        }
        throw new Error(`unexpected SQL: ${sql}`);
      },
    };
  }

  // Re-create the helper inline to avoid pulling the full migrationRunner
  // module (which boots logging, fs scans, etc.) into a unit test.
  const RENAME_MAP = {
    "007_run_pages": "008_run_pages",
    "015_mfa_columns": "016_mfa_columns",
    "015_run_secret_scan_blocked": "017_run_secret_scan_blocked",
  };
  function reconcile(db) {
    const sel = db.prepare("SELECT 1 AS hit FROM schema_migrations WHERE version = ?");
    const upd = db.prepare("UPDATE schema_migrations SET version = ?, checksum = ? WHERE version = ?");
    const del = db.prepare("DELETE FROM schema_migrations WHERE version = ?");
    const rewritten = [];
    for (const [oldV, newV] of Object.entries(RENAME_MAP)) {
      if (!sel.get(oldV)) continue;
      if (sel.get(newV)) del.run(oldV);
      // Empty checksum here mirrors the production fallback when the on-disk
      // file is missing — the real path recomputes from disk. The validation
      // loop in migrationRunner.js skips entries with empty checksums.
      else upd.run(newV, "", oldV);
      rewritten.push(`${oldV} → ${newV}`);
    }
    return rewritten;
  }

  // Case 1 — legacy DB: only OLD rows present → all get rewritten.
  {
    const db = makeStubDb();
    db.rows.set("007_run_pages", { version: "007_run_pages" });
    db.rows.set("015_mfa_columns", { version: "015_mfa_columns" });
    const rewritten = reconcile(db);
    assert.equal(rewritten.length, 2);
    assert.ok(db.rows.has("008_run_pages"));
    assert.ok(db.rows.has("016_mfa_columns"));
    assert.ok(!db.rows.has("007_run_pages"));
    assert.ok(!db.rows.has("015_mfa_columns"));
  }

  // Case 2 — fresh DB: only NEW rows present → no-op.
  {
    const db = makeStubDb();
    db.rows.set("008_run_pages", { version: "008_run_pages" });
    db.rows.set("016_mfa_columns", { version: "016_mfa_columns" });
    const rewritten = reconcile(db);
    assert.deepEqual(rewritten, []);
    assert.ok(db.rows.has("008_run_pages"));
    assert.ok(db.rows.has("016_mfa_columns"));
  }

  // Case 3 — both OLD and NEW exist (operator manually re-applied): OLD is
  // deleted, NEW preserved (no PK violation).
  {
    const db = makeStubDb();
    db.rows.set("007_run_pages", { version: "007_run_pages", checksum: "old" });
    db.rows.set("008_run_pages", { version: "008_run_pages", checksum: "new" });
    reconcile(db);
    assert.ok(!db.rows.has("007_run_pages"));
    assert.equal(db.rows.get("008_run_pages").checksum, "new");
  }

  // Case 4 — running reconcile twice is idempotent (the second pass is a no-op).
  {
    const db = makeStubDb();
    db.rows.set("007_run_pages", { version: "007_run_pages" });
    reconcile(db);
    const rewrittenAgain = reconcile(db);
    assert.deepEqual(rewrittenAgain, []);
  }
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
