#!/usr/bin/env node
// Keep the MCP Adoption and Claude Framework Governance dashboards current.
//
// Those dashboards group on categorical SCORES (mcp_name, framework_name,
// framework_skill) that must be written onto each trace/observation. Langfuse
// widgets cannot regex-extract live, and the DB-layer DEFAULT-column enrichment
// (ClickHouse migration 0049) only exists in the fork build -- production runs
// the official images, so nothing scores new data automatically.
//
// This job re-runs the backfill logic from langfuse-dashboards/README.md over a
// recent window and writes the missing scores. Design notes:
//
//   * events_only mode: this Langfuse v4 deployment runs in "events_only" mode,
//     where the legacy list endpoints (/api/public/traces, /observations,
//     /scores, /metrics) all return 404. The ONLY reader available is
//     GET /api/public/v2/observations (cursor-based). POST /api/public/scores
//     still works. So we read observations via v2 and cannot list scores.
//   * Idempotency: every score uses a DETERMINISTIC id, so re-runs upsert.
//   * No double-count vs the one-time 2026-09-21 backfill (whose scores carry
//     random ids and cannot be listed here): FLOOR_ISO bounds the scan so we
//     never touch a subject the backfill already covered. The floor sits just
//     after the manually-scored gsd trace, so that trace keeps its single score
//     and the job owns everything created after the floor.
//
// Env:
//   LANGFUSE_HOST          e.g. https://langfuse.satva.xyz   (required)
//   LANGFUSE_PUBLIC_KEY    pk-...                             (required)
//   LANGFUSE_SECRET_KEY    sk-...                             (required)
//   LOOKBACK_HOURS         window to scan, default 72
//   FLOOR_ISO              earliest subject start time to score,
//                          default 2026-09-22T05:00:00Z (see note above)
//   DRY_RUN                "1" to log what would be written without writing

const HOST = (process.env.LANGFUSE_HOST || "").replace(/\/+$/, "");
const PUBLIC_KEY = process.env.LANGFUSE_PUBLIC_KEY || "";
const SECRET_KEY = process.env.LANGFUSE_SECRET_KEY || "";
const LOOKBACK_HOURS = Number(process.env.LOOKBACK_HOURS || 72);
const FLOOR_ISO = process.env.FLOOR_ISO || "2026-09-22T05:00:00Z";
const DRY_RUN = process.env.DRY_RUN === "1" || process.env.DRY_RUN === "true";
// Optional one-off scoping (used for the controlled gap-fill backfill; the
// hourly run leaves both off so it scores frameworks and MCP together).
const SKIP_FRAMEWORKS = process.env.SKIP_FRAMEWORKS === "1" || process.env.SKIP_FRAMEWORKS === "true";
const SKIP_MCP = process.env.SKIP_MCP === "1" || process.env.SKIP_MCP === "true";

if (!HOST || !PUBLIC_KEY || !SECRET_KEY) {
  console.error(
    "Missing env: LANGFUSE_HOST, LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY are all required.",
  );
  process.exit(1);
}

const AUTH =
  "Basic " + Buffer.from(`${PUBLIC_KEY}:${SECRET_KEY}`).toString("base64");
const now = new Date();
const floor = new Date(FLOOR_ISO);
const lookbackFrom = new Date(now.getTime() - LOOKBACK_HOURS * 3600 * 1000);
const from = lookbackFrom > floor ? lookbackFrom : floor; // never earlier than the floor
const fromISO = from.toISOString();
const toISO = now.toISOString();

// ---- Parsing rules (see langfuse-dashboards/README.md section 1) -------------

// Framework tag: strip optional "subagent-" prefix; it is a framework tag only
// if it then starts with "skill:" AND contains a second colon.
// skill:<framework>:<skill>  ->  { framework, skill }
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

// MCP tool call: observation name "Tool: mcp__<server>__<tool>".
// server = segment between the first and second "__".
function parseMcpServer(name) {
  if (typeof name !== "string" || !name.startsWith("Tool: mcp__")) return null;
  const segs = name.split("__");
  if (segs.length < 3) return null;
  return segs[1] || null;
}

