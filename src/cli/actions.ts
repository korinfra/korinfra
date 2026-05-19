export type TuiCommand =
  | 'scan'
  | 'costs'
  | 'resources'
  | 'security'
  | 'recommend'
  | 'fix'
  | 'report'
  | 'history'
  | 'changes'
  | 'tags'
  | 'pricing'
  | 'init'
  | 'doctor'
  | 'config'
  | 'mcp'
  | 'rules'
  | '__filter__'
  | '__ask__';

export type TuiAction =
  | { type: 'navigate'; command: TuiCommand; args?: string[] }
  | { type: 'open-file'; path: string }
  | { type: 'copy'; text: string }
  | { type: 'back' }
  | { type: 'quit' }
  | { type: 'run-again' }
  | { type: 'open-filter' }
  | { type: 'copy-id'; id: string }
  | { type: 'apply-fix' }
  | { type: 'preview-dry-run' }
  | { type: 'mark' }
  | { type: 'filter-toggle' }
  | { type: 'sort-toggle' }
  | { type: 'dismiss' };

// ─── Reserved shortcut contract ─────────────────────────────────────────────
// Enter  primary / select / details / apply
// Esc/b  back / cancel
// q      quit
// r      run again / retry only
// s      scan or status only where obvious
// p      report / save report
// f      fix or refresh with AI
// d      doctor / download / diff / delete (explicit label required)
// o      open file / path
// c      copy / config
// g      generate / suggest tags
// /      ask AI
// :      command palette
// ?      help overlay
// e      expand (ErrorBox only — do not use as primary action)
// ─────────────────────────────────────────────────────────────────────────────

export type ActionHint = {
  key: string;
  label: string;
  reason?: string;
} & ({ disabled?: false; action: TuiAction } | { disabled: true; action?: TuiAction });

interface KeyLike {
  return?: boolean;
  escape?: boolean;
  ctrl?: boolean;
  shift?: boolean;
  tab?: boolean;
}

function actionTokenMatches(input: string, key: KeyLike, token: string): boolean {
  const normalized = token.trim().toLowerCase();

  if (normalized === 'enter' || normalized === 'return' || normalized === '⏎') {
    return key.return === true;
  }

  if (normalized === 'esc' || normalized === 'escape') {
    return key.escape === true;
  }

  if (normalized === 'space') {
    return input === ' ';
  }

  if (normalized === 'shift+tab') {
    return key.tab === true && key.shift === true;
  }

  if (normalized === 'tab') {
    return key.tab === true;
  }

  if (normalized.startsWith('ctrl+')) {
    return key.ctrl === true && input.toLowerCase() === normalized.slice(5);
  }

  if (normalized.startsWith('shift+')) {
    return key.shift === true && input.toLowerCase() === normalized.slice(6);
  }

  return input.toLowerCase() === normalized;
}

export function actionKeyMatches(input: string, key: KeyLike, actionKey: string): boolean {
  const tokens = actionKey
    .split('/')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

  if (tokens.length === 0) return false;
  return tokens.some((token) => actionTokenMatches(input, key, token));
}
