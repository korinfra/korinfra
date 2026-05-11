/**
 * ConfigCommand — §15 configuration view / edit.
 *
 * States:
 *   §15.1 show          — YAML-like pretty-print of loaded config; c copy, e edit.
 *   §15.2 set (form)    — TextInput for a dotted key; Enter → Zod validate → review.
 *   §15.2 set (review)  — SafeWriteReview overlay before write.
 *   §15.2 set (writing) — spinner while saveConfig runs.
 *   §15.2 set (done)    — success row.
 *   §15.3 json-error    — ErrorBox for unsupported --json flag (ERR2-1).
 *
 * Rules enforced: SCREEN_SHELL_RULE, VRHYTHM_RULE, DOT_SEP_RULE, X-1, ERR2-1, G-2.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import { TextInput } from '@inkjs/ui';
import yaml from 'js-yaml';

import { CommandHeader } from '../components/CommandHeader.js';
import { ScreenShell } from '../components/ScreenShell.js';
import { ErrorBox } from '../components/ErrorBox.js';
import { ActionBar } from '../components/ActionBar.js';
import { SafeWriteReview } from '../components/SafeWriteReview.js';
import {
  IH_BACK,
  IH_CANCEL,
  IH_COMMAND,
  IH_HELP,
  IH_QUIT,
  InteractionHints,
} from '../components/InteractionHints.js';
import { findConfigPath, loadConfig, saveConfig } from '../../config/index.js';
import type { Config } from '../../config/index.js';
import { ConfigSchema } from '../../config/types.js';
import { colors, icons } from '../theme.js';
import {
  GAP_AFTER_HEADER,
  GAP_BETWEEN_SECTIONS,
  GAP_ICON_TEXT,
  GAP_ROW,
  MARGIN_LEFT_CONTENT,
} from '../ui/spacing.js';
import { useInputMode } from '../hooks/useInputMode.js';
import { useGlobalOverlay } from '../hooks/useGlobalOverlay.js';
import type { TuiAction } from '../actions.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Nested-set via dotted path. Coerces booleans / numbers from raw string input. */
function setNestedValue(obj: Record<string, unknown>, dotPath: string, raw: string): void {
  const parts = dotPath.split('.');
  let cursor: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i] ?? '';
    if (typeof cursor[part] !== 'object' || cursor[part] === null) {
      cursor[part] = {};
    }
    cursor = cursor[part] as Record<string, unknown>;
  }
  const last = parts[parts.length - 1] ?? '';
  const lower = raw.toLowerCase();
  if (lower === 'true') cursor[last] = true;
  else if (lower === 'false') cursor[last] = false;
  else if (!isNaN(Number(raw)) && raw.trim() !== '') cursor[last] = Number(raw);
  else cursor[last] = raw;
}

/** Read nested value via dotted path; returns a display-safe string. */
function getNestedDisplay(cfg: Config, dotPath: string): string {
  const parts = dotPath.split('.');
  let cursor: unknown = cfg;
  for (const p of parts) {
    if (typeof cursor !== 'object' || cursor === null) return '';
    cursor = (cursor as Record<string, unknown>)[p];
  }
  if (cursor === undefined || cursor === null) return '';
  if (Array.isArray(cursor)) return cursor.join(', ');
  if (typeof cursor === 'string' || typeof cursor === 'number' || typeof cursor === 'boolean') return String(cursor);
  return '[object]';
}

/** Pretty-print selected top-level sections in YAML style for the show view. */
function formatConfigYaml(cfg: Config): string {
  // Match the sections implied by §15.1 example (aws, ai, thresholds/scan).
  // Display meaningful top-level sections; omit `version` noise.
  const view: Record<string, unknown> = {
    aws: cfg.aws,
    ai: cfg.ai,
    terraform: cfg.terraform,
    output: cfg.output,
    storage: cfg.storage,
    scan: cfg.scan,
    anomaly: cfg.anomaly,
  };
  return yaml.dump(view, { indent: 2, lineWidth: 120, noRefs: true, sortKeys: false });
}

// ─── Component ───────────────────────────────────────────────────────────────

type ConfigStage =
  | { kind: 'show' }
  | { kind: 'set-form'; dotKey: string; value: string }
  | { kind: 'set-review'; dotKey: string; oldValue: string; newValue: string; parsed: Config }
  | { kind: 'set-writing'; dotKey: string; newValue: string }
  | { kind: 'set-done'; dotKey: string; newValue: string }
  | { kind: 'set-error'; dotKey: string; message: string };

