import type { Formatter, ScanReport, CostEntry, ResourceEntry, RecommendationEntry } from './formatter.js';

function safeNum(n: number, decimals = 4): number {
  const factor = Math.pow(10, decimals);
  return Math.round(n * factor) / factor;
}

/**
 * Renders the ScanReport as pretty-printed JSON.
 * Extends the raw data with a computed `analytics` block so consumers don't
 * have to aggregate themselves.
 */
export class JSONFormatter implements Formatter {
  readonly contentType = 'application/json';
  readonly fileExtension = 'json';

  format(data: ScanReport): string {
    const out = buildJSONReport(data);
    return JSON.stringify(out, null, 2);
  }
}

// ---- computed analytics -----------------------------------------------------

interface ServiceTotal {
  service: string;
  monthlyCost: number;
  pct: number;
}

interface RegionTotal {
  region: string;
  resourceCount: number;
  monthlyCost: number;
}

interface TagCoverage {
  resourcesWithTags: number;
  resourcesWithoutTags: number;
  coveragePct: number;
}

interface CostTrendResult {
  direction: 'up' | 'down' | 'flat';
  firstWeekDailyAvg: number;
  lastWeekDailyAvg: number;
  changePct: number;
}

interface CostTrendByRegion {
  region: string;
  trend: CostTrendResult | null;
}

interface CostPerResource {
  resourceId: string;
  resourceName: string;
  resourceType: string;
  region: string;
  monthlyCost: number;
  pctOfTotal: number;
}

interface SavingsBySeverity {
  critical: number;
  high: number;
  medium: number;
  low: number;
}

interface JSONReport extends ScanReport {
  meta: {
    generator: string;
    reportVersion: string;
    generatedAt: string;
  };
  analytics: {
    costByService: ServiceTotal[];
    costByRegion: RegionTotal[];
    topResourcesByCost: Array<{ id: string; name: string; type: string; region: string; monthlyCost: number }>;
    savingsByImpact: Record<string, number>;
    recommendationsByStatus: Record<string, number>;
    healthScore: number;
    healthLabel: string;
    annualSavingsProjection: number;
    tagCoverage: TagCoverage;
    costTrend: CostTrendResult | null;
    costTrendByRegion: CostTrendByRegion[];
    costPerResource: CostPerResource[];
    savingsBySeverity: SavingsBySeverity;
  };
}

function buildCostByService(costs: CostEntry[]): ServiceTotal[] {
  const m = new Map<string, number>();
  for (const c of costs) m.set(c.serviceName, (m.get(c.serviceName) ?? 0) + c.monthlyCost);
  const total = [...m.values()].reduce((s, v) => s + v, 0);
  return [...m.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([service, monthlyCost]) => ({
      service,
      monthlyCost: safeNum(monthlyCost, 4),
      pct: total > 0 ? safeNum(monthlyCost / total * 100, 1) : 0,
    }));
}

function buildCostByRegion(resources: ResourceEntry[], costs: CostEntry[]): RegionTotal[] {
  const costMap = new Map<string, number>();
  for (const c of costs) costMap.set(c.region, (costMap.get(c.region) ?? 0) + c.monthlyCost);

  const resMap = new Map<string, number>();
  for (const r of resources) resMap.set(r.region, (resMap.get(r.region) ?? 0) + 1);

  const regions = new Set([...costMap.keys(), ...resMap.keys()]);
  return [...regions]
    .map(region => ({
      region,
      resourceCount: resMap.get(region) ?? 0,
      monthlyCost: safeNum(costMap.get(region) ?? 0, 4),
    }))
    .sort((a, b) => b.monthlyCost - a.monthlyCost);
}

function buildHealthScore(totalResources: number, recommendationCount: number): { score: number; label: string } {
  if (totalResources === 0) return { score: 100, label: 'No data' };
  const ratio = recommendationCount / totalResources;
  const score = Math.max(0, Math.round(100 - ratio * 100));
  const label = score >= 90 ? 'Excellent' : score >= 70 ? 'Good' : score >= 50 ? 'Fair' : 'Needs attention';
  return { score, label };
}

function buildTagCoverage(resources: ResourceEntry[]): TagCoverage {
  const total = resources.length;
  const withTags = resources.filter(r => r.tags && Object.keys(r.tags).length > 0).length;
  return {
    resourcesWithTags: withTags,
    resourcesWithoutTags: total - withTags,
    coveragePct: total > 0 ? safeNum(withTags / total * 100, 1) : 0,
  };
}

