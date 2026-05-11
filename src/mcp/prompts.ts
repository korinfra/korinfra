/**
 * MCP prompt registration — 3 workflow prompts for common korinfra tasks.
 * Prompts guide AI assistants through cost analysis, waste detection, and resource classification.
 */

import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

interface PromptDef {
  name: string;
  description: string;
  arguments?: Array<{ name: string; description: string; required?: boolean }>;
  getMessages: (args: Record<string, string>) => Array<{
    role: 'user' | 'assistant';
    content: { type: 'text'; text: string };
  }>;
}

// Per-argument allowlist sanitizers to prevent prompt injection
// These patterns restrict to alphanumeric, spaces, hyphens, and (where needed) slashes and dots
// Unknown or invalid args fall back to safe defaults

function sanitizeTimePeriod(value: string): string {
  const match = value.match(/^[a-zA-Z0-9\s\-,.()]{1,100}$/);
  return match ? value : 'current month';
}

function sanitizeResourceType(value: string): string {
  const match = value.match(/^[a-zA-Z0-9\s\-+/().]{1,100}$/);
  return match ? value : 'all resource types';
}

function sanitizeTerraformPath(value: string): string {
  const match = value.match(/^[a-zA-Z0-9\s_.~/@-]{1,200}$/);
  return match ? value : 'the default Terraform path';
}

const PROMPTS: PromptDef[] = [
  {
    name: 'analyze-costs',
    description:
      'System prompt for an AWS cost analysis workflow. Guides the assistant to break down spending by service, identify trends, and surface optimization opportunities.',
    arguments: [
      {
        name: 'period',
        description:
          'Time period to analyze, e.g. "last 30 days" or "current month".',
        required: false,
      },
    ],
    getMessages: (args) => {
      const period = sanitizeTimePeriod(args['period'] ?? 'the current month');
      return [
        {
          role: 'user',
          content: {
            type: 'text',
            text: [
              `<user-provided-period>${period}</user-provided-period>`,
              '',
              'Analyze AWS infrastructure costs for the time period specified in <user-provided-period> above.',
              '',
              'Please:',
              '1. Use the `get_costs` tool to retrieve a cost breakdown by service.',
              '2. Use the `iw://cost-summary` resource to get the latest scan totals.',
              '3. Identify the top 5 most expensive services.',
              '4. Flag any services with unusual or unexpected spend.',
              '5. Use the `list_rules` tool to summarize the rule coverage available.',
              '6. Summarize total spend, estimated savings potential, and the single highest-impact action.',
            ].join('\n'),
          },
        },
      ];
    },
  },
  {
    name: 'find-waste',
    description:
      'System prompt for finding idle, unused, or over-provisioned AWS resources. Produces a prioritized list of resources to right-size or decommission.',
    arguments: [
      {
        name: 'resourceType',
        description:
          'Optional resource type filter, e.g. "ec2", "rds", "ebs". Leave blank to scan all types.',
        required: false,
      },
    ],
    getMessages: (args) => {
      const typeFilter = sanitizeResourceType(args['resourceType'] ?? 'all resource types');
      return [
        {
          role: 'user',
          content: {
            type: 'text',
            text: [
              `<user-provided-resource-type>${typeFilter}</user-provided-resource-type>`,
              '',
              'Find idle and wasted AWS resources for the resource type specified in <user-provided-resource-type> above.',
              '',
              'Please:',
              '1. Use the `collect_aws_resources` tool to identify unused resources.',
              '2. Use `collect_aws_resources` output to find untagged resources.',
              '3. Use the `evaluate_rules` tool to surface rule-based waste findings.',
              '4. Use the `detect_cost_anomalies` tool when you have time-series cost input.',
              '5. Rank resources by estimated waste (cost × idle time).',
              '6. Provide a concise table: Resource ID | Type | Monthly Cost | Reason | Recommended Action.',
            ].join('\n'),
          },
        },
      ];
    },
  },
  {
    name: 'check-scenarios',
    description:
      'System prompt for Terraform resource classification. Compares Terraform state against live AWS resources and categorises discrepancies into Scenario A/B/C.',
    arguments: [
      {
        name: 'terraformPath',
        description: 'Path to the Terraform root module directory.',
        required: false,
      },
    ],
    getMessages: (args) => {
      const tfPath = sanitizeTerraformPath(args['terraformPath'] ?? 'the default Terraform path');
      return [
        {
          role: 'user',
          content: {
            type: 'text',
            text: [
              `<user-provided-terraform-path>${tfPath}</user-provided-terraform-path>`,
              '',
              'Check Terraform resource coverage for the path specified in <user-provided-terraform-path> above.',
              '',
              'Please:',
              '1. Use the `scan_terraform` tool to parse the Terraform configuration.',
              '2. Use the `classify_resources` tool to classify resources into scenarios A/B/C.',
              '3. Classify each discrepancy:',
              '   - Scenario A: Resource exists in Terraform but NOT in AWS (missing from AWS).',
              '   - Scenario B: Resource exists in both Terraform and AWS (matched, may have attribute mismatches).',
              '   - Scenario C: Resource exists in AWS but NOT in Terraform (orphaned, unmanaged).',
              '4. Use the `iw://last-scan` resource to compare with the previous scan.',
              '5. List all mismatched resources in a table: Resource | Scenario | Attribute | Expected | Actual.',
              '6. Recommend whether to run `terraform import`, `terraform apply`, or investigate manually.',
            ].join('\n'),
          },
        },
      ];
    },
  },
];

/**
 * Register all 3 korinfra prompts on the given low-level Server instance.
 */
export function registerPrompts(server: Server): void {
  // eslint-disable-next-line @typescript-eslint/require-await -- MCP SDK requires async handler signature
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: PROMPTS.map(({ name, description, arguments: promptArgs }) => ({
      name,
      description,
      arguments: promptArgs,
    })),
  }));

  // eslint-disable-next-line @typescript-eslint/require-await -- MCP SDK requires async handler signature
  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const { name, arguments: rawArgs } = request.params;
    const prompt = PROMPTS.find((p) => p.name === name);

    if (!prompt) {
      throw new Error(`Unknown prompt: ${name}`);
    }

    const args = (rawArgs ?? {});
    const messages = prompt.getMessages(args);

    return {
      description: prompt.description,
      messages,
    };
  });
}