interface ConfigCommandProps {
  args: string[];
  onBack?: () => void;
  onAction?: (action: TuiAction) => void;
}

function renderYamlLine(line: string, i: number): React.JSX.Element {
  if (line.trim() === '') return <Text key={i}> </Text>;
  const topKey = line.match(/^([a-z_][a-z0-9_]*):(.*)/);
  if (topKey) {
    const [, key, rest] = topKey;
    const val = (rest ?? '').trim();
    if (val === '' || val === '{}' || val === '[]') {
      return <Text key={i}><Text color={colors.brand} bold>{key}</Text><Text dimColor>:</Text></Text>;
    }
    return <Text key={i} wrap="truncate"><Text color={colors.brand} bold>{key}</Text><Text dimColor>: </Text><Text color={colors.highlight}>{val}</Text></Text>;
  }
  const indented = line.match(/^(\s+)([a-z_][a-z0-9_]*):\s*(.*)/);
  if (indented) {
    const [, indent, key, val] = indented;
    if (val === '' || val === '{}' || val === '[]') {
      return <Text key={i}><Text dimColor>{indent}{key}:</Text></Text>;
    }
    const valColor = val === 'true' ? colors.success : val === 'false' ? colors.error : colors.info;
    return <Text key={i} wrap="truncate"><Text dimColor>{indent}{key}: </Text><Text color={valColor}>{val}</Text></Text>;
  }
  return <Text key={i} wrap="truncate" dimColor>{line}</Text>;
}

