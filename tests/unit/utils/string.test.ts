import { describe, it, expect } from 'vitest';
import { levenshtein } from '../../../src/utils/string.js';

describe('levenshtein', () => {
  it('returns 0 for identical strings', () => {
    expect(levenshtein('abc', 'abc')).toBe(0);
    expect(levenshtein('', '')).toBe(0);
    expect(levenshtein('hello world', 'hello world')).toBe(0);
  });

  it('returns the length of the other string when one string is empty', () => {
    expect(levenshtein('', 'abc')).toBe(3);
    expect(levenshtein('abc', '')).toBe(3);
    expect(levenshtein('', 'x')).toBe(1);
  });

  it('counts a single insertion', () => {
    expect(levenshtein('scan', 'scans')).toBe(1);
    expect(levenshtein('cat', 'cats')).toBe(1);
    expect(levenshtein('a', 'ab')).toBe(1);
  });

  it('counts a single deletion', () => {
    expect(levenshtein('scans', 'scan')).toBe(1);
    expect(levenshtein('cats', 'cat')).toBe(1);
    expect(levenshtein('ab', 'a')).toBe(1);
  });

  it('counts a single substitution', () => {
    expect(levenshtein('abc', 'axc')).toBe(1);
    expect(levenshtein('cat', 'hat')).toBe(1);
    expect(levenshtein('a', 'b')).toBe(1);
  });

  it('handles fully different strings of equal length', () => {
    expect(levenshtein('abc', 'def')).toBe(3);
    expect(levenshtein('kitten', 'sittin')).toBe(2);
  });

  it('handles classic kitten/sitting example', () => {
    expect(levenshtein('kitten', 'sitting')).toBe(3);
  });

  it('handles strings with different lengths requiring multiple edits', () => {
    expect(levenshtein('sunday', 'saturday')).toBe(3);
    expect(levenshtein('intention', 'execution')).toBe(5);
  });

  it('is symmetric — distance(a, b) equals distance(b, a)', () => {
    expect(levenshtein('abc', 'def')).toBe(levenshtein('def', 'abc'));
    expect(levenshtein('kitten', 'sitting')).toBe(levenshtein('sitting', 'kitten'));
    expect(levenshtein('scan', 'scans')).toBe(levenshtein('scans', 'scan'));
  });

  it('handles single-character strings', () => {
    expect(levenshtein('a', 'a')).toBe(0);
    expect(levenshtein('a', 'b')).toBe(1);
    expect(levenshtein('a', '')).toBe(1);
    expect(levenshtein('', 'a')).toBe(1);
  });

  it('handles repeated characters correctly', () => {
    expect(levenshtein('aaa', 'aaa')).toBe(0);
    expect(levenshtein('aaa', 'bbb')).toBe(3);
    expect(levenshtein('aaa', 'aa')).toBe(1);
    expect(levenshtein('aa', 'aaa')).toBe(1);
  });

  it('handles strings with spaces and punctuation', () => {
    expect(levenshtein('hello world', 'hello-world')).toBe(1);
    expect(levenshtein('foo bar', 'foo bar')).toBe(0);
  });

  it('is case-sensitive', () => {
    expect(levenshtein('Hello', 'hello')).toBe(1);
    expect(levenshtein('ABC', 'abc')).toBe(3);
  });

  it('handles unicode characters', () => {
    expect(levenshtein('café', 'cafe')).toBe(1);
    expect(levenshtein('abc', 'abc')).toBe(0);
  });

  it('handles strings where one is a prefix of the other', () => {
    expect(levenshtein('aws', 'aws-ec2')).toBe(4);
    expect(levenshtein('aws-ec2', 'aws')).toBe(4);
  });
});
