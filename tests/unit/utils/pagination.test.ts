import { describe, it, expect, vi } from 'vitest';
import { paginateAll } from '../../../src/utils/pagination.js';

describe('paginateAll', () => {
  it('returns a single page when nextToken is undefined on first call', async () => {
    const fn = vi.fn().mockResolvedValue({ items: [1, 2, 3] });
    const result = await paginateAll<number>(fn);

    expect(result.items).toEqual([1, 2, 3]);
    expect(result.partial).toBe(false);
    expect(result.pagesFetched).toBe(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('fetches multiple pages under the cap and concatenates items in order', async () => {
    const pages = [
      { items: [1, 2], nextToken: 't1' },
      { items: [3, 4], nextToken: 't2' },
      { items: [5, 6] },
    ];
    const fn = vi.fn().mockImplementation(async () => pages.shift() ?? { items: [] });

    const result = await paginateAll<number>(fn, { maxPages: 10 });

    expect(result.items).toEqual([1, 2, 3, 4, 5, 6]);
    expect(result.partial).toBe(false);
    expect(result.pagesFetched).toBe(3);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('returns partial=false when pagesFetched equals maxPages but no nextToken remains', async () => {
    const pages = [
      { items: ['a'], nextToken: 't1' },
      { items: ['b'] },
    ];
    const fn = vi.fn().mockImplementation(async () => pages.shift() ?? { items: [] });
    const onPartial = vi.fn();

    const result = await paginateAll<string>(fn, { maxPages: 2, onPartial });

    expect(result.items).toEqual(['a', 'b']);
    expect(result.partial).toBe(false);
    expect(result.pagesFetched).toBe(2);
    expect(onPartial).not.toHaveBeenCalled();
  });

  it('returns partial=true when maxPages is hit and more data remains; calls onPartial once', async () => {
    const fn = vi.fn().mockImplementation(async (token: string | undefined) => {
      // Always returns more data
      const next = token === undefined ? 't1' : `${token}+`;
      return { items: [token ?? 'first'], nextToken: next };
    });
    const onPartial = vi.fn();

    const result = await paginateAll<string>(fn, { maxPages: 2, onPartial });

    expect(result.pagesFetched).toBe(2);
    expect(result.partial).toBe(true);
    expect(result.items).toEqual(['first', 't1']);
    expect(onPartial).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('does not call onPartial when partial is false', async () => {
    const fn = vi.fn().mockResolvedValue({ items: [1] });
    const onPartial = vi.fn();

    const result = await paginateAll<number>(fn, { onPartial });

    expect(result.partial).toBe(false);
    expect(onPartial).not.toHaveBeenCalled();
  });

  it('passes nextToken from the previous page to the next fn call', async () => {
    const pages = [
      { items: ['a'], nextToken: 'tok1' },
      { items: ['b'], nextToken: 'tok2' },
      { items: ['c'] },
    ];
    const fn = vi.fn().mockImplementation(async (_token: string | undefined) => {
      return pages.shift() ?? { items: [] };
    });

    await paginateAll<string>(fn, { maxPages: 10 });

    expect(fn).toHaveBeenNthCalledWith(1, undefined);
    expect(fn).toHaveBeenNthCalledWith(2, 'tok1');
    expect(fn).toHaveBeenNthCalledWith(3, 'tok2');
  });

  it('accumulates items in order across pages', async () => {
    const pages = [
      { items: ['p1-a', 'p1-b'], nextToken: 'n1' },
      { items: ['p2-a', 'p2-b'], nextToken: 'n2' },
      { items: ['p3-a'] },
    ];
    const fn = vi.fn().mockImplementation(async () => pages.shift() ?? { items: [] });

    const result = await paginateAll<string>(fn, { maxPages: 10 });

    expect(result.items).toEqual(['p1-a', 'p1-b', 'p2-a', 'p2-b', 'p3-a']);
  });

  it('throws AbortError when signal is already aborted before invocation', async () => {
    const controller = new AbortController();
    controller.abort();
    const fn = vi.fn().mockResolvedValue({ items: [] });

    await expect(paginateAll(fn, { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(fn).not.toHaveBeenCalled();
  });

  it('clamps maxPages=0 to 1 and fetches exactly one page', async () => {
    const fn = vi.fn().mockResolvedValue({ items: [1, 2], nextToken: 'more' });
    const onPartial = vi.fn();

    const result = await paginateAll<number>(fn, { maxPages: 0, onPartial });

    expect(fn).toHaveBeenCalledTimes(1);
    expect(result.pagesFetched).toBe(1);
    expect(result.partial).toBe(true);
    expect(result.items).toEqual([1, 2]);
    expect(onPartial).toHaveBeenCalledTimes(1);
  });

  it('handles an empty first page with no nextToken', async () => {
    const fn = vi.fn().mockResolvedValue({ items: [] });

    const result = await paginateAll<string>(fn);

    expect(result.items).toEqual([]);
    expect(result.partial).toBe(false);
    expect(result.pagesFetched).toBe(1);
  });
});