export function ConfigCommand({ args, onBack, onAction }: ConfigCommandProps): React.JSX.Element {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const termWidth = stdout?.columns ?? 80;
  const { setInputMode } = useInputMode();
  const { helpOpen, paletteOpen } = useGlobalOverlay();

  const filteredArgs = args.filter((a) => a !== '--json');
  const subcommand = filteredArgs[0] ?? 'show';
  const initialDotKey = subcommand === 'set' ? filteredArgs[1] ?? '' : '';
  const initialValue = subcommand === 'set' ? filteredArgs.slice(2).join(' ') : '';

  const [cfg, setCfg] = useState<Config | null>(null);
  const [configPath, setConfigPath] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [stage, setStage] = useState<ConfigStage>(() => {
    if (subcommand === 'set' && initialDotKey) {
      return { kind: 'set-form', dotKey: initialDotKey, value: initialValue };
    }
    return { kind: 'show' };
  });

  // Track input-mode so overlay gating works correctly when TextInput is active.
  useEffect(() => {
    if (stage.kind === 'set-form') setInputMode('field');
    else setInputMode('none');
    return () => { setInputMode('none'); };
  }, [stage.kind, setInputMode]);

  // Load config once on mount.
  useEffect(() => {
    let cancelled = false;
    void (async (): Promise<void> => {
      try {
        const [loaded, path] = await Promise.all([loadConfig(), findConfigPath()]);
        if (cancelled) return;
        setCfg(loaded);
        setConfigPath(path);
      } catch (err) {
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const yamlText = useMemo(() => (cfg !== null ? formatConfigYaml(cfg) : ''), [cfg]);

  // ─── Show-state keyboard ─────────────────────────────────────────────────────
  useInput((input, key) => {
    if (stage.kind !== 'show') return;
    if (input === 'q') { exit(); return; }
    if (input === 'b' || key.escape) {
      if (onBack !== undefined) onBack();
      return;
    }
    if (input === 'c' && yamlText !== '') {
      onAction?.({ type: 'copy', text: yamlText });
      return;
    }
    if (input === 'o' && configPath !== null) {
      onAction?.({ type: 'open-file', path: configPath });
      return;
    }
  }, { isActive: stage.kind === 'show' && !helpOpen && !paletteOpen });

  // ─── Set-form keyboard (Esc cancels to show) ────────────────────────────────
  useInput((input, key) => {
    if (stage.kind !== 'set-form') return;
    if (input === 'q') { exit(); return; }
    if (key.escape) {
      setStage({ kind: 'show' });
    }
  }, { isActive: stage.kind === 'set-form' && !helpOpen && !paletteOpen });

  // ─── Set-done / set-error keyboard ──────────────────────────────────────────
  useInput((input, key) => {
    if (stage.kind !== 'set-done' && stage.kind !== 'set-error') return;
    if (input === 'q') { exit(); return; }
    if (input === 'b' || key.escape) {
      setStage({ kind: 'show' });
    }
  }, { isActive: (stage.kind === 'set-done' || stage.kind === 'set-error') && !helpOpen && !paletteOpen });

  // ─── Load-error branch ──────────────────────────────────────────────────────
  if (loadError !== null) {
    return (
      <ScreenShell
        header={<CommandHeader command="config" description="view configuration" variant="compact" mode="local" />}
      >
        <ErrorBox
          title="Could not load config"
          message={loadError}
          actions={[{ key: 'i', label: 'run init', action: { type: 'navigate' as const, command: 'init' } }]}
          onAction={onAction}
          onBack={onBack}
        />
      </ScreenShell>
    );
  }

  // ─── Loading ────────────────────────────────────────────────────────────────
  if (cfg === null) {
    return (
      <ScreenShell
        header={<CommandHeader command="config" description="view configuration" variant="compact" mode="local" />}
      >
        <Box marginTop={GAP_AFTER_HEADER} marginLeft={MARGIN_LEFT_CONTENT}>
          <Text dimColor>Loading config…</Text>
        </Box>
      </ScreenShell>
    );
  }

  // ─── §15.2 Set — review stage (SafeWriteReview owns footer) ────────────────
  if (stage.kind === 'set-review') {
    const review = stage;
    return (
      <ScreenShell
        header={
          <CommandHeader
            command="config set"
            description={`set ${review.dotKey}`}
            scope="set value"
            variant="compact"
            mode="local"
          />
        }
      >
        <SafeWriteReview
          willChange={[
            {
              description: `Update ${review.dotKey}`,
              detail: `${review.oldValue === '' ? '(unset)' : review.oldValue} → ${review.newValue}`,
            },
          ]}
          willNotChange={[]}
          dataUsed={configPath !== null ? [configPath] : []}
          safety={{
            dryRunAvailable: false,
            requiresAwsWrite: false,
            createsPrOnly: false,
            rollback: `Run: korinfra config set ${review.dotKey} ${review.oldValue === '' ? '""' : review.oldValue}`,
          }}
          onConfirm={() => {
            setStage({ kind: 'set-writing', dotKey: review.dotKey, newValue: review.newValue });
            void (async (): Promise<void> => {
              try {
                await saveConfig(review.parsed, configPath ?? undefined);
                setCfg(review.parsed);
                setStage({ kind: 'set-done', dotKey: review.dotKey, newValue: review.newValue });
              } catch (err) {
                setStage({
                  kind: 'set-error',
                  dotKey: review.dotKey,
                  message: err instanceof Error ? err.message : String(err),
                });
              }
            })();
          }}
          onBack={() => setStage({ kind: 'set-form', dotKey: review.dotKey, value: review.newValue })}
        />
      </ScreenShell>
    );
  }

  // ─── §15.2 Set — writing stage ──────────────────────────────────────────────
  if (stage.kind === 'set-writing') {
    return (
      <ScreenShell
        header={
          <CommandHeader
            command="config set"
            description={`set ${stage.dotKey}`}
            scope="writing"
            variant="compact"
            mode="local"
          />
        }
      >
        <Box marginTop={GAP_AFTER_HEADER} marginLeft={MARGIN_LEFT_CONTENT}>
          <Text dimColor>Saving config…</Text>
        </Box>
      </ScreenShell>
    );
  }

  // ─── §15.2 Set — done stage ─────────────────────────────────────────────────
  if (stage.kind === 'set-done') {
    return (
      <ScreenShell
        header={
          <CommandHeader
            command="config set"
            description={`set ${stage.dotKey}`}
            scope="saved"
            variant="compact"
            mode="local"
          />
        }
        hints={<InteractionHints hints={[IH_COMMAND, IH_HELP, IH_BACK, IH_QUIT]} />}
      >
        <Box marginTop={GAP_AFTER_HEADER} marginLeft={MARGIN_LEFT_CONTENT} gap={GAP_ICON_TEXT}>
          <Text color={colors.success}>{icons.checkmark}</Text>
          <Text>{`Set ${stage.dotKey} = ${stage.newValue}`}</Text>
        </Box>
      </ScreenShell>
    );
  }

  // ─── §15.2 Set — error stage ────────────────────────────────────────────────
  if (stage.kind === 'set-error') {
    return (
      <ScreenShell
        header={
          <CommandHeader
            command="config set"
            description={`set ${stage.dotKey}`}
            scope="error"
            variant="compact"
            mode="local"
          />
        }
      >
        <ErrorBox
          title="Could not save config"
          message={stage.message}
          actions={[
            {
              key: 's',
              label: 'show config',
              action: { type: 'navigate' as const, command: 'config', args: ['show'] },
            },
          ]}
          onAction={onAction}
          onBack={onBack}
        />
      </ScreenShell>
    );
  }

  // ─── §15.2 Set — form stage ─────────────────────────────────────────────────
  if (stage.kind === 'set-form') {
    const form = stage;
    const oldValue = getNestedDisplay(cfg, form.dotKey);
    const handleSubmit = (submitted: string): void => {
      if (submitted === '') {
        setStage({
          kind: 'set-error',
          dotKey: form.dotKey,
          message: 'Value cannot be empty.',
        });
        return;
      }
      const mutable = structuredClone(cfg) as Record<string, unknown>;
      setNestedValue(mutable, form.dotKey, submitted);
      const parsed = ConfigSchema.safeParse(mutable);
      if (!parsed.success) {
        setStage({
          kind: 'set-error',
          dotKey: form.dotKey,
          message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n'),
        });
        return;
      }
      setStage({
        kind: 'set-review',
        dotKey: form.dotKey,
        oldValue,
        newValue: submitted,
        parsed: parsed.data,
      });
    };

    return (
      <ScreenShell
        header={
          <CommandHeader
            command="config set"
            description="update config value"
            scope="set value"
            variant="compact"
            mode="local"
          />
        }
        actions={
          <ActionBar
            actions={[
              {
                key: 'Enter',
                label: 'save',
                action: { type: 'navigate' as const, command: 'config', args: ['show'] },
              },
            ]}
            onAction={() => { /* Enter handled by TextInput.onSubmit */ }}
            screenId="config-set"
          />
        }
        hints={<InteractionHints hints={[IH_CANCEL, IH_QUIT]} />}
      >
        <Box marginTop={GAP_AFTER_HEADER} marginLeft={MARGIN_LEFT_CONTENT} flexDirection="column">
          <Box gap={GAP_ROW}>
            <Text dimColor>Key:</Text>
            <Text color={colors.brand}>{form.dotKey}</Text>
          </Box>
          <Box marginTop={GAP_BETWEEN_SECTIONS} gap={GAP_ROW}>
            <Text dimColor>Value:</Text>
            <TextInput
              defaultValue={form.value}
              placeholder={oldValue === '' ? 'enter value' : oldValue}
              onSubmit={handleSubmit}
            />
          </Box>
        </Box>
      </ScreenShell>
    );
  }

  // ─── §15.1 Show — default ───────────────────────────────────────────────────
  const yamlLines = yamlText.split('\n');

  return (
    <ScreenShell
      header={
        <CommandHeader
          command="config"
          description="view configuration"
          scope={configPath ?? undefined}
          variant="compact"
          mode="local"
        />
      }
      actions={
        <ActionBar
          actions={[
            {
              key: 'c',
              label: 'copy config',
              action: { type: 'copy' as const, text: yamlText },
            },
            ...(configPath !== null
              ? [
                  {
                    key: 'o',
                    label: 'open in editor',
                    action: { type: 'open-file' as const, path: configPath },
                  },
                ]
              : []),
          ]}
          onAction={(action) => { onAction?.(action); }}
          screenId="config-show"
        />
      }
      hints={
        <InteractionHints
          hints={[IH_COMMAND, IH_HELP, ...(onBack !== undefined ? [IH_BACK] : []), IH_QUIT]}
        />
      }
    >
      <Box
        marginTop={GAP_AFTER_HEADER}
        marginLeft={MARGIN_LEFT_CONTENT}
        width={Math.max(20, termWidth - MARGIN_LEFT_CONTENT - 2)}
        flexShrink={0}
        flexDirection="column"
      >
        {yamlLines.map((line, i) => renderYamlLine(line, i))}
      </Box>
    </ScreenShell>
  );
}
