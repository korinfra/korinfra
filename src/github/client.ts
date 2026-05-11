/**
 * GitHub REST client — native fetch, Bearer token auth.
 * Mirrors Go internal/github/client.go behaviour.
 */

import { redact } from '../redaction/redactor.js';

const BASE_URL = 'https://api.github.com';


export interface RateLimitInfo {
  remaining: number;
  reset: number; // Unix epoch seconds
}

export class GitHubClient {
  private readonly token: string;
  public rateLimitRemaining = 5000;
  public rateLimitReset = 0;

  constructor(token?: string) {
    const resolved = token ?? process.env['GITHUB_TOKEN'] ?? '';
    if (!resolved) {
      throw new Error(
        'GitHub token is required: set GITHUB_TOKEN or pass a token explicitly',
      );
    }
    if (!resolved || resolved.length < 10) {
      throw new Error(
        'GITHUB_TOKEN appears invalid (too short or empty). Set a valid personal access token.',
      );
    }
    if (!/^(ghp_|github_pat_|gho_|ghs_|v1\.)/.test(resolved)) {
      throw new Error(
        'Invalid GitHub token format. Expected a token starting with ghp_, github_pat_, gho_, or ghs_.',
      );
    }
    this.token = resolved;
  }

  private headers(withBody = false): Record<string, string> {
    const h: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (withBody) {
      h['Content-Type'] = 'application/json';
    }
    return h;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T | null> {
    const url = `${BASE_URL}${path}`;
    const init: Record<string, unknown> = {
      method,
      headers: this.headers(body !== undefined),
    };
    if (body !== undefined) init['body'] = JSON.stringify(body);

    const resp = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });

    // Track rate limit
    const remaining = resp.headers.get('X-RateLimit-Remaining');
    if (remaining !== null) {
      this.rateLimitRemaining = parseInt(remaining, 10);
    }
    this.rateLimitReset = Number(resp.headers.get('X-RateLimit-Reset') ?? '0');

    if (resp.status >= 400) {
      let message: string;
      try {
        const body = await resp.json() as Record<string, unknown>;
        if (typeof body === 'object' && body !== null && typeof body['message'] === 'string') {
          message = `GitHub API error ${resp.status}: ${redact(body['message'], 'moderate')}`;
        } else {
          message = `GitHub API error: status ${resp.status}`;
        }
      } catch {
        message = `GitHub API error: status ${resp.status}`;
      }
      throw new Error(message);
    }

    if (resp.status === 204 || resp.headers.get('Content-Length') === '0') {
      return null;
    }

    return resp.json() as Promise<T>;
  }

  async get<T>(path: string): Promise<T | null> {
    return this.request<T>('GET', path);
  }

  async post<T>(path: string, body: unknown): Promise<T | null> {
    return this.request<T>('POST', path, body);
  }

  async put<T>(path: string, body: unknown): Promise<T | null> {
    return this.request<T>('PUT', path, body);
  }

  async patch<T>(path: string, body: unknown): Promise<T | null> {
    return this.request<T>('PATCH', path, body);
  }

  async delete<T>(path: string): Promise<T | null> {
    return this.request<T>('DELETE', path);
  }
}
