/**
 * ReportCommand — §10 Report generation wizard with multi-step flow.
 *
 * Lifecycle:
 *   §10.1 Format select: list HTML/CSV/JSON with descriptions. Header subtitle `choose format`.
 *         ActionBar `Enter select`. NavHints nav-only.
 *   §10.1b Options (step 2/4): TextInput for output path + TextInput for scan ID (blank=latest).
 *         Header subtitle `report options  (2 of 4)` with DOT_SEP. Tab cycles fields.
 *         If path exists show dim mtime under field.
 *   §10.1c Review (step 3/4): SafeWriteReview — three labeled boxes "Will write / Data used / Rollback".
 *         Header subtitle `review  (3 of 4)`. If file exists: "Will write" box shows
 *         `Will overwrite · last modified: <rel>`. SafeWriteReview owns footer; Enter fires generation.
 *   §10.2 Generating: spinner + "Building report from scan <id>…".
 *         Header subtitle `generating <FORMAT> report…`. NavHints `q quit`.
 *   §10.3 Done: `✓ Report saved to <path>`. Header subtitle `report saved`.
 *         ActionBar `o open in browser, c copy path` (conditional, only on success).
 *         NavHints `q quit`. On failure: no ActionBar, NavHints only `q quit`.
 *
 * Rules enforced:
 *   VRHYTHM_RULE  — GAP_AFTER_HEADER / GAP_BETWEEN_SECTIONS / GAP_BEFORE_ACTIONS only
 *   DOT_SEP_RULE  — DOT_SEP from ui/text.js
 *   SCREEN_SHELL_RULE — wrapped in ScreenShell
 *   X-1 rule — NavHints = navigation only; o/c/p in ActionBar
 *   ERR2-1 rule — ErrorBox owns its footer
 *   G-2 rule — renderResult returns CommandResultView
 */

import React, { useState, useEffect, useMemo, useRef } from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import { useGlobalOverlay } from '../hooks/useGlobalOverlay.js';
import { TextInput } from '@inkjs/ui';
import { Spinner } from '@inkjs/ui';
import path from 'node:path';
import fs from 'node:fs';


import { CommandHeader } from '../components/CommandHeader.js';
import { ScreenShell } from '../components/ScreenShell.js';
import { InteractionHints, IH_QUIT, IH_BACK, IH_TAB, IH_COMMAND, IH_HELP } from '../components/InteractionHints.js';
import { ActionBar } from '../components/ActionBar.js';
import { SafeWriteReview } from '../components/SafeWriteReview.js';
import { colors, icons } from '../theme.js';
import { GAP_BETWEEN_SECTIONS, GAP_AFTER_HEADER, GAP_ICON_TEXT, GAP_ROW, MARGIN_LEFT_RESULT } from '../ui/spacing.js';
import { DOT_SEP } from '../ui/text.js';
import { truncateWidth } from '../ui/width.js';
import { safeWriteFile } from '../../utils/safe-fs.js';
import type { TuiAction } from '../actions.js';
import { getDb } from '../../storage/db.js';
import { getScan, listScans } from '../../storage/queries/scans.js';
import { listResources } from '../../storage/queries/resources.js';
import { listCosts } from '../../storage/queries/costs.js';
import { listRecommendations } from '../../storage/queries/recommendations.js';
import { createFormatter } from '../../output/index.js';
import { logger } from '../../utils/logger.js';

// ─── Types ────────────────────────────────────────────────────────────────────

type ReportStep = 'format' | 'options' | 'review' | 'generating' | 'done';
type ReportFormat = 'html' | 'csv' | 'json';

