import { describe, it, expect } from 'vitest';
import { parseArg, hasFlag, sanitizePromptInput, sanitizeCodeInput } from '../../../src/cli/utils/parseArgs.js';

describe('parseArg', () => {
  describe('space form (existing behavior)', () => {
    it('returns value after flag', () => {
      expect(parseArg(['--filter', 'ec2'], '--filter')).toBe('ec2');
    });

    it('returns value for short flag', () => {
      expect(parseArg(['-f', 'ec2'], '--filter', '-f')).toBe('ec2');
    });

    it('returns null when flag is absent', () => {
      expect(parseArg(['--other', 'val'], '--filter')).toBeNull();
    });

    it('returns null when flag is last arg with no value', () => {
      expect(parseArg(['--filter'], '--filter')).toBeNull();
    });

    it('returns null when next token starts with -', () => {
      expect(parseArg(['--filter', '-x'], '--filter')).toBeNull();
    });
  });

  describe('equals form (new behavior)', () => {
    it('returns value from --flag=value', () => {
      expect(parseArg(['--filter=ec2'], '--filter')).toBe('ec2');
    });

    it('returns value from -f=value short form', () => {
      expect(parseArg(['-f=ec2'], '--filter', '-f')).toBe('ec2');
    });

    it('returns null for empty equals value (--filter=)', () => {
      expect(parseArg(['--filter='], '--filter')).toBeNull();
    });

    it('returns null when equals value starts with -', () => {
      expect(parseArg(['--filter=-x'], '--filter')).toBeNull();
    });

    it('ignores equals form for a short flag when no short is provided', () => {
      expect(parseArg(['-f=ec2'], '--filter')).toBeNull();
    });
  });

  describe('precedence: space form wins over equals form', () => {
    it('returns space-form value when both forms are present', () => {
      expect(parseArg(['--filter=foo', '--filter', 'bar'], '--filter')).toBe('bar');
    });

    it('falls through to equals form when space-form next token starts with -', () => {
      expect(parseArg(['--filter', '--other', '--filter=ec2'], '--filter')).toBe('ec2');
    });
  });
});

describe('hasFlag', () => {
  it('returns true when flag is present', () => {
    expect(hasFlag(['--verbose', '--filter', 'ec2'], '--verbose')).toBe(true);
  });

  it('returns false when flag is absent', () => {
    expect(hasFlag(['--filter', 'ec2'], '--verbose')).toBe(false);
  });
});

describe('sanitizePromptInput', () => {
  it('strips control characters and trims', () => {
    expect(sanitizePromptInput('  hello\x00world  ')).toBe('helloworld');
  });

  it('collapses 3+ consecutive newlines to 2', () => {
    expect(sanitizePromptInput('a\n\n\n\nb')).toBe('a\n\nb');
  });

  it('strips injection markers', () => {
    expect(sanitizePromptInput('<|inject|>')).toBe('inject');
  });

  it('truncates to 500 characters', () => {
    expect(sanitizePromptInput('x'.repeat(600))).toHaveLength(500);
  });
});

describe('sanitizeCodeInput', () => {
  it('strips control characters', () => {
    expect(sanitizeCodeInput('code\x00block')).toBe('codeblock');
  });

  it('truncates to 8000 characters', () => {
    expect(sanitizeCodeInput('x'.repeat(9000))).toHaveLength(8000);
  });
});
