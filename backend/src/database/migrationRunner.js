/**
 * @module database/migrationRunner
 * @description Versioned, dialect-aware database migration runner.
 *
 * Implements a standard sequential migration pattern:
 *   1. A `schema_migrations` table tracks which migrations have been applied.
 *   2. Migration files live in `migrations/` as numbered `.sql` files (001_*, 002_*, …).
 *   3. On startup, the runner scans for unapplied migrations and executes them
 *      in order inside a transaction.
 *   4. Each migration is recorded with its name and timestamp so the history
 *      is auditable.
 *
 * ### Dialect awareness (INF-001)
 * The runner accepts a database adapter (not a raw `better-sqlite3` instance).
 * When the adapter's `dialect` is `"postgres"`, the runner translates
 * SQLite-specific SQL in migration files using the PostgreSQL adapter's
 * `translateSql()` function before execution.
 *
 * ### Adding a new migration
 * 1. Create `backend/src/database/migrations/NNN_description.sql`
 *    (NNN = zero-padded sequence number, e.g. `002_add_foo_column.sql`).
 * 2. Write idempotent SQL (use `IF NOT EXISTS`, `ALTER TABLE … ADD COLUMN` guards).
 * 3. Restart the server — the migration runs automatically.
 *
 * ### Exports
 * - {@link runMigrations} — Apply all pending migrations.
 */

import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { formatLogLine } from "../utils/logFormatter.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, "migrations");

/**
 * INF-008 rename map: pre-INF-008 migration filenames → post-INF-008 names.
 *
 * Several migration files were renamed in INF-008 to resolve duplicate numeric
 * prefixes (e.g. `007_run_pages.sql` collided with `007_quality_score_factors.sql`).
 * Existing databases recorded the OLD names in `schema_migrations.version`, so
 * without remapping the runner would treat every renamed file as new pending
 * work and try to re-execute non-idempotent `ALTER TABLE ... ADD COLUMN`
 * statements — crashing the server on startup.
 *
 * The keys are old `version` values (filename without `.sql`); the values are
 * the new `version` values that match the on-disk filenames after INF-008.
 * `reconcileRenamedMigrations()` (called from `runMigrations` before computing
 * pending) UPDATEs `schema_migrations` so the new files are recognised as
 * already-applied — no re-execution, no duplicate-column errors.
 *
 * Safe to keep indefinitely: the UPDATE is a no-op once a database has been
 * reconciled (the OLD version row no longer exists), and brand-new databases
 * never had the old rows in the first place.
 */
const INF_008_RENAME_MAP = {
  "007_run_pages": "008_run_pages",
  "008_visual_baselines": "009_visual_baselines",
  "009_run_browser": "010_run_browser",
  "010_baseline_browser": "011_baseline_browser",
  "011_run_retry_metadata": "012_run_retry_metadata",
  "012_run_network_condition": "013_run_network_condition",
  "013_accessibility_violations": "014_accessibility_violations",
  "014_quality_gates": "015_quality_gates",
  "015_mfa_columns": "016_mfa_columns",
  "015_run_secret_scan_blocked": "017_run_secret_scan_blocked",
  "015_web_vitals_budgets": "018_web_vitals_budgets",
  "016_metric_samples": "019_metric_samples",
  "017_auto_approval": "020_auto_approval",
  "018_activities_meta": "021_activities_meta",
  "019_crawl_baselines": "022_crawl_baselines",
  "020_run_changed_pages": "023_run_changed_pages",
  "021_run_budget_minutes": "024_run_budget_minutes",
  "021_run_github_check": "025_run_github_check",
  "022_run_changed_files": "026_run_changed_files",
  "023_test_fixtures": "027_test_fixtures",
  "024_environments": "028_environments",
  "025_run_shards": "029_run_shards",
  "026_run_trace_paths": "030_run_trace_paths",
  "027_run_root_causes": "031_run_root_causes",
  "028_workspace_mfa_enforcement": "032_workspace_mfa_enforcement",
  "029_webauthn_credentials": "033_webauthn_credentials",
  "030_projects_pii_firewall": "034_projects_pii_firewall",
  "031_activities_compliance": "035_activities_compliance",
  "032_workspace_siem_config": "036_workspace_siem_config",
  "033_system_workspace_seed": "037_system_workspace_seed",
  "034_activities_dedup": "038_activities_dedup",
};

