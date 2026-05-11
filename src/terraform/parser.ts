/**
 * Terraform HCL parser.
 * Uses @cdktf/hcl2json (WASM) to parse .tf files into structured objects.
 * Ported from Go internal/terraform/parser.go.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { resolve, join, extname } from 'node:path';

import { parse } from '@cdktf/hcl2json';
import pLimit from 'p-limit';

import type { TerraformResource } from './types.js';
import { logger } from '../utils/logger.js';

const walkConcurrencyLimit = pLimit(20);
/** Separate limit for CPU-bound WASM parse calls to reduce memory pressure. */
const parseLimit = pLimit(8);

// ---------------------------------------------------------------------------
// Type normalization map (matches Go awsTypeMap)
// ---------------------------------------------------------------------------

const awsTypeMap: Record<string, string> = {
  aws_instance: 'ec2_instance',
  aws_db_instance: 'rds_instance',
  aws_s3_bucket: 's3_bucket',
  aws_lambda_function: 'lambda_function',
  aws_ebs_volume: 'ebs_volume',
  aws_eip: 'elastic_ip',
  aws_nat_gateway: 'nat_gateway',
  aws_lb: 'load_balancer',
  aws_alb: 'load_balancer',
  aws_elasticache_cluster: 'elasticache_cluster',
  aws_dynamodb_table: 'dynamodb_table',
  aws_autoscaling_group: 'autoscaling_group',
  aws_ecs_service: 'ecs_service',
  aws_eks_cluster: 'eks_cluster',
  aws_cloudfront_distribution: 'cloudfront_distribution',
  aws_sqs_queue: 'sqs_queue',
  aws_sns_topic: 'sns_topic',
  aws_kinesis_stream: 'kinesis_stream',
};

/** Convert a Terraform resource type to an korinfra normalized type. */
export function normalizeResourceType(tfType: string): string {
  const mapped = awsTypeMap[tfType];
  if (mapped !== undefined) return mapped;
  if (tfType.startsWith('aws_')) return tfType.slice(4);
  return tfType;
}

/** Extract the provider prefix from a resource type string. */
function providerFromType(resType: string): string {
  const idx = resType.indexOf('_');
  return idx > 0 ? resType.slice(0, idx) : resType;
}

// ---------------------------------------------------------------------------
// hcl2json output shapes
// ---------------------------------------------------------------------------

/**
 * hcl2json converts HCL to a JSON structure where:
 *   resource.<type>.<name> = [{ ...attributes }]
 *   data.<type>.<name>     = [{ ...attributes }]
 *   module.<name>          = [{ ...attributes }]
 *   variable.<name>        = [{ ...attributes }]
 *   locals                 = [{ key: value, ... }]
 */
type HclJson = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

