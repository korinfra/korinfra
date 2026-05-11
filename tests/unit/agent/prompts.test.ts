/**
 * Tests for src/agent/prompts.ts.
 * Verifies correct tool names and absence of old wrong tool names.
 */

import { describe, it, expect } from 'vitest';
import { prompts, getPrompt } from '../../../src/agent/prompts.js';

// ─── Tool names: present and absent ──────────────────────────────────────────

describe('prompt tool names — correct names present, old names absent', () => {
  it('GENERAL_PROMPT contains expected tools and not old names', () => {
    expect(prompts.general).toContain('collect_aws_resources');
    expect(prompts.general).toContain('get_costs');
    expect(prompts.general).toContain('scan_terraform');
    expect(prompts.general).not.toMatch(/\baws_resources\b/);
    expect(prompts.general).not.toMatch(/\baws_costs\b/);
    expect(prompts.general).not.toMatch(/\bterraform_analyze\b/);
  });

  it('SCAN_PROMPT contains expected tools and not old names', () => {
    expect(prompts.scan).toContain('get_costs');
    expect(prompts.scan).toContain('collect_aws_resources');
    expect(prompts.scan).toContain('evaluate_rules');
    expect(prompts.scan).not.toMatch(/\baws_costs\b/);
    expect(prompts.scan).not.toMatch(/\baws_resources\b/);
  });

  it('FIX_PROMPT contains expected tools and not old names', () => {
    expect(prompts.fix).toContain('collect_aws_resources');
    expect(prompts.fix).toContain('scan_terraform');
    expect(prompts.fix).not.toMatch(/\baws_resources\b/);
    expect(prompts.fix).not.toMatch(/\bterraform_analyze\b/);
  });

  it('SECURITY_PROMPT contains expected tools and not old names', () => {
    expect(prompts.security).toContain('collect_aws_resources');
    expect(prompts.security).toContain('scan_terraform');
    expect(prompts.security).not.toMatch(/\baws_resources\b/);
  });
});

// ─── Shared BASE content in all prompts ──────────────────────────────────────

describe('BASE_FINOPS_PROMPT content shared across all prompts', () => {
  it('all prompts contain FinOps identity, savings, confidence, and style rules', () => {
    expect(prompts.general).toContain('FinOps');
    for (const [key, prompt] of Object.entries(prompts)) {
      expect(prompt, `${key}: estimated monthly savings`).toContain('estimated monthly savings');
      expect(prompt, `${key}: Confidence`).toContain('Confidence');
      // All prompts include base style rules
      expect(prompt, `${key}: emojis sparingly`).toContain('emojis sparingly');
    }
  });
});

// ─── Per-prompt content ───────────────────────────────────────────────────────

describe('per-prompt content checks', () => {
  it('SCAN_PROMPT mentions deduplication, save_scan, and rightsizing', () => {
    expect(prompts.scan).toContain('deduplicate');
    expect(prompts.scan).toContain('save_scan');
    expect(prompts.scan).toContain('Rightsizing');
  });

  it('FIX_PROMPT contains safety rules, terraform, and rollback', () => {
    expect(prompts.fix).toContain('SAFETY RULES');
    expect(prompts.fix).toContain('terraform');
    expect(prompts.fix).toContain('rollback');
  });

  it('SECURITY_PROMPT mentions scan_security, collect_aws_resources, and severity levels', () => {
    expect(prompts.security).toContain('scan_security');
    expect(prompts.security).toContain('collect_aws_resources');
    expect(prompts.security).toContain('CRITICAL');
  });
});

// ─── getPrompt helper ─────────────────────────────────────────────────────────

describe('getPrompt', () => {
  it('routes to correct prompt and falls back to general for unknown/empty/undefined', () => {
    expect(getPrompt()).toBe(prompts.general);
    expect(getPrompt(undefined)).toBe(prompts.general);
    expect(getPrompt('')).toBe(prompts.general);
    expect(getPrompt('unknown-cmd')).toBe(prompts.general);

    expect(getPrompt('scan')).toBe(prompts.scan);
    expect(getPrompt('fix')).toBe(prompts.fix);
    expect(getPrompt('security')).toBe(prompts.security);
    expect(getPrompt('costs')).toBe(prompts.costs);
  });
});