/**
 * Rewrite legacy `schema_migrations.version` rows to their post-INF-008 names.
 *
 * Each rename is processed atomically: if a row already exists under the NEW
 * name (e.g. operator manually re-applied the renamed file before upgrading)
 * the OLD row is deleted instead of UPDATEd so we don't violate the PK.
 *
 * The checksum is recomputed from the on-disk renamed file and written
 * alongside the new version. Eleven of the renamed files had their `-- Migration NNN:`
 * header bumped during INF-008, so the stored checksum (computed against the
 * pre-rename content) no longer matches the on-disk bytes. Without rewriting
 * the checksum here, the validation loop below would fire a false-positive
 * `⚠️ file changed after it was applied` warning for each of those files on
 * every startup of a pre-INF-008 database — drowning out any genuine
 * tampered-file warning the checksum system is meant to surface.
 *
 * @param {Object} db — Database adapter instance.
 * @returns {string[]} list of `${old} → ${new}` strings actually rewritten.
 */
function reconcileRenamedMigrations(db) {
  const rewritten = [];
  const selectStmt = db.prepare("SELECT 1 AS hit FROM schema_migrations WHERE version = ?");
  const updateStmt = db.prepare("UPDATE schema_migrations SET version = ?, checksum = ? WHERE version = ?");
  const deleteStmt = db.prepare("DELETE FROM schema_migrations WHERE version = ?");
  for (const [oldVersion, newVersion] of Object.entries(INF_008_RENAME_MAP)) {
    const oldRow = selectStmt.get(oldVersion);
    if (!oldRow) continue;
    const newRow = selectStmt.get(newVersion);
    if (newRow) {
      deleteStmt.run(oldVersion);
    } else {
      // Recompute checksum from the new on-disk file so the validation loop
      // doesn't flag the rename as a tampered file. Fall back to an empty
      // string (matches the `ALTER TABLE … DEFAULT ''` upgrade path) if the
      // file is missing for any reason — the validation loop skips empty
      // checksums, so we degrade to a no-op rather than crashing on startup.
      let newChecksum = "";
      try {
        const filePath = path.join(MIGRATIONS_DIR, `${newVersion}.sql`);
        if (fs.existsSync(filePath)) {
          newChecksum = checksum(fs.readFileSync(filePath, "utf-8"));
        }
      } catch {
        /* keep newChecksum = "" — validation loop skips empty checksums */
      }
      updateStmt.run(newVersion, newChecksum, oldVersion);
    }
    rewritten.push(`${oldVersion} → ${newVersion}`);
  }
  return rewritten;
}

/**
 * Ensure the schema_migrations tracking table exists.
 * @param {Object} db — Database adapter instance.
 */
function ensureMigrationsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     TEXT PRIMARY KEY,      -- e.g. "001_initial_schema"
      checksum    TEXT NOT NULL,          -- SHA-256 of the migration SQL
      appliedAt   TEXT NOT NULL,          -- ISO 8601 timestamp
      durationMs  INTEGER NOT NULL        -- execution time in ms
    )
  `);
  // Add checksum column if upgrading from an older schema_migrations table.
  // Use PRAGMA table_info on SQLite; information_schema on PostgreSQL.
  if (db.dialect === "postgres") {
    const cols = db.prepare(
      "SELECT column_name AS name FROM information_schema.columns WHERE table_name = 'schema_migrations'"
    ).all().map(c => c.name);
    if (!cols.includes("checksum")) {
      db.exec("ALTER TABLE schema_migrations ADD COLUMN checksum TEXT NOT NULL DEFAULT ''");
    }
  } else {
    const cols = db.prepare("PRAGMA table_info(schema_migrations)").all().map(c => c.name);
    if (!cols.includes("checksum")) {
      db.exec("ALTER TABLE schema_migrations ADD COLUMN checksum TEXT NOT NULL DEFAULT ''");
    }
  }
}

/**
 * Compute SHA-256 checksum of a migration file's contents.
 * @param {string} sql
 * @returns {string}
 */
function checksum(sql) {
  return crypto.createHash("sha256").update(sql).digest("hex").slice(0, 16);
}

/**
 * Get already-applied migrations as a Map of version → checksum.
 * @param {Object} db — Database adapter instance.
 * @returns {Map<string, string>}
 */
function getAppliedMigrations(db) {
  const rows = db.prepare("SELECT version, checksum FROM schema_migrations").all();
  const map = new Map();
  for (const r of rows) map.set(r.version, r.checksum || "");
  return map;
}

/**
 * Discover all migration files sorted by numeric prefix, then full filename.
 *
 * IMPORTANT: Migration filename prefixes (NNN_) must be globally unique.
 * @returns {Array<{version: string, filePath: string}>}
 */
function discoverMigrations() {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];
  return fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith(".sql"))
    .sort((a, b) => {
      const [aPrefix] = a.split("_");
      const [bPrefix] = b.split("_");
      const aNum = Number.parseInt(aPrefix, 10);
      const bNum = Number.parseInt(bPrefix, 10);
      if (Number.isFinite(aNum) && Number.isFinite(bNum) && aNum !== bNum) return aNum - bNum;
      return a.localeCompare(b);
    })
    .map(f => ({
      version: f.replace(/\.sql$/, ""),
      filePath: path.join(MIGRATIONS_DIR, f),
    }));
}

/**
 * Apply all pending migrations in order.
 *
 * Each migration runs inside its own transaction. If a migration fails,
 * that transaction is rolled back and the error is thrown — subsequent
 * migrations are NOT attempted.
 *
 * @param {Object} db — Database adapter instance (SQLite or PostgreSQL).
 * @param {Object} [opts] — Optional overrides.
 * @param {Function} [opts.translateSql] — SQL translator for PostgreSQL dialect.
 *   When omitted and dialect is "postgres", loaded dynamically from postgres-adapter.
 * @returns {{ applied: string[], skipped: number }}
 */
export function runMigrations(db, opts = {}) {
  ensureMigrationsTable(db);

  // INF-008: rewrite legacy version rows BEFORE we compute the pending set, so
  // renamed migration files aren't seen as new work on existing databases.
  const rewritten = reconcileRenamedMigrations(db);
  if (rewritten.length > 0) {
    console.log(formatLogLine("info", null,
      `[migrations] reconciled ${rewritten.length} legacy version row(s) post-INF-008 rename`
    ));
  }

  // Lazy-load translateSql only when running against PostgreSQL.
  // This avoids importing the postgres-adapter module (and its pg dependency)
  // when using SQLite. Callers MUST pass translateSql for PostgreSQL —
  // sqlite.js loads the module via top-level await and passes it here.
  let translateSql = opts.translateSql || null;
  if (!translateSql && db.dialect === "postgres") {
    throw new Error(
      "[migrations] translateSql must be provided for PostgreSQL dialect. " +
      "Ensure sqlite.js passes opts.translateSql from the pre-loaded postgres-adapter module."
    );
  }

  const applied = getAppliedMigrations(db);
  const all = discoverMigrations();

  // Validate checksums of already-applied migrations — detect tampered files.
  // A changed migration file means the DB schema may be inconsistent with
  // what the code expects. Warn loudly but don't crash (the change may be
  // intentional, e.g. a comment fix).
  for (const migration of all) {
    const existingChecksum = applied.get(migration.version);
    if (existingChecksum && existingChecksum !== "") {
      const sql = fs.readFileSync(migration.filePath, "utf-8");
      const currentChecksum = checksum(sql);
      if (existingChecksum !== currentChecksum) {
        console.warn(formatLogLine("warn", null,
          `[migrations] ⚠️  ${migration.version} file changed after it was applied ` +
          `(expected checksum ${existingChecksum}, got ${currentChecksum}). ` +
          `This may indicate an inconsistent schema.`
        ));
      }
    }
  }

  const pending = all.filter(m => !applied.has(m.version));

  if (pending.length === 0) {
    return { applied: [], skipped: all.length };
  }

  const results = [];

  for (const migration of pending) {
    const rawSql = fs.readFileSync(migration.filePath, "utf-8");
    const hash = checksum(rawSql);
    const start = Date.now();

    // Translate SQLite-specific SQL to PostgreSQL when needed.
    // The checksum is always computed on the raw (untranslated) SQL so it
    // stays consistent regardless of which dialect applies the migration.
    const sql = translateSql ? translateSql(rawSql) : rawSql;

    const applyMigration = db.transaction(() => {
      db.exec(sql);
      db.prepare(
        "INSERT INTO schema_migrations (version, checksum, appliedAt, durationMs) VALUES (?, ?, ?, ?)"
      ).run(migration.version, hash, new Date().toISOString(), Date.now() - start);
    });

    try {
      applyMigration();
      const ms = Date.now() - start;
      results.push(migration.version);
      console.log(formatLogLine("info", null, `[migrations] ✅ ${migration.version} (${ms}ms) [${hash}]`));
    } catch (err) {
      console.error(formatLogLine("error", null, `[migrations] ❌ ${migration.version} failed: ${err.message}`));
      throw err;
    }
  }

  return { applied: results, skipped: all.length - pending.length };
}


