#!/usr/bin/env node
// Keep the MCP Adoption and Claude Framework Governance dashboards current AND
// correctly dated.
//
// Those dashboards group on categorical SCORES (mcp_name, framework_name,
// framework_skill, plus the curated buckets mcp_bucket / framework_bucket)
// written onto each trace/observation. Two facts shape this job:
//
//   * events_only mode: this Langfuse v4 deployment runs in "events_only" mode,
//     where the legacy list endpoints (/traces, /observations, /scores, /metrics)
//     return 404. The only reader is GET /api/public/v2/observations (cursor).
//   * A score's timeline position = its ingestion EVENT timestamp (IngestionService
//     stamps score.timestamp from the event envelope). POST /api/public/scores
//     sends "now", which is why a backfill piles all history onto the backfill date.
//     So we WRITE via POST /api/public/ingestion with each event's timestamp set to
//     the observation's real startTime -> scores land on the real call date.
//
// Idempotency: every score uses a DETERMINISTIC id (name_subject_value), so
// re-runs upsert. Re-ingesting the same id with a real event timestamp also
// corrects the date of a score written earlier.
//
// MODES:
//   (default) score  -- scan observations in [floor..now] and (re)write derived
//                       scores via ingestion, stamped at the observation startTime.
//   delete           -- read LEGACY_IDS_FILE (JSON array of score ids) and DELETE
//                       each. Used once to remove the original random-id backfill
//                       scores after the accurate deterministic set is rebuilt.
//
// Env:
//   LANGFUSE_HOST / LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY  (required)
//   MODE              "score" (default) | "delete"
//   LOOKBACK_HOURS    window to scan, default 72
//   FLOOR_ISO         earliest subject startTime to score, default 2026-09-22T05:00:00Z
//   LEGACY_IDS_FILE   path to JSON id array (delete mode), default scripts/legacy-score-ids.json
//   SKIP_FRAMEWORKS / SKIP_MCP   "1" to skip that half (one-off scoping)
//   BUCKETS_ONLY      "1" to write ONLY mcp_bucket/framework_bucket (not base
//                     scores) -- use with a low FLOOR_ISO to backfill buckets over
//                     full history without double-counting existing base scores.
//   DRY_RUN           "1" to log without writing/deleting

import { readFileSync } from "node:fs";

const HOST = (process.env.LANGFUSE_HOST || "").replace(/\/+$/, "");
const PUBLIC_KEY = process.env.LANGFUSE_PUBLIC_KEY || "";
const SECRET_KEY = process.env.LANGFUSE_SECRET_KEY || "";
const MODE = (process.env.MODE || "score").toLowerCase();
const LOOKBACK_HOURS = Number(process.env.LOOKBACK_HOURS || 72);
const FLOOR_ISO = process.env.FLOOR_ISO || "2026-09-22T05:00:00Z";
const LEGACY_IDS_FILE = process.env.LEGACY_IDS_FILE || "scripts/legacy-score-ids.json";
const SKIP_FRAMEWORKS = process.env.SKIP_FRAMEWORKS === "1" || process.env.SKIP_FRAMEWORKS === "true";
const SKIP_MCP = process.env.SKIP_MCP === "1" || process.env.SKIP_MCP === "true";
// BUCKETS_ONLY: write ONLY the curated mcp_bucket / framework_bucket scores, not the
// base mcp_name/framework_name/framework_skill scores. Use with a low FLOOR_ISO to
// backfill buckets over full history WITHOUT re-writing (and double-counting against
// the original random-id) the base scores that already exist there.
const BUCKETS_ONLY = process.env.BUCKETS_ONLY === "1" || process.env.BUCKETS_ONLY === "true";
const DRY_RUN = process.env.DRY_RUN === "1" || process.env.DRY_RUN === "true";

if (!HOST || !PUBLIC_KEY || !SECRET_KEY) {
  console.error("Missing env: LANGFUSE_HOST, LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY are all required.");
  process.exit(1);
}

