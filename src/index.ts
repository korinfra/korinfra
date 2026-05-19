import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

import React from 'react';
import { render } from 'ink';

import { loadConfig } from './config/index.js';
import { setupLogger, logger } from './utils/logger.js';
import { getVersion } from './utils/version.js';
import { levenshtein } from './utils/string.js';
import { App } from './cli/App.js';
import { startMcpServer } from './mcp/index.js';
import { DEFAULT_MCP_PORT } from './config/types.js';
import { runHeadlessTextCommand, runJsonCommand } from './cli/headless.js';
import { redact, redactObject } from './redaction/redactor.js';
import { closeDb, getDb } from './storage/db.js';

// True system env vars that must never be overridden from .env files.
// Credentials are intentionally excluded: the existing `if (value && !process.env[key])`
// guard in loadProjectEnv already ensures shell env takes precedence, while allowing
// .korinfra/.env to supply keys that are absent from the shell (the common case after
// `korinfra init` writes ANTHROPIC_API_KEY there).
const SYSTEM_PROTECTED_ENV_KEYS = new Set([
  'NODE_ENV', 'PATH', 'HOME', 'USER', 'SHELL', 'TERM',
  'SYSTEMROOT', 'COMSPEC', 'APPDATA', 'USERPROFILE',
  'NODE_OPTIONS', 'NODE_EXTRA_CA_CERTS', 'LD_PRELOAD',
  // Locale (affect regex, sort collation)
  'LC_ALL', 'LC_COLLATE', 'LANG', 'LANGUAGE',
  // Proxy (MITM attack vector — routes all AWS API calls through attacker)
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
  // SSH
  'SSH_AUTH_SOCK', 'SSH_AGENT_PID',
  // AWS STS assume-role override
  'AWS_ROLE_ARN', 'AWS_WEB_IDENTITY_TOKEN_FILE', 'AWS_ROLE_SESSION_NAME',
  // Node.js internals not yet covered
  'NODE_DEBUG', 'NODE_PATH', 'LD_LIBRARY_PATH', 'DYLD_LIBRARY_PATH',
]);

const KNOWN_COMMANDS = [
  'scan', 'resources', 'costs', 'recommend', 'history', 'changes', 'config', 'doctor', 'mcp',
  'fix', 'tags', 'pricing', 'report', 'security', 'init', 'serve', 'rules',
];

function suggestKnownCommand(input: string): string | null {
  let best: string | null = null;
  let bestDist = Infinity;
  for (const command of KNOWN_COMMANDS) {
    const distance = levenshtein(input.toLowerCase(), command);
    if (distance < bestDist && distance <= 2) {
      best = command;
      bestDist = distance;
    }
  }
  return best;
}

