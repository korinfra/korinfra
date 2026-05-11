/**
 * Tests for src/github/client.ts — GitHubClient with mocked fetch.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GitHubClient } from '../../../src/github/client.js';

function makeFetchResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  const headersMap = new Map<string, string>(Object.entries(headers));
  return {
    status,
    headers: { get: (key: string) => headersMap.get(key) ?? null },
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

function mockFetch(response: Response): void {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
}

function mockFetchOnce(...responses: Response[]): void {
  const mockFn = vi.fn();
  for (const resp of responses) mockFn.mockResolvedValueOnce(resp);
  vi.stubGlobal('fetch', mockFn);
}

const VALID_TOKEN = 'ghp_test_token_abc123';

beforeEach(() => { delete process.env['GITHUB_TOKEN']; });
afterEach(() => { vi.unstubAllGlobals(); delete process.env['GITHUB_TOKEN']; });

// ---------------------------------------------------------------------------
// Constructor
// ---------------------------------------------------------------------------

describe('GitHubClient — constructor', () => {
  it('accepts valid tokens, reads env, throws when missing, initialises rate limit fields', () => {
    expect(() => new GitHubClient(VALID_TOKEN)).not.toThrow();

    process.env['GITHUB_TOKEN'] = 'ghp_env_token';
    expect(() => new GitHubClient()).not.toThrow();
    delete process.env['GITHUB_TOKEN'];

    expect(() => new GitHubClient('')).toThrow('GitHub token is required');
    expect(() => new GitHubClient(undefined)).toThrow('GitHub token is required');

    const client = new GitHubClient(VALID_TOKEN);
    expect(client.rateLimitRemaining).toBe(5000);
    expect(client.rateLimitReset).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// GET
// ---------------------------------------------------------------------------

describe('GitHubClient.get', () => {
  it('makes GET requests with correct URL, method, and required headers', async () => {
    mockFetch(makeFetchResponse(200, { login: 'vladimirmocanu' }));
    const client = new GitHubClient(VALID_TOKEN);
    await client.get('/user');

    const fetchMock = vi.mocked(fetch);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.github.com/user');
    expect(init.method).toBe('GET');
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe(`Bearer ${VALID_TOKEN}`);
    expect(headers['Accept']).toBe('application/vnd.github+json');
    expect(headers['X-GitHub-Api-Version']).toBe('2022-11-28');
  });

  it('returns null for 204 and parsed JSON for 200', async () => {
    mockFetch(makeFetchResponse(204, null, { 'Content-Length': '0' }));
    expect(await new GitHubClient(VALID_TOKEN).get('/repos/acme/infra/pulls/1/merge')).toBeNull();

    const payload = { number: 42, title: 'cost: reduce EC2 spend', state: 'open' };
    mockFetch(makeFetchResponse(200, payload));
    expect(await new GitHubClient(VALID_TOKEN).get('/repos/acme/infra/pulls/42')).toEqual(payload);
  });

  it('throws on 4xx and 5xx errors with correct messages', async () => {
    mockFetch(makeFetchResponse(404, { message: 'Not Found' }));
    await expect(new GitHubClient(VALID_TOKEN).get('/repos/acme/nonexistent')).rejects.toThrow('GitHub API error 404: Not Found');

    mockFetch(makeFetchResponse(403, { message: 'API rate limit exceeded for ...' }));
    await expect(new GitHubClient(VALID_TOKEN).get('/user')).rejects.toThrow('403');

    mockFetch(makeFetchResponse(401, { message: 'Bad credentials' }));
    await expect(new GitHubClient(VALID_TOKEN).get('/user')).rejects.toThrow('401');

    mockFetch(makeFetchResponse(500, 'Internal Server Error'));
    await expect(new GitHubClient(VALID_TOKEN).get('/user')).rejects.toThrow('GitHub API error: status 500');
  });
});

// ---------------------------------------------------------------------------
// POST
// ---------------------------------------------------------------------------

describe('GitHubClient.post', () => {
  it('makes POST requests with JSON body, Content-Type header, and returns parsed response', async () => {
    const prPayload = {
      number: 7, html_url: 'https://github.com/acme/infra/pull/7',
      title: 'korinfra: Cost Optimization Changes', state: 'open', draft: false,
      created_at: '2026-03-01T12:00:00Z',
    };
    mockFetch(makeFetchResponse(201, prPayload));
    const body = { title: 'korinfra: Cost Optimization Changes', body: '## Summary', head: 'korinfra/cost-opt-2026-03-01', base: 'main', draft: false };
    await new GitHubClient(VALID_TOKEN).post('/repos/acme/infra/pulls', body);

    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.github.com/repos/acme/infra/pulls');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual(body);
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');

    const label = { id: 1, name: 'cost-optimization', color: 'e4e669' };
    mockFetch(makeFetchResponse(201, label));
    expect(await new GitHubClient(VALID_TOKEN).post<typeof label>('/repos/acme/infra/labels', label)).toEqual(label);

    mockFetch(makeFetchResponse(422, { message: 'Validation Failed' }));
    await expect(new GitHubClient(VALID_TOKEN).post('/repos/acme/infra/pulls', { head: 'main', base: 'main' })).rejects.toThrow('422');
  });
});

// ---------------------------------------------------------------------------
// PUT / PATCH / DELETE
// ---------------------------------------------------------------------------

describe('GitHubClient HTTP methods — PUT, PATCH, DELETE', () => {
  it('makes PUT, PATCH, and DELETE requests with correct methods', async () => {
    mockFetch(makeFetchResponse(200, { merged: true }));
    await new GitHubClient(VALID_TOKEN).put('/repos/acme/infra/pulls/7/merge', { commit_title: 'Merge PR' });
    expect((vi.mocked(fetch).mock.calls[0] as [string, RequestInit])[1].method).toBe('PUT');

    mockFetch(makeFetchResponse(200, { number: 7, state: 'closed' }));
    await new GitHubClient(VALID_TOKEN).patch('/repos/acme/infra/pulls/7', { state: 'closed' });
    expect((vi.mocked(fetch).mock.calls[0] as [string, RequestInit])[1].method).toBe('PATCH');

    mockFetch(makeFetchResponse(204, null, { 'Content-Length': '0' }));
    const result = await new GitHubClient(VALID_TOKEN).delete('/repos/acme/infra/git/refs/heads/korinfra/cost-opt');
    expect((vi.mocked(fetch).mock.calls[0] as [string, RequestInit])[1].method).toBe('DELETE');
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Rate limit tracking
// ---------------------------------------------------------------------------

describe('GitHubClient — rate limit tracking', () => {
  it('updates rate limit fields from response headers and handles missing headers', async () => {
    mockFetch(makeFetchResponse(200, {}, { 'X-RateLimit-Remaining': '42' }));
    const client = new GitHubClient(VALID_TOKEN);
    await client.get('/user');
    expect(client.rateLimitRemaining).toBe(42);

    const resetEpoch = Math.floor(Date.now() / 1000) + 3600;
    mockFetch(makeFetchResponse(200, {}, { 'X-RateLimit-Reset': String(resetEpoch) }));
    const client2 = new GitHubClient(VALID_TOKEN);
    await client2.get('/user');
    expect(client2.rateLimitReset).toBe(resetEpoch);

    // Tracks to zero
    mockFetchOnce(
      makeFetchResponse(200, { number: 1 }, { 'X-RateLimit-Remaining': '10' }),
      makeFetchResponse(200, { number: 2 }, { 'X-RateLimit-Remaining': '0' }),
    );
    const client3 = new GitHubClient(VALID_TOKEN);
    await client3.get('/repos/acme/infra/pulls/1');
    expect(client3.rateLimitRemaining).toBe(10);
    await client3.get('/repos/acme/infra/pulls/2');
    expect(client3.rateLimitRemaining).toBe(0);

    // Missing header keeps initial value
    mockFetch(makeFetchResponse(200, {}));
    const client4 = new GitHubClient(VALID_TOKEN);
    await client4.get('/user');
    expect(client4.rateLimitRemaining).toBe(5000);
  });
});

// ---------------------------------------------------------------------------
// Error body parsing
// ---------------------------------------------------------------------------

describe('GitHubClient — error body parsing', () => {
  it('uses status-only message when body is not JSON and body.message on 4xx', async () => {
    const badResponse = {
      status: 503,
      headers: { get: () => null },
      json: () => Promise.reject(new Error('not json')),
    } as unknown as Response;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(badResponse));
    await expect(new GitHubClient(VALID_TOKEN).get('/user')).rejects.toThrow('GitHub API error: status 503');

    mockFetch(makeFetchResponse(409, { message: 'A pull request already exists for this head ref.' }));
    await expect(new GitHubClient(VALID_TOKEN).post('/repos/acme/infra/pulls', {})).rejects.toThrow('A pull request already exists');
  });
});
