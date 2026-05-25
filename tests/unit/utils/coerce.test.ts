import { describe, it, expect } from 'vitest';
import { asStr, floatValue, boolValue } from '../../../src/utils/coerce.js';

describe('asStr', () => {
  it('returns string values unchanged', () => {
    expect(asStr('hello')).toBe('hello');
    expect(asStr('')).toBe('');
    expect(asStr('  spaces  ')).toBe('  spaces  ');
  });

  it('converts numbers to their string representation', () => {
    expect(asStr(0)).toBe('0');
    expect(asStr(42)).toBe('42');
    expect(asStr(-1)).toBe('-1');
    expect(asStr(1.5)).toBe('1.5');
    expect(asStr(Infinity)).toBe('Infinity');
    expect(asStr(NaN)).toBe('NaN');
  });

  it('converts booleans to their string representation', () => {
    expect(asStr(true)).toBe('true');
    expect(asStr(false)).toBe('false');
  });

  it('returns default empty string for null', () => {
    expect(asStr(null)).toBe('');
  });

  it('returns default empty string for undefined', () => {
    expect(asStr(undefined)).toBe('');
  });

  it('returns custom defaultValue for null', () => {
    expect(asStr(null, 'fallback')).toBe('fallback');
  });

  it('returns custom defaultValue for undefined', () => {
    expect(asStr(undefined, 'none')).toBe('none');
  });

  it('returns default for plain objects to avoid [object Object]', () => {
    expect(asStr({ key: 'val' })).toBe('');
    expect(asStr({ key: 'val' }, 'obj')).toBe('obj');
  });

  it('returns default for arrays to avoid [object Object] style output', () => {
    expect(asStr([1, 2, 3])).toBe('');
    expect(asStr([], 'empty')).toBe('empty');
  });

  it('returns default for function values', () => {
    expect(asStr(() => 'x')).toBe('');
  });

  it('handles unicode strings without modification', () => {
    expect(asStr('こんにちは')).toBe('こんにちは');
    expect(asStr('🚀')).toBe('🚀');
  });
});

describe('floatValue', () => {
  it('returns finite numbers unchanged', () => {
    expect(floatValue(0)).toBe(0);
    expect(floatValue(1)).toBe(1);
    expect(floatValue(-1)).toBe(-1);
    expect(floatValue(1.5)).toBe(1.5);
    expect(floatValue(0.001)).toBe(0.001);
  });

  it('returns 0 for non-finite number inputs', () => {
    expect(floatValue(Infinity)).toBe(0);
    expect(floatValue(-Infinity)).toBe(0);
    expect(floatValue(NaN)).toBe(0);
  });

  it('parses numeric strings to their float value', () => {
    expect(floatValue('0')).toBe(0);
    expect(floatValue('1')).toBe(1);
    expect(floatValue('-1')).toBe(-1);
    expect(floatValue('1.5')).toBe(1.5);
    expect(floatValue('  42  ')).toBe(42);
    expect(floatValue('3.14159')).toBe(3.14159);
  });

  it('parses strings with leading numeric content', () => {
    expect(floatValue('10px')).toBe(10);
    expect(floatValue('2.5em')).toBe(2.5);
  });

  it('returns 0 for non-numeric strings', () => {
    expect(floatValue('')).toBe(0);
    expect(floatValue('abc')).toBe(0);
    expect(floatValue('true')).toBe(0);
    expect(floatValue('null')).toBe(0);
  });

  it('returns 0 for null', () => {
    expect(floatValue(null)).toBe(0);
  });

  it('returns 0 for undefined', () => {
    expect(floatValue(undefined)).toBe(0);
  });

  it('returns 0 for boolean inputs', () => {
    expect(floatValue(true)).toBe(0);
    expect(floatValue(false)).toBe(0);
  });

  it('returns 0 for object inputs', () => {
    expect(floatValue({})).toBe(0);
    expect(floatValue([])).toBe(0);
    expect(floatValue({ value: 42 })).toBe(0);
  });

  it('handles very large and very small finite numbers', () => {
    expect(floatValue(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
    expect(floatValue(Number.MIN_VALUE)).toBe(Number.MIN_VALUE);
  });
});

describe('boolValue', () => {
  it('returns boolean values unchanged', () => {
    expect(boolValue(true)).toBe(true);
    expect(boolValue(false)).toBe(false);
  });

  it('returns true only for the string "true"', () => {
    expect(boolValue('true')).toBe(true);
  });

  it('returns false for all other strings', () => {
    expect(boolValue('false')).toBe(false);
    expect(boolValue('True')).toBe(false);
    expect(boolValue('TRUE')).toBe(false);
    expect(boolValue('yes')).toBe(false);
    expect(boolValue('1')).toBe(false);
    expect(boolValue('on')).toBe(false);
    expect(boolValue('')).toBe(false);
  });

  it('returns false for null', () => {
    expect(boolValue(null)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(boolValue(undefined)).toBe(false);
  });

  it('returns false for numeric inputs', () => {
    expect(boolValue(1)).toBe(false);
    expect(boolValue(0)).toBe(false);
    expect(boolValue(-1)).toBe(false);
    expect(boolValue(NaN)).toBe(false);
  });

  it('returns false for object inputs', () => {
    expect(boolValue({})).toBe(false);
    expect(boolValue({ value: true })).toBe(false);
    expect(boolValue([])).toBe(false);
  });
});
