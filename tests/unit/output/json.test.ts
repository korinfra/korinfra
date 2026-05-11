import { describe, it, expect } from 'vitest';
import { JSONFormatter } from '../../../src/output/json.js';
import type { ScanReport } from '../../../src/output/formatter.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const emptyScanReport: ScanReport = {
  scanId: 'scan-empty-json-001',
  timestamp: '2025-01-15T10:00:00Z',
  resources: [],
  recommendations: [],
  costs: [],
  summary: {
    totalResources: 0,
    totalMonthlyCost: 0,
    potentialSavings: 0,
    recommendationCount: 0,
  },
};

const fullScanReport: ScanReport = {
  scanId: 'scan-2025-001',
  timestamp: '2025-01-15T10:00:00Z',
  resources: [
    {
      id: 'i-0a1b2c3d4e5f',
      type: 'ec2_instance',
      name: 'web-server-prod',
      region: 'us-east-1',
      state: 'running',
      instanceType: 'm5.xlarge',
      monthlyCost: 142.56,
      tags: { Environment: 'production', Team: 'platform' },
    },
    {
      id: 'arn:aws:s3:::my-bucket',
      type: 's3_bucket',
      name: 'my-company-logs',
      region: 'us-east-1',
      state: 'active',
      monthlyCost: 8.32,
    },
  ],
  recommendations: [
    {
      id: 'rec-001',
      resourceId: 'i-0a1b2c3d4e5f',
      type: 'rightsize',
      title: 'Downsize m5.xlarge to m5.large',
      estimatedSavings: 71.28,
      confidence: 0.87,
      impact: 'high',
      risk: 'low',
      status: 'open',
    },
  ],
  costs: [
    {
      serviceName: 'Amazon EC2',
      region: 'us-east-1',
      costDate: '2025-01-01',
      dailyCost: 4.752,
      monthlyCost: 142.56,
      currency: 'USD',
    },
  ],
  summary: {
    totalResources: 2,
    totalMonthlyCost: 150.88,
    potentialSavings: 71.28,
    recommendationCount: 1,
  },
};

// ── JSONFormatter ─────────────────────────────────────────────────────────────

