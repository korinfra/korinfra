import { describe, it, expect } from 'vitest';
import { CSVFormatter, csvEscape, csvRow, formatTags } from '../../../src/output/csv.js';
import type { ScanReport } from '../../../src/output/formatter.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const emptyScanReport: ScanReport = {
  scanId: 'scan-empty-001',
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
      tags: { Environment: 'production', Team: 'platform', Project: 'korinfra' },
    },
    {
      id: 'db-abc123',
      type: 'rds_instance',
      name: 'postgres-primary',
      region: 'us-east-1',
      state: 'available',
      instanceType: 'db.r5.large',
      monthlyCost: 215.0,
      tags: { Environment: 'production', Team: 'data' },
    },
    {
      id: 'my-company-logs',
      type: 's3_bucket',
      name: 'company-logs-archive',
      region: 'us-east-1',
      state: 'active',
      monthlyCost: 8.32,
      tags: {},
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
    {
      id: 'rec-002',
      resourceId: 'db-abc123',
      type: 'reserved_instance',
      title: 'Purchase 1yr Reserved Instance for postgres-primary',
      estimatedSavings: 64.5,
      confidence: 0.92,
      impact: 'medium',
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
    {
      serviceName: 'Amazon RDS',
      region: 'us-east-1',
      costDate: '2025-01-01',
      dailyCost: 7.167,
      monthlyCost: 215.0,
      currency: 'USD',
    },
  ],
  summary: {
    totalResources: 3,
    totalMonthlyCost: 365.88,
    potentialSavings: 135.78,
    recommendationCount: 2,
  },
};

// ── csvEscape — RFC 4180 compliance ──────────────────────────────────────────

describe('csvEscape', () => {
  it('handles all RFC 4180 escaping cases', () => {
    expect(csvEscape('hello')).toBe('hello');
    expect(csvEscape('i-0a1b2c3d4e5f')).toBe('i-0a1b2c3d4e5f');
    expect(csvEscape('')).toBe('');
    expect(csvEscape('EC2, RDS')).toBe('"EC2, RDS"');
    expect(csvEscape('say "hello"')).toBe('"say ""hello"""');
    expect(csvEscape('"a","b"')).toBe('"""a"",""b"""');
    expect(csvEscape('line1\nline2')).toBe('"line1\nline2"');
    expect(csvEscape('line1\rline2')).toBe('"line1\rline2"');
  });
});

// ── csvEscape — formula injection prevention (2C) ─────────────────────────────
// The escape() function prefixes any cell starting with =, +, -, @, \t, or \r
// with a leading apostrophe to prevent spreadsheet formula execution.
// Mutation check: remove the if-block at lines ~138-140 of src/output/csv.ts and
// these assertions will fail because the raw dangerous string would be returned.

describe('csvEscape — formula injection prevention', () => {
  it("prefixes '=' formula with apostrophe", () => {
    expect(csvEscape('=SUM(A1)')).toBe("'=SUM(A1)");
  });

  it("prefixes '+' formula with apostrophe", () => {
    expect(csvEscape("+cmd|' /C calc'!A0")).toBe("'+cmd|' /C calc'!A0");
  });

  it("prefixes '-' formula with apostrophe", () => {
    expect(csvEscape('-2+3+cmd')).toBe("'-2+3+cmd");
  });

  it("prefixes '@' formula with apostrophe", () => {
    expect(csvEscape('@SUM(A1)')).toBe("'@SUM(A1)");
  });

  it("prefixes tab-starting value with apostrophe", () => {
    expect(csvEscape('\t=EXEC')).toBe("'\t=EXEC");
  });

  it("prefixes carriage-return-starting value with apostrophe then RFC 4180 quotes it", () => {
    // '\r=EXEC' starts with \r so the apostrophe prefix is added → "'\r=EXEC".
    // That string then contains \r, so RFC 4180 quoting wraps the whole field
    // in double-quotes: `"'\r=EXEC"`.
    // The key security property: the raw \r=EXEC formula is NOT executed as-is;
    // the apostrophe prefix neutralises the formula character.
    const result = csvEscape('\r=EXEC');
    expect(result.startsWith("\"'")).toBe(true); // apostrophe prefix is present
    expect(result).not.toBe('\r=EXEC');           // raw formula not passed through
  });

  it('does not prefix safe values', () => {
    expect(csvEscape('normal text')).toBe('normal text');
    expect(csvEscape('100.00')).toBe('100.00');
    expect(csvEscape('')).toBe('');
  });
});

// ── csvRow ────────────────────────────────────────────────────────────────────

describe('csvRow', () => {
  it('joins and escapes fields correctly', () => {
    expect(csvRow(['ID', 'Type', 'Name'])).toBe('ID,Type,Name');
    expect(csvRow(['only'])).toBe('only');
    expect(csvRow(['normal', 'has,comma', 'has "quote"'])).toBe('normal,"has,comma","has ""quote"""');
  });
});

// ── formatTags ────────────────────────────────────────────────────────────────

