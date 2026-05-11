import { describe, it, expect } from 'vitest';
import { redact, redactObject } from '../../../src/redaction/index.js';

// ─── Pattern: AWS access keys ─────────────────────────────────────────────────

describe('patterns: AWS access keys', () => {
  it('redacts AKIA, ASIA, AROA keys but not short or lowercase variants', () => {
    expect(redact('key=AKIAIOSFODNN7EXAMPLE', 'minimal')).toBe('key=[ACCESS-KEY]');
    expect(redact('ASIAIOSFODNN7EXAMPLE', 'minimal')).toContain('[ACCESS-KEY]');
    expect(redact('AROAIOSFODNN7EXAMPLE', 'minimal')).toContain('[ACCESS-KEY]');
    expect(redact('short-AKIA', 'minimal')).toBe('short-AKIA');
    expect(redact('akiaiosfodnn7example123456', 'minimal')).toBe('akiaiosfodnn7example123456');
  });
});

// ─── Pattern: secret key=value ────────────────────────────────────────────────

describe('patterns: secret key=value', () => {
  it('redacts password= and token= with long values; ignores short values', () => {
    const pwd = redact('password=supersecretvalue12345678901234', 'minimal');
    expect(pwd).toContain('password=');
    expect(pwd).toContain('[REDACTED]');
    expect(pwd).not.toContain('supersecretvalue');

    const tok = redact('token=ghp_abcdefghijklmnopqrstuvwxyz123456', 'minimal');
    expect(tok).toContain('[REDACTED]');
    expect(tok).not.toContain('ghp_');

    expect(redact('key=short', 'minimal')).toBe('key=short');
  });

  it('redacts provider keys, bearer/jwt tokens, DSNs, and PEM private keys', () => {
    const anthropic = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789';
    expect(redact(anthropic, 'minimal')).toBe('[REDACTED]');

    const openai = 'sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    expect(redact(openai, 'minimal')).toBe('[REDACTED]');

    const githubPat = 'github_pat_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_12345';
    expect(redact(githubPat, 'minimal')).toBe('[REDACTED]');

    const bearer = redact('Authorization: Bearer abcdefghijklmnopqrstuvwxyz1234567890', 'minimal');
    expect(bearer).toContain('Bearer [REDACTED]');
    expect(bearer).not.toContain('abcdefghijklmnopqrstuvwxyz1234567890');

    const jwt = redact(
      'token eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkFsaWNlIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
      'minimal',
    );
    expect(jwt).toContain('[REDACTED]');
    expect(jwt).not.toContain('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9');

    const dsn = redact('postgresql://user:%40pass@db.internal:5432/app?sslmode=require', 'minimal');
    expect(dsn).toBe('[REDACTED]');

    const pem = [
      '-----BEGIN PRIVATE KEY-----',
      'MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQD',
      '-----END PRIVATE KEY-----',
    ].join('\n');
    expect(redact(pem, 'minimal')).toBe('[PRIVATE-KEY]');
  });
});

// ─── Pattern: ARNs, account IDs, IPs, emails, domains ────────────────────────

describe('patterns: ARNs and account IDs', () => {
  it('redacts account ID in ARN at moderate; keeps service prefix; skips at minimal', () => {
    const arnIAM = redact('arn:aws:iam::123456789012:user/alice', 'moderate');
    expect(arnIAM).toContain('[ACCOUNT-ID]');
    expect(arnIAM).not.toContain('123456789012');

    // S3 ARN has no account ID — stays unchanged
    expect(redact('arn:aws:s3:::my-bucket', 'moderate')).toContain('arn:aws:s3');

    // cn partition
    expect(redact('arn:aws-cn:iam::123456789012:user/bob', 'moderate')).toContain('[ACCOUNT-ID]');

    // At minimal, ARN-specific replacement does not fire
    expect(redact('arn:aws:iam::123456789012:role/MyRole', 'minimal')).not.toContain('[ACCESS-KEY]');
  });

  it('redacts standalone 12-digit account IDs at moderate; not at minimal; ignores non-12-digit', () => {
    const result = redact('account: 123456789012', 'moderate');
    expect(result).toContain('[ACCOUNT-ID]');
    expect(result).not.toContain('123456789012');

    expect(redact('account: 123456789012', 'minimal')).toBe('account: 123456789012');
    expect(redact('value: 1234567890', 'moderate')).toBe('value: 1234567890');
  });

  it('redacts account IDs in owner/principal contexts', () => {
    expect(redact('ownerId: 123456789012', 'moderate')).toContain('[ACCOUNT-ID]');
    expect(redact('principal=123456789012', 'moderate')).toContain('[ACCOUNT-ID]');
  });
});