interface FileInfo {
  exists: boolean;
  mtime?: Date;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getFileInfo(absPath: string): FileInfo {
  try {
    const stat = fs.statSync(absPath);
    return { exists: true, mtime: stat.mtime };
  } catch {
    return { exists: false };
  }
}

function formatFileDate(d: Date): string {
  const now = Date.now();
  const diffMs = now - d.getTime();
  const diffMins = Math.floor(diffMs / 60_000);
  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins} min ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

// ─── Props ────────────────────────────────────────────────────────────────────

interface ReportCommandProps {
  provider?: unknown;
  args?: string[];
  onRunAgain?: () => void;
  onBack?: () => void;
  onAction?: (action: TuiAction) => void;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function ReportCommand({
  args,
  onBack,
  onAction,
}: ReportCommandProps): React.JSX.Element {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const { helpOpen, paletteOpen } = useGlobalOverlay();

  const argList = args ?? [];
  const argFormatIdx = argList.indexOf('--format');
  const argScanIdx = argList.indexOf('--scan');
  const argOutputIdx = argList.indexOf('--output');
  const argFormat = argFormatIdx >= 0 ? argList[argFormatIdx + 1] : undefined;
  const argScan = argScanIdx >= 0 ? argList[argScanIdx + 1] : undefined;
  const argOutput = argOutputIdx >= 0 ? argList[argOutputIdx + 1] : undefined;
  const hasDirectArgs = argFormat !== undefined && (argFormat === 'html' || argFormat === 'csv' || argFormat === 'json');

  // State
  const [step, setStep] = useState<ReportStep>(hasDirectArgs ? 'review' : 'format');
  const [selectedFormat, setSelectedFormat] = useState<ReportFormat>(
    hasDirectArgs ? (argFormat) : 'html',
  );
  const [formatIdx, setFormatIdx] = useState(
    hasDirectArgs ? ['html', 'csv', 'json'].indexOf(argFormat as string) : 0,
  );
  const [outputPath, setOutputPath] = useState(
    argOutput ?? `~/korinfra-report.${hasDirectArgs ? argFormat : 'html'}`,
  );
  const [scanId, setScanId] = useState(argScan ?? '');
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ success: boolean; path: string; message: string } | null>(null);

  // Computed
  const termWidth = stdout?.columns ?? 80;
  const formats: Array<{ label: string; value: ReportFormat; description: string }> = [
    { label: 'HTML', value: 'html', description: 'rich, charts, shareable in browser' },
    { label: 'CSV', value: 'csv', description: 'spreadsheet / data export' },
    { label: 'JSON', value: 'json', description: 'raw data, programmatic use' },
  ];

  // Resolve output path
  const resolvedOutputPath = useMemo(() => {
    try {
      const expanded = outputPath.startsWith('~')
        ? path.join(process.env['HOME'] ?? process.env['USERPROFILE'] ?? '~', outputPath.slice(2))
        : path.resolve(process.cwd(), outputPath);
      return expanded;
    } catch {
      return '';
    }
  }, [outputPath]);

  const fileInfo = useMemo(() => getFileInfo(resolvedOutputPath), [resolvedOutputPath]);

  // ─── Format select (§10.1) ────────────────────────────────────────────────────

  useInput((input, key) => {
    if (step === 'format') {
      if (input === 'q') {
        exit();
        return;
      }
      if ((input === 'b' || key.escape) && onBack !== undefined) {
        onBack();
        return;
      }
      if ((input === 'b' || key.escape) && onBack === undefined) {
        exit();
        return;
      }
      if (key.upArrow) {
        const newIdx = Math.max(0, formatIdx - 1);
        setFormatIdx(newIdx);
        const newFmt = formats[newIdx];
        if (newFmt) {
          setSelectedFormat(newFmt.value);
        }
        return;
      }
      if (key.downArrow) {
        const newIdx = Math.min(formats.length - 1, formatIdx + 1);
        setFormatIdx(newIdx);
        const newFmt = formats[newIdx];
        if (newFmt) {
          setSelectedFormat(newFmt.value);
        }
        return;
      }
      if (key.return) {
        setOutputPath(`~/korinfra-report.${selectedFormat}`);
        setStep('options');
        return;
      }
    }

    // Options step (§10.1b)
    if (step === 'options') {
      if (input === 'q') {
        exit();
        return;
      }
      if ((input === 'b' || key.escape) && onBack !== undefined) {
        setStep('format');
        return;
      }
      if ((input === 'b' || key.escape) && onBack === undefined) {
        setStep('format');
        return;
      }
    }

    // Review step (§10.1c)
    if (step === 'review') {
      if (input === 'q') {
        exit();
        return;
      }
      if ((input === 'b' || key.escape) && onBack !== undefined) {
        setStep('options');
        return;
      }
      if ((input === 'b' || key.escape) && onBack === undefined) {
        setStep('options');
        return;
      }
    }

    // Generating step (§10.2)
    if (step === 'generating') {
      if (input === 'q') {
        exit();
        return;
      }
    }

    // Done step (§10.3)
    if (step === 'done') {
      if (input === 'q' || input === 'b' || key.escape) {
        if (onBack !== undefined) onBack();
        else exit();
        return;
      }
    }
  }, { isActive: !helpOpen && !paletteOpen });

