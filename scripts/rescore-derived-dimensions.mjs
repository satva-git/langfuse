#!/usr/bin/env node
// Keep the MCP Adoption and Claude Framework Governance dashboards current.
//
// Those dashboards group on categorical SCORES (mcp_name, framework_name,
// framework_skill) that must be written onto each trace/observation. Langfuse
// widgets cannot regex-extract live, and the DB-layer DEFAULT-column enrichment
// (ClickHouse migration 0049) only exists in the fork build -- production runs
// the official images, so nothing scores new data automatically.
//
// This job re-runs the exact backfill logic from langfuse-dashboards/README.md
// over a recent lookback window. It is IDEMPOTENT: every score uses a
// deterministic id, so overlapping runs upsert instead of duplicating. Schedule
// it (GitHub Actions cron / Coolify scheduled task / plain cron) to keep the
// dashboards live until Option A (structured metadata at instrumentation) ships.
//
// Env:
//   LANGFUSE_HOST          e.g. https://langfuse.satva.xyz   (required)
//   LANGFUSE_PUBLIC_KEY    pk-...                             (required)
//   LANGFUSE_SECRET_KEY    sk-...                             (required)
//   LOOKBACK_HOURS         window to scan, default 72
//   DRY_RUN               "1" to log what would be written without writing

const HOST = (process.env.LANGFUSE_HOST || "").replace(/\/+$/, "");
const PUBLIC_KEY = process.env.LANGFUSE_PUBLIC_KEY || "";
const SECRET_KEY = process.env.LANGFUSE_SECRET_KEY || "";
const LOOKBACK_HOURS = Number(process.env.LOOKBACK_HOURS || 72);
const DRY_RUN = process.env.DRY_RUN === "1" || process.env.DRY_RUN === "true";

if (!HOST || !PUBLIC_KEY || !SECRET_KEY) {
  console.error(
    "Missing env: LANGFUSE_HOST, LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY are all required.",
  );
  process.exit(1);
}

const AUTH =
  "Basic " + Buffer.from(`${PUBLIC_KEY}:${SECRET_KEY}`).toString("base64");
const now = new Date();
const from = new Date(now.getTime() - LOOKBACK_HOURS * 3600 * 1000);
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
  const server = segs[1];
  return server || null;
}

// Deterministic, filesystem/id-safe score id so re-runs upsert.
function scoreId(kind, subjectId, value) {
  const raw = `${kind}|${subjectId}|${value}`;
  return raw.replace(/[^a-zA-Z0-9_:.-]/g, "_").slice(0, 200);
}

// ---- Langfuse public API helpers --------------------------------------------

