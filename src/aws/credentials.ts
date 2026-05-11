import { fromIni, fromNodeProviderChain, fromTemporaryCredentials } from '@aws-sdk/credential-providers';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import type { CollectorConfig } from './types.js';
import { throttledCall } from './rate-limiter.js';
import { logger } from '../utils/logger.js';

interface CallerIdentity {
  account: string;
  arn: string;
  userId: string;
}

type CredentialProvider = ReturnType<typeof fromIni>;

/**
 * Detects which credential source is being used for logging and audit purposes.
 */
function detectCredentialSource(config: CollectorConfig): string {
  // L7: Log credential source for audit trail
  const profile = config.profile ?? process.env['AWS_PROFILE'];
  if (profile) {
    return `profile:${profile}`;
  }

  if (process.env['AWS_ACCESS_KEY_ID']) {
    return 'environment-variables (AWS_ACCESS_KEY_ID)';
  }

  if (process.env['AWS_EC2_METADATA_SERVICE_ENDPOINT']) {
    return 'ec2-metadata-service';
  }

  // Default: will try env → ~/.aws/credentials → ECS task role → EC2 instance metadata
  return 'default-provider-chain (env/ini/IMDS)';
}

/**
 * Resolves AWS credentials for the given collector config.
 * Priority: explicit profile > AWS_PROFILE env > default provider chain (env, ini, IMDS, etc.).
 * If roleArn is set, wraps with STS AssumeRole.
 *
 * L7: Logs which credential provider was used for security audit trail.
 */
export function getCredentials(config: CollectorConfig): CredentialProvider {
  const profile = config.profile ?? process.env['AWS_PROFILE'];
  const credentialSource = detectCredentialSource(config);

  // Use fromIni when a specific profile is requested; otherwise use the full
  // provider chain so env-var-only and IMDS credentials work (CI, ECS, Lambda).
  const base: CredentialProvider = profile
    ? fromIni({ profile })
    : fromNodeProviderChain() as CredentialProvider;

  if (config.roleArn) {
    const arnPattern = /^arn:aws[a-z-]*:iam::[0-9]{12}:role\/\S+$/;
    if (!arnPattern.test(config.roleArn)) {
      throw new Error('Invalid roleArn format. Expected: arn:aws:iam::ACCOUNT_ID:role/RoleName');
    }
    logger.debug(
      { credentialSource, roleArn: config.roleArn },
      'Credential resolution: using STS AssumeRole with base credentials',
    );
    return fromTemporaryCredentials({
      masterCredentials: base,
      params: {
        RoleArn: config.roleArn,
        RoleSessionName: 'korinfra-session',
        ...(config.externalId ? { ExternalId: config.externalId } : {}),
      },
    });
  }

  logger.debug({ credentialSource }, 'Credential resolution: using base credentials');
  return base;
}

/**
 * Resolves the AWS region to use.
 * Priority: config regions[0] > config.defaultRegion > AWS_REGION env > AWS_DEFAULT_REGION env > us-east-1
 */
export function resolveRegion(config: CollectorConfig): string {
  if (config.regions.length > 0) return config.regions[0] ?? 'us-east-1';
  if (config.defaultRegion) return config.defaultRegion;
  return process.env['AWS_REGION'] ?? process.env['AWS_DEFAULT_REGION'] ?? 'us-east-1';
}

/**
 * Verifies credentials via STS GetCallerIdentity.
 */
export async function testConnection(
  config: CollectorConfig,
  signal?: AbortSignal,
): Promise<CallerIdentity> {
  const credentials = getCredentials(config);
  const region = resolveRegion(config);
  const client = new STSClient({ credentials, region, requestHandler: new NodeHttpHandler({ connectionTimeout: 3_000, socketTimeout: 15_000 }), maxAttempts: 1 });
  const options: Record<string, unknown> = {};
  if (signal !== undefined) options['abortSignal'] = signal;
  const out = await throttledCall('sts', 'GetCallerIdentity', region, () =>
    client.send(new GetCallerIdentityCommand({}), options as Parameters<typeof client.send>[1]),
  );
  return {
    account: out.Account ?? '',
    arn: out.Arn ?? '',
    userId: out.UserId ?? '',
  };
}