  // ─── Step: Format select (§10.1) ──────────────────────────────────────────────

  if (step === 'format') {
    return (
      <ScreenShell
        header={<CommandHeader command="report" description="choose format" />}
        actions={
          <ActionBar
            actions={[
              { key: 'Enter', label: 'select', action: { type: 'run-again' as const } },
            ]}
            onAction={(action) => {
              if (action.type === 'run-again') {
                setOutputPath(`~/korinfra-report.${selectedFormat}`);
                setStep('options');
                return;
              }
              onAction?.(action);
            }}
            marginLeft={MARGIN_LEFT_RESULT}
          />
        }
        hints={<InteractionHints hints={[IH_COMMAND, IH_HELP, ...(onBack !== undefined ? [IH_BACK] : []), IH_QUIT]} />}
      >
        <Box marginLeft={MARGIN_LEFT_RESULT} marginTop={GAP_AFTER_HEADER} flexDirection="column">
          {formats.map((fmt, idx) => {
            const isSelected = idx === formatIdx;
            return (
              <Box key={fmt.value} flexDirection="column" marginBottom={GAP_BETWEEN_SECTIONS}>
                <Box gap={GAP_ROW}>
                  <Text color={isSelected ? colors.brand : undefined}>
                    {isSelected ? '▸' : ' '}
                  </Text>
                  <Text bold={isSelected} color={isSelected ? colors.brand : colors.highlight}>
                    {fmt.label}
                  </Text>
                  <Text dimColor>{fmt.description}</Text>
                </Box>
              </Box>
            );
          })}
        </Box>
      </ScreenShell>
    );
  }

  // ─── Step: Options (§10.1b) ───────────────────────────────────────────────────

  if (step === 'options') {
    return (
      <ReportOptionsStep
        format={selectedFormat}
        outputPath={outputPath}
        scanId={scanId}
        fileInfo={fileInfo}
        onNext={(newPath, newScanId) => {
          setOutputPath(newPath);
          setScanId(newScanId);
          setStep('review');
        }}
        onBack={() => setStep('format')}
      />
    );
  }

  // ─── Step: Review (§10.1c) ────────────────────────────────────────────────────

  if (step === 'review') {
    return (
      <ReportReviewStep
        format={selectedFormat}
        outputPath={outputPath}
        fileInfo={fileInfo}
        scanId={scanId}
        onConfirm={() => setStep('generating')}
        onBack={() => setStep('options')}
      />
    );
  }

  // ─── Step: Generating (§10.2) ─────────────────────────────────────────────────

  if (step === 'generating') {
    return (
      <ReportGeneratingStep
        format={selectedFormat}
        outputPath={resolvedOutputPath}
        scanId={scanId}
        onDone={(success, path, message) => {
          if (success) {
            setResult({ success: true, path, message });
          } else {
            setResult({ success: false, path: '', message });
            setError(message);
          }
          setStep('done');
        }}
      />
    );
  }

  // ─── Step: Done (§10.3) ────────────────────────────────────────────────────────