async function apiGet(path, params) {
  const url = new URL(`${HOST}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const res = await fetch(url, { headers: { Authorization: AUTH } });
  if (!res.ok) {
    throw new Error(`GET ${url.pathname} -> ${res.status} ${await res.text()}`);
  }
  return res.json();
}

async function* paginate(path, params, timeKeys) {
  let page = 1;
  for (;;) {
    const body = await apiGet(path, {
      ...params,
      [timeKeys.from]: fromISO,
      [timeKeys.to]: toISO,
      page,
      limit: 100,
    });
    const rows = body.data || [];
    for (const row of rows) yield row;
    const totalPages = body.meta?.totalPages ?? 1;
    if (page >= totalPages || rows.length === 0) break;
    page += 1;
  }
}

let created = 0;
let skipped = 0;

// Presence dedupe. The original 2026-09-21 backfill wrote its scores with RANDOM
// ids, so deterministic-id upsert alone would not recognise them and would create
// duplicates for any subject inside the lookback window that the backfill already
// covered (double-counting on the dashboards). So before writing, we load every
// existing score of each derived name and skip subjects already scored with the
// same value. Key: trace-scoped -> `${traceId}|${value}`; observation-scoped
// (mcp_name) -> `${observationId}|${value}`.
async function loadExistingKeys(name, keyOf) {
  const keys = new Set();
  let page = 1;
  for (;;) {
    const body = await apiGet("/api/public/scores", {
      name,
      page,
      limit: 100,
      fromTimestamp: "2026-01-01T00:00:00Z",
    });
    const rows = body.data || [];
    for (const s of rows) {
      const k = keyOf(s);
      if (k) keys.add(k);
    }
    const totalPages = body.meta?.totalPages ?? 1;
    if (page >= totalPages || rows.length === 0) break;
    page += 1;
  }
  return keys;
}

async function upsertScore({ id, name, value, traceId, observationId, comment }) {
  if (DRY_RUN) {
    console.log(`[dry-run] ${name}=${value} trace=${traceId}${observationId ? " obs=" + observationId : ""}`);
    skipped += 1;
    return;
  }
  // Note: the public-scores body has no `source` field -- the server stamps
  // source=API for public-API ingestion automatically (see PostScoreBodyFoundationSchema).
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

async function rescoreFrameworks() {
  const existingNames = await loadExistingKeys(
    "framework_name",
    (s) => `${s.traceId}|${s.stringValue}`,
  );
  const existingSkills = await loadExistingKeys(
    "framework_skill",
    (s) => `${s.traceId}|${s.stringValue}`,
  );
  let traces = 0;
  for await (const trace of paginate("/api/public/traces", {}, { from: "fromTimestamp", to: "toTimestamp" })) {
    const tags = Array.isArray(trace.tags) ? trace.tags : [];
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
      if (existingNames.has(`${trace.id}|${framework}`)) { skipped += 1; continue; }
      await upsertScore({
        id: scoreId("framework_name", trace.id, framework),
        name: "framework_name",
        value: framework,
        traceId: trace.id,
      });
      existingNames.add(`${trace.id}|${framework}`);
    }
    for (const skill of skills) {
      if (existingSkills.has(`${trace.id}|${skill}`)) { skipped += 1; continue; }
      await upsertScore({
        id: scoreId("framework_skill", trace.id, skill),
        name: "framework_skill",
        value: skill,
        traceId: trace.id,
      });
      existingSkills.add(`${trace.id}|${skill}`);
    }
  }
  console.log(`Frameworks: scanned ${traces} framework-tagged traces in the window.`);
}

// ---- MCP: one score per TOOL observation named "Tool: mcp__server__tool" ----

async function rescoreMcp() {
  // mcp_name is observation-scoped (one score per tool call). Dedupe on the
  // observation id so an already-scored call is never counted twice.
  const existing = await loadExistingKeys(
    "mcp_name",
    (s) => (s.observationId ? `${s.observationId}|${s.stringValue}` : null),
  );
  let calls = 0;
  for await (const obs of paginate(
    "/api/public/observations",
    { type: "TOOL" },
    { from: "fromStartTime", to: "toStartTime" },
  )) {
    const server = parseMcpServer(obs.name);
    if (!server) continue;
    calls += 1;
    if (existing.has(`${obs.id}|${server}`)) { skipped += 1; continue; }
    await upsertScore({
      id: scoreId("mcp_name", obs.id, server),
      name: "mcp_name",
      value: server,
      traceId: obs.traceId,
      observationId: obs.id,
      comment: "scheduled re-score: extracted from tool name",
    });
    existing.add(`${obs.id}|${server}`);
  }
  console.log(`MCP: scanned ${calls} mcp__ tool-call observations in the window.`);
}

// ---- Main -------------------------------------------------------------------

(async () => {
  console.log(
    `Re-score window ${fromISO} .. ${toISO} (${LOOKBACK_HOURS}h)${DRY_RUN ? " [DRY RUN]" : ""}`,
  );
  await rescoreFrameworks();
  await rescoreMcp();
  console.log(
    DRY_RUN
      ? `Done (dry run). ${skipped} scores would be written.`
      : `Done. ${created} scores written, ${skipped} already present (skipped).`,
  );
})().catch((err) => {
  console.error("Re-score job failed:", err);
  process.exit(1);
});
