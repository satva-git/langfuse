-- One-off helper: apply the MCP/framework enrichment columns to a running
-- (unclustered) ClickHouse, then print verification. Safe to re-run (IF NOT EXISTS).
-- Fetch + run inside the clickhouse container:
--   wget -qO- <url> | clickhouse-client --database default --multiquery
ALTER TABLE observations ADD COLUMN IF NOT EXISTS mcp_name LowCardinality(Nullable(String)) DEFAULT nullIf(extractGroups(name, '^mcp__([A-Za-z0-9_-]+?)__(.+)$')[1], '') AFTER name;
ALTER TABLE observations ADD COLUMN IF NOT EXISTS mcp_tool Nullable(String) DEFAULT nullIf(extractGroups(name, '^mcp__([A-Za-z0-9_-]+?)__(.+)$')[2], '') AFTER mcp_name;
ALTER TABLE traces ADD COLUMN IF NOT EXISTS framework_name LowCardinality(Nullable(String)) DEFAULT nullIf(extractGroups(arrayFirst(t -> match(t, '^(subagent-)?skill:[A-Za-z0-9-]+:[A-Za-z0-9-]+$'), tags), '^(?:subagent-)?skill:([A-Za-z0-9-]+):([A-Za-z0-9-]+)$')[1], '') AFTER tags;
ALTER TABLE traces ADD COLUMN IF NOT EXISTS framework_skill LowCardinality(Nullable(String)) DEFAULT nullIf(extractGroups(arrayFirst(t -> match(t, '^(subagent-)?skill:[A-Za-z0-9-]+:[A-Za-z0-9-]+$'), tags), '^(?:subagent-)?skill:([A-Za-z0-9-]+):([A-Za-z0-9-]+)$')[2], '') AFTER framework_name;
SELECT '=== columns present (expect 4 rows) ===' AS section;
SELECT table, name, type FROM system.columns WHERE name IN ('mcp_name','mcp_tool','framework_name','framework_skill') ORDER BY table, name;
SELECT '=== observations classified ===' AS section;
SELECT count() AS total_obs, countIf(mcp_name IS NOT NULL) AS mcp_classified FROM observations;
SELECT '=== top MCP tools ===' AS section;
SELECT mcp_name, mcp_tool, count() AS c FROM observations WHERE mcp_name IS NOT NULL GROUP BY mcp_name, mcp_tool ORDER BY c DESC LIMIT 8;
SELECT '=== top frameworks ===' AS section;
SELECT framework_name, framework_skill, count() AS c FROM traces WHERE framework_name IS NOT NULL GROUP BY framework_name, framework_skill ORDER BY c DESC LIMIT 8;
