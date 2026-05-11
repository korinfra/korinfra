/**
 * InitCommand — §13 quick-setup wizard.
 *
 * Lifecycle (4-step, with intermediate confirm + review):
 *   §13.1  profile      — Select AWS profile. Subtitle `set up korinfra  (1 of 4)`.
 *   §13.1c confirm      — Confirm profile + region. Subtitle `set up korinfra  (1 of 4)`.
 *   §13.2  connecting   — STS GetCallerIdentity. Subtitle `set up korinfra  (2 of 4)`.
 *   §13.3  ai-provider  — Anthropic / None. Subtitle `set up korinfra  (3 of 4)`.
 *   §13.4  ai-key       — PasswordInput. Subtitle `set up korinfra  (3 of 4)`.
 *   §17    review       — SafeWriteReview gate before config write.
 *          writing      — Save config (spinner).
 *   §13.5  done         — Summary + `s scan now`. Subtitle `done`.
 *
 * Rules enforced:
 *   VRHYTHM_RULE, DOT_SEP_RULE, SCREEN_SHELL_RULE, X-1, ERR2-1, G-2, G-5.
 */

import React, { useEffect, useMemo, useState } from 'react';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Box, Text, useApp, useInput } from 'ink';
import { PasswordInput, Select, Spinner } from '@inkjs/ui';

import { ActionBar } from '../components/ActionBar.js';
import { CommandHeader } from '../components/CommandHeader.js';
import { ErrorBox } from '../components/ErrorBox.js';
import {
  IH_BACK,
  IH_COMMAND,
  IH_HELP,
  IH_QUIT,
  InteractionHints,
  type InteractionHint,
} from '../components/InteractionHints.js';
import { SafeWriteReview } from '../components/SafeWriteReview.js';
import { ScreenShell } from '../components/ScreenShell.js';
import { colors, icons } from '../theme.js';
import { GAP_AFTER_HEADER, GAP_BETWEEN_SECTIONS, GAP_ICON_TEXT, GAP_ROW, MARGIN_LEFT_CONTENT } from '../ui/spacing.js';
import { DOT_SEP } from '../ui/text.js';
import { formatPathForTerminal } from '../ui/format.js';
import { useGlobalOverlay } from '../hooks/useGlobalOverlay.js';
import { testConnection } from '../../aws/credentials.js';
import { projectConfigPath } from '../../config/paths.js';
import type { TuiAction } from '../actions.js';
import { detectAwsProfiles, validateApiKey, writekorinfraConfig } from './init-core.js';

// ─── Types ────────────────────────────────────────────────────────────────────

type Step =
  | 'profile'
  | 'confirm'
  | 'connecting'
  | 'ai-provider'
  | 'ai-key'
  | 'review'
  | 'writing'
  | 'done'
  | 'error';

type AiProvider = 'anthropic' | 'none';

interface WizardState {
  step: Step;
  profiles: string[];
  selectedProfile: string;
  region: string;
  callerIdentity: { account: string; arn: string } | null;
  aiProvider: AiProvider;
  aiKey: string;
  configPath: string;
  envSaved: boolean;
  errorMessage: string;
  errorOriginStep: Step;
}

// ─── Progress indicator (§13.1b) ─────────────────────────────────────────────

type ProgressKey = 'profile' | 'credentials' | 'ai' | 'done';

const PROGRESS_STEPS: Array<{ id: ProgressKey; label: string }> = [
  { id: 'profile', label: 'profile' },
  { id: 'credentials', label: 'credentials' },
  { id: 'ai', label: 'AI provider' },
  { id: 'done', label: 'done' },
];

function progressKeyFor(step: Step): ProgressKey {
  switch (step) {
    case 'profile':
    case 'confirm':
      return 'profile';
    case 'connecting':
      return 'credentials';
    case 'ai-provider':
    case 'ai-key':
      return 'ai';
    case 'review':
    case 'writing':
    case 'done':
      return 'done';
    case 'error':
    default:
      return 'profile';
  }
}

