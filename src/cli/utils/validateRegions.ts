/**
 * Shared AWS region validation utility.
 * Used by scan, pricing, and resources commands.
 */

const AWS_REGION_RE = /^[a-z]{2}-[a-z]+-\d+$/;

type ValidateRegionsResult =
  | { valid: true }
  | { valid: false; invalid: string[] };

/**
 * Validates that all provided region strings match the AWS region format.
 * An empty array is always valid (means "use default region").
 */
export function validateRegions(regions: string[]): ValidateRegionsResult {
  const invalid = regions.filter((r) => !AWS_REGION_RE.test(r));
  if (invalid.length === 0) return { valid: true };
  return { valid: false, invalid };
}
