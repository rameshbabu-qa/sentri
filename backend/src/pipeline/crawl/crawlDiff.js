/**
 * @module pipeline/crawlDiff
 * @description AUTO-002 diff-aware crawling primitive. Compares the current
 * crawl's page snapshots against the persisted baseline map and classifies
 * each URL into added / changed / unchanged / removed buckets.
 *
 * Fingerprinting reuses `stateFingerprint.js` (no new hashing scheme) so
 * a page's fingerprint is stable across the state-explorer and link-crawl
 * discovery paths.
 */

import { fingerprintState } from "./stateFingerprint.js";

/**
 * @param {object} snapshot - page snapshot `{ url, title, elements[], ... }`.
 * @returns {string} content-addressed fingerprint for the page.
 */
export function buildPageFingerprint(snapshot) {
  return fingerprintState(snapshot);
}

/**
 * Classify each URL in the current crawl against the previous baseline.
 *
 * @param {Record<string, {fingerprint: string}>|null|undefined} previousByUrl
 *   URL → baseline row (`{ fingerprint, capturedAt, ... }`) from
 *   `crawlBaselineRepo.getMapByProjectId()`. `null` / `undefined` / `{}`
 *   are all treated equivalently as "no previous baseline" — every
 *   current URL is classified as added.
 * @param {Array<{url: string}>|null|undefined} currentSnapshots
 *   Raw snapshots from the crawl. `null` / `undefined` → no URLs.
 * @param {object} [opts]
 * @param {function(object): string} [opts.fingerprintOf]
 *   AUTO-002b: optional override for fingerprint computation. State-mode
 *   callers pass a function that returns a pre-computed fingerprint
 *   keyed off the original snapshot identity, because the default
 *   `buildPageFingerprint` recomputes from `snap.url` — which would
 *   embed the composite `url#fp=<fp>` key in the new fingerprint and
 *   make every state-mode re-crawl look "changed". Link-crawl callers
 *   omit this and get the default URL-derived fingerprint.
 * @returns {{changedPages: string[], addedPages: string[], changedOnlyPages: string[], removedPages: string[], unchangedPages: string[], fingerprints: Record<string,string>}}
 */
export function diffCrawlSnapshots(previousByUrl, currentSnapshots, opts = {}) {
  // Accept null/undefined for both inputs. `previousByUrl` is read with
  // bracket-access below, which throws on null; the `|| {}` normalisation
  // keeps the function contract documented (and matches the existing
  // `Object.keys(previousByUrl || {})` on the removed-pages branch).
  const prev = previousByUrl || {};
  const fpOf = typeof opts.fingerprintOf === "function" ? opts.fingerprintOf : buildPageFingerprint;

  const currentByUrl = new Map();
  for (const snapshot of currentSnapshots || []) {
    currentByUrl.set(snapshot.url, fpOf(snapshot));
  }

  const added = [];
  const changed = [];
  const removed = [];
  const unchanged = [];

  for (const [url, fingerprint] of currentByUrl.entries()) {
    const prevRow = prev[url];
    if (!prevRow) {
      added.push(url);
      continue;
    }
    if (prevRow.fingerprint === fingerprint) unchanged.push(url);
    else changed.push(url);
  }

  for (const url of Object.keys(prev)) {
    if (!currentByUrl.has(url)) removed.push(url);
  }

  return {
    changedPages: [...added, ...changed],
    addedPages: added,
    changedOnlyPages: changed,
    removedPages: removed,
    unchangedPages: unchanged,
    fingerprints: Object.fromEntries(currentByUrl),
  };
}
