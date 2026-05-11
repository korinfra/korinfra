import { describe, it, expect } from 'vitest';
import { renderPieChartSVG, renderBarChartSVG, renderSparklineSVG } from '../../../src/output/svg.js';
import type { PieSlice, BarItem } from '../../../src/output/svg.js';

// ── renderPieChartSVG ─────────────────────────────────────────────────────────

describe('renderPieChartSVG', () => {
  const awsBreakdown: PieSlice[] = [
    { label: 'EC2', value: 450 },     // 45%
    { label: 'RDS', value: 250 },     // 25%
    { label: 'S3', value: 150 },      // 15%
    { label: 'Lambda', value: 100 },  // 10%
    { label: 'Other', value: 50 },    //  5%
  ];

  it('renders a valid SVG with correct structure and attributes', () => {
    const svg = renderPieChartSVG(awsBreakdown, 500, 280);
    expect(svg.trimStart()).toMatch(/^<svg /);
    expect(svg.trimEnd()).toMatch(/<\/svg>$/);
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(svg).toContain('width="500"');
    expect(svg).toContain('height="280"');
  });

  it('renders one path per slice and legend labels with percentages', () => {
    const svg = renderPieChartSVG(awsBreakdown, 500, 280);
    const pathCount = (svg.match(/<path /g) ?? []).length;
    expect(pathCount).toBe(5);
    expect(svg).toContain('EC2');
    expect(svg).toContain('RDS');
    expect(svg).toContain('S3');
    expect(svg).toContain('Lambda');
    expect(svg).toContain('45.0%');
    expect(svg).toContain('25.0%');
    expect(svg).toContain('15.0%');
    expect(svg).toContain('10.0%');
    const rectCount = (svg.match(/<rect /g) ?? []).length;
    expect(rectCount).toBeGreaterThanOrEqual(5);
  });

  it('groups slices below 2% into "Other"', () => {
    const data: PieSlice[] = [
      { label: 'EC2', value: 950 },
      { label: 'Tiny', value: 10 },
      { label: 'Also Tiny', value: 5 },
      { label: 'CloudTrail', value: 35 },
    ];
    const svg = renderPieChartSVG(data, 500, 280);
    const pathCount = (svg.match(/<path /g) ?? []).length;
    expect(pathCount).toBe(3);
    expect(svg).toContain('Other');
    expect(svg).not.toContain('Tiny (');
    expect(svg).not.toContain('Also Tiny (');
  });

  it('handles edge cases: empty data, zero total, single slice, custom dimensions', () => {
    expect(renderPieChartSVG([], 500, 280)).toContain('No data');
    expect(renderPieChartSVG([{ label: 'EC2', value: 0 }], 500, 280)).toContain('No cost data');
    const single = renderPieChartSVG([{ label: 'EC2', value: 1000 }], 500, 280);
    expect(single).toContain('<svg');
    expect(single).toContain('</svg>');
    const custom = renderPieChartSVG([{ label: 'EC2', value: 100 }], 800, 400);
    expect(custom).toContain('width="800"');
    expect(custom).toContain('height="400"');
  });
});

// ── renderBarChartSVG ─────────────────────────────────────────────────────────

describe('renderBarChartSVG', () => {
  const resources: BarItem[] = [
    { label: 'i-001/web-prod', value: 142.56 },
    { label: 'db-primary/postgres', value: 215.0 },
    { label: 'cache-001/redis', value: 48.0 },
    { label: 'nat-gateway-1', value: 32.4 },
    { label: 'lambda-api/prod', value: 12.1 },
  ];

  it('renders a valid SVG with bars, labels, and dollar values', () => {
    const svg = renderBarChartSVG(resources, 550, 300);
    expect(svg.trimStart()).toMatch(/^<svg /);
    expect(svg.trimEnd()).toMatch(/<\/svg>$/);
    expect(svg).toContain('width="550"');
    const rects = (svg.match(/<rect /g) ?? []).length;
    expect(rects).toBe(5);
    expect(svg).toContain('i-001/web-prod');
    expect(svg).toContain('db-primary/postgres');
    expect(svg).toContain('$143');
    expect(svg).toContain('$215');
  });

  it('limits to 10 bars even with more data', () => {
    const manyItems: BarItem[] = Array.from({ length: 15 }, (_, i) => ({
      label: `resource-${i}`,
      value: 100 - i,
    }));
    const svg = renderBarChartSVG(manyItems, 550, 300);
    const rects = (svg.match(/<rect /g) ?? []).length;
    expect(rects).toBe(10);
  });

  it('handles edge cases: empty data, all-zero values, single item', () => {
    expect(renderBarChartSVG([], 550, 300)).toContain('No data');
    expect(renderBarChartSVG([{ label: 'EC2', value: 0 }], 550, 300)).toContain('No data');
    const single = renderBarChartSVG([{ label: 'EC2', value: 100 }], 550, 300);
    expect(single).toContain('<rect ');
    expect(single).toContain('$100');
  });
});

// ── renderSparklineSVG ────────────────────────────────────────────────────────

describe('renderSparklineSVG', () => {
  const increasingCosts = [
    80, 82, 85, 83, 88, 90, 91, 89, 92, 95,
    96, 94, 97, 100, 102, 101, 103, 105, 107, 108,
    110, 109, 112, 113, 115, 114, 117, 119, 121, 122,
  ];

  it('renders a valid sparkline SVG with correct structure for increasing trend', () => {
    const svg = renderSparklineSVG(increasingCosts, 300, 80);
    expect(svg.trimStart()).toMatch(/^<svg /);
    expect(svg.trimEnd()).toMatch(/<\/svg>$/);
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(svg).toContain('<polyline ');
    expect(svg).toContain('<circle ');
    expect(svg).toContain('width="300"');
    expect(svg).toContain('height="80"');
    expect(svg).toContain('#008672'); // green for increasing
  });

  it('uses red for decreasing trend, green for flat trend', () => {
    const decreasing = renderSparklineSVG([120, 110, 105, 98, 90, 85, 80, 72, 68, 60], 300, 80);
    expect(decreasing).toContain('#e11d48');
    const flat = renderSparklineSVG([100, 100, 100, 100, 100], 300, 80);
    expect(flat).toContain('#008672');
  });

  it('inverts color semantics when direction is up-bad (cost plots)', () => {
    const risingCost = renderSparklineSVG(increasingCosts, 300, 80, 'up-bad');
    expect(risingCost).toContain('#e11d48'); // rising cost = red
    const fallingCost = renderSparklineSVG([100, 90, 80, 70, 60], 300, 80, 'up-bad');
    expect(fallingCost).toContain('#008672'); // falling cost = green
  });

  it('handles edge cases: empty, single point, two points, all-same values, custom dimensions', () => {
    const empty = renderSparklineSVG([], 300, 80);
    expect(empty).toContain('<svg');
    expect(empty).not.toContain('<polyline');

    const single = renderSparklineSVG([100], 300, 80);
    expect(single).toContain('<svg');
    expect(single).not.toContain('<polyline');

    const two = renderSparklineSVG([50, 75], 300, 80);
    expect(two).toContain('<polyline ');
    expect(two).toContain('<circle ');

    expect(() => renderSparklineSVG([50, 50, 50, 50, 50], 300, 80)).not.toThrow();
    const flatData = renderSparklineSVG([50, 50, 50, 50, 50], 300, 80);
    expect(flatData).toContain('<polyline ');

    const custom = renderSparklineSVG([10, 20, 15], 400, 100);
    expect(custom).toContain('width="400"');
    expect(custom).toContain('height="100"');
  });
});