describe('patterns: IP addresses', () => {
  it('redacts public IPs at moderate; private IPs only at strict; nothing at minimal', () => {
    const pub = redact('server at 203.0.113.42', 'moderate');
    expect(pub).toContain('[PUBLIC-IP]');
    expect(pub).not.toContain('203.0.113.42');

    // Private IPs preserved at moderate
    expect(redact('host 10.0.0.1 is internal', 'moderate')).toBe('host 10.0.0.1 is internal');
    expect(redact('host 172.16.0.5', 'moderate')).toBe('host 172.16.0.5');
    expect(redact('host 192.168.1.100', 'moderate')).toBe('host 192.168.1.100');

    // Private IPs redacted at strict
    expect(redact('host 10.0.0.1', 'strict')).toContain('[PRIVATE-IP]');
    expect(redact('host 192.168.1.100', 'strict')).toContain('[PRIVATE-IP]');

    // Nothing at minimal
    expect(redact('server 203.0.113.42 and 10.0.0.1', 'minimal')).toBe('server 203.0.113.42 and 10.0.0.1');
  });
});

describe('patterns: emails and domains', () => {
  it('redacts emails at moderate/strict; domains only at strict', () => {
    expect(redact('contact user@example.com please', 'moderate')).toContain('[EMAIL]');
    expect(redact('contact user@example.com please', 'moderate')).not.toContain('user@example.com');
    expect(redact('admin@example.com', 'minimal')).toBe('admin@example.com');
    expect(redact('owner@company.org', 'strict')).toContain('[EMAIL]');

    expect(redact('visit example.com today', 'strict')).toContain('[REDACTED_DOMAIN]');
    expect(redact('visit example.com today', 'moderate')).not.toContain('[REDACTED_DOMAIN]');
  });
});

// ─── Level behavior (combined) ────────────────────────────────────────────────

describe('redaction levels', () => {
  it('minimal: only access keys and secret values; leaves IPs, account IDs, emails', () => {
    const s = 'user@host.com ip=203.0.113.1 acct=123456789012 key=AKIAIOSFODNN7EXAMPLE';
    const result = redact(s, 'minimal');
    expect(result).toContain('[ACCESS-KEY]');
    expect(result).toContain('user@host.com');
    expect(result).toContain('203.0.113.1');
    expect(result).toContain('123456789012');
  });

  it('moderate: redacts keys, ARNs, account IDs, public IPs, emails; preserves private IPs', () => {
    const s = [
      'key=AKIAIOSFODNN7EXAMPLE',
      'arn:aws:iam::123456789012:role/Admin',
      'ip=203.0.113.5',
      'private=10.0.0.1',
      'email=dev@example.com',
    ].join(' ');
    const result = redact(s, 'moderate');
    expect(result).toContain('[ACCESS-KEY]');
    expect(result).toContain('[ACCOUNT-ID]');
    expect(result).toContain('[PUBLIC-IP]');
    expect(result).toContain('[EMAIL]');
    expect(result).toContain('10.0.0.1'); // private IP preserved
  });

  it('strict: redacts everything including private IPs and domains', () => {
    const result = redact('internal 10.0.0.5 or external 203.0.113.5 visit example.com', 'strict');
    expect(result).toContain('[PRIVATE-IP]');
    expect(result).toContain('[PUBLIC-IP]');
    expect(result).toContain('[REDACTED_DOMAIN]');
  });
});

// ─── redactObject ─────────────────────────────────────────────────────────────