describe('formatTags', () => {
  it('formats tags with proper delimiters and escaping', () => {
    expect(formatTags(undefined)).toBe('');
    expect(formatTags({})).toBe('');
    expect(formatTags({ Environment: 'production' })).toBe('Environment=production');
    expect(formatTags({ Environment: 'production', Team: 'platform' })).toBe('Environment=production; Team=platform');
    expect(formatTags({ 'key=with=equals': 'value' })).toBe('key_with_equals=value');
    expect(formatTags({ 'key;with;semi': 'value' })).toBe('key_with_semi=value');
    expect(formatTags({ key: 'a;b;c' })).toBe('key=a,b,c');
    expect(formatTags({ key: 'say "hello"' })).toBe('key=say ""hello""');
  });
});

// ── CSVFormatter ──────────────────────────────────────────────────────────────

describe('CSVFormatter', () => {
  const fmt = new CSVFormatter();

  it('has correct contentType and fileExtension', () => {
    expect(fmt.contentType).toBe('text/csv');
    expect(fmt.fileExtension).toBe('csv');
  });

  it('formats empty scan with summary metadata and no section headers', () => {
    const output = fmt.format(emptyScanReport);
    expect(output).toContain('scan_id,scan-empty-001');
    expect(output).toContain('timestamp,2025-01-15T10:00:00Z');
    expect(output).toContain('total_resources,0');
    expect(output).toContain('total_monthly_cost,0.00');
    expect(output).toContain('potential_savings,0.00');
    expect(output).toContain('recommendation_count,0');
    const lines = output.split('\n');
    expect(lines.some(l => l.startsWith('ID,Type,Name,Region'))).toBe(false);
    expect(lines.some(l => l.startsWith('ID,Resource ID,Type,Title'))).toBe(false);
    expect(lines.some(l => l.startsWith('Service,Region,Date'))).toBe(false);
  });

  it('formats resources section with correct headers and row data', () => {
    const lines = fmt.format(fullScanReport).split('\n');
    expect(lines).toContain('ID,Type,Name,Region,State,Instance Type,Monthly Cost (USD),Tags');

    const ec2Row = lines.find(l => l.includes('i-0a1b2c3d4e5f'))!;
    expect(ec2Row).toContain('ec2_instance');
    expect(ec2Row).toContain('web-server-prod');
    expect(ec2Row).toContain('us-east-1');
    expect(ec2Row).toContain('running');
    expect(ec2Row).toContain('m5.xlarge');
    expect(ec2Row).toContain('142.56');
    expect(ec2Row).toContain('Environment=production');
    expect(ec2Row).toContain('Team=platform');

    const rdsRow = lines.find(l => l.includes('db-abc123'))!;
    expect(rdsRow).toContain('rds_instance');
    expect(rdsRow).toContain('215.00');

    const s3Row = lines.find(l => l.includes('my-company-logs'))!;
    expect(s3Row).toContain('s3_bucket');
    expect(s3Row).toContain('8.32');
  });

  it('formats recommendations and costs sections correctly', () => {
    const lines = fmt.format(fullScanReport).split('\n');

    expect(lines).toContain('ID,Resource ID,Type,Title,Savings,Confidence,Impact,Risk,Status,Scenario');
    const rec1 = lines.find(l => l.includes('rec-001'))!;
    expect(rec1).toContain('87%');
    expect(rec1).toContain('71.28');
    expect(rec1).toContain('rightsize');
    expect(rec1).toContain('open');

    expect(lines).toContain('Service,Region,Date,Daily Cost,Monthly Cost,Currency');
    const ec2Cost = lines.find(l => l.includes('Amazon EC2'))!;
    expect(ec2Cost).toContain('4.7520');
    expect(ec2Cost).toContain('142.56');
    expect(ec2Cost).toContain('USD');
  });

  it('RFC 4180: quotes service names with commas, doubles quotes in resource names', () => {
    const commaReport: ScanReport = {
      ...fullScanReport,
      costs: [{
        serviceName: 'EC2, Auto Scaling',
        region: 'us-east-1',
        costDate: '2025-01-01',
        dailyCost: 1.0,
        monthlyCost: 30.0,
        currency: 'USD',
      }],
      resources: [],
      recommendations: [],
    };
    expect(fmt.format(commaReport)).toContain('"EC2, Auto Scaling"');

    const quoteReport: ScanReport = {
      ...fullScanReport,
      resources: [{
        id: 'i-test',
        type: 'ec2_instance',
        name: 'instance "primary"',
        region: 'us-east-1',
        state: 'running',
        monthlyCost: 50.0,
      }],
      recommendations: [],
      costs: [],
    };
    expect(fmt.format(quoteReport)).toContain('"instance ""primary"""');
  });

  it('outputs sections in order: summary, resources, recommendations, costs', () => {
    const output = fmt.format(fullScanReport);
    const scanIdPos = output.indexOf('scan_id');
    const resourceHeaderPos = output.indexOf('ID,Type,Name,Region');
    const recHeaderPos = output.indexOf('ID,Resource ID,Type,Title');
    const costHeaderPos = output.indexOf('Service,Region,Date');
    expect(scanIdPos).toBeLessThan(resourceHeaderPos);
    expect(resourceHeaderPos).toBeLessThan(recHeaderPos);
    expect(recHeaderPos).toBeLessThan(costHeaderPos);
  });
});
