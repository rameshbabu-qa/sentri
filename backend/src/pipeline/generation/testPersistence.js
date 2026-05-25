/**
 * testPersistence.js — Persist validated tests to SQLite
 *
 * Extracts the duplicated "Store in db" block that appeared in both
 * generateSingleTest and crawlAndGenerateTests.
 *
 * Exports:
 *   persistGeneratedTests(validatedTests, project, run, defaults) → testIds[]
 *   buildPipelineStats({ pagesFound, rawTests, removed, enhancedCount, rejected, journeys, dedupStats }) → object
 */

import { generateTestId } from "../utils/idGenerator.js";
import { getProviderName } from "../aiProvider.js";
import { PROMPT_VERSION } from "./prompts/outputSchema.js";
import * as testRepo from "../database/repositories/testRepo.js";
import { logActivity } from "../utils/activityLogger.js";
import { ACTIVITY_TYPES } from "../constants/activityTypes.js";
import { APPROVAL_SOURCE } from "../services/approvalService.js";
import { normalizeQualityToConfidence } from "./deduplicator.js";

/**
 * Pseudo-user attributed to machine-made approvals in `tests.approvedBy` and
 * `activities.userName`. The literal `"auto-approver"` is pinned by the
 * audit-trail contract in ROADMAP.md (AUTO-003b) and NEXT.md, so consumers
 * (UI badges, activity log filters, route handlers) should reference this
 * constant rather than re-typing the string.
 */
export const AUTO_APPROVER_USER = "auto-approver";

/**
 * Write validated test objects into SQLite and update the run record.
 *
 * @param {object[]} validatedTests — tests that passed validation
 * @param {object}   project        — project record (id, name, url)
 * @param {object}   run            — mutable run record
 * @param {object}   [defaults]     — fallback values for name/description/sourceUrl/pageTitle
 * @returns {string[]} array of created test IDs
 */
/**
 * Global kill-switch for auto-approval (AUTO-003b). Read on every persist
 * call from `DISABLE_AUTO_APPROVAL` — any truthy value (`"1"`, `"true"`,
 * `"yes"`, case-insensitive) forces every generated test to land in Draft
 * regardless of the project-level `autoApproveThreshold`.
 *
 * Intended for ops incidents: if an AI provider starts producing bad tests
 * faster than reviewers can revoke them, setting this env var is a
 * one-step rollback that doesn't require a code deploy or per-project
 * threshold reset. Per-project thresholds stay intact and take effect
 * again as soon as the env var is removed.
 *
 * The check runs per-call (one string compare and a `process.env` read,
 * neither measurable at the persist hot path) so operators don't have to
 * restart the backend to flip the switch — and so test fixtures can drive
 * the behaviour by mutating `process.env` between cases. Matches the
 * convention used by other env-var gates in the codebase (e.g.
 * `ALLOW_PRIVATE_URLS` in `routes/system.js`).
 *
 * Exported so the test suite can call it directly without round-tripping
 * through `persistGeneratedTests`.
 */