function loadProjectEnv(): void {
  const envPath = path.join(process.cwd(), '.korinfra', '.env');
  try {
    const content = fs.readFileSync(envPath, 'utf8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const value = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '').trim();
      // Validate key name: must be a safe env var name
      if (!key || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
      // Never override protected system env vars
      if (SYSTEM_PROTECTED_ENV_KEYS.has(key)) continue;
      // Limit value length to prevent env var abuse
      if (value.length > 256) {
        logger.warn({ key }, '[korinfra] .env value exceeds 256 chars — skipping');
        continue;
      }
      // Only set if not already set in the environment (env vars take precedence)
      if (value && !process.env[key]) {
        process.env[key] = value;
      }
    }
  } catch {
    // .korinfra/.env doesn't exist — that's fine
  }
}

function tryDetectGithubToken(): void {
  if (process.env['GITHUB_TOKEN']) return;
  try {
    const token = execSync('gh auth token', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim();
    if (token && /^(ghp_|github_pat_|gho_|ghs_|v1\.)/.test(token)) {
      process.env['GITHUB_TOKEN'] = token;
    }
  } catch { /* gh not installed or not authenticated — ignore */ }
}

// ─── Headless: command-specific guidance for unsupported commands (CLI-2) ──────

function getUnsupportedCommandGuidance(command: string): string {
  switch (command) {
    case 'fix':
      return [
        `korinfra fix: apply an AI-generated fix for a recommendation.`,
        ``,
        `Usage:`,
        `  korinfra fix <rec-id> --no-tui`,
        `  korinfra fix <rec-id> --dry-run --no-tui`,
        `  korinfra fix <rec-id> --json`,
        ``,
        `Next: run \`korinfra recommend --no-tui\` to list pending recommendation IDs.`,
      ].join('\n');
    case 'recommend':
      return [
        `korinfra recommend --refresh: non-interactive AI refresh is not available yet.`,
        `Next: run \`korinfra recommend --json\` for cached recommendations in JSON format, or use the TUI for AI refresh.`,
      ].join('\n');
    case 'security':
      return [
        `korinfra security --refresh: non-interactive AI refresh is not available yet.`,
        `Next: run \`korinfra security --json --dir ./terraform\` for security findings in JSON format, or use the TUI for interactive scanning.`,
      ].join('\n');
    case 'changes':
      return [
        `korinfra changes: view recent AWS API activity from CloudTrail.`,
        `Next: run \`korinfra\` in a terminal and select changes, or use the MCP tool get_changes.`,
      ].join('\n');
    case 'tags':
      return [
        `korinfra tags: tag audit and AI suggestion require the interactive TUI.`,
        `Next: run \`korinfra\` in a terminal and select tags.`,
      ].join('\n');
    case 'init':
      return [
        `korinfra init: use --non-interactive or --config for headless setup, or run \`korinfra\` in a terminal for the guided wizard.`,
        `Examples:`,
        `  korinfra init --non-interactive --profile default --ai-provider anthropic --ai-key sk-ant-api...`,
        `  korinfra init --non-interactive --profile my-profile --ai-provider none`,
        `  korinfra init --config ./korinfra-setup.yaml`,
        `Config file keys: profile, ai_provider, ai_key`,
      ].join('\n');
    case 'doctor':
      return [
        `korinfra doctor: environment diagnostics require the interactive TUI.`,
        `Next: run \`korinfra\` in a terminal and select doctor.`,
      ].join('\n');
    case 'config':
      return [
        `korinfra config: configuration management requires the interactive TUI.`,
        `Next: run \`korinfra\` in a terminal and select config, or use \`korinfra config set <key> <value>\`.`,
      ].join('\n');
    case 'mcp':
      return [
        `korinfra mcp: use --non-interactive or --config for headless install, or run \`korinfra\` in a terminal for the guided wizard.`,
        `Examples:`,
        `  korinfra mcp install --non-interactive --ide claude-code,cursor`,
        `  korinfra mcp install --non-interactive --ide claude-code`,
        `  korinfra mcp uninstall --non-interactive`,
        `  korinfra mcp install --config ./mcp-setup.yaml`,
        `Supported IDEs: claude-code, cursor, vscode, jetbrains`,
        `Config file keys: ide (comma-separated)`,
      ].join('\n');
    default:
      return `korinfra ${command}: non-interactive output is not available for this command. Run \`korinfra\` in an interactive terminal or use \`korinfra --help\`.`;
  }
}

async function runHeadlessCommand(command: string, commandArgs: string[]): Promise<boolean> {
  return runHeadlessTextCommand(command, commandArgs);
}

async function main(): Promise<void> {
  loadProjectEnv();
  tryDetectGithubToken();
  const args = process.argv.slice(2);

  // Handle --help / -h early
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write([
      'korinfra',
      '',
      'Usage: korinfra [command] [flags]',
      '',
      'Analyze',
      '  scan        Full infrastructure scan',
      '  costs       Cost breakdown',
      '  resources   List AWS resources',
      '  security    Terraform security checks',
      '  history     View scan history',
      '  changes     Audit recent AWS API activity',
      '  rules       List built-in cost optimization rules',
      '',
      'Actions',
      '  recommend   Show recommendations',
      '  fix         Apply recommended fixes',
      '  report      Generate cost report',
      '  tags        Audit tag compliance',
      '  pricing     Look up AWS pricing',
      '',
      'Setup',
      '  init        Initialize config',
      '  doctor      Diagnose environment',
      '  config      View or edit configuration',
      '  mcp         Install MCP server  (subcommands: install, status, uninstall, token revoke|rotate|status)',
      '  serve       Run the MCP server (stdio default; --http for HTTP transport)',
      '',
      'Run: korinfra <command> --help',
      '',
      'Flags:',
      '  --version, -V   Print version and exit',
      '  --help, -h      Show this help text',
      '  --json          JSON output mode (scan, costs, resources, report, history, pricing status, rules)',
      '  --verbose       Enable verbose logging',
      '  --no-tui        Use terminal output for explicit commands',
      '',
    ].join('\n'));
    process.exit(0);
  }

  // Handle --version / -V early
  if (args.includes('--version') || args.includes('-V')) {
    const version = getVersion();
    process.stdout.write(`korinfra ${version}\n`);
    process.exit(0);
  }

  // Handle serve mode (MCP server — no TUI, no agent)
  if (args[0] === 'serve') {
    const transport = args.includes('--http') ? 'http' : 'stdio';
    const portIdx = args.indexOf('--port');
    const portStr = portIdx !== -1 ? (args[portIdx + 1] ?? '') : '';
    const port = /^\d+$/.test(portStr) ? parseInt(portStr, 10) : DEFAULT_MCP_PORT;
    const rotateToken = args.includes('--rotate-token');
    await startMcpServer({ transport, port, rotateToken });
    return; // Server keeps running until transport closes
  }

  const command = args[0];
  if (command !== undefined && command !== '' && !command.startsWith('-') && !KNOWN_COMMANDS.includes(command)) {
    const suggestion = suggestKnownCommand(command);
    process.stderr.write([
      `Unknown command: ${command}`,
      ...(suggestion !== null ? [`Did you mean: ${suggestion}?`, '', `Next: korinfra ${suggestion} --help`] : ['', 'Next: korinfra --help']),
      '',
    ].join('\n'));
    process.exit(1);
  }

  // Load config to initialise logging — missing config is fine (user needs to run init)
  try {
    const config = await loadConfig();
    setupLogger(config.output.verbose ? 'debug' : 'info');
    // Prime the DB singleton with configured values so all subsequent getDb() calls
    // inherit the user's storage.path and storage.retention_days instead of defaults.
    const dbPath = config.storage.path.trim() !== '' ? config.storage.path : undefined;
    getDb(dbPath, config.storage.retention_days);
    // Honor output.color: false by setting NO_COLOR before any chalk/ink rendering.
    if (!config.output.color) {
      process.env['NO_COLOR'] = '1';
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') throw err;
    // No config yet — use default log level; TUI will show init prompt
  }

  // Detect TTY for TUI vs headless mode
  const isTTY = process.stdout.isTTY ?? false;
  const isCI = Boolean(process.env['CI']);
  const isDumbTerm = process.env['TERM'] === 'dumb';
  const forceHeadless = Boolean(process.env['KORINFRA_HEADLESS']);
  const outputEnv = process.env['KORINFRA_OUTPUT']; // 'json' | 'text' | undefined
  const isJson = args.includes('--json') || outputEnv === 'json';
  const isMcpTokenCmd = command === 'mcp' && args[1] === 'token';
  // `korinfra rules <anything>` (subcommand or flag) → headless dispatcher.
  // `korinfra rules` (bare) → TUI panel.
  const isRulesHeadless = command === 'rules' && args[1] !== undefined;
  const headless = args.includes('--no-tui') || isJson || !isTTY || isCI || isDumbTerm || forceHeadless
    || outputEnv === 'text' || isMcpTokenCmd || isRulesHeadless;

  if (headless) {
    const explicitCommand = command !== undefined && command !== '' && !command.startsWith('-');
    if (explicitCommand) {
      const cleanArgs = args.slice(1).filter((arg) => arg !== '--no-tui' && arg !== '--json');
      if (isJson) {
        const exitCode = await runJsonCommand(command, cleanArgs);
        if (exitCode !== false) process.exit(exitCode);
        // JSON not supported for this command — emit guidance as JSON error
        process.stdout.write(JSON.stringify({
          command,
          status: 'error',
          message: getUnsupportedCommandGuidance(command),
        }, null, 2) + '\n');
        process.exit(1);
      } else {
        const handled = await runHeadlessCommand(command, cleanArgs);
        // Honor process.exitCode if a handler set it (usage / validation errors).
        // Calling process.exit(0) directly would override it; process.exit() with
        // no arg uses process.exitCode if set, else 0.
        if (handled) process.exit();
        process.stderr.write(getUnsupportedCommandGuidance(command) + '\n');
        process.exit(1);
      }
    }
    if (isJson) {
      process.stderr.write(JSON.stringify({ status: 'error', message: 'No command specified. Run `korinfra --help`.' }, null, 2) + '\n');
    } else {
      process.stderr.write('korinfra: interactive TUI requires a terminal. Run `korinfra --help` for command usage.\n');
    }
    process.exit(1);
  }

  // Interactive TUI mode — use alt screen buffer for clean experience
  // Previous terminal content is restored on exit
  process.stdout.write('\x1b[?1049h\x1b[H');
  const restoreScreen = (): void => { process.stdout.write('\x1b[?1049l'); };
  // Clear sensitive env vars on exit to reduce memory exposure to child processes
  const SENSITIVE_ENV_KEYS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GITHUB_TOKEN', 'MCP_AUTH_TOKEN', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN'];
  process.on('exit', () => {
    restoreScreen();
    for (const key of SENSITIVE_ENV_KEYS) delete process.env[key];
    closeDb();
  });
  process.on('SIGINT', () => {
    if (globalThis.__korinfraAgentAbort !== undefined) {
      globalThis.__korinfraAgentAbort();
    }
    restoreScreen();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    if (globalThis.__korinfraAgentAbort !== undefined) {
      globalThis.__korinfraAgentAbort();
    }
    restoreScreen();
    process.exit(0);
  });

  process.env['KORINFRA_TUI'] = '1';
  const { waitUntilExit } = render(React.createElement(App, { args }));
  await waitUntilExit();
  // Cancel any in-flight agent loop so AWS SDK + AI streams release their handles.
  if (globalThis.__korinfraAgentAbort !== undefined) {
    globalThis.__korinfraAgentAbort();
  }
  restoreScreen();
  // AWS SDK NodeHttpHandler keeps TCP connections alive via keep-alive agents.
  // SQLite WAL mode holds file handles. Neither yields to the event loop naturally,
  // so we must force exit after Ink is done. The 'exit' handler above calls closeDb().
  process.exit(0);
}

process.on('unhandledRejection', (reason) => {
  if (reason instanceof Error) {
    // pino's err serializer (serializeErr) sanitizes stack traces
    logger.error({ err: reason }, 'Unhandled rejection');
  } else {
    logger.error({ err: redact(String((reason as string | number | boolean | null | undefined) ?? ''), 'moderate') }, 'Unhandled rejection');
  }
  closeDb();
  process.exit(1);
});
process.on('uncaughtException', (err) => {
  logger.error({ err: redact(err.message, 'moderate') }, 'Uncaught exception');
  closeDb();
  process.exit(1);
});

main().catch((err: unknown) => {
  const safeErr = err && typeof err === 'object'
    ? redactObject(err, 'moderate')
    : redact(String(err), 'moderate');
  logger.error(safeErr, 'Fatal error');
  process.exit(1);
});
