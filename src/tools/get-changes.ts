import { lookupCloudTrailEvents } from '../aws/cloudtrail.js';
import { loadConfig } from '../config/index.js';
import { redactObject } from '../redaction/index.js';
import { jsonResult, errorResult } from './types.js';
import type { ToolDefinition } from './types.js';

interface CloudTrailOpts {
  profile?: string;
  region: string;
  hours?: number;
  resourceType?: string;
  username?: string;
  maxResults?: number;
}

export const getChangesTool: ToolDefinition = {
  name: 'get_changes',
  description: 'Fetch recent AWS API activity from CloudTrail. Shows who changed what resources and when. Use to answer "what changed recently?" or "who modified X?"',
  inputSchema: {
    type: 'object',
    properties: {
      profile: { type: 'string', description: 'AWS CLI profile.' },
      region: { type: 'string', description: 'AWS region. Defaults to config default_region, then us-east-1.' },
      hours: { type: 'number', description: 'Look back N hours. Default 24, max 168 (7 days).' },
      resourceType: { type: 'string', description: 'Filter by AWS resource type, e.g. AWS::EC2::Instance' },
      username: { type: 'string', description: 'Filter by IAM username or role session name.' },
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
  handler: async (args) => {
    try {
      const profile = typeof args['profile'] === 'string' ? args['profile'] : undefined;
      const hours = typeof args['hours'] === 'number' ? Math.min(args['hours'], 168) : 24;
      const resourceType = typeof args['resourceType'] === 'string' ? args['resourceType'] : undefined;
      const username = typeof args['username'] === 'string' ? args['username'] : undefined;

      let region = typeof args['region'] === 'string' ? args['region'] : '';
      if (!region) {
        try {
          const config = await loadConfig();
          region = config.aws?.default_region ?? 'us-east-1';
        } catch {
          region = 'us-east-1';
        }
      }

      const cloudTrailOpts: CloudTrailOpts = { region, hours };
      if (profile) cloudTrailOpts.profile = profile;
      if (resourceType) cloudTrailOpts.resourceType = resourceType;
      if (username) cloudTrailOpts.username = username;
      const events = await lookupCloudTrailEvents(cloudTrailOpts);

      return jsonResult(redactObject({
        events: events.map(e => ({
          eventId: e.eventId,
          eventTime: e.eventTime.toISOString(),
          eventName: e.eventName,
          eventSource: e.eventSource,
          username: e.username,
          resourceType: e.resourceType,
          resourceName: e.resourceName,
          awsRegion: e.awsRegion,
          errorCode: e.errorCode,
        })),
        count: events.length,
        region,
        hours,
      }, 'moderate'));
    } catch (err) {
      return errorResult(err);
    }
  },
};
