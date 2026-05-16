export interface PaginateOptions {
  /** Maximum number of pages to fetch before stopping. Default: 100. */
  maxPages?: number;
  /** Called synchronously the moment the page cap is hit and there is still a nextToken. */
  onPartial?: () => void;
  /** Optional AbortSignal — checked before each page fetch. */
  signal?: AbortSignal;
}

export interface PaginateResult<T> {
  items: T[];
  /** True when the loop exited because maxPages was reached AND a nextToken was still pending. */
  partial: boolean;
  pagesFetched: number;
}

export async function paginateAll<T>(
  fn: (token: string | undefined) => Promise<{ items: T[]; nextToken?: string }>,
  opts?: PaginateOptions,
): Promise<PaginateResult<T>> {
  const maxPages = Math.max(1, opts?.maxPages ?? 100);
  const items: T[] = [];
  let nextToken: string | undefined;
  let pagesFetched = 0;

  do {
    if (opts?.signal?.aborted) {
      const err = new Error('paginateAll aborted');
      err.name = 'AbortError';
      throw err;
    }
    const r = await fn(nextToken);
    items.push(...r.items);
    nextToken = r.nextToken;
    pagesFetched += 1;
  } while (nextToken !== undefined && pagesFetched < maxPages);

  const partial = nextToken !== undefined;
  if (partial) opts?.onPartial?.();
  return { items, partial, pagesFetched };
}