  if (step === 'done') {
    if (result?.success) {
      return (
        <ScreenShell
          header={<CommandHeader command="report" description="report saved" />}
          actions={
            <ActionBar
              actions={[
                { key: 'o', label: 'open in browser', action: { type: 'open-file' as const, path: result.path } },
                { key: 'c', label: 'copy path', action: { type: 'copy' as const, text: result.path } },
              ]}
              onAction={onAction}
              marginLeft={MARGIN_LEFT_RESULT}
            />
          }
          hints={<InteractionHints hints={[IH_COMMAND, IH_HELP, ...(onBack !== undefined ? [IH_BACK] : []), IH_QUIT]} />}
        >
          <Box marginLeft={MARGIN_LEFT_RESULT} marginTop={GAP_AFTER_HEADER} flexDirection="column">
            <Box gap={GAP_ICON_TEXT}>
              <Text color={colors.success}>{icons.success ?? '✓'}</Text>
              <Text>Report saved to {truncateWidth(result.path, termWidth - 20)}</Text>
            </Box>
          </Box>
        </ScreenShell>
      );
    } else {
      return (
        <ScreenShell
          header={<CommandHeader command="report" description="report saved" />}
          hints={<InteractionHints hints={[IH_COMMAND, IH_HELP, ...(onBack !== undefined ? [IH_BACK] : []), IH_QUIT]} />}
        >
          <Box marginLeft={MARGIN_LEFT_RESULT} marginTop={GAP_AFTER_HEADER} flexDirection="column">
            <Box gap={GAP_ICON_TEXT}>
              <Text color={colors.warning}>{icons.warning}</Text>
              <Text>Failed to generate report: {error}</Text>
            </Box>
          </Box>
        </ScreenShell>
      );
    }
  }

