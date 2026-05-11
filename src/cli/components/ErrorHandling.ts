import type { ActionHint } from '../actions.js';
import { redact } from '../../redaction/redactor.js';

export function cleanErrorMessage(raw: string): string {
  let msg = redact(raw, 'moderate');
  msg = msg.replace(/^Error:\s*/i, '');
  msg = msg.split('\n').filter(line => !line.trim().startsWith('at ')).join('\n').trim();
  if (msg.length > 200) msg = msg.slice(0, 197) + '...';
  return msg;
}

export function errorHint(message: string): string {
  const lower = message.toLowerCase();
  if (lower.includes('auth') || lower.includes('api key') || lower.includes('unauthorized') || lower.includes('invalid_api_key') || lower.includes('authentication')) {
    return 'Check your API key configuration.';
  }
  if (lower.includes('rate limit') || lower.includes('429') || lower.includes('too many requests') || lower.includes('overloaded')) {
    return 'Rate limit reached — wait a moment and try again (press r)';
  }
  if (lower.includes('timeout') || lower.includes('econnrefused') || lower.includes('network') || lower.includes('enotfound') || lower.includes('fetch failed')) {
    return 'Network issue — check your internet connection';
  }
  if (lower.includes('aws') || lower.includes('credentials') || lower.includes('accessdenied') || lower.includes('nosuchbucket')) {
    return 'AWS credentials issue.';
  }
  if (lower.includes('no config') || lower.includes('enoent') || lower.includes('config file')) {
    return 'Configuration is missing.';
  }
  return 'Run diagnostics from here to inspect the environment.';
}

export function errorActions(message: string, onRunAgain?: () => void): ActionHint[] {
  const lower = message.toLowerCase();
  const actions: ActionHint[] = [];
  if (onRunAgain !== undefined) actions.push({ key: 'r', label: 'retry', action: { type: 'run-again' as const } });
  if (lower.includes('no config') || lower.includes('enoent') || lower.includes('config file') || lower.includes('api key') || lower.includes('auth')) {
    actions.push({ key: 'i', label: 'run init', action: { type: 'navigate' as const, command: 'init' } });
  }
  actions.push({ key: 'd', label: 'run doctor', action: { type: 'navigate' as const, command: 'doctor' } });
  return actions;
}
