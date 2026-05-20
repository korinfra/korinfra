/**
 * Shared argument parsing utilities for CLI commands.
 */

/**
 * Extract the value following a named flag from an argument array.
 * Returns null if the flag is not found or has no value.
 * Rejects values that start with `-` (to prevent flag-value collisions).
 */
export function parseArg(args: string[], flag: string, short?: string): string | null {
  // Space form: --flag value (wins if both forms are present)
  const idx = args.findIndex((a) => a === flag || (short !== undefined && a === short));
  if (idx !== -1 && idx + 1 < args.length) {
    const val = args[idx + 1] ?? '';
    if (!val.startsWith('-')) return val;
  }
  // Equals form: --flag=value or -f=value
  const eqPrefix = `${flag}=`;
  const eqShortPrefix = short !== undefined ? `${short}=` : null;
  const eqHit = args.find(
    (a) => a.startsWith(eqPrefix) || (eqShortPrefix !== null && a.startsWith(eqShortPrefix)),
  );
  if (eqHit !== undefined) {
    const value = eqHit.slice(eqHit.indexOf('=') + 1);
    return value === '' || value.startsWith('-') ? null : value;
  }
  return null;
}

export function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

/**
 * Sanitize a user-provided value before interpolating it into an AI prompt.
 * Strips control characters, injection markers, and limits length.
 */
export function sanitizePromptInput(input: string): string {
  return input
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/<\|/g, '')
    .replace(/\|>/g, '')
    .slice(0, 500)
    .trim();
}

/**
 * Sanitize code/HCL content for AI prompts — same stripping but higher length cap.
 * Used for patch_content which can be multi-resource HCL blocks (>>500 chars).
 */
export function sanitizeCodeInput(input: string): string {
  return input
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .replace(/\n{4,}/g, '\n\n\n')
    .replace(/<\|/g, '')
    .replace(/\|>/g, '')
    .slice(0, 8000)
    .trim();
}