  return <Box />;
}

// ─── ReportOptionsStep component ──────────────────────────────────────────────

interface ReportOptionsStepProps {
  format: ReportFormat;
  outputPath: string;
  scanId: string;
  fileInfo: FileInfo;
  onNext: (path: string, scanId: string) => void;
  onBack: () => void;
}

type OptionsField = 'outputPath' | 'scanId';

function ReportOptionsStep({
  format,
  outputPath: initialPath,
  scanId: initialScanId,
  fileInfo,
  onNext,
  onBack,
}: ReportOptionsStepProps): React.JSX.Element {
  const { exit } = useApp();
  const { helpOpen, paletteOpen } = useGlobalOverlay();
  const [outputPath, setOutputPath] = useState(initialPath);
  const [scanId, setScanId] = useState(initialScanId);
  const [focusedField, setFocusedField] = useState<OptionsField>('outputPath');
  const prevHelpOpenRef = useRef(helpOpen);
  const [textInputKey, setTextInputKey] = useState(0);

  // Strip `?` that @inkjs/ui TextInput types in the same event cycle that opens the help overlay.
  // Force re-mount via key so the uncontrolled TextInput picks up the corrected defaultValue.
  useEffect(() => {
    if (helpOpen && !prevHelpOpenRef.current) {
      setOutputPath(p => p.endsWith('?') ? p.slice(0, -1) : p);
      setScanId(s => s.endsWith('?') ? s.slice(0, -1) : s);
      setTextInputKey(k => k + 1);
    }
    prevHelpOpenRef.current = helpOpen;
  }, [helpOpen]);

  useInput((input, key) => {
    if (input === 'q') {
      exit();
      return;
    }
    if ((input === 'b' || key.escape) && onBack !== undefined) {
      onBack();
      return;
    }
    if (input === 'Tab' || key.tab) {
      setFocusedField((f) => (f === 'outputPath' ? 'scanId' : 'outputPath'));
      return;
    }
    if (key.return && focusedField === 'scanId') {
      onNext(outputPath, scanId);
      return;
    }
  }, { isActive: !helpOpen && !paletteOpen });

  return (
    <ScreenShell
      header={<CommandHeader command="report" description={`report options${DOT_SEP}(2 of 4)`} />}
      actions={
        <ActionBar
          actions={[
            { key: 'Enter', label: 'next', action: { type: 'run-again' as const } },
          ]}
          onAction={(action) => {
            if (action.type === 'run-again') {
              onNext(outputPath, scanId);
            }
          }}
          marginLeft={MARGIN_LEFT_RESULT}
        />
      }
      hints={<InteractionHints hints={[IH_TAB, IH_COMMAND, IH_HELP, IH_BACK, IH_QUIT]} />}
    >
      <Box marginLeft={MARGIN_LEFT_RESULT} marginTop={GAP_AFTER_HEADER} flexDirection="column">
        {/* Output path field */}
        <Box flexDirection="column" marginBottom={GAP_BETWEEN_SECTIONS}>
          <Text bold>Output path</Text>
          <Box marginTop={GAP_BETWEEN_SECTIONS}>
            {focusedField === 'outputPath' ? (
              <TextInput
                key={textInputKey}
                defaultValue={outputPath}
                onChange={setOutputPath}
                placeholder={`~/korinfra-report.${format}`}
              />
            ) : (
              <Text color={colors.info}>{outputPath}</Text>
            )}
          </Box>
          {fileInfo.exists && fileInfo.mtime && (
            <Box marginTop={GAP_BETWEEN_SECTIONS}>
              <Text dimColor>last modified: {formatFileDate(fileInfo.mtime)}</Text>
            </Box>
          )}
        </Box>

        {/* Scan ID field */}
        <Box flexDirection="column" marginBottom={GAP_BETWEEN_SECTIONS}>
          <Text bold>Scan ID  (leave blank for latest)</Text>
          <Box marginTop={GAP_BETWEEN_SECTIONS}>
            {focusedField === 'scanId' ? (
              <TextInput
                key={`scan-${textInputKey}`}
                defaultValue={scanId}
                onChange={setScanId}
                placeholder="latest"
              />
            ) : (
              <Text color={scanId ? colors.info : colors.muted}>
                {scanId || 'latest'}
              </Text>
            )}
          </Box>
        </Box>
      </Box>
    </ScreenShell>
  );
}

// ─── ReportReviewStep component ────────────────────────────────────────────────

interface ReportReviewStepProps {
  format: ReportFormat;
  outputPath: string;
  fileInfo: FileInfo;
  scanId: string;
  onConfirm: () => void;
  onBack: () => void;
}

function ReportReviewStep({
  format,
  outputPath,
  fileInfo,
  scanId,
  onConfirm,
  onBack,
}: ReportReviewStepProps): React.JSX.Element {
  const [isActive, setIsActive] = useState(false);
  const mountedRef = useRef(false);

  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      const id = setTimeout(() => {
        setIsActive(true);
      }, 80);
      return () => {
        clearTimeout(id);
      };
    }
    return undefined;
  }, []);

  try {
    const db = getDb();
    const scan = scanId ? getScan(db, scanId) : null;
    const latestScans = listScans(db, 1, 0);
    const activeScan = scan ?? (latestScans.length > 0 ? latestScans[0] : null);

    const dataUsedParts = [];
    if (activeScan) {
      const scanIdStr = activeScan.id.slice(0, 12);
      dataUsedParts.push(`Scan ${scanIdStr}`);
      if (activeScan.total_recommendations && activeScan.total_recommendations > 0) {
        dataUsedParts.push(`${activeScan.total_recommendations} finding${activeScan.total_recommendations !== 1 ? 's' : ''}`);
      }
      if (activeScan.total_resources && activeScan.total_resources > 0) {
        dataUsedParts.push(`${activeScan.total_resources} resource${activeScan.total_resources !== 1 ? 's' : ''}`);
      }
    }

    return (
      <ScreenShell
        header={<CommandHeader command="report" description={`review${DOT_SEP}(3 of 4)`} />}
      >
        <SafeWriteReview
          willChange={[
            {
              description: `Write ${format.toUpperCase()} report`,
              detail: outputPath,
            },
          ]}
          willNotChange={[]}
          dataUsed={dataUsedParts.length > 0 ? [dataUsedParts.join(DOT_SEP)] : ['latest scan']}
          safety={{
            dryRunAvailable: false,
            requiresAwsWrite: false,
            createsPrOnly: false,
            rollback: fileInfo.exists ? 'Restore from backup or delete the file' : 'Delete the generated file',
          }}
          onConfirm={onConfirm}
          onBack={onBack}
          isActive={isActive}
          compact
        />
      </ScreenShell>
    );
  } catch (err) {
    logger.error({ err }, '[report] Failed to load scan data for review');
    return (
      <ScreenShell
        header={<CommandHeader command="report" description={`review${DOT_SEP}(3 of 4)`} />}
      >
        <SafeWriteReview
          willChange={[
            {
              description: `Write ${format.toUpperCase()} report`,
              detail: outputPath,
            },
          ]}
          willNotChange={[]}
          dataUsed={['latest scan']}
          safety={{
            dryRunAvailable: false,
            requiresAwsWrite: false,
            createsPrOnly: false,
            rollback: fileInfo.exists ? 'Delete the file' : 'Delete the generated file',
          }}
          onConfirm={onConfirm}
          onBack={onBack}
          isActive={isActive}
          compact
        />
      </ScreenShell>
    );
  }
}

