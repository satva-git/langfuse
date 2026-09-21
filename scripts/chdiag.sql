SELECT '=== databases ===' AS section;
SELECT name FROM system.databases;
SELECT '=== key table row counts ===' AS section;
SELECT database, name, total_rows, engine FROM system.tables WHERE name IN ('observations','traces','events_full','events_core','scores') ORDER BY database, name;
SELECT '=== sample observation names (default.observations) ===' AS section;
SELECT name, count() AS c FROM observations GROUP BY name ORDER BY c DESC LIMIT 8;
