import React, { useMemo } from "react";
import { type ChartProps } from "@/src/features/widgets/chart-library/chart-props";
import {
  type PivotTableConfig,
  type DatabaseRow,
  extractMetricValues,
} from "@/src/features/widgets/utils/pivot-table-utils";
import { cn } from "@/src/utils/tailwind";
import { formatMetricName } from "@/src/features/widgets/utils";

interface ScoreHeatmapProps {
  data: ChartProps["data"];
  config?: PivotTableConfig;
  isLoading?: boolean;
}

// Three-band coloring: green ≥ 70 %, amber 40–69 %, red < 40 % of the range.
function heatColorClass(ratio: number): string {
  if (ratio >= 0.7)
    return "bg-green-100 dark:bg-green-900 text-green-900 dark:text-green-100";
  if (ratio >= 0.4)
    return "bg-amber-100 dark:bg-amber-900 text-amber-900 dark:text-amber-100";
  return "bg-red-100 dark:bg-red-900 text-red-900 dark:text-red-100";
}

/**
 * ScoreHeatmap renders a color-coded matrix widget.
 *
 * Two modes:
 * - 2-dimension config (dims[0] × dims[1]): first dimension = rows,
 *   second dimension = columns, first metric = cell value.
 * - 1-dimension + multi-metric config: dimension = rows,
 *   metric names = columns, each cell = that metric's value.
 *
 * Color bands are relative to the min/max values present in the dataset.
 */
export function ScoreHeatmap({
  data,
  config,
  isLoading,
}: ScoreHeatmapProps): React.ReactElement | null {
  const matrix = useMemo(() => {
    if (!config || !data?.length) return null;

    const dims = config.dimensions ?? [];
    const metrics = config.metrics ?? [];
    const rows = data as unknown as DatabaseRow[];

    // Compute per-row average across all non-null cell values.
    function rowAvg(
      cells: Record<string, Record<string, number | null>>,
      rk: string,
    ): number {
      const vals = Object.values(cells[rk] ?? {}).filter(
        (v): v is number => v !== null,
      );
      return vals.length
        ? vals.reduce((a, b) => a + b, 0) / vals.length
        : -Infinity;
    }

    if (dims.length >= 2) {
      // 2-dimension mode
      const rowDim = dims[0];
      const colDim = dims[1];
      const metricKey = metrics[0] ?? "metric";

      const colKeys = [...new Set(rows.map((r) => r[colDim]?.toString() ?? ""))]
        .filter(Boolean)
        .sort();

      const cells: Record<string, Record<string, number | null>> = {};
      for (const row of rows) {
        const rk = row[rowDim]?.toString() ?? "";
        const ck = row[colDim]?.toString() ?? "";
        const v = extractMetricValues(row, [metricKey])[metricKey];
        if (!cells[rk]) cells[rk] = {};
        cells[rk][ck] = typeof v === "number" ? v : null;
      }

      // Sort rows by descending subtotal average.
      const rowKeys = [...new Set(rows.map((r) => r[rowDim]?.toString() ?? ""))]
        .filter(Boolean)
        .sort((a, b) => rowAvg(cells, b) - rowAvg(cells, a));

      const allValues = Object.values(cells)
        .flatMap((r) => Object.values(r))
        .filter((v): v is number => v !== null);
      const min = Math.min(...allValues);
      const max = Math.max(...allValues);

      return { rowKeys, colKeys, cells, min, max };
    }

    if (dims.length === 1 && metrics.length > 1) {
      // 1-dimension + multi-metric mode
      const rowDim = dims[0];
      const colKeys = metrics;

      const cells: Record<string, Record<string, number | null>> = {};
      for (const row of rows) {
        const rk = row[rowDim]?.toString() ?? "";
        const metricValues = extractMetricValues(row, metrics);
        if (!cells[rk]) cells[rk] = {};
        for (const m of metrics) {
          cells[rk][m] =
            typeof metricValues[m] === "number" ? metricValues[m] : null;
        }
      }

      // Sort rows by descending subtotal average.
      const rowKeys = [...new Set(rows.map((r) => r[rowDim]?.toString() ?? ""))]
        .filter(Boolean)
        .sort((a, b) => rowAvg(cells, b) - rowAvg(cells, a));

      const allValues = Object.values(cells)
        .flatMap((r) => Object.values(r))
        .filter((v): v is number => v !== null);
      const min = Math.min(...allValues);
      const max = Math.max(...allValues);

      return { rowKeys, colKeys, cells, min, max };
    }

    return null;
  }, [data, config]);

  if (isLoading) {
    return (
      <div className="text-muted-foreground flex h-32 items-center justify-center text-sm">
        Loading…
      </div>
    );
  }

  if (!matrix || !matrix.rowKeys.length) {
    return (
      <div className="text-muted-foreground flex h-32 items-center justify-center text-sm">
        No data — configure two dimensions or one dimension with multiple
        metrics.
      </div>
    );
  }

  const { rowKeys, colKeys, cells, min, max } = matrix;
  const range = max - min || 1;

  // Per-row subtotal averages (already used for sort order).
  const rowAvgs: Record<string, number | null> = {};
  for (const rk of rowKeys) {
    const vals = colKeys
      .map((ck) => cells[rk]?.[ck] ?? null)
      .filter((v): v is number => v !== null);
    rowAvgs[rk] = vals.length
      ? vals.reduce((a, b) => a + b, 0) / vals.length
      : null;
  }

  return (
    <div className="overflow-auto">
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr>
            <th className="bg-background sticky left-0 z-10 max-w-36 min-w-28 border p-1 text-left" />
            {colKeys.map((col) => (
              <th
                key={col}
                className="text-muted-foreground max-w-28 border p-1 font-medium whitespace-nowrap"
                title={col}
              >
                <div className="max-w-24 truncate">{formatMetricName(col)}</div>
              </th>
            ))}
            <th className="text-muted-foreground border p-1 font-medium whitespace-nowrap">
              Avg
            </th>
          </tr>
        </thead>
        <tbody>
          {rowKeys.map((row) => {
            const avg = rowAvgs[row];
            const avgRatio = avg !== null ? (avg - min) / range : null;
            return (
              <tr key={row}>
                <td
                  className="bg-background sticky left-0 z-10 max-w-36 truncate border p-1 font-medium"
                  title={row}
                >
                  {row}
                </td>
                {colKeys.map((col) => {
                  const val = cells[row]?.[col] ?? null;
                  const ratio = val !== null ? (val - min) / range : null;
                  return (
                    <td
                      key={col}
                      className={cn(
                        "border p-1 text-center whitespace-nowrap tabular-nums",
                        ratio !== null
                          ? heatColorClass(ratio)
                          : "bg-muted text-muted-foreground",
                      )}
                      title={
                        val !== null
                          ? `${row} / ${col}: ${val.toFixed(4)}`
                          : "No data"
                      }
                    >
                      {val !== null ? val.toFixed(2) : "—"}
                    </td>
                  );
                })}
                <td
                  className={cn(
                    "border p-1 text-center font-semibold whitespace-nowrap tabular-nums",
                    avgRatio !== null
                      ? heatColorClass(avgRatio)
                      : "bg-muted text-muted-foreground",
                  )}
                  title={
                    avg !== null ? `Row avg: ${avg.toFixed(4)}` : "No data"
                  }
                >
                  {avg !== null ? avg.toFixed(2) : "—"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