const AUTH = "Basic " + Buffer.from(`${PUBLIC_KEY}:${SECRET_KEY}`).toString("base64");
const now = new Date();
const floor = new Date(FLOOR_ISO);
const lookbackFrom = new Date(now.getTime() - LOOKBACK_HOURS * 3600 * 1000);
const from = lookbackFrom > floor ? lookbackFrom : floor;
const fromISO = from.toISOString();
const toISO = now.toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- Parsing rules (see langfuse-dashboards/README.md section 1) -------------
function parseFrameworkTag(rawTag) {
  const tag = rawTag.startsWith("subagent-") ? rawTag.slice("subagent-".length) : rawTag;
  if (!tag.startsWith("skill:")) return null;
  const parts = tag.split(":");
  if (parts.length < 3) return null; // bare skill:<name> = personal skill, excluded
  const framework = parts[1];
  const skill = parts.slice(2).join(":");
  if (!framework || !skill) return null;
  return { framework, skill };
}
function parseMcpServer(name) {
  if (typeof name !== "string" || !name.startsWith("Tool: mcp__")) return null;
  const segs = name.split("__");
  if (segs.length < 3) return null;
  return segs[1] || null;
}
// A BARE skill tag: `skill:<name>` (exactly one colon, optional subagent- prefix).
// These are excluded from framework_name (they're personal/global skills), but a
// subset of them ARE gstack commands -> used for GStack bucket detection below.
function parseBareSkill(rawTag) {
  const tag = rawTag.startsWith("subagent-") ? rawTag.slice("subagent-".length) : rawTag;
  if (!tag.startsWith("skill:")) return null;
  const parts = tag.split(":");
  if (parts.length !== 2) return null; // exactly skill:<name>
  return parts[1] || null;
}
// Deterministic, id-safe score id -> re-runs upsert instead of duplicating.
function scoreId(kind, subjectId, value) {
  return `${kind}_${subjectId}_${value}`.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 200);
}

// ---- Curated buckets (see langfuse-dashboards/README.md section 1.5) ---------
// mcp_bucket: raw mcp_name server segment -> tracked business display name, else "Other".
// Confirmed from live discovery (2026-09-22). satva-/claude_ai_Satva- prefixed servers
// are the real Satva integrations; lookalikes without that prefix (Basecamp,
// claude_ai_Gmail, ...) are DISTINCT servers and fall to Other by design.
const MCP_BUCKET_MAP = {
  claude_ai_Google_sheets: "Satva Google Sheets",
  "claude_ai_Satva-basecamp": "Satva Basecamp",
  claude_ai_Google_Drive: "Satva Google Drive",
  "satva-gmail": "Satva Gmail",
  "satva-zoho": "Satva Zoho",
  // Aspirational canonical MCPs with no data yet. Identifiers predicted from this
  // org's connected servers; verify/adjust when the first real call lands.
  claude_ai_Pipedrive_MCP: "Satva Pipedrive",
  playwright: "Playwright MCP",
  // TODO (confirm raw id on first appearance): Satva Xero, Satva QuickBooks,
  // Satva Shopify, SyncTools Shopify, Satva Linnworks, Satva Google Docs,
  // Satva Google Slides, Satva Google Analytics, Satva Freepik, Satva Instantly,
  // Playwright Codegen MCP.
};
function mcpBucket(server) {
  return MCP_BUCKET_MAP[server] || "Other";
}

// framework_bucket: raw framework_name -> one of the five canonical, else "Other".
const FRAMEWORK_DISPLAY = { gsd: "GSD", sat: "SAT", gstack: "GStack", ecc: "ECC", superpowers: "Superpowers" };
function frameworkBucket(framework) {
  return FRAMEWORK_DISPLAY[String(framework).toLowerCase()] || "Other";
}

// GStack does NOT tag runs as skill:gstack:*. It surfaces as BARE skill:<command>
// tags whose name is one of its installed commands. Ground truth = the actual
// install (~/.claude/skills/gstack/ command folders + the _gstack-command router),
// confirmed 2026-09-22 (supersedes the stale master-prompt list). Detection is exact
// tag-segment membership, so common words (review/ship/qa) can't false-positive on
// free text.
const GSTACK_COMMANDS = new Set([
  "autoplan", "benchmark", "benchmark-models", "browse", "canary", "careful",
  "codex", "context-restore", "context-save", "cso", "design-consultation",
  "design-html", "design-review", "design-shotgun", "devex-review",
  "document-generate", "document-release", "freeze", "gstack-upgrade", "guard",
  "health", "investigate", "ios-clean", "ios-design-review", "ios-fix", "ios-qa",
  "ios-sync", "land-and-deploy", "landing-report", "learn", "make-pdf",
  "office-hours", "open-gstack-browser", "pair-agent", "plan-ceo-review",
  "plan-design-review", "plan-devex-review", "plan-eng-review", "plan-tune", "qa",
  "qa-only", "retro", "review", "scrape", "setup-browser-cookies", "setup-deploy",
  "setup-gbrain", "ship", "skillify", "sync-gbrain", "unfreeze", "_gstack-command",
]);