function StepProgress({ step }: { step: Step }): React.JSX.Element {
  const current = progressKeyFor(step);
  const isDone = step === 'done';
  const currentIdx = PROGRESS_STEPS.findIndex((s) => s.id === current);

  return (
    <Box marginLeft={MARGIN_LEFT_CONTENT} marginTop={GAP_AFTER_HEADER} gap={GAP_ROW} flexWrap="wrap">
      {PROGRESS_STEPS.map((s, i) => {
        const complete = isDone ? true : i < currentIdx;
        const active = !isDone && i === currentIdx;
        const glyph = complete ? icons.checkmark : active ? icons.pointer : icons.pending;
        const color = complete ? colors.success : active ? colors.brand : colors.muted;
        return (
          <Box key={s.id} gap={GAP_ROW}>
            {/* Fixed 2-col glyph prefix to avoid layout shift */}
            <Text color={color}>{glyph}</Text>
            <Text color={color} bold={active} dimColor={!active && !complete}>
              {s.label}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}

// ─── Region detection ─────────────────────────────────────────────────────────

/**
 * Parses ~/.aws/config for the given profile's `region =`.
 * Falls back to env AWS_REGION / AWS_DEFAULT_REGION, then 'us-east-1'.
 */
function detectRegionForProfile(profile: string): string {
  try {
    const configPath = path.join(os.homedir(), '.aws', 'config');
    const content = fs.readFileSync(configPath, 'utf8');
    const sectionHeader = profile === 'default' ? '[default]' : `[profile ${profile}]`;
    const lines = content.split('\n');
    let inSection = false;
    for (const raw of lines) {
      const line = raw.trim();
      if (line.startsWith('[')) {
        inSection = line === sectionHeader;
        continue;
      }
      if (inSection) {
        const m = line.match(/^region\s*=\s*(\S+)/);
        if (m?.[1]) return m[1];
      }
    }
  } catch {
    // fall through
  }
  return process.env['AWS_REGION'] ?? process.env['AWS_DEFAULT_REGION'] ?? 'us-east-1';
}

// ─── Props ────────────────────────────────────────────────────────────────────

interface InitCommandProps {
  args?: string[];
  onBack?: () => void;
  onAction?: (action: TuiAction) => void;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function InitCommand({ onBack, onAction }: InitCommandProps): React.JSX.Element {
  const { exit } = useApp();
  const { helpOpen, paletteOpen } = useGlobalOverlay();

  const [state, setState] = useState<WizardState>(() => {
    const profiles = detectAwsProfiles();
    const defaultProfile = profiles.includes('default') ? 'default' : (profiles[0] ?? 'default');
    return {
      step: 'profile',
      profiles,
      selectedProfile: defaultProfile,
      region: detectRegionForProfile(defaultProfile),
      callerIdentity: null,
      aiProvider: 'anthropic',
      aiKey: '',
      configPath: projectConfigPath(),
      envSaved: false,
      errorMessage: '',
      errorOriginStep: 'connecting',
    };
  });

  const noProfilesFound = state.step === 'profile' && state.profiles.length === 0;

  useInput((input, key) => {
    // PasswordInput owns its own key handling — only allow Esc/b back.
    if (state.step === 'ai-key') {
      if (input === 'b' || key.escape) {
        setState((s) => ({ ...s, step: 'ai-provider' }));
      }
      return;
    }

    if (input === 'q') {
      exit();
      return;
    }

    // Review step: SafeWriteReview owns Enter/b/Esc; nothing extra to do here.
    if (state.step === 'review') return;

    if (state.step === 'profile') {
      if (input === 'b' || key.escape) {
        if (onBack !== undefined) onBack();
        else exit();
        return;
      }
      if (key.return) {
        setState((s) => ({ ...s, step: 'confirm' }));
        return;
      }
      return;
    }

    if (state.step === 'confirm') {
      if (key.return) {
        setState((s) => ({ ...s, step: 'connecting', errorMessage: '' }));
        return;
      }
      if (input === 'b' || key.escape) {
        setState((s) => ({ ...s, step: 'profile', callerIdentity: null }));
      }
      return;
    }

    if (state.step === 'connecting') {
      if (input === 'b' || key.escape) {
        setState((s) => ({ ...s, step: 'profile', callerIdentity: null }));
      }
      return;
    }

    if (state.step === 'ai-provider') {
      if (input === 'b' || key.escape) {
        setState((s) => ({ ...s, step: 'confirm' }));
        return;
      }
      return;
    }

    if (state.step === 'writing') {
      // Long-running write: block back until complete (spinner state).
      return;
    }

    if (state.step === 'done') {
      if (input === 's') {
        onAction?.({ type: 'navigate', command: 'scan' });
        return;
      }
      if (input === 'b' || key.escape) {
        if (onBack !== undefined) onBack();
        else exit();
      }
      return;
    }

    if (state.step === 'error') {
      if (input === 'r') {
        setState((s) => ({ ...s, step: s.errorOriginStep, errorMessage: '' }));
        return;
      }
      if (input === 'b' || key.escape) {
        setState((s) => ({
          ...s,
          step: s.errorOriginStep === 'writing' ? 'review' : 'profile',
          errorMessage: '',
        }));
      }
    }
  }, { isActive: !noProfilesFound && !helpOpen && !paletteOpen });

  // STS verification
  useEffect(() => {
    if (state.step !== 'connecting') return;

    let cancelled = false;
    const controller = new AbortController();

    void (async () => {
      try {
        const identity = await testConnection(
          {
            profile: state.selectedProfile === 'default' ? undefined : state.selectedProfile,
            regions: [state.region],
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } as any,
          controller.signal,
        );
        if (!cancelled) {
          setState((s) => ({
            ...s,
            step: 'ai-provider',
            callerIdentity: { account: identity.account, arn: identity.arn },
          }));
        }
      } catch (err) {
        if (!cancelled) {
          setState((s) => ({
            ...s,
            step: 'error',
            errorOriginStep: 'connecting',
            errorMessage: err instanceof Error ? err.message : String(err),
          }));
        }
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [state.step, state.selectedProfile, state.region]);

  // Config write
  useEffect(() => {
    if (state.step !== 'writing') return;

    let cancelled = false;
    void (async () => {
      try {
        const result = await writekorinfraConfig({
          profile: state.selectedProfile,
          aiProvider: state.aiProvider,
          aiKey: state.aiKey,
        });
        if (!cancelled) {
          setState((s) => ({
            ...s,
            step: 'done',
            aiKey: '',
            configPath: result.configPath,
            envSaved: result.envSaved,
          }));
        }
      } catch (err) {
        if (!cancelled) {
          setState((s) => ({
            ...s,
            step: 'error',
            errorOriginStep: 'writing',
            errorMessage: err instanceof Error ? err.message : String(err),
          }));
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [state.step, state.selectedProfile, state.aiProvider, state.aiKey]);

  const subtitle = useMemo(() => {
    switch (state.step) {
      case 'profile':
      case 'confirm':
        return `set up korinfra${DOT_SEP}(1 of 4)`;
      case 'connecting':
        return `set up korinfra${DOT_SEP}(2 of 4)`;
      case 'ai-provider':
      case 'ai-key':
        return `set up korinfra${DOT_SEP}(3 of 4)`;
      case 'review':
        return `review${DOT_SEP}(before write)`;
      case 'writing':
        return 'saving configuration…';
      case 'done':
        return 'done';
      case 'error':
        return 'setup failed';
    }
  }, [state.step]);

  // ── Empty-state: no AWS profiles found ──────────────────────────────────
  if (noProfilesFound) {
    const awsConfigPath = path.join(os.homedir(), '.aws', 'config');
    const displayPath = formatPathForTerminal(awsConfigPath);
    return (
      <ScreenShell header={<CommandHeader command="init" description="initial setup" />}>
        <ErrorBox
          title="AWS profiles not found"
          message={`Create your AWS config file with a [profile_name] section, then run init again.\n\nCreate or edit: ${displayPath}`}
          hint="The wizard cannot continue until a profile exists."
          actions={[
            { key: 'd', label: 'run doctor', action: { type: 'navigate' as const, command: 'doctor' } },
            { key: 'c', label: 'copy AWS config path', action: { type: 'copy' as const, text: awsConfigPath } },
          ]}
          onAction={onAction}
          onBack={onBack}
        />
      </ScreenShell>
    );
  }

  // ── Error state ─────────────────────────────────────────────────────────
  if (state.step === 'error') {
    return (
      <ScreenShell header={<CommandHeader command="init" description={subtitle} />}>
        <ErrorBox
          title="Setup failed"
          message={state.errorMessage}
          actions={[
            { key: 'r', label: 'retry', action: { type: 'run-again' as const } },
            { key: 'd', label: 'doctor', action: { type: 'navigate' as const, command: 'doctor' } },
          ]}
          onAction={(action) => {
            if (action.type === 'run-again') {
              setState((s) => ({ ...s, step: s.errorOriginStep, errorMessage: '' }));
            } else {
              onAction?.(action);
            }
          }}
          onBack={onBack}
        />
      </ScreenShell>
    );
  }

  // ── Review (SafeWriteReview) ─────────────────────────────────────────────
  if (state.step === 'review') {
    const willChange = [
      { description: 'Write korinfra config', detail: state.configPath },
    ];
    if (state.aiProvider === 'anthropic' && state.aiKey !== '') {
      willChange.push({
        description: 'Save ANTHROPIC_API_KEY to .korinfra/.env (chmod 600)',
        detail: '.korinfra/.env',
      });
      willChange.push({
        description: 'Add .korinfra/.env and .korinfra/data.db to .gitignore',
        detail: '.gitignore',
      });
    }
    const dataUsed = [
      `profile ${state.selectedProfile}`,
      `region ${state.region}`,
      `AI provider ${state.aiProvider}`,
    ];

    return (
      <ScreenShell
        header={<CommandHeader command="init" description={subtitle} />}
        hints={<InteractionHints hints={[IH_COMMAND, IH_HELP, IH_BACK, IH_QUIT]} />}
      >
        <SafeWriteReview
          willChange={willChange}
          willNotChange={[]}
          dataUsed={dataUsed}
          safety={{
            dryRunAvailable: false,
            requiresAwsWrite: false,
            createsPrOnly: false,
            rollback: 'Delete the .korinfra/ directory to undo.',
          }}
          onConfirm={() => setState((s) => ({ ...s, step: 'writing' }))}
          onBack={() => setState((s) => ({ ...s, step: s.aiProvider === 'anthropic' ? 'ai-key' : 'ai-provider' }))}
          compact
        />
      </ScreenShell>
    );
  }

  // ── Build NavHints per step (X-1: navigation keys only) ─────────────────
  const navHints: InteractionHint[] = (() => {
    switch (state.step) {
      case 'profile':
        // no back on step 1 (top of wizard)
        return [IH_HELP, IH_QUIT];
      case 'confirm':
      case 'ai-provider':
        return [IH_HELP, IH_BACK, IH_QUIT];
      case 'connecting':
      case 'writing':
        return [IH_QUIT];
      case 'ai-key':
        // PasswordInput owns input — only show navigation keys.
        return [IH_HELP, IH_BACK, IH_QUIT];
      case 'done':
        return [IH_COMMAND, IH_HELP, IH_BACK, IH_QUIT];
      default:
        return [IH_COMMAND, IH_HELP, IH_QUIT];
    }
  })();

  // ── ActionBar per step ──────────────────────────────────────────────────
  const actionBar = (() => {
    switch (state.step) {
      case 'profile':
      case 'ai-provider':
        return (
          <ActionBar
            actions={[{ key: 'Enter', label: 'select', action: { type: 'run-again' as const } }]}
            onAction={onAction}
            marginLeft={MARGIN_LEFT_CONTENT}
          />
        );
      case 'confirm':
        return (
          <ActionBar
            actions={[{ key: 'Enter', label: 'verify credentials', action: { type: 'run-again' as const } }]}
            onAction={onAction}
            marginLeft={MARGIN_LEFT_CONTENT}
          />
        );
      case 'done':
        return (
          <ActionBar
            actions={[{ key: 's', label: 'scan now', action: { type: 'navigate' as const, command: 'scan' } }]}
            onAction={onAction}
            marginLeft={MARGIN_LEFT_CONTENT}
          />
        );
      case 'connecting':
      case 'ai-key':
      case 'writing':
      default:
        return undefined;
    }
  })();

  return (
    <ScreenShell
      header={<CommandHeader command="init" description={subtitle} />}
      actions={actionBar}
      hints={<InteractionHints hints={navHints} />}
    >
      <StepProgress step={state.step} />

      {/* §13.1 Profile select */}
      {state.step === 'profile' && (
        <Box flexDirection="column" marginLeft={MARGIN_LEFT_CONTENT} marginTop={GAP_BETWEEN_SECTIONS}>
          <Box marginBottom={GAP_BETWEEN_SECTIONS} flexDirection="column">
            <Text bold>AWS Profile</Text>
            <Text dimColor>
              From ~/.aws/config and ~/.aws/credentials.
            </Text>
          </Box>
          <Select
            options={state.profiles.map((p) => ({ label: p, value: p }))}
            defaultValue={state.selectedProfile}
            onChange={(value) => {
              setState((s) => ({
                ...s,
                selectedProfile: value,
                region: detectRegionForProfile(value),
                step: 'confirm',
              }));
            }}
          />
        </Box>
      )}

      {/* §13.1c Confirm */}
      {state.step === 'confirm' && (
        <Box flexDirection="column" marginLeft={MARGIN_LEFT_CONTENT} marginTop={GAP_BETWEEN_SECTIONS}>
          <Box gap={GAP_ROW}>
            <Text>Profile selected:</Text>
            <Text bold color={colors.brand}>{state.selectedProfile}</Text>
          </Box>
          <Box gap={GAP_ROW}>
            <Text>Region detected:</Text>
            <Text bold color={colors.brand}>{state.region}</Text>
          </Box>
          <Box marginTop={GAP_BETWEEN_SECTIONS}>
            <Text dimColor>korinfra will verify credentials for this profile.</Text>
          </Box>
        </Box>
      )}

      {/* §13.2 Connecting */}
      {state.step === 'connecting' && (
        <Box marginLeft={MARGIN_LEFT_CONTENT} marginTop={GAP_BETWEEN_SECTIONS} gap={GAP_ROW}>
          <Spinner label={`Verifying AWS credentials for profile: ${state.selectedProfile}…`} />
        </Box>
      )}

      {/* §13.3 AI provider */}
      {state.step === 'ai-provider' && (
        <Box flexDirection="column" marginLeft={MARGIN_LEFT_CONTENT} marginTop={GAP_BETWEEN_SECTIONS}>
          {state.callerIdentity && (
            <Box gap={GAP_ICON_TEXT} marginBottom={GAP_BETWEEN_SECTIONS}>
              <Text color={colors.success}>{icons.checkmark}</Text>
              <Text>
                Connected to account <Text bold>{state.callerIdentity.account}</Text>
              </Text>
            </Box>
          )}
          <Box marginBottom={GAP_BETWEEN_SECTIONS} flexDirection="column">
            <Text bold>AI Provider</Text>
            <Text dimColor>
              AI improves recommendations, reports, and fixes. Choose None for rules-only mode.
            </Text>
          </Box>
          <Select
            options={[
              { label: `Anthropic Claude${DOT_SEP}recommended${DOT_SEP}requires API key`, value: 'anthropic' },
              { label: `None${DOT_SEP}rules-only${DOT_SEP}free${DOT_SEP}no API key`, value: 'none' },
            ]}
            onChange={(value) => {
              const provider = value as AiProvider;
              setState((s) => ({
                ...s,
                aiProvider: provider,
                step: provider === 'anthropic' ? 'ai-key' : 'review',
              }));
            }}
          />
        </Box>
      )}

      {/* §13.4 API key entry */}
      {state.step === 'ai-key' && (
        <Box flexDirection="column" marginLeft={MARGIN_LEFT_CONTENT} marginTop={GAP_BETWEEN_SECTIONS}>
          <Box flexDirection="column" marginBottom={GAP_BETWEEN_SECTIONS}>
            <Text bold>Anthropic API key</Text>
            <Text dimColor>Input is hidden. Starts with sk-ant-api…</Text>
            <Text dimColor>Get a key at:  console.anthropic.com → API Keys</Text>
          </Box>
          <Box gap={GAP_ROW}>
            <Text color={colors.brand}>{icons.pointer}</Text>
            <PasswordInput
              placeholder="sk-ant-api…"
              onSubmit={(value) => {
                if (!validateApiKey('anthropic', value)) {
                  setState((s) => ({
                    ...s,
                    step: 'error',
                    errorOriginStep: 'ai-key',
                    errorMessage: 'Invalid key format. Must start with sk-ant-api',
                  }));
                  return;
                }
                setState((s) => ({ ...s, aiKey: value, step: 'review' }));
              }}
            />
          </Box>
        </Box>
      )}

      {/* writing spinner */}
      {state.step === 'writing' && (
        <Box marginLeft={MARGIN_LEFT_CONTENT} marginTop={GAP_BETWEEN_SECTIONS} gap={GAP_ROW}>
          <Spinner label="Saving configuration…" />
        </Box>
      )}

      {/* §13.5 Done */}
      {state.step === 'done' && (
        <Box flexDirection="column" marginLeft={MARGIN_LEFT_CONTENT} marginTop={GAP_BETWEEN_SECTIONS}>
          <Box gap={GAP_ICON_TEXT}>
            <Text color={colors.success}>{icons.checkmark}</Text>
            <Text>Config saved to <Text color={colors.brand}>{formatPathForTerminal(state.configPath)}</Text></Text>
          </Box>
          <Box flexDirection="column" marginTop={GAP_BETWEEN_SECTIONS}>
            <Box gap={GAP_ROW}>
              <Text dimColor>Profile:</Text>
              <Text color={colors.info}>{state.selectedProfile}</Text>
            </Box>
            <Box gap={GAP_ROW}>
              <Text dimColor>AI:</Text>
              <Text color={colors.info}>
                {state.aiProvider === 'anthropic'
                  ? `Anthropic Claude${DOT_SEP}claude-sonnet-4-6`
                  : 'None (rules-only)'}
              </Text>
            </Box>
            <Box gap={GAP_ROW}>
              <Text dimColor>Region:</Text>
              <Text color={colors.info}>{state.region}</Text>
            </Box>
          </Box>
          <Box marginTop={GAP_BETWEEN_SECTIONS}>
            <Text dimColor>Run korinfra scan to get started.</Text>
          </Box>
        </Box>
      )}
    </ScreenShell>
  );
}
