-- Enrichment for v4.x events schema. events_full carries full-text indexes, so each
-- ALTER needs SETTINGS enable_full_text_index = 1 (per migration 0047). Re-runnable.
ALTER TABLE events_full ADD COLUMN IF NOT EXISTS mcp_name LowCardinality(Nullable(String)) DEFAULT nullIf(extractGroups(name, '^mcp__([A-Za-z0-9_-]+?)__(.+)$')[1], '') SETTINGS enable_full_text_index = 1;
ALTER TABLE events_full ADD COLUMN IF NOT EXISTS mcp_tool Nullable(String) DEFAULT nullIf(extractGroups(name, '^mcp__([A-Za-z0-9_-]+?)__(.+)$')[2], '') SETTINGS enable_full_text_index = 1;
ALTER TABLE events_full ADD COLUMN IF NOT EXISTS framework_name LowCardinality(Nullable(String)) DEFAULT nullIf(extractGroups(arrayFirst(t -> match(t, '^(subagent-)?skill:[A-Za-z0-9-]+:[A-Za-z0-9-]+$'), tags), '^(?:subagent-)?skill:([A-Za-z0-9-]+):([A-Za-z0-9-]+)$')[1], '') SETTINGS enable_full_text_index = 1;
ALTER TABLE events_full ADD COLUMN IF NOT EXISTS framework_skill LowCardinality(Nullable(String)) DEFAULT nullIf(extractGroups(arrayFirst(t -> match(t, '^(subagent-)?skill:[A-Za-z0-9-]+:[A-Za-z0-9-]+$'), tags), '^(?:subagent-)?skill:([A-Za-z0-9-]+):([A-Za-z0-9-]+)$')[2], '') SETTINGS enable_full_text_index = 1;
ALTER TABLE events_core ADD COLUMN IF NOT EXISTS mcp_name LowCardinality(Nullable(String)) DEFAULT nullIf(extractGroups(name, '^mcp__([A-Za-z0-9_-]+?)__(.+)$')[1], '') SETTINGS enable_full_text_index = 1;
ALTER TABLE events_core ADD COLUMN IF NOT EXISTS mcp_tool Nullable(String) DEFAULT nullIf(extractGroups(name, '^mcp__([A-Za-z0-9_-]+?)__(.+)$')[2], '') SETTINGS enable_full_text_index = 1;
ALTER TABLE events_core ADD COLUMN IF NOT EXISTS framework_name LowCardinality(Nullable(String)) DEFAULT nullIf(extractGroups(arrayFirst(t -> match(t, '^(subagent-)?skill:[A-Za-z0-9-]+:[A-Za-z0-9-]+$'), tags), '^(?:subagent-)?skill:([A-Za-z0-9-]+):([A-Za-z0-9-]+)$')[1], '') SETTINGS enable_full_text_index = 1;
ALTER TABLE events_core ADD COLUMN IF NOT EXISTS framework_skill LowCardinality(Nullable(String)) DEFAULT nullIf(extractGroups(arrayFirst(t -> match(t, '^(subagent-)?skill:[A-Za-z0-9-]+:[A-Za-z0-9-]+$'), tags), '^(?:subagent-)?skill:([A-Za-z0-9-]+):([A-Za-z0-9-]+)$')[2], '') SETTINGS enable_full_text_index = 1;
SELECT '=== events_full classified (total / mcp / framework) ===' AS section;
SELECT count() AS total, countIf(mcp_name IS NOT NULL) AS mcp, countIf(framework_name IS NOT NULL) AS fw FROM events_full;
SELECT '=== top MCP tools ===' AS section;
SELECT mcp_name, mcp_tool, count() AS c FROM events_full WHERE mcp_name IS NOT NULL GROUP BY mcp_name, mcp_tool ORDER BY c DESC LIMIT 10;
SELECT '=== top frameworks (by distinct trace) ===' AS section;
SELECT framework_name, framework_skill, uniqExact(trace_id) AS traces FROM events_full WHERE framework_name IS NOT NULL GROUP BY framework_name, framework_skill ORDER BY traces DESC LIMIT 10;