export function isAutoApprovalDisabled() {
  const v = String(process.env.DISABLE_AUTO_APPROVAL || "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

export function persistGeneratedTests(validatedTests, project, run, defaults = {}) {
  const createdTestIds = [];
  // Global kill-switch (DISABLE_AUTO_APPROVAL) overrides every per-project
  // threshold — setting the env var pins `threshold = null`, which pins
  // `autoApproved = false` below, regardless of the project's configuration.
  // Read per-call (not cached at module scope) so operators can flip the
  // switch without restarting the backend.
  const threshold = isAutoApprovalDisabled()
    ? null
    : (Number.isFinite(project?.autoApproveThreshold) ? project.autoApproveThreshold : null);
  for (const t of validatedTests) {
    const testId = generateTestId();
    // `confidenceScore` is 0–1 (normalized by `deduplicateTests` and the
    // orchestrator's re-score step); `_quality` is 0–100. Normalize the
    // fallback so the `>= threshold` comparison below always compares on
    // the same scale — a bare `(t._quality || 0)` would read `75 >= 0.8`
    // as true and silently auto-approve every test if the fallback ever
    // activates. `threshold` is validated to (0, 1] on the route.
    const confidenceScore = Number.isFinite(t?.confidenceScore)
      ? t.confidenceScore
      : normalizeQualityToConfidence(t?._quality);
    const autoApproved = threshold !== null && confidenceScore >= threshold;
    // approvedAt is epoch ms (INTEGER per migration 017 + NEXT.md spec) so the
    // approvals timeline can do straight arithmetic ranges; reviewedAt stays
    // ISO-string to match the rest of the codebase's review timestamp convention.
    const now = new Date();
    const approvedAt = autoApproved ? now.getTime() : null;
    const reviewedAt = autoApproved ? now.toISOString() : null;
    const test = {
      // Spread AI-generated fields first so our critical fields below always win.
      // This prevents the AI from accidentally overriding id, projectId, reviewStatus, etc.
      ...t,
      id: testId,
      projectId: project.id,
      name: t.name || defaults.name || "",
      description: t.description || defaults.description || "",
      sourceUrl: t.sourceUrl || defaults.sourceUrl || project.url,
      pageTitle: t.pageTitle || defaults.pageTitle || project.name,
      createdAt: new Date().toISOString(),
      lastResult: null,
      lastRunAt: null,
      qualityScore: t._quality || 0,
      confidenceScore,
      // Per-factor breakdown that produced `qualityScore` — surfaced as the
      // "why was this drafted?" explainer in the Review Queue. `_qualityFactors`
      // is set by `deduplicateTests`; we coerce missing data to `[]` so the
      // column is never `undefined` (SQLite would store it as `null` then
      // `rowToTest` already round-trips `null` → `[]`, but being explicit here
      // means the test record matches what the API returns).
      qualityScoreFactors: Array.isArray(t._qualityFactors) ? t._qualityFactors : [],
      isJourneyTest: t.isJourneyTest || false,
      journeyType: t.journeyType || null,
      assertionEnhanced: t._assertionEnhanced || false,
      // All generated tests start as draft — humans must approve before regression
      reviewStatus: autoApproved ? "approved" : "draft",
      reviewedAt,
      approvalSource: autoApproved ? APPROVAL_SOURCE.AUTO : null,
      approvalThreshold: autoApproved ? threshold : null,
      approvedAt,
      approvedBy: autoApproved ? AUTO_APPROVER_USER : null,
      // Traceability — which prompt version and AI model produced this test
      promptVersion: PROMPT_VERSION,
      modelUsed: getProviderName(),
      // Requirement traceability — linked Jira/issue key (set via API or Import Issue)
      linkedIssueKey: t.linkedIssueKey || null,
      // Tags for filtering and traceability matrix grouping
      tags: Array.isArray(t.tags) ? t.tags : [],
      // API test marker — "api_har_capture" when generated from captured network traffic
      generatedFrom: t._generatedFrom || null,
      // ACL-001: Workspace scope — inherit from the project
      workspaceId: project.workspaceId || null,
    };
    testRepo.create(test);
    if (autoApproved) {
      logActivity({
        type: ACTIVITY_TYPES.TEST_AUTO_APPROVE,
        projectId: project.id,
        projectName: project.name,
        testId,
        testName: test.name,
        detail: `Auto-approved at confidence ${confidenceScore.toFixed(2)} (threshold ${threshold.toFixed(2)})`,
        userName: AUTO_APPROVER_USER,
        workspaceId: project.workspaceId || null,
        // Structured provenance per ROADMAP.md / NEXT.md AUTO-003b spec —
        // detail is for humans; meta is for analytics joins (calibration UI).
        meta: { score: confidenceScore, threshold },
      });
    }
    run.tests.push(testId);
    createdTestIds.push(testId);
  }
  return createdTestIds;
}

/**
 * Build the pipelineStats summary object attached to run records.
 *
 * @param {object} params
 * @returns {object}
 */
export function buildPipelineStats({ pagesFound = 0, rawTests = [], removed = 0, enhancedCount = 0, rejected = 0, journeys = [], dedupStats = {}, apiEndpointsDiscovered = 0 }) {
  const apiTestCount = rawTests.filter(t => t._generatedFrom === "api_har_capture" || t._generatedFrom === "api_user_described").length;
  return {
    pagesFound,
    rawTestsGenerated: rawTests.length,
    duplicatesRemoved: removed,
    assertionsEnhanced: enhancedCount,
    validationRejected: rejected,
    journeysDetected: journeys.length,
    averageQuality: dedupStats.averageQuality || 0,
    apiEndpointsDiscovered,
    apiTestsGenerated: apiTestCount,
  };
}
