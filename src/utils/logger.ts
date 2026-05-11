import { createRequire } from 'node:module';
import os from 'node:os';
import type { Logger as PinoLogger, LoggerOptions } from 'pino';
import type pino from 'pino';
import { redactObject } from '../redaction/redactor.js';

// ─── Security sanitizers ──────────────────────────────────────────────────────

/**
 * L4: Replace home directory paths in stack traces with `~` to avoid leaking
 * the OS username embedded in absolute paths (e.g. C:\Users\Vladimir\... or
 * /home/vladimir/...).
 */
const HOME_DIR = os.homedir();
// Build a regex that matches the literal home dir path (case-insensitive on
// Windows where paths are case-insensitive).
const HOME_RE = new RegExp(HOME_DIR.replace(/[/\\]/g, '[/\\\\]').replace(/[.*+?^${}()|[\]]/g, String.raw`\$&`), 'gi');

function sanitizeStack(stack: unknown): string | undefined {
  if (typeof stack !== 'string') return undefined;
  return stack.replace(HOME_RE, '~');
}

/**
 * L5: Regex for environment variable names that commonly contain secrets.
 * Covers *_TOKEN, *_SECRET, *_KEY, *_PASSWORD, *_PASS, *_CREDENTIAL,
 * *_AUTH, *_PWD and all AWS_* credential variants.
 */
const SECRET_ENV_RE = /(token|secret|key|password|pass|credential|auth|pwd)/i;

/**
 * Serialize an error object, sanitizing stack traces and redacting any
 * environment variables captured on the error that look like secrets.
 */
function serializeErr(err: unknown): unknown {
  if (err === null || typeof err !== 'object') return err;
  const e = err as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  for (const k of Object.keys(e)) {
    if (k === 'stack') {
      out['stack'] = sanitizeStack(e['stack']);
    } else if (k === 'env' && e['env'] !== null && typeof e['env'] === 'object') {
      // Redact secret env vars that may be captured on the error
      const env = e['env'] as Record<string, unknown>;
      const sanitizedEnv: Record<string, unknown> = {};
      for (const [envKey, envVal] of Object.entries(env)) {
        sanitizedEnv[envKey] = SECRET_ENV_RE.test(envKey) ? '[REDACTED]' : envVal;
      }
      out['env'] = sanitizedEnv;
    } else {
      out[k] = e[k];
    }
  }

  return out;
}

// Bun compiled binaries cannot use pino (thread-stream/real-require are incompatible).
// Detect Bun compiled mode and fall back to a minimal console-based logger.
const isBunCompiled = typeof (globalThis as Record<string, unknown>)['Bun'] !== 'undefined'
  && typeof process.argv[0] === 'string'
  && !process.argv[0].includes('node_modules');
const require = createRequire(import.meta.url);

export type Logger = PinoLogger;

export interface LoggerCreateOptions {
  level?: string;
  pretty?: boolean;
}

// ─── Minimal logger for Bun compiled binaries ────────────────────────────────

const LOG_LEVELS: Record<string, number> = {
  fatal: 60,
  error: 50,
  warn: 40,
  info: 30,
  debug: 20,
  trace: 10,
  silent: Infinity,
};

function createMinimalLogger(level = 'info'): Logger {
  const threshold = LOG_LEVELS[level] ?? 30;

  const noop = () => {};

  function safeArg(arg: unknown): unknown {
    if (arg !== null && typeof arg === 'object' && !Array.isArray(arg)) {
      return redactObject(arg, 'moderate');
    }
    return arg;
  }

  const makeMethod = (methodLevel: number, method: (...args: unknown[]) => void) => {
    return methodLevel >= threshold ? method : noop;
  };

  const logger = {
    level,
    fatal: makeMethod(60, (...args: unknown[]) => console.error('[FATAL]', ...args.map(safeArg))),
    error: makeMethod(50, (...args: unknown[]) => console.error('[ERROR]', ...args.map(safeArg))),
    warn: makeMethod(40, (...args: unknown[]) => console.warn('[WARN]', ...args.map(safeArg))),
    info: makeMethod(30, (...args: unknown[]) => console.error('[INFO]', ...args.map(safeArg))),
    debug: makeMethod(20, (...args: unknown[]) => console.error('[DEBUG]', ...args.map(safeArg))),
    trace: makeMethod(10, (...args: unknown[]) => console.error('[TRACE]', ...args.map(safeArg))),
    silent: noop,
    child: () => logger,
    isLevelEnabled: (l: string) => (LOG_LEVELS[l] ?? 0) >= threshold,
    // Stubs for pino API compatibility
    bindings: () => ({}),
    flush: noop,
    on: noop,
  };

  return logger as unknown as Logger;
}