describe('redactObject', () => {
  it('passes null, undefined, and non-string primitives through unchanged', () => {
    expect(redactObject(null, 'strict')).toBeNull();
    expect(redactObject(undefined, 'strict')).toBeUndefined();
    expect(redactObject(42, 'strict')).toBe(42);
    expect(redactObject(true, 'strict')).toBe(true);
  });

  it('redacts string values in flat objects and fully redacts sensitive keys', () => {
    const obj = { ip: '203.0.113.5', name: 'alice' };
    const result = redactObject(obj, 'moderate') as typeof obj;
    expect(result.ip).toContain('[PUBLIC-IP]');
    expect(result.name).toBe('alice');

    expect((redactObject({ password: 'supersecretvalue12345678' }, 'minimal') as Record<string, string>)['password']).toBe('[REDACTED]');
    expect((redactObject({ api_token: 'ghp_sometoken123456789012345678901234' }, 'minimal') as Record<string, string>)['api_token']).toBe('[REDACTED]');
    expect((redactObject({ authorization: 'Bearer abcdefghijklmnopqrstuvwxyz123' }, 'minimal') as Record<string, string>)['authorization']).toBe('[REDACTED]');
    expect((redactObject({ privateKey: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----' }, 'minimal') as Record<string, string>)['privateKey']).toBe('[REDACTED]');
    expect((redactObject({ clientSecret: 'client-secret-value-123456789' }, 'minimal') as Record<string, string>)['clientSecret']).toBe('[REDACTED]');
    expect((redactObject({ idToken: 'id-token-value-123456789' }, 'minimal') as Record<string, string>)['idToken']).toBe('[REDACTED]');
  });

  it('handles nested objects, arrays, and does not mutate the original', () => {
    const nested = { db: { host: '203.0.113.10', password: 'hunter2_longenoughtoredact1234' } };
    const nr = redactObject(nested, 'moderate') as typeof nested;
    expect(nr.db.host).toContain('[PUBLIC-IP]');
    expect(nr.db.password).toBe('[REDACTED]');

    const arr = ['203.0.113.1', 'hello'];
    const ar = redactObject(arr, 'moderate') as string[];
    expect(ar[0]).toContain('[PUBLIC-IP]');
    expect(ar[1]).toBe('hello');

    const objWithArr = { ips: ['203.0.113.1', '10.0.0.1'] };
    const oar = redactObject(objWithArr, 'moderate') as typeof objWithArr;
    expect(oar.ips[0]).toContain('[PUBLIC-IP]');
    expect(oar.ips[1]).toBe('10.0.0.1');

    const orig = { secret: 'mysecretvalue12345678901234' };
    redactObject(orig, 'strict');
    expect(orig.secret).toBe('mysecretvalue12345678901234'); // not mutated
  });

  it('redacts 12-digit numeric account IDs in nested objects', () => {
    const res = redactObject({ ownerId: 123456789012, shortId: 12345 }, 'moderate') as Record<string, unknown>;
    expect(res['ownerId']).toBe('[ACCOUNT-ID]');
    expect(res['shortId']).toBe(12345);
  });

  it('skips prototype-poisoning keys and does not leak them into output', () => {
    const payload = Object.create(null) as Record<string, unknown>;
    payload['__proto__'] = { polluted: true };
    payload['constructor'] = { dangerous: true };
    payload['prototype'] = { chain: true };
    payload['safeEmail'] = 'alice@example.com';

    const out = redactObject(payload, 'moderate') as Record<string, unknown>;
    expect(Object.hasOwn(out, '__proto__')).toBe(false);
    expect(Object.hasOwn(out, 'constructor')).toBe(false);
    expect(Object.hasOwn(out, 'prototype')).toBe(false);
    expect(out['safeEmail']).toBe('[EMAIL]');
  });

  it('handles cyclic references safely', () => {
    const cyclic: Record<string, unknown> = { name: 'alice' };
    cyclic['self'] = cyclic;

    const out = redactObject(cyclic, 'strict') as Record<string, unknown>;
    expect(out['name']).toBe('alice');
    expect(out['self']).toBe('[REDACTED]');
  });

  it('enforces max recursion depth for deeply nested structures', () => {
    const root: Record<string, unknown> = {};
    let cursor: Record<string, unknown> = root;
    for (let i = 0; i < 52; i++) {
      const child: Record<string, unknown> = {};
      cursor['next'] = child;
      cursor = child;
    }

    const out = redactObject(root, 'strict') as Record<string, unknown>;
    let node: unknown = out;
    for (let i = 0; i < 50; i++) {
      node = (node as Record<string, unknown>)['next'];
    }
    expect((node as Record<string, unknown>)['next']).toBe('[REDACTED]');
  });

  it('handles edge cases: empty string and strings with no sensitive data', () => {
    expect(redact('', 'strict')).toBe('');
    expect(redact('Hello, world!', 'moderate')).toBe('Hello, world!');
  });

  it('truncates very large input and still redacts sensitive values in the retained prefix', () => {
    const secretPrefix = 'token=supersecretvalue12345678901234567890 ';
    const veryLargeInput = secretPrefix + 'x'.repeat(1_050_000);

    const out = redact(veryLargeInput, 'minimal');

    expect(out).toContain('token=[REDACTED]');
    expect(out).toContain('[TRUNCATED_FOR_REDACTION]');
    expect(out).not.toContain('supersecretvalue12345678901234567890');
    expect(out.length).toBeLessThan(1_000_100);
  });
});
