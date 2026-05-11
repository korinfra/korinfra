/**
 * TrendChart — ASCII line chart for cost trend + linear regression forecast.
 *
 * Renders actual daily cost points as a step/line chart and overlays a
 * projected trend line derived from linear regression of the same data.
 *
 * Layout:
 *   - Y-axis: left column showing cost scale labels
 *   - X-axis: bottom row showing date labels
 *   - Chart body: fixed height, variable width (fills available terminal width)
 *   - Legend: "Actual costs  Projected trend"
 *   - Forecast text: "Projected cost on <date>: $X (↑/↓ N% vs current)"
 *
 * VRHYTHM_RULE: spacing from src/cli/ui/spacing.ts only.
 * DOT_SEP_RULE: DOT_SEP from src/cli/ui/text.js.
 */

import React from 'react';
import { Box, Text, useStdout } from 'ink';

import { colors, supportsUnicode } from '../theme.js';
import { GAP_BETWEEN_SECTIONS } from '../ui/spacing.js';
import { DOT_SEP } from '../ui/text.js';
import { formatMoneyExact, formatMoney } from '../ui/format.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CostDataPoint {
  /** ISO date string, e.g. "2025-04-01" */
  date: string;
  /** Cost in USD */
  amount: number;
}

interface TrendChartProps {
  data: CostDataPoint[];
  /** Number of days to project forward for the trend line. Default: 30. */
  forecastDays?: number;
}

// ─── Linear regression ────────────────────────────────────────────────────────

interface RegressionResult {
  slope: number;
  intercept: number;
}

/**
 * Simple OLS linear regression: y = slope * x + intercept.
 * x = index (0-based), y = cost amount.
 */
function linearRegression(values: number[]): RegressionResult {
  const n = values.length;
  if (n < 2) return { slope: 0, intercept: values[0] ?? 0 };

  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;

  for (let i = 0; i < n; i++) {
    const vi = values[i] ?? 0;
    sumX += i;
    sumY += vi;
    sumXY += i * vi;
    sumXX += i * i;
  }

  const meanX = sumX / n;
  const meanY = sumY / n;
  const denom = sumXX - n * meanX * meanX;
  const slope = denom === 0 ? 0 : (sumXY - n * meanX * meanY) / denom;
  const intercept = meanY - slope * meanX;

  return { slope, intercept };
}

// ─── Chart rendering ──────────────────────────────────────────────────────────

/** Chart height in terminal rows (body only, not legend/forecast). */
const CHART_HEIGHT = 8;
/** Y-axis label width. */
const Y_LABEL_W = 10;
/** Minimum chart body width. */
const MIN_CHART_W = 20;

const ACTUAL_CHAR = supportsUnicode ? '▪' : '#';
const TREND_CHAR = supportsUnicode ? '·' : '.';
const EMPTY_CHAR = ' ';

