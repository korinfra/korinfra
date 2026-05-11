import { writeTagsToResources } from '../aws/tag-writer.js';
import { redactObject } from '../redaction/index.js';
import { jsonResult, errorResult } from './types.js';
import type { ToolDefinition } from './types.js';

const ARN_REGEX = /^arn:aws(-[a-z]+)*:[a-z0-9-]+:[a-z0-9-]*:\d*:[A-Za-z0-9_/:.-]+$/;

export const applyTagsRealTool: ToolDefinition = {
  name: 'apply_tags_real',
  description: 'Write tags directly to AWS resources via Resource Groups Tagging API. This is a DESTRUCTIVE operation — only call after the user has explicitly confirmed in the UI.',
  inputSchema: {
    type: 'object',
    required: ['arns', 'tags', 'region'],
    properties: {
      profile: { type: 'string', description: 'AWS CLI profile.' },
      region: { type: 'string', description: 'AWS region where resources reside.' },
      arns: {
        type: 'array',
        items: { type: 'string' },
        maxItems: 100,
        description: 'ARNs of resources to tag.',
      },
      tags: {
        type: 'object',
        additionalProperties: { type: 'string' },
        description: 'Tag key-value pairs to apply.',
      },
    },
    additionalProperties: false,
  },
  annotations: { destructiveHint: true },
  handler: async (args) => {
    try {
      const profile = typeof args['profile'] === 'string' ? args['profile'] : undefined;
      const region = typeof args['region'] === 'string' ? args['region'] : '';
      if (!region) return errorResult('region is required');

      const arns = Array.isArray(args['arns']) ? (args['arns'] as string[]) : [];
      if (arns.length === 0) return errorResult('arns array is empty');
      const invalidArns = arns.filter(a => !ARN_REGEX.test(a));
      if (invalidArns.length > 0) return errorResult(`Invalid ARN format: ${invalidArns.slice(0, 3).join(', ')}`);

      const rawTags = args['tags'];
      if (!rawTags || typeof rawTags !== 'object' || Array.isArray(rawTags)) {
        return errorResult('tags must be an object');
      }
      const tags = Object.fromEntries(
        Object.entries(rawTags as Record<string, unknown>).map(([k, v]) => [k, String(v)])
      );

      const results = await writeTagsToResources(profile ? { profile, region, arns, tags } : { region, arns, tags });
      const failed = results.filter(r => !r.success);

      return jsonResult(redactObject({
        applied: results.length - failed.length,
        failed: failed.length,
        results: results.map(r => ({
          arn: r.arn,
          success: r.success,
          error: r.error,
        })),
      }, 'moderate'));
    } catch (err) {
      return errorResult(err);
    }
  },
};
