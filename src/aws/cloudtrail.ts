import { CloudTrailClient, LookupEventsCommand } from '@aws-sdk/client-cloudtrail';
import type { LookupAttribute } from '@aws-sdk/client-cloudtrail';
import { getCredentials } from './credentials.js';
import { throttledCall } from './rate-limiter.js';

export interface CloudTrailEvent {
  eventId: string;
  eventTime: Date;
  eventName: string;
  eventSource: string;
  username: string;
  resourceType?: string;
  resourceName?: string;
  awsRegion: string;
  errorCode?: string;
}

export async function lookupCloudTrailEvents(opts: {
  profile?: string;
  region: string;
  hours?: number;
  resourceType?: string;
  username?: string;
  maxResults?: number;
}): Promise<CloudTrailEvent[]> {
  const config = opts.profile ? { profile: opts.profile, regions: [opts.region] } : { regions: [opts.region] };
  const creds = getCredentials(config);
  const client = new CloudTrailClient({ region: opts.region, credentials: creds });
  const hours = opts.hours ?? 24;
  const startTime = new Date(Date.now() - hours * 60 * 60 * 1000);

  const attributes: LookupAttribute[] = [];
  if (opts.resourceType) {
    attributes.push({ AttributeKey: 'ResourceType', AttributeValue: opts.resourceType });
  }
  if (opts.username) {
    attributes.push({ AttributeKey: 'Username', AttributeValue: opts.username });
  }

  const result = await throttledCall('cloudtrail', 'LookupEvents', opts.region, () =>
    client.send(new LookupEventsCommand({
      StartTime: startTime,
      MaxResults: Math.min(opts.maxResults ?? 50, 50),
      LookupAttributes: attributes.length > 0 ? attributes : undefined,
    }))
  );

  return (result.Events ?? []).map((e) => {
    let errorCode: string | undefined;
    if (e.CloudTrailEvent) {
      try {
        const parsed = JSON.parse(e.CloudTrailEvent) as Record<string, unknown>;
        if (typeof parsed['errorCode'] === 'string') errorCode = parsed['errorCode'];
      } catch { /* malformed JSON — skip */ }
    }
    const event: CloudTrailEvent = {
      eventId: e.EventId ?? '',
      eventTime: e.EventTime ?? new Date(),
      eventName: e.EventName ?? '',
      eventSource: e.EventSource ?? '',
      username: e.Username ?? 'unknown',
      awsRegion: opts.region,
    };
    if (e.Resources?.[0]?.ResourceType) event.resourceType = e.Resources[0].ResourceType;
    if (e.Resources?.[0]?.ResourceName) event.resourceName = e.Resources[0].ResourceName;
    if (errorCode) event.errorCode = errorCode;
    return event;
  });
}
