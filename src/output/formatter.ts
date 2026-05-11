import { JSONFormatter } from './json.js';
import { CSVFormatter } from './csv.js';
import { HTMLFormatter } from './html.js';

export type OutputFormat = 'json' | 'csv' | 'html';

export interface ScanReport {
  scanId: string;
  timestamp: string;
  resources: ResourceEntry[];
  recommendations: RecommendationEntry[];
  costs: CostEntry[];
  summary: {
    totalResources: number;
    totalMonthlyCost: number;
    potentialSavings: number;
    recommendationCount: number;
  };
}

export interface ResourceEntry {
  id: string;
  type: string;
  name: string;
  region: string;
  state: string;
  instanceType?: string;
  monthlyCost: number;
  monthlyCostSource?: 'cost_explorer' | 'pricing_api' | null;
  tags?: Record<string, string>;
}

export interface RecommendationEntry {
  id: string;
  resourceId: string;
  type: string;
  title: string;
  description?: string;
  estimatedSavings: number;
  /** 0.0–1.0 */
  confidence: number;
  impact: string;
  risk: string;
  status: string;
  scenario?: string | null;
  implementationSteps?: string[] | null;
}

export interface CostEntry {
  serviceName: string;
  region: string;
  /** ISO date string, e.g. "2025-01-15" */
  costDate: string;
  dailyCost: number;
  monthlyCost: number;
  currency: string;
}

export interface Formatter {
  format(data: ScanReport): string;
  contentType: string;
  fileExtension: string;
}

/**
 * Returns a Formatter for the given output format.
 * Throws for unknown formats.
 */
export function createFormatter(format: OutputFormat): Formatter {
  switch (format) {
    case 'json':
      return new JSONFormatter();
    case 'csv':
      return new CSVFormatter();
    case 'html':
      return new HTMLFormatter();
  }
}

/**
 * Escapes XML/HTML special characters for safe embedding in SVG or HTML output.
 * The `String(s)` coercion handles non-string inputs gracefully.
 */
export function escapeXml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Truncates a string to `max` characters, appending an ellipsis if needed.
 */
export function truncateStr(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '\u2026';
}
