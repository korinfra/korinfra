/**
 * Integration tests for src/mcp/resources.ts — redaction verification (2E).
 *
 * The MCP resources layer calls redactObject(config, 'moderate') before
 * serialising configuration for external consumers. This test suite confirms
 * that sensitive fields (e.g. token-named fields that isSensitiveKey matches)
 * are absent from the serialised output — and that the raw value never leaks.
 */

import { describe, it, expect } from 'vitest';
import { redactObject } from '../../../src/redaction/redactor.js';

// ---------------------------------------------------------------------------
// We test the redaction boundary directly — the RESOURCES array in
// src/mcp/resources.ts calls redactObject(config, 'moderate') before returning.
// Rather than spinning up a full MCP Server (which requires live DB + net),
// we exercise redactObject directly with config-shaped payloads that mirror
// what loadConfig() returns, and assert the security property holds.
// ---------------------------------------------------------------------------

describe('MCP resources — redactObject applied to config (2E)', () => {
  it('redacts token_env field value (isSensitiveKey matches "token")', () => {
    // Simulate a config object shaped like korinfraConfig.github
    const configLike = {
      github: {
        token_env: 'ghp_realLookingToken1234567890ABCDE',
        default_org: 'my-org',
        pr_draft: true,
      },
    };

    const redacted = redactObject(configLike, 'moderate') as {
      github: { token_env: unknown; default_org: unknown };
    };

    // token_env: 'token' is in sensitiveExactWords, so entire value is [REDACTED]
    expect(redacted.github.token_env).toBe('[REDACTED]');
    expect(redacted.github.token_env).not.toBe('ghp_realLookingToken1234567890ABCDE');

    // Non-sensitive fields pass through unchanged
    expect(redacted.github.default_org).toBe('my-org');
  });

  it('does not expose raw GitHub PAT in serialised JSON output', () => {
    const rawToken = 'ghp_realLookingToken1234567890ABCDE';
    const configLike = {
      github: {
        token_env: rawToken,
        pr_draft: false,
      },
    };

    const redacted = redactObject(configLike, 'moderate');
    const serialised = JSON.stringify(redacted, null, 2);

    // The raw PAT value must never appear in what gets sent to an MCP client
    expect(serialised).not.toContain(rawToken);
    expect(serialised).toContain('[REDACTED]');
  });

  it('redacts api_key_env field (isSensitiveKey matches compound ["api","key"])', () => {
    const configLike = {
      ai: {
        api_key_env: 'sk-ant-api03-MyRealKey1234567890',
        model: 'claude-sonnet-4-6',
      },
    };

    const redacted = redactObject(configLike, 'moderate') as {
      ai: { api_key_env: unknown; model: unknown };
    };

    // api_key_env splits to ['api','key','env']; 'api'+'key' matches compound pattern
    expect(redacted.ai.api_key_env).toBe('[REDACTED]');
    expect(redacted.ai.model).toBe('claude-sonnet-4-6');
  });

  it('redacts nested secret values at any depth', () => {
    const configLike = {
      level1: {
        level2: {
          token: 'supersecretvalue12345678',
          safe: 'keep-me',
        },
      },
    };

    const redacted = redactObject(configLike, 'moderate') as {
      level1: { level2: { token: unknown; safe: unknown } };
    };

    expect(redacted.level1.level2.token).toBe('[REDACTED]');
    expect(redacted.level1.level2.safe).toBe('keep-me');
  });

  it('does not leak token through JSON.stringify after redactObject', () => {
    // Verify the full pipeline: redact → serialise → check raw string
    const sensitiveConfig = {
      github: { token_env: 'ghp_ShouldNotAppear1234567890ABCD' },
      ai: { api_key_env: 'sk-ant-api03-ShouldNotAppear12345' },
    };

    const output = JSON.stringify(redactObject(sensitiveConfig, 'moderate'));

    expect(output).not.toContain('ghp_ShouldNotAppear1234567890ABCD');
    expect(output).not.toContain('sk-ant-api03-ShouldNotAppear12345');
  });
});
