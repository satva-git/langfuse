# Fork customization: native MCP / framework enrichment

**Owner:** analytics / platform team · **Added:** 2026-09-21

This fork carries a permanent custom diff that classifies every trace/observation with
MCP and Claude-Code-framework fields **at the database layer**, so new data is enriched
automatically with no backfill script and no scheduled job.

## What was changed (keep these across upstream merges)

1. **ClickHouse migration** — `0049_add_mcp_and_framework_columns.{up,down}.sql`
   Adds four columns whose values are computed via `DEFAULT` expressions (same convention
   as `evaluator_id` in `0047`), so existing rows resolve on read and new rows compute on
   insert:
   - `observations.mcp_name`  = server from `mcp__<server>__<tool>` name (non-greedy split on first `__`)
   - `observations.mcp_tool`  = tool from the same name
   - `traces.framework_name`  = framework from `skill:<fw>:<skill>` / `subagent-skill:<fw>:<skill>` tag
   - `traces.framework_skill` = skill from the same tag
   The `subagent-` prefix is ignored, so `skill:X:Y` and `subagent-skill:X:Y` dedupe to one pair.

2. **Dashboard dimension registry** — `packages/shared/src/features/query/dataModel.ts`
   - `observationsView.dimensions`: `mcpName`, `mcpTool` (native), `frameworkName`,
     `frameworkSkill` (via the existing `traces` join — powers the employee × framework pivot).
   - `traceView.dimensions`: `frameworkName`, `frameworkSkill` (native).

## Why it does NOT touch application code
The worker inserts via ClickHouse `JSONEachRow` and never emits these fields, so the
`DEFAULT` expression is applied server-side on every insert. No change to
`IngestionService`, `ClickhouseWriter`, or the `definitions.ts` Zod schemas is required.

## Merge conflict guidance
- If upstream renumbers migrations past `0048`, renumber `0049_*` to the next free slot;
  the `DEFAULT`-column approach is idempotent (`ADD COLUMN IF NOT EXISTS`).
- If upstream restructures `dataModel.ts`, re-add the four dimension entries to whichever
  file declares the traces/observations views. They are plain SQL-column dimensions.
- If upstream moves the physical write off the `observations`/`traces` tables (e.g. onto the
  `events_full`/`events_core` schema for v2 views), port the `DEFAULT` expressions onto the
  new physical table(s) and add the dimensions to the corresponding `events*View`.

## Deploy notes
- The ClickHouse migration auto-runs from the **web** container entrypoint
  (`web/entrypoint.sh` → `clickhouse/scripts/up.sh`), unless
  `LANGFUSE_AUTO_CLICKHOUSE_MIGRATION_DISABLED=true`. Redeploying **web** applies the
  schema change and ships the new dashboard dimensions in one step.
- The **worker** needs no code change and no redeploy for enrichment to work.
- No historical data-mutation (`ALTER TABLE ... UPDATE`) is needed — `DEFAULT` covers old rows.
