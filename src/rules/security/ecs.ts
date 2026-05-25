/**
 * ECS task definition security rules.
 */

import type { SecurityRule } from './types.js';

/** Env var name fragments that suggest a secret value. */
const SENSITIVE_NAME_FRAGMENTS = [
  'password', 'passwd', 'secret', 'token', 'api_key', 'apikey',
  'access_key', 'private_key', 'credential', 'auth', 'cert',
];

/** Parse container_definitions JSON string into an array of container objects. */
function parseContainerDefs(cfg: Record<string, unknown>): Record<string, unknown>[] {
  const raw = cfg['container_definitions'];
  if (raw === null || raw === undefined) return [];
  try {
    const parsed: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (Array.isArray(parsed)) {
      return parsed.filter((c): c is Record<string, unknown> =>
        c !== null && typeof c === 'object' && !Array.isArray(c),
      );
    }
  } catch {
    // Malformed JSON — skip rule
  }
  return [];
}

export const ecsRules: SecurityRule[] = [
  {
    id: 'ECS-SEC-002',
    title: 'ECS task definition with privileged container',
    description:
      'One or more containers run in privileged mode, granting full host access including all capabilities and devices.',
    severity: 'critical',
    resourceTypes: ['aws_ecs_task_definition'],
    evaluate: (res) => parseContainerDefs(res.configuration).some((c) => c['privileged'] === true),
    recommendation:
      'Remove privileged: true. Grant only the Linux capabilities your container needs via linuxParameters.capabilities.',
  },
  {
    id: 'ECS-SEC-003',
    title: 'ECS task definition with potential plaintext secrets in environment variables',
    description:
      'Container environment variables contain names associated with credentials or secrets. Values should come from Secrets Manager or SSM Parameter Store.',
    severity: 'high',
    resourceTypes: ['aws_ecs_task_definition'],
    evaluate: (res) => {
      for (const c of parseContainerDefs(res.configuration)) {
        const env = c['environment'];
        if (!Array.isArray(env)) continue;
        for (const entry of env) {
          if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
          const e = entry as Record<string, unknown>;
          const name = typeof e['name'] === 'string' ? e['name'].toLowerCase() : '';
          const value = typeof e['value'] === 'string' ? e['value'] : '';
          // Flag non-empty hardcoded values with sensitive names; skip Terraform
          // references (${...}), ARNs, SSM paths (/... or ssm:...), and blanks.
          if (
            value.trim() !== '' &&
            !value.startsWith('${') &&
            !value.startsWith('arn:') &&
            !value.startsWith('/') &&
            !value.startsWith('ssm:') &&
            SENSITIVE_NAME_FRAGMENTS.some((f) => name.includes(f))
          ) {
            return true;
          }
        }
      }
      return false;
    },
    recommendation:
      'Use secrets[] with valueFrom pointing to Secrets Manager ARNs or SSM Parameter Store paths instead of environment[].',
  },
  {
    id: 'ECS-SEC-004',
    title: 'ECS task definition uses host network mode',
    description:
      'network_mode = "host" gives containers direct access to the host network interface, bypassing network isolation.',
    severity: 'high',
    resourceTypes: ['aws_ecs_task_definition'],
    evaluate: (res) => {
      const mode = res.configuration['network_mode'];
      return typeof mode === 'string' && mode === 'host';
    },
    recommendation:
      'Use awsvpc for Fargate tasks or bridge for EC2 launch type to maintain network isolation.',
  },
];
