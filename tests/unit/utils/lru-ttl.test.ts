import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { LruTtl } from '../../../src/utils/lru-ttl.js';

describe('LruTtl', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('get returns undefined for missing key', () => {
    const cache = new LruTtl<string, number>(3, 1000);
    expect(cache.get('missing')).toBeUndefined();
  });

  it('set then get returns the value', () => {
    const cache = new LruTtl<string, number>(3, 1000);
    cache.set('a', 1);
    expect(cache.get('a')).toBe(1);
  });

  it('set over maxSize evicts the oldest entry (insertion-order)', () => {
    const cache = new LruTtl<string, number>(2, 1000);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    expect(cache.has('a')).toBe(false);
    expect(cache.get('b')).toBe(2);
    expect(cache.get('c')).toBe(3);
    expect(cache.size).toBe(2);
  });

  it('get refreshes LRU order so subsequent set over maxSize evicts a different key', () => {
    const cache = new LruTtl<string, number>(2, 1000);
    cache.set('a', 1);
    cache.set('b', 2);
    // Touch 'a' so 'b' becomes the oldest
    expect(cache.get('a')).toBe(1);
    cache.set('c', 3);
    expect(cache.has('b')).toBe(false);
    expect(cache.get('a')).toBe(1);
    expect(cache.get('c')).toBe(3);
  });

  it('get returns undefined after TTL expires and removes the entry', () => {
    const cache = new LruTtl<string, number>(3, 1000);
    cache.set('a', 1);
    expect(cache.size).toBe(1);
    vi.advanceTimersByTime(1001);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it('has returns true for live entry, false for expired, false for missing', () => {
    const cache = new LruTtl<string, number>(3, 1000);
    cache.set('a', 1);
    expect(cache.has('a')).toBe(true);
    expect(cache.has('missing')).toBe(false);
    vi.advanceTimersByTime(1001);
    expect(cache.has('a')).toBe(false);
  });

  it('delete returns true for existing key, false for missing; removes the entry', () => {
    const cache = new LruTtl<string, number>(3, 1000);
    cache.set('a', 1);
    expect(cache.delete('a')).toBe(true);
    expect(cache.has('a')).toBe(false);
    expect(cache.delete('a')).toBe(false);
    expect(cache.delete('never-existed')).toBe(false);
  });

  it('clear empties the map', () => {
    const cache = new LruTtl<string, number>(3, 1000);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBeUndefined();
  });

  it('re-setting an existing key updates value and refreshes LRU order', () => {
    const cache = new LruTtl<string, number>(2, 1000);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('a', 11); // updates value and moves 'a' to MRU position
    expect(cache.size).toBe(2);
    expect(cache.get('a')).toBe(11);
    // Adding a third should evict 'b' since 'a' is now MRU
    cache.set('c', 3);
    expect(cache.has('b')).toBe(false);
    expect(cache.get('a')).toBe(11);
    expect(cache.get('c')).toBe(3);
  });

  it('size reflects current map size', () => {
    const cache = new LruTtl<string, number>(3, 1000);
    expect(cache.size).toBe(0);
    cache.set('a', 1);
    expect(cache.size).toBe(1);
    cache.set('b', 2);
    expect(cache.size).toBe(2);
    cache.delete('a');
    expect(cache.size).toBe(1);
    cache.clear();
    expect(cache.size).toBe(0);
  });
});