function buildCostTrend(costs: CostEntry[]): CostTrendResult | null {
  if (costs.length === 0) return null;

  const dailyMap = new Map<string, number>();
  for (const c of costs) {
    const d = c.costDate.slice(0, 10);
    dailyMap.set(d, (dailyMap.get(d) ?? 0) + c.dailyCost);
  }

  const days = [...dailyMap.keys()].sort();
  const vals = days.map(d => dailyMap.get(d) as number);

  const firstWeekVals = vals.slice(0, 7);
  const lastWeekVals = vals.slice(-7);

  const firstWeekAvg = firstWeekVals.reduce((s, v) => s + v, 0) / Math.min(7, firstWeekVals.length);
  const lastWeekAvg = lastWeekVals.reduce((s, v) => s + v, 0) / Math.min(7, lastWeekVals.length);

  const direction: 'up' | 'down' | 'flat' =
    lastWeekAvg > firstWeekAvg ? 'up' : lastWeekAvg < firstWeekAvg ? 'down' : 'flat';

  const changePct =
    firstWeekAvg > 0 ? safeNum((lastWeekAvg - firstWeekAvg) / firstWeekAvg * 100, 1) : 0;

  return {
    direction,
    firstWeekDailyAvg: safeNum(firstWeekAvg, 4),
    lastWeekDailyAvg: safeNum(lastWeekAvg, 4),
    changePct,
  };
}

function buildCostTrendByRegion(costs: CostEntry[]): CostTrendByRegion[] {
  const regions = [...new Set(costs.map(c => c.region).filter(Boolean))];
  return regions.map(region => ({
    region,
    trend: buildCostTrend(costs.filter(c => c.region === region)),
  }));
}

function buildCostPerResource(resources: ResourceEntry[], totalCost: number): CostPerResource[] {
  return resources
    .filter(r => r.monthlyCost > 0)
    .sort((a, b) => b.monthlyCost - a.monthlyCost)
    .slice(0, 20)
    .map(r => ({
      resourceId: r.id,
      resourceName: r.name,
      resourceType: r.type,
      region: r.region,
      monthlyCost: safeNum(r.monthlyCost, 2),
      pctOfTotal: totalCost > 0 ? safeNum(r.monthlyCost / totalCost * 100, 1) : 0,
    }));
}

function buildSavingsBySeverity(recommendations: RecommendationEntry[]): SavingsBySeverity {
  return {
    critical: safeNum(recommendations.filter(r => r.impact === 'critical').reduce((s, r) => s + r.estimatedSavings, 0), 2),
    high: safeNum(recommendations.filter(r => r.impact === 'high').reduce((s, r) => s + r.estimatedSavings, 0), 2),
    medium: safeNum(recommendations.filter(r => r.impact === 'medium').reduce((s, r) => s + r.estimatedSavings, 0), 2),
    low: safeNum(recommendations.filter(r => r.impact === 'low').reduce((s, r) => s + r.estimatedSavings, 0), 2),
  };
}

function buildJSONReport(data: ScanReport): JSONReport {
  const costByService = buildCostByService(data.costs);
  const costByRegion = buildCostByRegion(data.resources, data.costs);
  const topResourcesByCost = [...data.resources]
    .filter(r => r.monthlyCost > 0)
    .sort((a, b) => b.monthlyCost - a.monthlyCost)
    .slice(0, 10)
    .map(r => ({ id: r.id, name: r.name, type: r.type, region: r.region, monthlyCost: r.monthlyCost }));

  const savingsByImpact: Record<string, number> = {};
  const recommendationsByStatus: Record<string, number> = {};
  for (const r of data.recommendations) {
    savingsByImpact[r.impact] = safeNum((savingsByImpact[r.impact] ?? 0) + r.estimatedSavings, 4);
    recommendationsByStatus[r.status] = (recommendationsByStatus[r.status] ?? 0) + 1;
  }

  const { score: healthScore, label: healthLabel } = buildHealthScore(
    data.summary.totalResources,
    data.summary.recommendationCount,
  );

  const annualSavingsProjection = safeNum(data.summary.potentialSavings * 12, 2);
  const tagCoverage = buildTagCoverage(data.resources);
  const costTrend = buildCostTrend(data.costs);
  const costTrendByRegion = buildCostTrendByRegion(data.costs);
  const costPerResource = buildCostPerResource(data.resources, data.summary.totalMonthlyCost);
  const savingsBySeverity = buildSavingsBySeverity(data.recommendations);

  return {
    meta: {
      generator: 'korinfra',
      reportVersion: '2',
      generatedAt: new Date().toISOString(),
    },
    ...data,
    analytics: {
      costByService,
      costByRegion,
      topResourcesByCost,
      savingsByImpact,
      recommendationsByStatus,
      healthScore,
      healthLabel,
      annualSavingsProjection,
      tagCoverage,
      costTrend,
      costTrendByRegion,
      costPerResource,
      savingsBySeverity,
    },
  };
}
