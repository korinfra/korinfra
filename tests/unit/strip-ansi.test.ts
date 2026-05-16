import { describe, it, expect } from 'vitest';
import { stripAnsi } from '../../src/cli/ui/text.js';

const ESC = '\u001B';
const CSI8 = '\u009B';
const BEL = '\u0007';
const DEL = '\u007F';

describe('stripAnsi', () => {
  it('returns plain ASCII unchanged', () => {
    expect(stripAnsi('hello world')).toBe('hello world');
  });

  it('preserves tab, newline, and carriage return', () => {
    expect(stripAnsi('a\tb\nc\rd')).toBe('a\tb\nc\rd');
  });

  it('strips ANSI SGR colour and reset codes', () => {
    expect(stripAnsi(`${ESC}[31mEVIL${ESC}[0m bucket`)).toBe('EVIL bucket');
    expect(stripAnsi(`${ESC}[1;31;42mEVIL${ESC}[0m`)).toBe('EVIL');
  });

  it('strips ANSI screen-clearing sequences', () => {
    expect(stripAnsi(`${ESC}[2J${ESC}[Hpwned`)).toBe('pwned');
  });

  it('strips bare BEL, ESC, and DEL', () => {
    expect(stripAnsi(`a${BEL}b`)).toBe('ab');
    expect(stripAnsi(`a${ESC}b`)).toBe('ab');
    expect(stripAnsi(`a${DEL}b`)).toBe('ab');
  });

  it('removes 8-bit CSI sequences (U+009B)', () => {
    expect(stripAnsi(`${CSI8}31mEVIL${CSI8}0m`)).toBe('EVIL');
  });

  it('does not change benign AWS resource names', () => {
    expect(stripAnsi('my-bucket-prod')).toBe('my-bucket-prod');
    expect(stripAnsi('arn:aws:s3:::my-bucket')).toBe('arn:aws:s3:::my-bucket');
    expect(stripAnsi('i-0abc1234def5678')).toBe('i-0abc1234def5678');
  });

  it('handles empty string', () => {
    expect(stripAnsi('')).toBe('');
  });
});