export function TrendChart({ data, forecastDays = 30 }: TrendChartProps): React.JSX.Element {
  const { stdout } = useStdout();
  const termWidth = stdout?.columns ?? 80;

  // Need at least 2 data points to draw anything meaningful
  if (data.length < 2) {
    return (
      <Box>
        <Text dimColor>Not enough daily cost data for trend analysis (need at least 2 days).</Text>
      </Box>
    );
  }

  const amounts = data.map((d) => d.amount);
  const { slope, intercept } = linearRegression(amounts);

  // Build projected points past the actual data
  const lastActualIdx = amounts.length - 1;
  const projectedAmounts: number[] = [];
  for (let i = 1; i <= forecastDays; i++) {
    const projected = intercept + slope * (lastActualIdx + i);
    projectedAmounts.push(Math.max(0, projected));
  }

  const allAmounts = [...amounts, ...projectedAmounts];
  const maxVal = Math.max(...allAmounts, 1);
  const minVal = Math.min(...allAmounts.filter((v) => v > 0), 0);

  // Chart body width = terminal width - Y-axis label width - 2 (border/gap)
  const chartW = Math.max(MIN_CHART_W, termWidth - Y_LABEL_W - 4);
  const totalPoints = amounts.length + projectedAmounts.length;

  // Sample points to fit chart width (compress if needed)
  function samplePoint(colIdx: number): { actual: number | null; projected: number | null } {
    const ratio = colIdx / (chartW - 1);
    const dataIdx = Math.floor(ratio * (totalPoints - 1));

    if (dataIdx < amounts.length) {
      return { actual: amounts[dataIdx] ?? null, projected: null };
    }
    return { actual: null, projected: projectedAmounts[dataIdx - amounts.length] ?? null };
  }

  // Map a value to a row index (0 = top, CHART_HEIGHT-1 = bottom)
  function valueToRow(val: number): number {
    const range = maxVal - minVal;
    if (range === 0) return Math.floor(CHART_HEIGHT / 2);
    const normalized = (val - minVal) / range;
    return Math.floor((1 - normalized) * (CHART_HEIGHT - 1));
  }

  // Build grid: rows × cols
  type CellType = 'actual' | 'trend' | 'empty';
  const grid: CellType[][] = Array.from({ length: CHART_HEIGHT }, () =>
    Array.from({ length: chartW }, () => 'empty'),
  );

  for (let col = 0; col < chartW; col++) {
    const { actual, projected } = samplePoint(col);
    if (actual !== null && actual > 0) {
      const row = valueToRow(actual);
      if (row >= 0 && row < CHART_HEIGHT) {
        const gridRow = grid[row];
        if (gridRow) gridRow[col] = 'actual';
      }
    } else if (projected !== null && projected > 0) {
      const row = valueToRow(projected);
      if (row >= 0 && row < CHART_HEIGHT) {
        const gridRow = grid[row];
        if (gridRow) gridRow[col] = 'trend';
      }
    }
  }

  // Y-axis labels: top, middle, bottom
  const yTop = formatMoney(maxVal);
  const yMid = formatMoney((maxVal + minVal) / 2);
  const yBot = formatMoney(minVal > 0 ? minVal : 0);

  // Forecast target date: today + forecastDays
  const forecastDate = new Date();
  forecastDate.setDate(forecastDate.getDate() + forecastDays);
  const forecastDateStr = forecastDate.toISOString().slice(0, 10);

  // Projected value at forecastDays ahead
  const lastProjected = projectedAmounts[projectedAmounts.length - 1] ?? 0;
  const lastActual = amounts[amounts.length - 1] ?? 0;
  const pctChange = lastActual > 0 ? ((lastProjected - lastActual) / lastActual) * 100 : 0;
  const trendDir = pctChange > 1 ? '↑' : pctChange < -1 ? '↓' : '→';
  const trendColor = pctChange > 1 ? colors.error : pctChange < -1 ? colors.success : colors.warning;

  return (
    <Box flexDirection="column">
      {/* Chart rows */}
      {grid.map((row, rowIdx) => {
        const isTop = rowIdx === 0;
        const isMid = rowIdx === Math.floor(CHART_HEIGHT / 2);
        const isBot = rowIdx === CHART_HEIGHT - 1;
        const yLabel = isTop ? yTop : isMid ? yMid : isBot ? yBot : '';

        return (
          <Box key={`row-${rowIdx}`}>
            {/* Y-axis label */}
            <Text dimColor>{yLabel.padEnd(Y_LABEL_W)}</Text>
            {/* Chart cells */}
            <Text>
              {row.map((cell, colIdx) => {
                if (cell === 'actual') return ACTUAL_CHAR;
                if (cell === 'trend') return TREND_CHAR;
                // Draw axis line on bottom row
                if (rowIdx === CHART_HEIGHT - 1) return supportsUnicode ? '─' : '-';
                if (colIdx === 0) return supportsUnicode ? '│' : '|';
                return EMPTY_CHAR;
              }).join('')}
            </Text>
          </Box>
        );
      })}

      {/* X-axis label */}
      <Box>
        <Text>{' '.repeat(Y_LABEL_W)}</Text>
        <Text dimColor>
          {data[0]?.date ?? ''}{' '.repeat(Math.max(0, chartW - (data[0]?.date?.length ?? 0) - (data[data.length - 1]?.date?.length ?? 0) - 1))}{data[data.length - 1]?.date ?? ''}
        </Text>
      </Box>

      {/* Legend */}
      <Box marginTop={GAP_BETWEEN_SECTIONS} gap={2}>
        <Text>
          <Text color={colors.brand}>{ACTUAL_CHAR}</Text>
          {' Actual costs'}
        </Text>
        <Text>
          <Text dimColor>{TREND_CHAR}</Text>
          {' Projected trend'}
        </Text>
      </Box>

      {/* Forecast summary */}
      <Box marginTop={GAP_BETWEEN_SECTIONS}>
        <Text dimColor>
          {'Projected cost on '}
          <Text color={colors.brand}>{forecastDateStr}</Text>
          {`: ${formatMoneyExact(lastProjected)}`}
          {DOT_SEP}
          <Text color={trendColor}>{trendDir} {Math.abs(pctChange).toFixed(1)}% vs current</Text>
        </Text>
      </Box>
    </Box>
  );
}
