-- Fix MCP columns: names are prefixed with "Tool: " in this version, so allow an
-- optional "Tool: " prefix. MODIFY COLUMN updates the DEFAULT; existing rows reclassify
-- on read, new rows on insert. Framework columns are already correct and left as-is.
ALTER TABLE events_full MODIFY COLUMN mcp_name LowCardinality(Nullable(String)) DEFAULT nullIf(extractGroups(name, '^(?:Tool: )?mcp__([A-Za-z0-9_-]+?)__(.+)$')[1], '') SETTINGS enable_full_text_index = 1;
ALTER TABLE events_full MODIFY COLUMN mcp_tool Nullable(String) DEFAULT nullIf(extractGroups(name, '^(?:Tool: )?mcp__([A-Za-z0-9_-]+?)__(.+)$')[2], '') SETTINGS enable_full_text_index = 1;
ALTER TABLE events_core MODIFY COLUMN mcp_name LowCardinality(Nullable(String)) DEFAULT nullIf(extractGroups(name, '^(?:Tool: )?mcp__([A-Za-z0-9_-]+?)__(.+)$')[1], '') SETTINGS enable_full_text_index = 1;
ALTER TABLE events_core MODIFY COLUMN mcp_tool Nullable(String) DEFAULT nullIf(extractGroups(name, '^(?:Tool: )?mcp__([A-Za-z0-9_-]+?)__(.+)$')[2], '') SETTINGS enable_full_text_index = 1;
SELECT '=== events_full classified (total / mcp / framework) ===' AS s;
SELECT count() AS total, countIf(mcp_name IS NOT NULL) AS mcp, countIf(framework_name IS NOT NULL) AS fw FROM events_full;
SELECT '=== top MCP servers x tool ===' AS s;
SELECT mcp_name, mcp_tool, count() AS c FROM events_full WHERE mcp_name IS NOT NULL GROUP BY mcp_name, mcp_tool ORDER BY c DESC LIMIT 12;
SELECT '=== MCP calls per server ===' AS s;
SELECT mcp_name, count() AS c FROM events_full WHERE mcp_name IS NOT NULL GROUP BY mcp_name ORDER BY c DESC;
