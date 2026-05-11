/**
 * Pure-TypeScript SVG chart generators.
 * No external libraries. All output is valid SVG that renders offline.
 * Color palette is accessible (color-blind friendly, prints well in grayscale).
 */

import { escapeXml, truncateStr } from './formatter.js';

export interface PieSlice {
  label: string;
  value: number;
  color?: string;
}

export interface BarItem {
  label: string;
  value: number;
}

// Accessible color palette — matches Go version
const PALETTE = [
  '#0075ca', '#e4e669', '#7057ff', '#008672',
  '#e11d48', '#f97316', '#06b6d4', '#84cc16',
  '#a855f7', '#ec4899',
];

function colorFor(i: number): string {
  return PALETTE[i % PALETTE.length] as string;
}


function emptySVG(width: number, height: number, msg: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
    `<text x="50%" y="50%" text-anchor="middle" font-family="Arial,sans-serif" font-size="12" fill="#999">${msg}</text>` +
    `</svg>`;
}

/**
 * Renders a pie chart as an inline SVG string.
 * Slices that are less than 2% of total are grouped as "Other".
 */
export function renderPieChartSVG(
  data: PieSlice[],
  width = 500,
  height = 280,
): string {
  if (data.length === 0) return emptySVG(width, height, 'No data');

  const total = data.reduce((s, d) => s + d.value, 0);
  if (total === 0) return emptySVG(width, height, 'No cost data');

  // Group slices < 2% into "Other"
  const items: PieSlice[] = [];
  let other = 0;
  for (const d of data) {
    if (d.value / total < 0.02) {
      other += d.value;
    } else {
      items.push(d);
    }
  }
  if (other > 0) items.push({ label: 'Other', value: other });

  const cx = width / 2;
  const cy = height / 2;
  const r = Math.min(cx, cy) * 0.65;

  const parts: string[] = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid meet">`);
  parts.push(`<style>text{font-family:Arial,sans-serif;font-size:11px;fill:var(--c-800,#333);}</style>`);

  let startAngle = -Math.PI / 2;

  for (let i = 0; i < items.length; i++) {
    const item = items[i] as PieSlice;
    const frac = item.value / total;
    const endAngle = startAngle + frac * 2 * Math.PI;

    const x1 = cx + r * Math.cos(startAngle);
    const y1 = cy + r * Math.sin(startAngle);
    const x2 = cx + r * Math.cos(endAngle);
    const y2 = cy + r * Math.sin(endAngle);

    const largeArc = endAngle - startAngle > Math.PI ? 1 : 0;
    const color = item.color ?? colorFor(i);

    parts.push(
      `<path d="M${cx.toFixed(2)},${cy.toFixed(2)} L${x1.toFixed(2)},${y1.toFixed(2)} ` +
      `A${r.toFixed(2)},${r.toFixed(2)} 0 ${largeArc},1 ${x2.toFixed(2)},${y2.toFixed(2)} Z" ` +
      `fill="${color}" stroke="#fff" stroke-width="1.5"/>`,
    );

    startAngle = endAngle;
  }

  // Legend — right side
  const legendX = width * 0.67 + 5;
  const legendY = cy - items.length * 9;
  for (let i = 0; i < items.length; i++) {
    const item = items[i] as PieSlice;
    const ly = legendY + i * 20;
    const color = item.color ?? colorFor(i);
    const label = truncateStr(item.label, 18);
    const pct = (item.value / total * 100).toFixed(1);
    parts.push(`<rect x="${legendX.toFixed(0)}" y="${ly.toFixed(0)}" width="12" height="12" fill="${color}"/>`);
    parts.push(`<text x="${(legendX + 16).toFixed(0)}" y="${(ly + 10).toFixed(0)}">${escapeXml(label)} (${escapeXml(pct)}%)</text>`);
  }

  parts.push(`</svg>`);
  return parts.join('');
}

/**
 * Renders a horizontal bar chart as an inline SVG string.
 * Limited to top 10 items.
 */
