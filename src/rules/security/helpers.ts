/**
 * Shared security rule helpers.
 */

const AKIA_RE = /\bAKIA[A-Z0-9]{16}\b/;
const ASIA_RE = /\bASIA[A-Z0-9]{16}\b/;
const AROA_RE = /\bAROA[A-Z0-9]{16}\b/;

export function containsCredentialPatterns(text: string): boolean {
  if (!text) return false;
  const upper = text.toUpperCase();
  return AKIA_RE.test(upper) || ASIA_RE.test(upper) || AROA_RE.test(upper) ||
    upper.includes('AWS_SECRET_ACCESS_KEY') ||
    upper.includes('AWS_ACCESS_KEY_ID') ||
    /password\s*=\s*\S+/i.test(text);
}