// ---- HTTP with retry on transient 5xx/network (deploy restarts) --------------
async function fetchWithRetry(url, init, label, tries = 6) {
  let lastErr;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const res = await fetch(url, init);
      if (res.ok) return res;
      const transient = res.status === 429 || res.status >= 500;
      const bodyText = await res.text();
      if (!transient) throw new Error(`${label} -> ${res.status} ${bodyText}`);
      lastErr = new Error(`${label} -> ${res.status} ${bodyText}`);
    } catch (err) {
      lastErr = err;
      if (err.message && err.message.includes(" -> 4")) throw err;
    }
    if (attempt < tries) await sleep(Math.min(1000 * 2 ** (attempt - 1), 20000));
  }
  throw lastErr;
}

async function apiGet(path, params) {
  const url = new URL(`${HOST}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  const res = await fetchWithRetry(url, { headers: { Authorization: AUTH } }, `GET ${url.pathname}`);
  return res.json();
}

// v2 observations is cursor-paginated (events_only-safe). Yields each observation.
async function* observations(extraParams) {
  let cursor;
  for (;;) {
    const body = await apiGet("/api/public/v2/observations", {
      ...extraParams,
      fromStartTime: fromISO,
      toStartTime: toISO,
      limit: 100,
      cursor,
    });
    const rows = body.data || [];
    for (const row of rows) yield row;
    cursor = body.meta?.cursor;
    if (!cursor || rows.length === 0) break;
  }
}

// ---- Buffered ingestion writer (accurate score timestamps) ------------------
let created = 0;
let buffer = [];
const BATCH = 100;

function toIsoOffset(startTime) {
  // v2 returns ISO already (…Z). Guard against a bare value.
  const d = new Date(startTime);
  return isNaN(d.getTime()) ? now.toISOString() : d.toISOString();
}

async function flush() {
  if (buffer.length === 0) return;
  const batch = buffer;
  buffer = [];
  if (DRY_RUN) {
    created += batch.length;
    return;
  }
  await fetchWithRetry(
    `${HOST}/api/public/ingestion`,
    {
      method: "POST",
      headers: { Authorization: AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ batch }),
    },
    `POST /ingestion (${batch.length} scores)`,
  );
  created += batch.length;
}

async function writeScore({ id, name, value, traceId, observationId, startTime, comment }) {
  const body = {
    id,
    name,
    value,
    dataType: "CATEGORICAL",
    traceId,
    environment: "default",
    comment: comment || "scheduled re-score (accurate timestamp)",
  };
  if (observationId) body.observationId = observationId;
  buffer.push({
    id: `evt_${id}`,
    timestamp: toIsoOffset(startTime), // event timestamp -> score.timestamp -> real call date
    type: "score-create",
    body,
  });
  if (buffer.length >= BATCH) await flush();
}

// ---- Frameworks: one score per (trace, framework) and (trace, skill) --------
async function rescoreFrameworks() {
  let traces = 0;
  for await (const obs of observations({ isRootObservation: "true", fields: "basic,trace_context" })) {
    const traceId = obs.traceId;
    const tags = Array.isArray(obs.tags) ? obs.tags : [];
    if (!traceId) continue;
    const frameworks = new Set();
    const skills = new Set();
    const buckets = new Set();
    for (const tag of tags) {
      const parsed = parseFrameworkTag(tag);
      if (parsed) {
        frameworks.add(parsed.framework);
        skills.add(parsed.skill);
        buckets.add(frameworkBucket(parsed.framework));
        continue;
      }
      // Not a framework tag -> maybe a bare gstack command tag (skill:<cmd>).
      const bare = parseBareSkill(tag);
      if (bare && GSTACK_COMMANDS.has(bare)) buckets.add("GStack");
    }
    // A trace counts if it carries any framework tag OR any detected bucket
    // (the latter picks up gstack-only traces that carry no skill:X:Y tag).
    if (frameworks.size === 0 && buckets.size === 0) continue;
    traces += 1;
    if (!BUCKETS_ONLY) {
      for (const framework of frameworks) {
        await writeScore({ id: scoreId("framework_name", traceId, framework), name: "framework_name", value: framework, traceId, startTime: obs.startTime });
      }
      for (const skill of skills) {
        await writeScore({ id: scoreId("framework_skill", traceId, skill), name: "framework_skill", value: skill, traceId, startTime: obs.startTime });
      }
    }
    for (const bucket of buckets) {
      await writeScore({ id: scoreId("framework_bucket", traceId, bucket), name: "framework_bucket", value: bucket, traceId, startTime: obs.startTime });
    }
  }
  console.log(`Frameworks: scanned ${traces} framework-tagged traces in the window.`);
}

// ---- MCP: one score per TOOL observation named "Tool: mcp__server__tool" ----
async function rescoreMcp() {
  let calls = 0;
  for await (const obs of observations({ type: "TOOL", fields: "basic" })) {
    const server = parseMcpServer(obs.name);
    if (!server || !obs.traceId) continue;
    calls += 1;
    if (!BUCKETS_ONLY) {
      await writeScore({
        id: scoreId("mcp_name", obs.id, server),
        name: "mcp_name",
        value: server,
        traceId: obs.traceId,
        observationId: obs.id,
        startTime: obs.startTime,
        comment: "scheduled re-score: extracted from tool name (accurate timestamp)",
      });
    }
    const bucket = mcpBucket(server);
    await writeScore({
      id: scoreId("mcp_bucket", obs.id, bucket),
      name: "mcp_bucket",
      value: bucket,
      traceId: obs.traceId,
      observationId: obs.id,
      startTime: obs.startTime,
      comment: "scheduled re-score: curated bucket (tracked business MCP or Other)",
    });
  }
  console.log(`MCP: scanned ${calls} mcp__ tool-call observations in the window.`);
}

// ---- Delete mode: remove legacy (random-id) scores by id --------------------
async function deleteLegacy() {
  let ids;
  try {
    ids = JSON.parse(readFileSync(LEGACY_IDS_FILE, "utf8"));
  } catch (err) {
    throw new Error(`Could not read LEGACY_IDS_FILE ${LEGACY_IDS_FILE}: ${err.message}`);
  }
  if (!Array.isArray(ids)) throw new Error("LEGACY_IDS_FILE must contain a JSON array of score ids.");
  console.log(`Delete mode: ${ids.length} legacy score ids to remove${DRY_RUN ? " [DRY RUN]" : ""}.`);
  let deleted = 0;
  for (const id of ids) {
    if (DRY_RUN) { deleted += 1; continue; }
    await fetchWithRetry(
      `${HOST}/api/public/scores/${encodeURIComponent(id)}`,
      { method: "DELETE", headers: { Authorization: AUTH } },
      `DELETE /scores/${id}`,
    );
    deleted += 1;
    if (deleted % 100 === 0) console.log(`  deleted ${deleted}/${ids.length}`);
  }
  console.log(`Delete: ${deleted} scores deleted.`);
}

// ---- Main -------------------------------------------------------------------
(async () => {
  if (MODE === "delete") {
    await deleteLegacy();
    return;
  }
  console.log(`Re-score window ${fromISO} .. ${toISO} (lookback ${LOOKBACK_HOURS}h, floor ${floor.toISOString()})${BUCKETS_ONLY ? " [BUCKETS_ONLY]" : ""}${DRY_RUN ? " [DRY RUN]" : ""}`);
  if (SKIP_FRAMEWORKS) console.log("Frameworks: skipped (SKIP_FRAMEWORKS).");
  else await rescoreFrameworks();
  if (SKIP_MCP) console.log("MCP: skipped (SKIP_MCP).");
  else await rescoreMcp();
  await flush();
  console.log(DRY_RUN ? `Done (dry run). ${created} scores would be written.` : `Done. ${created} scores ingested (stamped at real call time).`);
})().catch((err) => {
  console.error("Re-score job failed:", err);
  process.exit(1);
});
