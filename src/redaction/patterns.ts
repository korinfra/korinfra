// Pre-compiled regex patterns for sensitive data detection.
// Ported from Go: internal/redaction/patterns.go

// AWS access key IDs: AKIA*, ASIA*, AROA*, AIDA*, ANPA*, ANVA*, APKA* (20 chars)
export const reAccessKey = /\b(A3T[A-Z0-9]|AKIA|ASIA|AROA|AIDA|ANPA|ANVA|APKA|AIRO|ARES)[A-Z0-9]{16}\b/g;

// AWS ARNs: arn:aws:service:region:account-id:resource
export const reARN = /arn:aws[a-z-]*:[a-z0-9-]+:[a-z0-9-]*:([0-9]{12}):[a-zA-Z0-9/_:.*-]{0,512}/g;

// AWS account IDs — only match in typical account ID contexts to avoid false positives:
// - After the account segment of an ARN: arn:aws:iam::123456789012:
// - In JSON account-like fields: "accountId": "123456789012", "owner": "123456789012"
// - After account/owner/principal labels: owner_id = "123456789012", principal: 123456789012
// Capture group 1 = leading context, group 2 = the 12-digit ID.
export const reAccountID = /((?:arn:[a-z0-9-]*:[a-z0-9-]*:[a-z0-9-]*:|(?:account|owner|principal)[_-]?(?:id)?["'\s:=]+|"(?:account|owner|principal)(?:[_-]?id)?"\s*:\s*"))(?<![-:])([0-9]{12})(?![-:])/gi;

// All IPv4 addresses — private filtering done in code
export const rePublicIPv4 = /\b(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9][0-9]|[0-9])\.(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9][0-9]|[0-9])\.(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9][0-9]|[0-9])\.(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9][0-9]|[0-9])\b/g;

// Private IPv4 prefixes (RFC-1918)
export const rePrivateIPv4 =
  /\b(10\.(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9][0-9]|[0-9])\.(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9][0-9]|[0-9])\.(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9][0-9]|[0-9])|172\.(1[6-9]|2[0-9]|3[01])\.(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9][0-9]|[0-9])\.(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9][0-9]|[0-9])|192\.168\.(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9][0-9]|[0-9])\.(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9][0-9]|[0-9]))\b/g;

// IPv6 addresses — full, compressed, and loopback forms.
// Negative lookbehind (?<![a-zA-Z]) prevents matching hex-like segments inside
// ARN service names (e.g. "s3" in "arn:aws:s3:::bucket" should not match).
export const rePublicIPv6 =
  /(?<![a-zA-Z])(?:(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|(?:[0-9a-fA-F]{1,4}:){1,7}:|(?:[0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|(?:[0-9a-fA-F]{1,4}:){1,5}(?::[0-9a-fA-F]{1,4}){1,2}|(?:[0-9a-fA-F]{1,4}:){1,4}(?::[0-9a-fA-F]{1,4}){1,3}|(?:[0-9a-fA-F]{1,4}:){1,3}(?::[0-9a-fA-F]{1,4}){1,4}|(?:[0-9a-fA-F]{1,4}:){1,2}(?::[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:(?::[0-9a-fA-F]{1,4}){1,6}|:(?::[0-9a-fA-F]{1,4}){1,7}|::(?:[fF]{4}(?::0{1,4})?:)?(?:25[0-5]|(?:2[0-4]|1?[0-9])?[0-9])(?:\.(?:25[0-5]|(?:2[0-4]|1?[0-9])?[0-9])){3})/g;

// Generic secret key patterns (key=value style)
export const reSecretKey =
  /(?:secret[_-]?access[_-]?key|secret[_-]?key|secret|password|passwd|pwd|token|api[_-]?key)\s*[=:]\s*["']?([^\s"']{8,})["']?/gi;

// JSON-format secret key patterns: "KeyName": "value"
export const reSecretKeyJson =
  /"(?:SecretAccessKey|secret_access_key|api_key|apiKey|AccessKeyId|access_key_id|password|token|sessionToken|session_token)"\s*:\s*"([^"]{8,})"/gi;

// Email addresses — bounded quantifiers (RFC 5321: local ≤64, domain ≤253, TLD ≤63)
// to prevent polynomial backtracking (ReDoS) on no-match inputs with many dots.
export const reEmail = /\b[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,63}\b/g;

// Domain names (simple pattern — AWS-service filtering done in code)
export const reDomain = /\b([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}\b/g;

// Sensitive keyword list — keys whose values should always be redacted.
// isSensitiveKey splits the key on camelCase boundaries, underscores, and hyphens,
// then checks exact-word matches against sensitiveExactWords, and consecutive-word
// matches against sensitiveCompoundPatterns.
export const sensitiveExactWords = new Set([
  'password', 'passwd', 'pwd', 'secret', 'apikey', 'privatekey', 'confidential',
  'token', 'authorization',
  'api_key', 'keyid', 'keymaterial', 'private_key',
]);

// Consecutive word pairs that indicate a sensitive field when they appear together.
export const sensitiveCompoundPatterns: ReadonlyArray<readonly [string, string]> = [
  ['access', 'key'],
  ['secret', 'key'],
  ['client', 'secret'],
  ['api', 'key'],
  ['private', 'key'],
  ['api', 'token'],
  ['auth', 'token'],
  ['access', 'token'],
  ['id', 'token'],
  ['session', 'token'],
  ['refresh', 'token'],
  ['bearer', 'token'],
  ['subnet', 'id'],
  ['security', 'group'],
  ['vpc', 'id'],
  ['parameter', 'value'],
  ['db', 'password'],
  ['user', 'password'],
];

// Legacy flat array kept for redactor.ts regex patterns — not used for key matching.
export const sensitiveKeywords: string[] = [
  'password', 'passwd', 'pwd', 'secret', 'apikey', 'secretkey', 'accesskey',
  'privatekey', 'confidential', 'authtoken', 'accesstoken', 'sessiontoken',
];

// GitHub Personal Access Tokens (classic ghp_/gho_ and fine-grained github_pat_)
export const reGitHubPAT =
  /\bgh(?:p|o|u|s|r)_[A-Za-z0-9]{36}\b|\bgithub_pat_[A-Za-z0-9_]{20,255}\b/g;

// JSON Web Tokens — three base64url segments separated by dots
export const reJWT =
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;

// Bearer tokens in Authorization headers — keep the "Bearer " prefix, redact the token
export const reBearer = /\bBearer\s+([A-Za-z0-9._-]{20,})/gi;

// Anthropic API keys (sk-ant-api03-* and legacy sk-ant-*)
export const reAnthropicKey = /\bsk-ant-(?:api\d+-)?[A-Za-z0-9_-]{20,}\b/g;

// OpenAI API keys (legacy sk-* and project-scoped sk-proj-*)
export const reOpenAIKey = /\bsk-(?:proj-[A-Za-z0-9_-]{20,}|[A-Za-z0-9]{20,})\b/g;

// PEM private key blocks (RSA, EC, DSA, OPENSSH)
export const rePrivateKeyBlock =
  /-----BEGIN(?: RSA| EC| DSA| OPENSSH)? PRIVATE KEY-----[\s\S]*?-----END(?: RSA| EC| DSA| OPENSSH)? PRIVATE KEY-----/g;

// Database connection string DSNs (postgresql, mysql, mongodb, redis, amqp)
export const reDSN = /(?:postgresql|postgres|mysql|mongodb(?:\+srv)?|redis|amqps?|amqp):\/\/[^@\s"']{4,}@[^\s"']{4,}/gi;