// Deterministic, id-safe score id so re-runs upsert instead of duplicating.
function scoreId(kind, subjectId, value) {
  return `${kind}|${subjectId}|${value}`.replace(/[^a-zA-Z0-9_:.-]/g, "_").slice(0, 200);
}

// ---- Langfuse public API helpers --------------------------------------------

async function apiGet(path, params) {
  const url = new URL(`${HOST}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, { headers: { Authorization: AUTH } });
  if (!res.ok) {
    throw new Error(`GET ${url.pathname} -> ${res.status} ${await res.text()}`);
  }
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

let created = 0;
let skipped = 0;

async function upsertScore({ id, name, value, traceId, observationId, comment }) {
  if (DRY_RUN) {
    console.log(`[dry-run] ${name}=${value} trace=${traceId}${observationId ? " obs=" + observationId : ""}`);
    skipped += 1;
    return;
  }
  // The public-scores body has no `source` field -- the server stamps source=API
  // for public-API ingestion automatically (see PostScoreBodyFoundationSchema).
  const payload = {
    id,
    name,
    value,
    dataType: "CATEGORICAL",
    traceId,
    environment: "default",
    comment: comment || "scheduled re-score: extracted from trace tags / tool names",
  };
  if (observationId) payload.observationId = observationId;
  const res = await fetch(`${HOST}/api/public/scores`, {
    method: "POST",
    headers: { Authorization: AUTH, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(`POST /scores (${name}=${value}) -> ${res.status} ${await res.text()}`);
  }
  created += 1;
}

// ---- Frameworks: one score per (trace, framework) and (trace, skill) --------
// Root observations carry the trace's tags via the trace_context field group,
// so one root observation per trace gives us the framework tags trace-scoped.

async function rescoreFrameworks() {
  let traces = 0;
  for await (const obs of observations({
    isRootObservation: "true",
    fields: "basic,trace_context",
  })) {
    const traceId = obs.traceId;
    const tags = Array.isArray(obs.tags) ? obs.tags : [];
    if (!traceId) continue;
    const frameworks = new Set();
    const skills = new Set();
    for (const tag of tags) {
      const parsed = parseFrameworkTag(tag);
      if (!parsed) continue;
      frameworks.add(parsed.framework);
      skills.add(parsed.skill);
    }
    if (frameworks.size === 0) continue;
    traces += 1;
    for (const framework of frameworks) {
      await upsertScore({
        id: scoreId("framework_name", traceId, framework),
        name: "framework_name",
        value: framework,
        traceId,
      });
    }
    for (const skill of skills) {
      await upsertScore({
        id: scoreId("framework_skill", traceId, skill),
        name: "framework_skill",
        value: skill,
        traceId,
      });
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
    await upsertScore({
      id: scoreId("mcp_name", obs.id, server),
      name: "mcp_name",
      value: server,
      traceId: obs.traceId,
      observationId: obs.id,
      comment: "scheduled re-score: extracted from tool name",
    });
  }
  console.log(`MCP: scanned ${calls} mcp__ tool-call observations in the window.`);
}

// ---- Main -------------------------------------------------------------------

(async () => {
  console.log(
    `Re-score window ${fromISO} .. ${toISO} (lookback ${LOOKBACK_HOURS}h, floor ${floor.toISOString()})${DRY_RUN ? " [DRY RUN]" : ""}`,
  );
  if (SKIP_FRAMEWORKS) console.log("Frameworks: skipped (SKIP_FRAMEWORKS).");
  else await rescoreFrameworks();
  if (SKIP_MCP) console.log("MCP: skipped (SKIP_MCP).");
  else await rescoreMcp();
  console.log(
    DRY_RUN
      ? `Done (dry run). ${skipped} scores would be written.`
      : `Done. ${created} scores upserted.`,
  );
})().catch((err) => {
  console.error("Re-score job failed:", err);
  process.exit(1);
});