// ─── ReportGeneratingStep component ───────────────────────────────────────────

interface ReportGeneratingStepProps {
  format: ReportFormat;
  outputPath: string;
  scanId: string;
  onDone: (success: boolean, path: string, message: string) => void;
}

function ReportGeneratingStep({
  format,
  outputPath,
  scanId,
  onDone,
}: ReportGeneratingStepProps): React.JSX.Element {
  const { exit } = useApp();
  const { helpOpen, paletteOpen } = useGlobalOverlay();

  useInput((input) => {
    if (input === 'q') {
      exit();
    }
  }, { isActive: !helpOpen && !paletteOpen });

  useEffect(() => {
    const tid = setTimeout(() => {
      try {
        const db = getDb();

        // Get the appropriate scan
        let activeScan = null;
        if (scanId) {
          activeScan = getScan(db, scanId);
          if (!activeScan) {
            onDone(false, '', `Scan "${scanId}" not found`);
            return;
          }
        } else {
          const latestScans = listScans(db, 1, 0);
          activeScan = latestScans.length > 0 ? latestScans[0] : null;
          if (!activeScan) {
            onDone(false, '', 'No scan data available');
            return;
          }
        }

        // Build report data
        const formatter = createFormatter(format);
        const resources = listResources(db, activeScan.id);
        const costs = listCosts(db, activeScan.id);
        const recommendations = listRecommendations(db, activeScan.id);
        const potentialSavings = recommendations.reduce((s, r) => s + (r.estimated_savings ?? 0), 0);
        const reportData = {
          scanId: activeScan.id,
          timestamp: activeScan.completed_at ?? activeScan.started_at,
          resources: resources.map(r => ({
            id: r.resource_id,
            type: r.type,
            name: r.name ?? '',
            region: r.region ?? '',
            state: r.state ?? '',
            ...(r.instance_type !== null && r.instance_type !== undefined ? { instanceType: r.instance_type } : {}),
            monthlyCost: r.monthly_cost ?? 0,
            monthlyCostSource: r.monthly_cost_source ?? null,
            ...(r.tags !== null && r.tags !== undefined ? { tags: r.tags } : {}),
          })),
          recommendations: recommendations.map(r => ({
            id: r.id,
            resourceId: r.resource_id ?? '',
            type: r.type,
            title: r.title,
            ...(r.description !== null && r.description !== undefined ? { description: r.description } : {}),
            estimatedSavings: r.estimated_savings ?? 0,
            confidence: r.confidence ?? 0,
            impact: r.impact ?? 'medium',
            risk: r.risk ?? 'low',
            status: r.status ?? 'draft',
            scenario: r.scenario ?? null,
            implementationSteps: r.implementation_steps ?? null,
          })),
          costs: costs.map(c => ({
            serviceName: c.service_name,
            region: c.region ?? '',
            costDate: c.cost_date,
            dailyCost: c.daily_cost ?? 0,
            monthlyCost: c.monthly_cost ?? 0,
            currency: c.currency ?? 'USD',
          })),
          summary: {
            totalResources: resources.length,
            totalMonthlyCost: costs.reduce((s, c) => s + (c.monthly_cost ?? 0), 0),
            potentialSavings,
            recommendationCount: recommendations.length,
          },
        };

        // Format and write
        const formatted = formatter.format(reportData);
        safeWriteFile(outputPath, formatted, { mode: 0o600, dirMode: 0o700 });
        onDone(true, outputPath, 'Report generated successfully');
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unknown error';
        onDone(false, '', msg);
      }
    }, 500);

    return () => {
      clearTimeout(tid);
    };
  }, [format, outputPath, scanId, onDone]);

  return (
    <ScreenShell
      header={<CommandHeader command="report" description={`generating ${format.toUpperCase()} report…`} />}
      hints={<InteractionHints hints={[IH_QUIT]} />}
    >
      <Box marginLeft={MARGIN_LEFT_RESULT} marginTop={GAP_AFTER_HEADER} flexDirection="column">
        <Box gap={GAP_ROW}>
          <Spinner />
          <Text>Building report from scan {scanId || 'latest'}…</Text>
        </Box>
      </Box>
    </ScreenShell>
  );
}