// ─── Pino logger for Node.js runtime ─────────────────────────────────────────

function buildOptions(opts: LoggerCreateOptions = {}): LoggerOptions {
  const level = opts.level ?? 'info';
  const pretty = opts.pretty ?? process.env['NODE_ENV'] !== 'production';

  const baseOpts: LoggerOptions = {
    level,
    serializers: {
      // L4 + L5: sanitize stack traces and secret env vars on logged errors
      err: serializeErr,
      error: serializeErr,
    },
    redact: {
      paths: [
        'headers.authorization',
        'err.$response',
        'err.$metadata',
        '**.arn',
        '**.secretAccessKey',
        '**.SecretAccessKey',
        '**.sessionToken',
        '**.SessionToken',
        '**.accessKeyId',
        '**.AccessKeyId',
        '**.credentials',
        '**.password',
        '**.token',
        '**.apiKey',
        '**.api_key',
        '**.privateKey',
        '**.private_key',
        '**.secret',
        // L5: expanded secret field patterns
        '**.auth',
        '**.Auth',
        '**.credential',
        '**.Credential',
        '**.pass',
        '**.pwd',
        '**.authToken',
        '**.auth_token',
        '**.account',
        '**.accountId',
        '**.AccountId',
        '**.public_ip',
        '**.private_ip',
        '**.subnet_id',
        '**.key_name',
        '**.db_name',
        '**.dns_name',
        '**.security_group_ids',
        '**.security_group_id',
        '**.vpc_id',
        'err.$response.headers',
        'err.$response.body',
        '**.Credentials',
        '**.endpoint',
        '**.url',
        '*.stack',
        'err.stack',
        '**.cookie',
        '**.set-cookie',
        '**.Cookie',
        '**.Set-Cookie',
        '**.authorization',
        '**.Authorization',
        'err.cause.stack',
        '**.cause.stack',
      ],
      censor: '[REDACTED]',
    },
  };

  if (pretty) {
    return {
      ...baseOpts,
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:HH:MM:ss',
          ignore: 'pid,hostname',
          destination: 2, // stderr
        },
      },
    };
  }

  return {
    ...baseOpts,
    // JSON to stderr
  };
}

/**
 * Create a new pino logger instance.
 * Defaults to stderr, pino-pretty in non-production environments.
 * Falls back to a minimal console logger in Bun compiled binaries.
 */
export function createLogger(opts: LoggerCreateOptions = {}): Logger {
  if (isBunCompiled) {
    return createMinimalLogger(opts.level);
  }

  // Dynamic require — pino is available in Node.js runtime but incompatible with Bun compile
  const pinoFactory = require('pino') as typeof pino;
  const options = buildOptions(opts);
  const pretty = opts.pretty ?? process.env['NODE_ENV'] !== 'production';

  if (pretty) {
    return pinoFactory(options);
  }

  return pinoFactory(options, pinoFactory.destination({ dest: 2, sync: false }));
}

/** Global logger instance. Reconfigure with setupLogger(). */
let _logger: Logger = createLogger();

/**
 * Reconfigure the global logger level.
 * Call this from your CLI root after parsing --log-level flags.
 */
export function setupLogger(level?: string): void {
  _logger = createLogger({ level: level ?? 'info' });
}

export const logger: Logger = new Proxy({} as Logger, {
  get(_target, prop) {
    return Reflect.get(_logger, prop) as unknown;
  },
});

