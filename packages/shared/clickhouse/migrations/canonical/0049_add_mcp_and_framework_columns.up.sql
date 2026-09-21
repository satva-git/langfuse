-- Derived MCP + framework classification columns.
--
-- Values are computed via DEFAULT expressions from existing data (observations.name,
-- traces.tags), following the same convention as evaluator_id in migration 0047. This means:
--   * existing rows resolve their values on read (metadata-only migration, no backfill mutation)
--   * new rows compute their values on insert -- the worker inserts via JSONEachRow and never
--     emits these fields, so ClickHouse applies the DEFAULT automatically (no worker code change)
--
-- MCP observation names:  mcp__<server>__<tool>   (server may itself contain single underscores,
--                         so we split on the FIRST `__...__` boundary via a non-greedy capture)
-- Framework trace tags:   skill:<framework>:<skill>  OR  subagent-skill:<framework>:<skill>
--                         (the optional `subagent-` prefix is ignored, so skill:X:Y and
--                         subagent-skill:X:Y collapse to the same framework/skill pair)

ALTER TABLE observations {CLICKHOUSE_CLUSTER_CLAUSE}
  ADD COLUMN IF NOT EXISTS mcp_name LowCardinality(Nullable(String)) DEFAULT nullIf(extractGroups(name, '^mcp__([A-Za-z0-9_-]+?)__(.+)$')[1], '') AFTER name
 {CLICKHOUSE_CLUSTERED_ONLY: SETTINGS alter_sync = 2};

ALTER TABLE observations {CLICKHOUSE_CLUSTER_CLAUSE}
  ADD COLUMN IF NOT EXISTS mcp_tool Nullable(String) DEFAULT nullIf(extractGroups(name, '^mcp__([A-Za-z0-9_-]+?)__(.+)$')[2], '') AFTER mcp_name
 {CLICKHOUSE_CLUSTERED_ONLY: SETTINGS alter_sync = 2};

ALTER TABLE traces {CLICKHOUSE_CLUSTER_CLAUSE}
  ADD COLUMN IF NOT EXISTS framework_name LowCardinality(Nullable(String)) DEFAULT nullIf(extractGroups(arrayFirst(t -> match(t, '^(subagent-)?skill:[A-Za-z0-9-]+:[A-Za-z0-9-]+$'), tags), '^(?:subagent-)?skill:([A-Za-z0-9-]+):([A-Za-z0-9-]+)$')[1], '') AFTER tags
 {CLICKHOUSE_CLUSTERED_ONLY: SETTINGS alter_sync = 2};

ALTER TABLE traces {CLICKHOUSE_CLUSTER_CLAUSE}
  ADD COLUMN IF NOT EXISTS framework_skill LowCardinality(Nullable(String)) DEFAULT nullIf(extractGroups(arrayFirst(t -> match(t, '^(subagent-)?skill:[A-Za-z0-9-]+:[A-Za-z0-9-]+$'), tags), '^(?:subagent-)?skill:([A-Za-z0-9-]+):([A-Za-z0-9-]+)$')[2], '') AFTER framework_name
 {CLICKHOUSE_CLUSTERED_ONLY: SETTINGS alter_sync = 2};
