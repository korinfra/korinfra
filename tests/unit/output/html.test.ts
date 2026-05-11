import { describe, it, expect } from 'vitest';
import { HTMLFormatter } from '../../../src/output/html.js';
import type { ScanReport } from '../../../src/output/formatter.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const emptyScanReport: ScanReport = {
  scanId: 'scan-html-empty',
  timestamp: '2025-01-15T10:00:00.000Z',
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
  scanId: 'scan-html-2025-001',
  timestamp: '2025-01-15T10:00:00.000Z',
  resources: [
    {
      id: 'i-0a1b2c3d4e5f',
      type: 'ec2_instance',
      name: 'web-server-prod',
      region: 'us-east-1',
      state: 'running',
      instanceType: 'm5.xlarge',
      monthlyCost: 142.56,
      tags: { Environment: 'production' },
    },
    {
      id: 'db-abc123',
      type: 'rds_instance',
      name: 'postgres-primary',
      region: 'us-west-2',
      state: 'available',
      instanceType: 'db.r5.large',
      monthlyCost: 215.0,
      tags: {},
    },
    {
      id: 'my-bucket',
      type: 's3_bucket',
      name: 'company-logs-archive',
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
    {
      id: 'rec-002',
      resourceId: 'db-abc123',
      type: 'reserved_instance',
      title: 'Convert postgres-primary to Reserved Instance',
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
      costDate: '2025-01-02',
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

// ── HTMLFormatter ─────────────────────────────────────────────────────────────

describe('HTMLFormatter', () => {
  const fmt = new HTMLFormatter();

  it('has correct contentType and fileExtension', () => {
    expect(fmt.contentType).toBe('text/html');
    expect(fmt.fileExtension).toBe('html');
  });

  it('produces a valid HTML document structure', () => {
    const output = fmt.format(emptyScanReport);
    expect(output.trimStart()).toMatch(/^<!DOCTYPE html>/i);
    expect(output).toContain('<html lang="en">');
    expect(output).toContain('<head>');
    expect(output).toContain('<meta charset="UTF-8">');
    expect(output).toContain('name="viewport"');
    expect(output).toContain('<title>');
    expect(output).toContain('scan-html-empty');
    expect(output).toContain('<style>');
    expect(output).toContain('</style>');
    expect(output).toContain('<body>');
    expect(output).toContain('</body>');
    expect(output).toContain('</html>');
  });

  it('escapes XSS payloads in resource names, recommendation titles, and cost service names', () => {
    const scriptReport: ScanReport = {
      ...emptyScanReport,
      resources: [{
        id: 'i-xss',
        type: 'ec2_instance',
        name: "<script>alert('xss')</script>",
        region: 'us-east-1',
        state: 'running',
        monthlyCost: 0,
      }],
      recommendations: [{
        id: 'rec-xss',
        resourceId: 'i-xss',
        type: 'idle',
        title: "<script>alert('xss')</script>",
        estimatedSavings: 0,
        confidence: 1,
        impact: 'high',
        risk: 'low',
        status: 'open',
      }],
      costs: [],
    };
    const out1 = fmt.format(scriptReport);
    // Ensure <script> tags are escaped in the embedded JSON to prevent context breakout
    expect(out1).not.toContain('<script>alert');
    expect(out1).toContain('&lt;script&gt;');
    expect(out1).toContain('&lt;');
    expect(out1).toContain('&gt;');

    // img onerror in cost service name
    const imgReport: ScanReport = {
      ...emptyScanReport,
      resources: [],
      recommendations: [],
      costs: [{
        serviceName: '<img src=x onerror=alert(1)>',
        region: 'us-east-1',
        costDate: '2025-01-01',
        dailyCost: 1.0,
        monthlyCost: 30.0,
        currency: 'USD',
      }],
    };
    const imgOut = fmt.format(imgReport);
    expect(imgOut).toContain('&lt;img src=x onerror=alert(1)&gt;');

    // ampersand in resource name
    const ampReport: ScanReport = {
      ...emptyScanReport,
      resources: [{
        id: 'i-amp',
        type: 'ec2_instance',
        name: 'prod & staging',
        region: 'us-east-1',
        state: 'running',
        monthlyCost: 0,
      }],
      recommendations: [],
      costs: [],
    };
    const ampOut = fmt.format(ampReport);
    expect(ampOut).toContain('&amp;');

    // double-quotes in resource name
    const quotReport: ScanReport = {
      ...emptyScanReport,
      resources: [{
        id: 'i-quot',
        type: 'ec2_instance',
        name: 'server "primary"',
        region: 'us-east-1',
        state: 'running',
        monthlyCost: 0,
      }],
      recommendations: [],
      costs: [],
    };
    expect(fmt.format(quotReport)).toContain('&quot;');

    // single-quotes in scan ID
    const apostropheReport: ScanReport = { ...emptyScanReport, scanId: "scan-it's-mine" };
    expect(fmt.format(apostropheReport)).toContain('&#39;');
  });

  it('renders summary section with correct values', () => {
    const output = fmt.format(fullScanReport);
    expect(output).toContain('$365.88');
    expect(output).toContain('$135.78');
    expect(output).toContain('>3<');
    expect(output).toContain('>2<');
  });

  it('renders resources table with headers and all resource rows', () => {
    const output = fmt.format(fullScanReport);
    expect(output).toContain('Resources <span class="tab-btn-badge">3</span>');
    expect(output).toContain('<th onclick="onResourcesSort(\'id\')"');
    expect(output).toContain('<th onclick="onResourcesSort(\'type\')"');
    expect(output).toContain('<th onclick="onResourcesSort(\'name\')"');
    expect(output).toContain('<th onclick="onResourcesSort(\'region\')"');
    expect(output).toContain('<th onclick="onResourcesSort(\'state\')"');
    expect(output).toContain('<th onclick="onResourcesSort(\'monthlyCost\')"');
    // Resource data is embedded in JSON, verify all resources are present
    expect(output).toContain('i-0a1b2c3d4e5f');
    expect(output).toContain('web-server-prod');
    expect(output).toContain('ec2_instance');
    expect(output).toContain('running');
    expect(output).toContain('"monthlyCost":142.56');
    expect(output).toContain('db-abc123');
    expect(output).toContain('postgres-primary');
    expect(output).toContain('"monthlyCost":215');
    expect(output).toContain('my-bucket');
    expect(output).toContain('"monthlyCost":8.32');
  });

  it('renders recommendations table with headers, savings, confidence, and badges', () => {
    const output = fmt.format(fullScanReport);
    expect(output).toContain('Recommendations <span class="tab-btn-badge">2</span>');
    expect(output).toContain('<th onclick="onRecommendationsSort(\'title\')"');
    expect(output).toContain('<th onclick="onRecommendationsSort(\'estimatedSavings\')"');
    expect(output).toContain('<th onclick="onRecommendationsSort(\'confidence\')"');
    expect(output).toContain('<th onclick="onRecommendationsSort(\'impact\')"');
    expect(output).toContain('<th onclick="onRecommendationsSort(\'risk\')"');
    expect(output).toContain('Downsize m5.xlarge to m5.large');
    expect(output).toContain('$71.28');
    expect(output).toContain('87');
    expect(output).toContain('badge-high');
    expect(output).toContain('badge-low');
  });

  it('renders costs section with heading, service names, regions, and daily costs', () => {
    const output = fmt.format(fullScanReport);
    expect(output).toContain('Cost Breakdown by Service');
    expect(output).toContain('Amazon EC2');
    expect(output).toContain('Amazon RDS');
    expect(output).toContain('us-east-1');
    expect(output).toContain('$142.56');
    expect(output).toContain('$215.00');
  });

  it('omits resource, recommendation, and cost tables when sections are empty', () => {
    const output = fmt.format(emptyScanReport);
    expect(output).not.toContain('Resource Inventory');
    expect(output).not.toContain('Cost Breakdown by Service');
  });
});