describe('JSONFormatter', () => {
  const fmt = new JSONFormatter();

  it('has correct contentType and fileExtension', () => {
    expect(fmt.contentType).toBe('application/json');
    expect(fmt.fileExtension).toBe('json');
  });

  describe('output is valid JSON', () => {
    it('does not throw when parsing empty report', () => {
      const output = fmt.format(emptyScanReport);
      expect(() => JSON.parse(output)).not.toThrow();
    });

    it('does not throw when parsing full report', () => {
      const output = fmt.format(fullScanReport);
      expect(() => JSON.parse(output)).not.toThrow();
    });
  });

  describe('empty scan report structure', () => {
    it('contains summary object with zero values', () => {
      const parsed = JSON.parse(fmt.format(emptyScanReport));
      expect(parsed.summary).toMatchObject({
        totalResources: 0,
        totalMonthlyCost: 0,
        potentialSavings: 0,
        recommendationCount: 0,
      });
    });
  });

  describe('full scan report — all sections present', () => {
    let parsed: ReturnType<typeof JSON.parse>;
    beforeEach(() => {
      parsed = JSON.parse(fmt.format(fullScanReport));
    });

    it('serializes resources correctly', () => {
      expect(parsed.resources).toHaveLength(2);
      expect(parsed.resources[0].id).toBe('i-0a1b2c3d4e5f');
      expect(parsed.resources[0].monthlyCost).toBe(142.56);
      expect(parsed.resources[0].tags).toEqual({ Environment: 'production', Team: 'platform' });
    });

    it('serializes recommendations correctly', () => {
      expect(parsed.recommendations).toHaveLength(1);
      expect(parsed.recommendations[0].id).toBe('rec-001');
      expect(parsed.recommendations[0].estimatedSavings).toBe(71.28);
      expect(parsed.recommendations[0].confidence).toBe(0.87);
    });

    it('serializes costs correctly', () => {
      expect(parsed.costs).toHaveLength(1);
      expect(parsed.costs[0].serviceName).toBe('Amazon EC2');
      expect(parsed.costs[0].dailyCost).toBe(4.752);
    });

    it('serializes summary correctly', () => {
      expect(parsed.summary.totalResources).toBe(2);
      expect(parsed.summary.totalMonthlyCost).toBe(150.88);
      expect(parsed.summary.potentialSavings).toBe(71.28);
    });
  });

  describe('special characters in values', () => {
    it('preserves unicode characters without corruption', () => {
      const report: ScanReport = {
        ...emptyScanReport,
        scanId: 'scan-unicode-\u00e9\u00e0\u00fc',
        resources: [
          {
            id: 'i-uni',
            type: 'ec2_instance',
            name: 'server-\u4e2d\u6587-\u00e9l\u00e8ve',
            region: 'eu-west-1',
            state: 'running',
            monthlyCost: 10.0,
          },
        ],
        recommendations: [],
        costs: [],
      };
      const output = fmt.format(report);
      const parsed = JSON.parse(output);
      expect(parsed.resources[0].name).toBe('server-\u4e2d\u6587-\u00e9l\u00e8ve');
    });

    it('preserves angle brackets (no HTML escaping)', () => {
      // Standard JSON.stringify does NOT escape < or > in modern Node.js
      // This verifies the formatter does not accidentally apply HTML escaping
      const report: ScanReport = {
        ...emptyScanReport,
        resources: [
          {
            id: 'i-html',
            type: 'ec2_instance',
            name: '<web-server>',
            region: 'us-east-1',
            state: 'running',
            monthlyCost: 0,
          },
        ],
        recommendations: [],
        costs: [],
      };
      const output = fmt.format(report);
      const parsed = JSON.parse(output);
      // The parsed value must be the original string — not HTML-escaped
      expect(parsed.resources[0].name).toBe('<web-server>');
      // And the raw JSON string must not contain \u003c (unicode escape for <)
      // because we want no HTML escaping of angle brackets
      // Note: JSON.stringify in Node.js does NOT produce \u003c by default
      expect(output).not.toContain('\\u003c');
      expect(output).not.toContain('\\u003e');
    });

    it('escapes newlines in values (valid JSON)', () => {
      const report: ScanReport = {
        ...emptyScanReport,
        resources: [
          {
            id: 'i-nl',
            type: 'ec2_instance',
            name: 'line1\nline2',
            region: 'us-east-1',
            state: 'running',
            monthlyCost: 0,
          },
        ],
        recommendations: [],
        costs: [],
      };
      const output = fmt.format(report);
      // Must be valid JSON
      expect(() => JSON.parse(output)).not.toThrow();
      const parsed = JSON.parse(output);
      expect(parsed.resources[0].name).toBe('line1\nline2');
    });

    it('handles double-quotes in values', () => {
      const report: ScanReport = {
        ...emptyScanReport,
        resources: [
          {
            id: 'i-q',
            type: 'ec2_instance',
            name: 'says "hello" world',
            region: 'us-east-1',
            state: 'running',
            monthlyCost: 0,
          },
        ],
        recommendations: [],
        costs: [],
      };
      const output = fmt.format(report);
      expect(() => JSON.parse(output)).not.toThrow();
      expect(JSON.parse(output).resources[0].name).toBe('says "hello" world');
    });
  });

  describe('ARN redaction boundary (2D)', () => {
    // DESIGN BOUNDARY: JSONFormatter does NOT redact ARNs or any sensitive values.
    // Redaction is the caller's responsibility and happens before any LLM call
    // (see src/agent/claude.ts — redact(prompt, 'moderate') at line 83).
    // The JSON output formatter is a faithful serializer: it preserves the raw
    // ScanReport for file export and human inspection, not for LLM consumption.
    // Tests below document and enforce this boundary explicitly.

    it('preserves raw ARN in JSON output (redaction is pre-LLM, not at output layer)', () => {
      const output = fmt.format(fullScanReport);
      const parsed = JSON.parse(output) as { resources: Array<{ id: string }> };

      // The ARN resource ID is present in fullScanReport as 'arn:aws:s3:::my-bucket'
      const arnResource = parsed.resources.find(r => r.id === 'arn:aws:s3:::my-bucket');
      expect(arnResource).toBeDefined();

      // The raw ARN IS present — this is intentional (output layer does not redact)
      expect(output).toContain('arn:aws:s3:::my-bucket');
    });

    it('does not call redactObject or modify any string values in the report', () => {
      // Verify JSONFormatter is a pure serializer by checking a known safe value
      // comes through exactly as provided. If the formatter were to call redactObject
      // at 'moderate' level, ARNs would have their account IDs masked. Since there
      // is no account ID in 'arn:aws:s3:::my-bucket' (the account segment is empty),
      // we also verify the scanId and resource names are untouched.
      const output = fmt.format(fullScanReport);
      expect(output).toContain('"scan-2025-001"');
      expect(output).toContain('"web-server-prod"');
      expect(output).toContain('"my-company-logs"');
    });
  });

  describe('output format', () => {
    it('is pretty-printed (contains newlines and indentation)', () => {
      const output = fmt.format(emptyScanReport);
      expect(output).toContain('\n');
      // pretty-print uses 2-space indentation
      expect(output).toContain('  ');
    });

    it('round-trips: parsed and re-stringified equals original parse', () => {
      const output = fmt.format(fullScanReport);
      const parsed = JSON.parse(output);
      // Re-serialize and re-parse to confirm lossless round-trip
      const reparsed = JSON.parse(JSON.stringify(parsed));
      expect(reparsed.scanId).toBe(fullScanReport.scanId);
      expect(reparsed.resources).toHaveLength(fullScanReport.resources.length);
      expect(reparsed.recommendations).toHaveLength(fullScanReport.recommendations.length);
    });
  });
});