function extractFromBlock(
  blockType: string,
  hcl: HclJson,
  filePath: string,
): TerraformResource[] {
  const results: TerraformResource[] = [];
  const section = hcl[blockType];
  if (section === null || section === undefined || typeof section !== 'object') return results;

  switch (blockType) {
    case 'resource': {
      // resource.<type>.<name> = [attrs]
      const byType = section as Record<string, Record<string, unknown[]>>;
      for (const [resType, byName] of Object.entries(byType)) {
        if (typeof byName !== 'object' || byName === null || byName === undefined) continue;
        for (const [resName, instances] of Object.entries(byName)) {
          const config =
            Array.isArray(instances) && instances.length > 0
              ? (instances[0] as Record<string, unknown>)
              : {};
          results.push({
            address: `${resType}.${resName}`,
            type: resType,
            name: resName,
            provider: providerFromType(resType),
            module: '',
            filePath: filePath,
            lineNumber: 0,
            configuration: config,
            dependencies: [],
          });
        }
      }
      break;
    }

    case 'data': {
      // data.<type>.<name> = [attrs]
      const byType = section as Record<string, Record<string, unknown[]>>;
      for (const [resType, byName] of Object.entries(byType)) {
        if (typeof byName !== 'object' || byName === null || byName === undefined) continue;
        for (const [resName, instances] of Object.entries(byName)) {
          const config =
            Array.isArray(instances) && instances.length > 0
              ? (instances[0] as Record<string, unknown>)
              : {};
          results.push({
            address: `data.${resType}.${resName}`,
            type: resType,
            name: resName,
            provider: providerFromType(resType),
            module: '',
            filePath: filePath,
            lineNumber: 0,
            configuration: config,
            dependencies: [],
          });
        }
      }
      break;
    }

    case 'module': {
      // module.<name> = [attrs]
      const byName = section as Record<string, unknown[]>;
      for (const [modName, instances] of Object.entries(byName)) {
        const config =
          Array.isArray(instances) && instances.length > 0
            ? (instances[0] as Record<string, unknown>)
            : {};
        results.push({
          address: `module.${modName}`,
          type: 'module',
          name: modName,
          provider: '',
          module: '',
          filePath: filePath,
          lineNumber: 0,
          configuration: config,
          dependencies: [],
        });
      }
      break;
    }

    case 'variable': {
      // variable.<name> = [attrs]
      const byName = section as Record<string, unknown[]>;
      for (const [varName, instances] of Object.entries(byName)) {
        const config =
          Array.isArray(instances) && instances.length > 0
            ? (instances[0] as Record<string, unknown>)
            : {};
        results.push({
          address: `var.${varName}`,
          type: 'variable',
          name: varName,
          provider: '',
          module: '',
          filePath: filePath,
          lineNumber: 0,
          configuration: config,
          dependencies: [],
        });
      }
      break;
    }

    case 'locals': {
      // locals = [{ key: value, ... }]
      const instances = section as unknown[];
      if (!Array.isArray(instances)) break;
      for (const block of instances) {
        if (typeof block !== 'object' || block === null || block === undefined) continue;
        for (const [key, value] of Object.entries(block as Record<string, unknown>)) {
          results.push({
            address: `local.${key}`,
            type: 'local',
            name: key,
            provider: '',
            module: '',
            filePath: filePath,
            lineNumber: 0,
            configuration: { [key]: value },
            dependencies: [],
          });
        }
      }
      break;
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const MAX_TF_FILE_BYTES = 10 * 1024 * 1024; // 10 MB

/** Parse a single .tf file. Returns [] on error (non-fatal, matches Go behaviour). */
export async function parseTerraformFile(filePath: string): Promise<TerraformResource[]> {
  const absPath = resolve(filePath);
  if (extname(absPath) !== '.tf') return [];
  try {
    const fileStat = await stat(absPath);
    if (fileStat.size > MAX_TF_FILE_BYTES) {
      logger.warn({ file: absPath, size: fileStat.size }, 'Terraform file too large, skipping');
      return [];
    }
  } catch (err) {
    logger.debug({ file: absPath, err: err instanceof Error ? err.message : String(err) }, 'Failed to stat Terraform file');
    return [];
  }
  let contents: string;
  try {
    contents = await readFile(absPath, 'utf8');
  } catch (err) {
    logger.debug({ file: absPath, err: err instanceof Error ? err.message : String(err) }, 'Failed to read Terraform file');
    return [];
  }

  let hcl: HclJson;
  try {
    hcl = await parseLimit(() => parse(absPath, contents));
  } catch (err) {
    logger.debug({ file: absPath, err: err instanceof Error ? err.message : String(err) }, 'Failed to parse Terraform file');
    return [];
  }

  const resources: TerraformResource[] = [];
  for (const blockType of ['resource', 'data', 'module', 'variable', 'locals']) {
    resources.push(...extractFromBlock(blockType, hcl, absPath));
  }
  return resources;
}

const TOTAL_MAX_BYTES = 200 * 1024 * 1024; // 200 MB

/** Recursively scan a directory for .tf files and return all resources sorted by file+position. */
export async function parseTerraformDir(dir: string): Promise<TerraformResource[]> {
  const absDir = resolve(dir);
  const all: TerraformResource[] = [];
  const scanState = { totalBytes: 0 };
  await walkDir(absDir, all, 10, scanState);
  // Sort by filePath, then address (line numbers are 0 from hcl2json)
  all.sort((a, b) => {
    if (a.filePath !== b.filePath) return a.filePath < b.filePath ? -1 : 1;
    return a.address < b.address ? -1 : 1;
  });
  return all;
}

async function walkDir(
  dir: string,
  results: TerraformResource[],
  maxDepth: number,
  scanState?: { totalBytes: number },
): Promise<void> {
  if (maxDepth <= 0) return;

  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err: unknown) {
    logger.debug({ dir, err: err instanceof Error ? err.message : String(err) }, 'walkDir: failed to read directory entry');
    return;
  }

  // Skip only vendored/generated directories. User-defined modules/ directories
  // are part of the project and must be scanned for security findings.
  // Note: .terraform/ is already caught by the startsWith('.') check above.
  const SKIP_DIRS = new Set(['.terraform', 'terraform.tfstate.d']);

  await Promise.all(
    entries.map((entry: Dirent) => walkConcurrencyLimit(async () => {
      const entryName = entry.name;
      // Skip hidden directories and known vendored/generated directories
      if (entryName.startsWith('.') && entryName !== '.') return;
      if (SKIP_DIRS.has(entryName)) return;
      const fullPath = join(dir, entryName);

      if (entry.isSymbolicLink()) return;

      if (entry.isDirectory()) {
        await walkDir(fullPath, results, maxDepth - 1, scanState);
        return;
      }

      if (entry.isFile() && extname(entryName) === '.tf') {
        // Check aggregate size limit before processing
        if (scanState !== undefined) {
          try {
            const fileStat = await stat(fullPath);
            scanState.totalBytes += fileStat.size;
            if (scanState.totalBytes > TOTAL_MAX_BYTES) {
              throw new Error(
                `Terraform directory scan exceeded 200 MB aggregate size limit. ` +
                `Scan a smaller directory or exclude large files.`,
              );
            }
          } catch (err: unknown) {
            if (err instanceof Error && err.message.includes('aggregate size limit')) {
              throw err;
            }
            // Non-fatal stat error, continue scanning
            logger.debug({ file: fullPath, err: err instanceof Error ? err.message : String(err) }, 'Failed to stat Terraform file for size check');
          }
        }
        const parsed = await parseTerraformFile(fullPath);
        results.push(...parsed);
      }
    })),
  );
}

/** Filter out data sources, modules, variables, and locals — keep only managed resources. */
export function filterManagedTerraformResources(
  resources: TerraformResource[],
): TerraformResource[] {
  return resources.filter((r) => {
    if (r.type === 'module' || r.type === 'variable' || r.type === 'local') return false;
    if (r.address.startsWith('data.')) return false;
    return true;
  });
}

/** Filter to only AWS-provider resources. */
export function filterAWSResources(resources: TerraformResource[]): TerraformResource[] {
  return resources.filter((r) => r.provider === 'aws');
}

/**
 * Validate that a path is a directory containing .tf files.
 * Returns true if at least one .tf file exists directly in dir (non-recursive).
 */
export async function isTerraformDir(dir: string): Promise<boolean> {
  try {
    const s = await stat(dir);
    if (!s.isDirectory()) return false;
    const entries = await readdir(dir);
    return entries.some((e) => e.endsWith('.tf'));
  } catch {
    return false;
  }
}
