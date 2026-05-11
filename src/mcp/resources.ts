/**
 * MCP resource registration — 3 read-only resources exposing korinfra state.
 * All data is redacted at 'moderate' level before exposure.
 */

import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { loadConfig } from '../config/index.js';
import { getDb } from '../storage/index.js';
import { listScans } from '../storage/queries/scans.js';
import { redact, redactObject } from '../redaction/redactor.js';

interface ResourceDef {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
  read: () => Promise<string>;
}

const RESOURCES: ResourceDef[] = [
  {
    uri: 'iw://config',
    name: 'korinfra-config',
    description: 'Current korinfra configuration (sensitive values redacted)',
    mimeType: 'application/json',
    read: async () => {
      const config = await loadConfig();
      const redacted = redactObject(config, 'moderate');
      return JSON.stringify(redacted, null, 2);
    },
  },
  {
    uri: 'iw://last-scan',
    name: 'last-scan',
    description: 'Most recent korinfra scan results summary',
    mimeType: 'application/json',
    // eslint-disable-next-line @typescript-eslint/require-await -- implements ResourceDef.read: () => Promise<string>
    read: async () => {
      const db = getDb();
      const scans = listScans(db, 1, 0);
      const scan = scans[0] ?? null;
      if (scan === null) {
        return JSON.stringify({ message: 'No scans found. Run a scan first.' }, null, 2);
      }
      const redacted = redactObject(scan, 'moderate');
      return JSON.stringify(redacted, null, 2);
    },
  },
  {
    uri: 'iw://cost-summary',
    name: 'cost-summary',
    description: 'Cost summary from the most recent korinfra scan',
    mimeType: 'application/json',
    // eslint-disable-next-line @typescript-eslint/require-await -- implements ResourceDef.read: () => Promise<string>
    read: async () => {
      const db = getDb();
      const scans = listScans(db, 1, 0);
      const scan = scans[0] ?? null;
      const summary = scan
        ? {
            scanId: scan.id,
            startedAt: scan.started_at,
            completedAt: scan.completed_at,
            status: scan.status,
            totalResources: scan.total_resources,
            totalCostUsd: scan.total_cost,
            totalRecommendations: scan.total_recommendations,
            estimatedSavingsUsd: scan.total_savings,
            scenarioBreakdown: {
              scenarioA: scan.scenario_a_count,
              scenarioB: scan.scenario_b_count,
              scenarioC: scan.scenario_c_count,
            },
          }
        : null;
      const redacted = redactObject(summary, 'moderate');
      return JSON.stringify(redacted ?? { message: 'No scans found.' }, null, 2);
    },
  },
];

/**
 * Register all 3 korinfra resources on the given low-level Server instance.
 */
export function registerResources(server: Server): void {
  // eslint-disable-next-line @typescript-eslint/require-await -- MCP SDK requires async handler signature
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: RESOURCES.map(({ uri, name, description, mimeType }) => ({
      uri,
      name,
      description,
      mimeType,
    })),
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;
    const resource = RESOURCES.find((r) => r.uri === uri);

    if (!resource) {
      return {
        contents: [
          {
            uri,
            mimeType: 'application/json',
            text: JSON.stringify({ error: `Unknown resource: ${uri}` }),
          },
        ],
      };
    }

    try {
      const text = await resource.read();
      return {
        contents: [{ uri, mimeType: resource.mimeType, text }],
      };
    } catch (err) {
      const message = redact(err instanceof Error ? err.message : String(err), 'moderate');
      return {
        contents: [
          {
            uri,
            mimeType: 'application/json',
            text: JSON.stringify({ error: message }),
          },
        ],
      };
    }
  });
}
