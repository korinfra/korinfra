/**
 * S3 security rules.
 * Ported from Go internal/terraform/scanner.go S3 section.
 */

import type { SecurityRule, TfResource } from './types.js';

/**
 * Check whether a bucket reference field (from a sibling resource) points to a given bucket.
 * Handles: literal bucket name, Terraform reference like "${aws_s3_bucket.example.id}",
 * or reference like "aws_s3_bucket.example.bucket".
 */
function refMatchesBucket(bucketField: unknown, bucket: TfResource): boolean {
  const ref = String((bucketField as string | null | undefined) ?? '');
  if (!ref) return false;
  // Exact resource address match (e.g. "aws_s3_bucket.example" in the ref)
  if (ref.includes(bucket.address)) return true;
  // Resource name word-boundary match — avoid "s3" matching "s3-logs"
  const escapedName = bucket.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\w-])${escapedName}(?![\\w-])`).test(ref);
}

export const s3Rules: SecurityRule[] = [
  {
    id: 'S3-SEC-001',
    title: 'S3 bucket with public ACL',
    description: 'S3 bucket has a public ACL which allows unrestricted access',
    severity: 'critical',
    resourceTypes: ['aws_s3_bucket', 'aws_s3_bucket_acl'],
    evaluate: (res) => {
      const acl = res.configuration['acl'];
      return acl === 'public-read' || acl === 'public-read-write';
    },
    recommendation:
      'Set acl to "private" or use aws_s3_bucket_public_access_block to block public access',
  },
  {
    id: 'S3-SEC-002',
    title: 'S3 bucket without encryption',
    description: 'S3 bucket does not have server-side encryption configured',
    severity: 'high',
    resourceTypes: ['aws_s3_bucket'],
    evaluate: (res, all) => {
      // Inline config
      if ('server_side_encryption_configuration' in res.configuration) return false;
      // Separate aws_s3_bucket_server_side_encryption_configuration resource
      if (all?.some(r =>
        r.type === 'aws_s3_bucket_server_side_encryption_configuration' &&
        refMatchesBucket(r.configuration['bucket'], res),
      )) return false;
      return true;
    },
    recommendation: 'Add server_side_encryption_configuration block with AES256 or aws:kms',
  },
  {
    id: 'S3-SEC-003',
    title: 'S3 bucket without versioning',
    description: 'S3 bucket does not have versioning enabled',
    severity: 'medium',
    resourceTypes: ['aws_s3_bucket'],
    evaluate: (res, all) => {
      // Inline config — hcl2json parses nested blocks as arrays
      const v = res.configuration['versioning'];
      if (v !== undefined && v !== null) {
        const vObj: unknown = Array.isArray(v) ? v[0] : v;
        if (vObj !== null && typeof vObj === 'object') {
          if ((vObj as Record<string, unknown>)['enabled'] === true) return false;
        }
      }
      // Separate aws_s3_bucket_versioning resource with status=Enabled
      if (all?.some(r => {
        if (r.type !== 'aws_s3_bucket_versioning') return false;
        if (!refMatchesBucket(r.configuration['bucket'], res)) return false;
        const vc = r.configuration['versioning_configuration'];
        const vcObj: unknown = Array.isArray(vc) ? vc[0] : vc;
        if (vcObj && typeof vcObj === 'object') {
          return String(((vcObj as Record<string, unknown>)['status'] as string | null | undefined) ?? '').toLowerCase() === 'enabled';
        }
        return false;
      })) return false;
      return true;
    },
    recommendation: 'Enable versioning with versioning { enabled = true }',
  },
  {
    id: 'S3-SEC-004',
    title: 'S3 bucket without logging',
    description: 'S3 bucket does not have access logging enabled',
    severity: 'medium',
    resourceTypes: ['aws_s3_bucket'],
    evaluate: (res, all) => {
      // Inline config
      if ('logging' in res.configuration) return false;
      // Separate aws_s3_bucket_logging resource
      if (all?.some(r =>
        r.type === 'aws_s3_bucket_logging' &&
        refMatchesBucket(r.configuration['bucket'], res),
      )) return false;
      return true;
    },
    recommendation: 'Add logging block with target_bucket and target_prefix',
  },
  {
    id: 'S3-SEC-005',
    title: 'S3 bucket missing public access block',
    description: 'S3 bucket does not have aws_s3_bucket_public_access_block with all four block settings enabled',
    severity: 'high',
    resourceTypes: ['aws_s3_bucket'],
    evaluate: (res, all) => {
      // Check for separate aws_s3_bucket_public_access_block resource
      const sibling = all?.find(r =>
        r.type === 'aws_s3_bucket_public_access_block' &&
        refMatchesBucket(r.configuration['bucket'], res),
      );
      if (!sibling) return true; // no block resource at all
      const c = sibling.configuration;
      return !(
        c['block_public_acls'] === true &&
        c['block_public_policy'] === true &&
        c['ignore_public_acls'] === true &&
        c['restrict_public_buckets'] === true
      );
    },
    recommendation:
      'Add aws_s3_bucket_public_access_block with block_public_acls, block_public_policy, ignore_public_acls, restrict_public_buckets all set to true',
  },
  {
    id: 'S3-SEC-006',
    title: 'S3 bucket policy grants public access',
    description:
      'S3 bucket policy has a statement with Effect=Allow and Principal="*" which makes the bucket publicly accessible regardless of ACL settings',
    severity: 'critical',
    resourceTypes: ['aws_s3_bucket_policy'],
    evaluate: (res) => {
      const policy = res.configuration['policy'];
      if (typeof policy !== 'string') return false;
      try {
        const doc = JSON.parse(policy) as Record<string, unknown>;
        const stmts = Array.isArray(doc['Statement']) ? doc['Statement'] : [doc['Statement']];
        return stmts.some((s: unknown) => {
          if (s === null || typeof s !== 'object') return false;
          const stmt = s as Record<string, unknown>;
          if (stmt['Effect'] !== 'Allow') return false;
          const principal = stmt['Principal'];
          if (principal === '*') return true;
          if (principal !== null && typeof principal === 'object') {
            const p = principal as Record<string, unknown>;
            const aws = Array.isArray(p['AWS']) ? p['AWS'] : [p['AWS']];
            return aws.includes('*');
          }
          return false;
        });
      } catch {
        return false;
      }
    },
    recommendation:
      'Remove Principal="*" from Allow statements; use specific IAM principals and enable aws_s3_bucket_public_access_block',
  },
];