export function renderBarChartSVG(
  data: BarItem[],
  width = 550,
  height = 300,
): string {
  if (data.length === 0) return emptySVG(width, height, 'No data');

  const maxVal = Math.max(...data.map(d => d.value));
  if (maxVal === 0) return emptySVG(width, height, 'No data');

  const items = data.slice(0, 10);

  const marginLeft = 160;
  const marginRight = 100;
  const marginTop = 20;
  const barHeight = 22;
  const barGap = 6;
  const totalBarsHeight = items.length * (barHeight + barGap);
  const svgHeight = totalBarsHeight + marginTop + 20;
  const chartWidth = Math.max(50, width - marginLeft - marginRight);

  const parts: string[] = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${svgHeight}" viewBox="0 0 ${width} ${svgHeight}" preserveAspectRatio="xMidYMid meet">`);
  parts.push(`<style>text{font-family:Arial,sans-serif;font-size:11px;fill:var(--c-800,#333);}</style>`);

  for (let i = 0; i < items.length; i++) {
    const item = items[i] as BarItem;
    const y = marginTop + i * (barHeight + barGap);
    const barWidth = Math.max(2, Math.round(chartWidth * item.value / maxVal));
    const color = colorFor(i);
    const label = truncateStr(item.label, 22);

    // Left label
    parts.push(`<text x="${marginLeft - 6}" y="${y + barHeight - 6}" text-anchor="end">${escapeXml(label)}</text>`);
    // Bar
    parts.push(`<rect x="${marginLeft}" y="${y}" width="${barWidth}" height="${barHeight}" fill="${color}" rx="2"/>`);
    // Value label right of bar
    parts.push(`<text x="${marginLeft + barWidth + 4}" y="${y + barHeight - 6}">$${escapeXml(item.value.toFixed(0))}</text>`);
  }

  parts.push(`</svg>`);
  return parts.join('');
}

/**
 * Direction semantics for a sparkline trend.
 * - 'up-good': rising values are positive (e.g. revenue, usage) → green when up
 * - 'up-bad':  rising values are negative (e.g. cost, errors)   → red when up
 */
type SparklineDirection = 'up-good' | 'up-bad';

/**
 * Renders a sparkline line chart as an inline SVG string.
 * Color reflects whether the trend direction is desirable — callers plotting
 * cost must pass `direction: 'up-bad'` so rising cost renders red.
 */
export function renderSparklineSVG(
  data: number[],
  width = 300,
  height = 80,
  direction: SparklineDirection = 'up-good',
): string {
  if (data.length < 2) return emptySVG(width, height, '');

  const minVal = Math.min(...data);
  const maxVal = Math.max(...data);
  const valRange = maxVal === minVal ? 1 : maxVal - minVal;

  const pad = 8;
  const chartW = width - 2 * pad;
  const chartH = height - 2 * pad;
  const n = data.length;

  const toX = (i: number): number => pad + (i * chartW) / (n - 1);
  const toY = (v: number): number => pad + chartH * (1 - (v - minVal) / valRange);

  const pointsStr = data
    .map((p, i) => `${toX(i).toFixed(1)},${toY(p).toFixed(1)}`)
    .join(' ');

  const GOOD = '#008672';
  const BAD = '#e11d48';
  const isUp = (data[data.length - 1] as number) >= (data[0] as number);
  const trendColor = direction === 'up-good'
    ? (isUp ? GOOD : BAD)
    : (isUp ? BAD : GOOD);

  const lastX = toX(n - 1);
  const lastY = toY(data[n - 1] as number);

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid meet">`,
    `<polyline points="${pointsStr}" fill="none" stroke="${trendColor}" stroke-width="2" stroke-linejoin="round"/>`,
    `<circle cx="${lastX.toFixed(1)}" cy="${lastY.toFixed(1)}" r="3" fill="${trendColor}"/>`,
    `</svg>`,
  ].join('');
}
