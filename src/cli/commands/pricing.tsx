/**
 * pricing command — cache status, region picker, download, clear.
 *
 * Implements tui-ux-spec.md §12.
 *   §12.1 cache status      — usable / stale / empty
 *   §12.2 download state    — spinner + progress bar
 *   §12.3 region picker     — multi-select overlay
 *   §12.4 region breakdown  — table below status when cache is usable
 */

import React, { useEffect, useRef, useState } from 'react';

import { Box, Text, useApp, useInput, useStdout } from 'ink';
import { Spinner } from '@inkjs/ui';

import { ErrorBox } from '../components/ErrorBox.js';
import { ActionBar } from '../components/ActionBar.js';
import { ProgressBar } from '../components/ProgressBar.js';
import { ScreenShell } from '../components/ScreenShell.js';
import { DataTable } from '../components/DataTable.js';
import type { ColumnDef } from '../components/DataTable.js';
import { SafeWriteReview } from '../components/SafeWriteReview.js';
import { CommandHeader } from '../components/CommandHeader.js';
import {
  InteractionHints,
  IH_QUIT,
  IH_BACK,
  IH_COMMAND,
  IH_HELP,
} from '../components/InteractionHints.js';
import { colors, icons, semanticColors, borders } from '../theme.js';
import {
  GAP_AFTER_HEADER,
  GAP_BETWEEN_SECTIONS,
  GAP_ROW,
  MARGIN_LEFT_CONTENT,
} from '../ui/spacing.js';
import { DOT_SEP } from '../ui/text.js';
import { truncateWidth } from '../ui/width.js';
import { SectionTitle } from '../ui/typography.js';
import { PricingCache, AwsPricingClient } from '../../pricing/index.js';
import { getDb } from '../../storage/index.js';
import type { ActionHint, TuiAction } from '../actions.js';
import { useGlobalOverlay } from '../hooks/useGlobalOverlay.js';

// ─── Constants ───────────────────────────────────────────────────────────────

const COMMON_REGIONS = [
  'us-east-1', 'us-east-2', 'us-west-1', 'us-west-2',
  'eu-west-1', 'eu-west-2', 'eu-west-3', 'eu-central-1', 'eu-north-1',
  'ap-southeast-1', 'ap-southeast-2', 'ap-northeast-1', 'ap-south-1',
  'ca-central-1', 'sa-east-1',
] as const;

/** Cache entries older than this are considered stale. */
const STALE_THRESHOLD_DAYS = 14;
/** Downloads covering more than this many regions trigger a SafeWriteReview. */
const LARGE_DOWNLOAD_REGION_THRESHOLD = 2;

const AWS_REGION_RE = /^[a-z]{2}-[a-z]+-\d+$/;

// Service specs pulled in bulk per region. Each region fetches all of these.
interface BulkFetchSpec { serviceCode: string; productFamily?: string; label: string }
const BULK_SPECS: BulkFetchSpec[] = [
  { serviceCode: 'AmazonEC2', label: 'EC2' },
  { serviceCode: 'AmazonEC2', productFamily: 'Storage', label: 'EBS' },
  { serviceCode: 'AmazonRDS', label: 'RDS' },
  { serviceCode: 'AmazonElastiCache', label: 'ElastiCache' },
  { serviceCode: 'AmazonS3', label: 'S3' },
  { serviceCode: 'AWSELB', label: 'ELB' },
  { serviceCode: 'AmazonDynamoDB', label: 'DynamoDB' },
  { serviceCode: 'AmazonVPC', label: 'NAT Gateway' },
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

type CacheHealth = 'usable' | 'stale' | 'empty';

function computeCacheHealth(count: number, expiredCount: number, newest: string | null): CacheHealth {
  if (count === 0) return 'empty';
  if (newest === null) return 'stale';
  const ageDays = (Date.now() - new Date(newest).getTime()) / (1000 * 60 * 60 * 24);
  if (expiredCount > 0 || ageDays >= STALE_THRESHOLD_DAYS) return 'stale';
  return 'usable';
}

function cacheHealthColor(health: CacheHealth): string | undefined {
  switch (health) {
    case 'usable': return semanticColors.status.pass;
    case 'stale': return semanticColors.status.warn;
    case 'empty': return semanticColors.status.fail;
  }
}

/** "2 days ago", "just now", "3 weeks ago" — or "never" for null input. */
function formatRelativeTime(isoOrNull: string | null): string {
  if (isoOrNull === null) return 'never';
  const d = new Date(isoOrNull);
  if (Number.isNaN(d.getTime())) return isoOrNull;
  const diffMs = Date.now() - d.getTime();
  const diffMins = Math.floor(diffMs / 60_000);
  if (diffMins < 2) return 'just now';
  if (diffMins < 60) return `${diffMins} minutes ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours} hour${diffHours !== 1 ? 's' : ''} ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 14) return `${diffDays} day${diffDays !== 1 ? 's' : ''} ago`;
  const diffWeeks = Math.floor(diffDays / 7);
  if (diffWeeks < 8) return `${diffWeeks} week${diffWeeks !== 1 ? 's' : ''} ago`;
  const diffMonths = Math.floor(diffDays / 30);
  return `${diffMonths} month${diffMonths !== 1 ? 's' : ''} ago`;
}

function formatDate(iso: string | null): string {
  if (iso === null) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().slice(0, 10);
}

function isRegionStale(newest: string): boolean {
  const d = new Date(newest);
  if (Number.isNaN(d.getTime())) return true;
  const ageDays = (Date.now() - d.getTime()) / (1000 * 60 * 60 * 24);
  return ageDays >= STALE_THRESHOLD_DAYS;
}

// ─── Cache status state ──────────────────────────────────────────────────────

interface CacheState {
  status: 'loading' | 'done' | 'error';
  count: number;
  newest: string | null;
  expiredCount: number;
  regionBreakdown: Array<{ region: string; count: number; oldest: string; newest: string }>;
  errorMessage: string;
}

// Mode of the pricing screen — drives which overlay/footer renders.
type Mode =
  | { kind: 'status' }
  | { kind: 'picker' }
  | { kind: 'review'; regions: string[] }
  | { kind: 'downloading'; regions: string[] }
  | { kind: 'download-done'; regions: string[]; failed: number; succeeded: number; entries: number; errorMsg?: string }
  | { kind: 'clear-confirm' };

// ─── Region picker overlay (§12.3) ───────────────────────────────────────────

interface RegionPickerProps {
  selected: Set<string>;
  focusedIdx: number;
  onChange: (next: Set<string>) => void;
  onFocus: (idx: number) => void;
  onConfirm: (regions: string[]) => void;
  onCancel: () => void;
}

const SELECT_ALL_IDX = 0;

function RegionPicker({
  selected, focusedIdx, onChange, onFocus, onConfirm, onCancel,
}: RegionPickerProps): React.JSX.Element {
  const { helpOpen, paletteOpen } = useGlobalOverlay();
  const { stdout } = useStdout();
  const termRows = stdout?.rows ?? 24;

  // Chrome = everything except region rows (measured from PTY at 30 rows):
  // header(3) + gaps(2) + border-top(1) + title+gaps+select-all+divider(6)
  // + border-bottom(1) + gaps(2) + actionbar(1) + gap(1) + selected(1) + gap(1) + hints(1) + trailing(1)
  // + ↓ indicator always shown when clipped (1) = 22
  // ↑ indicator appears when scrollTop > 0, adding 1 more row → subtract 1 extra to leave headroom
  const PICKER_CHROME = 22;
  const maxVisible = Math.max(3, termRows - PICKER_CHROME - 1);

  // Compute scrollTop inline from focusedIdx — avoids the 1-frame flicker that
  // useState+useEffect causes when the cursor crosses a scroll boundary.
  const scrollTopRef = useRef(0);
  if (focusedIdx !== SELECT_ALL_IDX) {
    const regionIdx = focusedIdx - 1;
    if (regionIdx < scrollTopRef.current) scrollTopRef.current = regionIdx;
    else if (regionIdx >= scrollTopRef.current + maxVisible) scrollTopRef.current = regionIdx - maxVisible + 1;
  }
  const scrollTop = focusedIdx === SELECT_ALL_IDX ? 0 : scrollTopRef.current;

  useInput((input, key) => {
    if (key.escape || input === 'b') { onCancel(); return; }
    if (key.upArrow) {
      onFocus(Math.max(0, focusedIdx - 1));
      return;
    }
    if (key.downArrow) {
      onFocus(Math.min(COMMON_REGIONS.length, focusedIdx + 1));
      return;
    }
    if (input === ' ') {
      if (focusedIdx === SELECT_ALL_IDX) {
        if (selected.size === COMMON_REGIONS.length) {
          onChange(new Set());
        } else {
          onChange(new Set(COMMON_REGIONS));
        }
      } else {
        const region = COMMON_REGIONS[focusedIdx - 1] ?? '';
        const next = new Set(selected);
        if (next.has(region)) next.delete(region);
        else next.add(region);
        onChange(next);
      }
      return;
    }
    if (key.return) {
      if (selected.size === 0) return;
      onConfirm([...selected]);
    }
  }, { isActive: !helpOpen && !paletteOpen });

  const allSelected = selected.size === COMMON_REGIONS.length;
  const hasAbove = scrollTop > 0;
  const hasBelow = scrollTop + maxVisible < COMMON_REGIONS.length;
  const visibleRegions = COMMON_REGIONS.slice(scrollTop, scrollTop + maxVisible);

  return (
    <Box flexDirection="column" marginLeft={MARGIN_LEFT_CONTENT} marginTop={GAP_AFTER_HEADER}>
      <Box borderStyle={borders.card} borderColor={colors.border} paddingX={1} flexDirection="column">
        <Box>
          <SectionTitle>Select regions to download</SectionTitle>
        </Box>

        {/* Select-all row */}
        <Box marginTop={GAP_BETWEEN_SECTIONS} gap={GAP_ROW} flexShrink={0}>
          <Text color={focusedIdx === SELECT_ALL_IDX ? colors.brand : undefined}>
            {focusedIdx === SELECT_ALL_IDX ? icons.pointer : ' '}
          </Text>
          <Text>{allSelected ? '[x]' : '[ ]'}</Text>
          <Text>Select all</Text>
        </Box>

        {/* Divider */}
        <Box marginTop={GAP_BETWEEN_SECTIONS} marginBottom={GAP_BETWEEN_SECTIONS}>
          <Text dimColor>{icons.dash.repeat(40)}</Text>
        </Box>

        {/* Scroll indicator above */}
        {hasAbove && (
          <Box>
            <Text dimColor>↑ {scrollTop} above</Text>
          </Box>
        )}

        {/* Region rows — windowed + flexShrink=0 to prevent Yoga zero-height collapse */}
        {visibleRegions.map((region, i) => {
          const rowIdx = scrollTop + i + 1;
          const isFocused = focusedIdx === rowIdx;
          const isSelected = selected.has(region);
          return (
            <Box key={region} gap={GAP_ROW} flexShrink={0}>
              <Text color={isFocused ? colors.brand : undefined}>
                {isFocused ? icons.pointer : ' '}
              </Text>
              <Text>{isSelected ? '[x]' : '[ ]'}</Text>
              <Text>{region}</Text>
            </Box>
          );
        })}

        {/* Scroll indicator below */}
        {hasBelow && (
          <Box>
            <Text dimColor>↓ {COMMON_REGIONS.length - scrollTop - maxVisible} below</Text>
          </Box>
        )}
      </Box>

      {/* Overlay footer — owns its own hints */}
      <Box marginTop={GAP_BETWEEN_SECTIONS}>
        <ActionBar
          actions={[
            { key: 'Enter', label: 'download selected', action: { type: 'run-again' } },
            { key: 'Space', label: 'toggle', action: { type: 'run-again' } },
          ]}
          marginLeft={MARGIN_LEFT_CONTENT}
        />
      </Box>
      <Box marginLeft={MARGIN_LEFT_CONTENT} marginTop={GAP_BETWEEN_SECTIONS}>
        <Text dimColor>{selected.size} selected</Text>
      </Box>
      <Box marginLeft={MARGIN_LEFT_CONTENT}>
        <InteractionHints hints={[IH_COMMAND, IH_HELP, IH_BACK, IH_QUIT]} />
      </Box>
    </Box>
  );
}

// ─── Downloader (§12.2) ──────────────────────────────────────────────────────

interface DownloadRunnerProps {
  regions: string[];
  onDone: (result: { succeeded: number; failed: number; entries: number; errorMsg?: string }) => void;
  onCancel: () => void;
}

function Downloader({ regions, onDone, onCancel }: DownloadRunnerProps): React.JSX.Element {
  const [currentRegion, setCurrentRegion] = useState(0); // 0..regions.length
  const [servicesDoneInRegion, setServicesDoneInRegion] = useState(0);
  const [succeeded, setSucceeded] = useState(0);
  const [failed, setFailed] = useState(0);
  const controllerRef = useRef<AbortController | null>(null);
  const { exit } = useApp();
  const { helpOpen, paletteOpen } = useGlobalOverlay();

  useInput((input) => {
    if (input === 'q') {
      controllerRef.current?.abort();
      exit();
    }
  }, { isActive: !helpOpen && !paletteOpen });

  useEffect(() => {
    const controller = new AbortController();
    controllerRef.current = controller;
    let cancelled = false;

    async function run(): Promise<void> {
      let db;
      try {
        db = getDb();
      } catch {
        if (!cancelled) onCancel();
        return;
      }
      const cache = new PricingCache(db);
      const client = new AwsPricingClient({ cache });

      let succeededLocal = 0;
      let failedLocal = 0;
      let entriesLocal = 0;
      let firstErrorMsg: string | undefined;

      for (let r = 0; r < regions.length; r++) {
        if (cancelled || controller.signal.aborted) return;
        setCurrentRegion(r);
        setServicesDoneInRegion(0);

        const region = regions[r] ?? '';
        for (let s = 0; s < BULK_SPECS.length; s++) {
          if (cancelled || controller.signal.aborted) return;
          const spec = BULK_SPECS[s];
          if (!spec) continue;
          try {
            const entries = await client.fetchAllPrices(
              spec.serviceCode, region, spec.productFamily, controller.signal,
            );
            for (const entry of entries) {
              if (cancelled || controller.signal.aborted) return;
              cache.setCachedPrice(spec.serviceCode, entry.key, region, entry.hourlyPrice);
              entriesLocal++;
            }
            succeededLocal++;
          } catch (err) {
            failedLocal++;
            firstErrorMsg ??= err instanceof Error ? err.message : String(err);
          }
          if (!cancelled) setServicesDoneInRegion(s + 1);
        }
      }

      if (!cancelled) {
        setSucceeded(succeededLocal);
        setFailed(failedLocal);
        setCurrentRegion(regions.length);
        onDone({
          succeeded: succeededLocal,
          failed: failedLocal,
          entries: entriesLocal,
          ...(firstErrorMsg !== undefined ? { errorMsg: firstErrorMsg } : {}),
        });
      }
    }

    void run();
    return () => { cancelled = true; controller.abort(); };
  }, [regions, onDone, onCancel]);

  const regionLabel = regions[Math.min(currentRegion, regions.length - 1)] ?? regions[0] ?? '';
  const totalSteps = regions.length * BULK_SPECS.length;
  const doneSteps = currentRegion * BULK_SPECS.length + servicesDoneInRegion;
  const pct = totalSteps > 0 ? Math.round((doneSteps / totalSteps) * 100) : 0;

  // Keep values referenced so no-unused-vars doesn't fire; they're surfaced via onDone.
  void succeeded; void failed;

  return (
    <Box flexDirection="column" gap={GAP_BETWEEN_SECTIONS} marginLeft={MARGIN_LEFT_CONTENT} marginTop={GAP_AFTER_HEADER}>
      <Box gap={GAP_ROW}>
        <Spinner />
        <Text>
          Fetching <Text color={colors.brand}>{regionLabel}</Text> pricing data…
          <Text dimColor>
            {DOT_SEP}(region {Math.min(currentRegion + 1, regions.length)} of {regions.length})
          </Text>
        </Text>
      </Box>
      <ProgressBar value={pct} />
    </Box>
  );
}

// ─── Status screen (§12.1 + §12.4) ───────────────────────────────────────────

interface PricingCommandProps {
  args: string[];
  onBack?: () => void;
  onAction?: (action: TuiAction) => void;
}

export function PricingCommand({ args, onBack, onAction }: PricingCommandProps): React.JSX.Element {
  const { exit } = useApp();
  const { helpOpen, paletteOpen } = useGlobalOverlay();

  // Cache load state
  const [cache, setCache] = useState<CacheState>({
    status: 'loading',
    count: 0,
    newest: null,
    expiredCount: 0,
    regionBreakdown: [],
    errorMessage: '',
  });
  const [reloadNonce, setReloadNonce] = useState(0);

  // Screen mode
  const [mode, setMode] = useState<Mode>({ kind: 'status' });

  // Picker overlay state — kept on parent so Escape re-opens to the same selection.
  const [pickerSelected, setPickerSelected] = useState<Set<string>>(new Set());
  const [pickerFocusedIdx, setPickerFocusedIdx] = useState(0);

  // Initial "subcommand" aliases — `pricing download --regions a,b` jumps straight in.
  useEffect(() => {
    if (args[0] === 'download') {
      const regionsArg = args.indexOf('--regions');
      if (regionsArg !== -1 && typeof args[regionsArg + 1] === 'string') {
        const regions = (args[regionsArg + 1] ?? '')
          .split(',')
          .map((s) => s.trim())
          .filter((s) => AWS_REGION_RE.test(s));
        if (regions.length > 0) {
          setMode(regions.length > LARGE_DOWNLOAD_REGION_THRESHOLD
            ? { kind: 'review', regions }
            : { kind: 'downloading', regions });
        }
      }
    }
  }, [args]);

  // Load cache stats (and reload after downloads / clears).
  useEffect(() => {
    let cancelled = false;
    function load(): void {
      try {
        const db = getDb();
        const pc = new PricingCache(db);
        const stats = pc.getCacheStats();
        const expiredCount = pc.getExpiredCount();
        const regionBreakdown = pc.getRegionBreakdown();
        if (!cancelled) {
          setCache({
            status: 'done',
            count: stats.count,
            newest: stats.newest_entry ?? null,
            expiredCount,
            regionBreakdown,
            errorMessage: '',
          });
        }
      } catch (err) {
        if (!cancelled) {
          setCache((c) => ({
            ...c,
            status: 'error',
            errorMessage: err instanceof Error ? err.message : String(err),
          }));
        }
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [reloadNonce]);

  // Parent-level input — only active when no overlay owns it.
  const parentActive =
    mode.kind === 'status' && cache.status !== 'error' && !helpOpen && !paletteOpen;
  useInput((input, key) => {
    if (input === 'q') { exit(); return; }
    if ((input === 'b' || key.escape) && onBack !== undefined) { onBack(); return; }
  }, { isActive: parentActive });

  // ── Error / loading guards ────────────────────────────────────────────────

  if (cache.status === 'error') {
    return (
      <ScreenShell header={<CommandHeader command="pricing" description="cache status" variant="compact" />}>
        <ErrorBox message={cache.errorMessage} onBack={onBack} onAction={onAction} />
      </ScreenShell>
    );
  }

  // ── Overlay: SafeWriteReview (downloads >2 regions, or clear confirm) ────

  if (mode.kind === 'review') {
    const regionCount = mode.regions.length;
    const estMinutes = Math.max(1, Math.ceil(regionCount * BULK_SPECS.length / 4));
    return (
      <ScreenShell
        header={<CommandHeader command="pricing" description="confirm download" variant="compact" mode="setup" />}
        overlayActive
      >
        <SafeWriteReview
          willChange={[{
            description: `Download pricing data for ${regionCount} region${regionCount !== 1 ? 's' : ''}`,
            detail: mode.regions.join(', '),
          }]}
          willNotChange={['Existing cached pricing entries in other regions', 'AWS resources or configuration']}
          dataUsed={[`${regionCount} region${regionCount !== 1 ? 's' : ''}`, 'AWS Pricing API']}
          safety={{
            dryRunAvailable: false,
            requiresAwsWrite: false,
            createsPrOnly: false,
            rollback: `No AWS resources are touched. Estimated ${estMinutes} min. Rerun to refresh or use u clear cache to wipe.`,
          }}
          onConfirm={() => setMode({ kind: 'downloading', regions: mode.regions })}
          onBack={() => setMode({ kind: 'status' })}
        />
      </ScreenShell>
    );
  }

  if (mode.kind === 'clear-confirm') {
    return (
      <ScreenShell
        header={<CommandHeader command="pricing" description="confirm clear cache" variant="compact" mode="setup" />}
        overlayActive
        hints={<InteractionHints hints={[IH_COMMAND, IH_HELP, IH_BACK, IH_QUIT]} />}
      >
        <SafeWriteReview
          willChange={[{
            description: `Delete all ${cache.count} cached pricing entries`,
            detail: cache.regionBreakdown.map((r) => r.region).join(', '),
          }]}
          willNotChange={['AWS resources or configuration', 'Scan history']}
          dataUsed={['Local SQLite pricing_cache table']}
          safety={{
            dryRunAvailable: false,
            requiresAwsWrite: false,
            createsPrOnly: false,
            rollback: 'Re-run d download to refetch pricing data.',
          }}
          onConfirm={() => {
            try {
              const db = getDb();
              new PricingCache(db).clearAll();
            } catch {
              // Fall through — status screen will re-read and show whatever's there.
            }
            setReloadNonce((n) => n + 1);
            setMode({ kind: 'status' });
          }}
          onBack={() => setMode({ kind: 'status' })}
        />
      </ScreenShell>
    );
  }

  // ── Overlay: Region picker (§12.3) ────────────────────────────────────────

  if (mode.kind === 'picker') {
    return (
      <ScreenShell
        header={<CommandHeader command="pricing" description="cache status" variant="compact" />}
        overlayActive
      >
        <RegionPicker
          selected={pickerSelected}
          focusedIdx={pickerFocusedIdx}
          onChange={setPickerSelected}
          onFocus={setPickerFocusedIdx}
          onConfirm={(regions) => {
            if (regions.length > LARGE_DOWNLOAD_REGION_THRESHOLD) {
              setMode({ kind: 'review', regions });
            } else {
              setMode({ kind: 'downloading', regions });
            }
          }}
          onCancel={() => setMode({ kind: 'status' })}
        />
      </ScreenShell>
    );
  }

  // ── Overlay: Downloading (§12.2) ──────────────────────────────────────────

  if (mode.kind === 'downloading') {
    return (
      <ScreenShell
        header={<CommandHeader command="pricing" description="downloading…" variant="compact" mode="setup" />}
        overlayActive
        hints={<InteractionHints hints={[IH_QUIT]} />}
      >
        <Downloader
          regions={mode.regions}
          onDone={({ succeeded, failed, entries, errorMsg }) => {
            setReloadNonce((n) => n + 1);
            setMode({
              kind: 'download-done',
              regions: mode.regions,
              succeeded,
              failed,
              entries,
              ...(errorMsg !== undefined ? { errorMsg } : {}),
            });
          }}
          onCancel={() => setMode({ kind: 'status' })}
        />
      </ScreenShell>
    );
  }

  if (mode.kind === 'download-done') {
    const { succeeded, failed, entries, errorMsg } = mode;
    const allFailed = succeeded === 0 && failed > 0;
    return (
      <ScreenShell
        header={<CommandHeader command="pricing" description="download complete" variant="compact" mode="setup" />}
        actions={
          <ActionBar
            screenId="pricing-download-done"
            actions={[
              { key: 'r', label: 'run again', action: { type: 'run-again' } },
              { key: 's', label: 'status', action: { type: 'navigate', command: 'pricing' } },
            ]}
            onAction={(action) => {
              if (action.type === 'run-again') {
                setMode({ kind: 'downloading', regions: mode.regions });
                return;
              }
              if (action.type === 'navigate' && action.command === 'pricing') {
                setReloadNonce((n) => n + 1);
                setMode({ kind: 'status' });
                return;
              }
              onAction?.(action);
            }}
          />
        }
        hints={<InteractionHints hints={[IH_COMMAND, IH_HELP, ...(onBack !== undefined ? [IH_BACK] : []), IH_QUIT]} />}
      >
        <Box flexDirection="column" marginLeft={MARGIN_LEFT_CONTENT} marginTop={GAP_AFTER_HEADER} gap={GAP_ROW}>
          {allFailed ? (
            <Text color={semanticColors.status.fail} bold>
              {icons.error}  Download failed
            </Text>
          ) : failed === 0 ? (
            <Text color={semanticColors.status.pass} bold>
              {icons.checkmark}  Download complete
            </Text>
          ) : (
            <Text color={semanticColors.status.warn} bold>
              {icons.warning}  Download complete with errors
            </Text>
          )}
          <Text dimColor>
            {entries.toLocaleString()} entries stored{DOT_SEP}{succeeded} specs succeeded{DOT_SEP}{failed} failed
          </Text>
          {entries === 0 && !allFailed && (
            <Text color={semanticColors.status.warn}>
              No pricing data was stored. Check AWS credentials and pricing:GetProducts permission.
            </Text>
          )}
          {allFailed && errorMsg !== undefined && (
            <Text color={semanticColors.status.fail} wrap="wrap">
              {errorMsg}
            </Text>
          )}
        </Box>
      </ScreenShell>
    );
  }

  // ── Default: Status screen (§12.1 + §12.4) ───────────────────────────────

  const health = computeCacheHealth(cache.count, cache.expiredCount, cache.newest);
  const healthColor = cacheHealthColor(health);

  const actions: ActionHint[] = [
    {
      key: 'd', label: 'download',
      action: { type: 'navigate', command: 'pricing', args: ['__picker'] },
    },
    {
      key: 'r', label: 'refresh',
      action: { type: 'navigate', command: 'pricing', args: ['__refresh'] },
      disabled: cache.regionBreakdown.length === 0,
      reason: 'no cached regions',
    },
    {
      key: 'u', label: 'clear cache',
      action: { type: 'navigate', command: 'pricing', args: ['__clear'] },
      disabled: cache.count === 0,
      reason: 'cache empty',
    },
  ];

  interface RegionRow { region: string; entries: string; lastUpdated: string; stale: boolean }
  const regionRows: RegionRow[] = cache.regionBreakdown.map((r) => ({
    region: r.region,
    entries: r.count.toLocaleString(),
    lastUpdated: formatRelativeTime(r.newest),
    stale: isRegionStale(r.newest),
  }));
  const regionColumns: ColumnDef<RegionRow>[] = [
    { key: 'region', label: 'REGION', maxWidth: 22, priority: 1 },
    {
      key: 'entries',
      label: 'ENTRIES',
      maxWidth: 12,
      priority: 1,
      renderCell: (value, row) => {
        const color = row.stale ? semanticColors.status.warn : semanticColors.status.pass;
        return <Text color={color}>{String(value)}</Text>;
      },
    },
    {
      key: 'lastUpdated', label: 'LAST UPDATED', priority: 2, maxWidth: 28,
      renderCell: (value, row, width) => {
        const text = row.stale ? `${String(value)} (stale)` : String(value);
        if (row.stale) {
          return <Text color={semanticColors.status.warn}>{truncateWidth(text, width)}</Text>;
        }
        return <Text>{truncateWidth(text, width)}</Text>;
      },
    },
  ];

  const regionsCsv = cache.regionBreakdown.map((r) => r.region).join(', ') || '—';

  return (
    <ScreenShell
      header={<CommandHeader command="pricing" description="cache status" variant="compact" />}
      actions={
        <ActionBar
          screenId="pricing-status"
          actions={actions}
          onAction={(action) => {
            if (action.type === 'navigate' && action.command === 'pricing') {
              const tag = action.args?.[0];
              if (tag === '__picker') {
                // Seed picker with currently-cached regions if any.
                setPickerSelected(new Set(cache.regionBreakdown.map((r) => r.region)));
                setPickerFocusedIdx(0);
                setMode({ kind: 'picker' });
                return;
              }
              if (tag === '__refresh') {
                // Reload status display from local cache only — no network call.
                setReloadNonce((n) => n + 1);
                return;
              }
              if (tag === '__clear') {
                setMode({ kind: 'clear-confirm' });
                return;
              }
            }
            onAction?.(action);
          }}
        />
      }
      hints={<InteractionHints hints={[IH_COMMAND, IH_HELP, ...(onBack !== undefined ? [IH_BACK] : []), IH_QUIT]} />}
    >
      <Box flexDirection="column" marginLeft={MARGIN_LEFT_CONTENT} marginTop={GAP_AFTER_HEADER}>

        {/* Stale/empty banner */}
        {(health === 'stale' || health === 'empty') && (
          <Box marginBottom={GAP_BETWEEN_SECTIONS} gap={GAP_ROW}>
            <Text color={semanticColors.status.warn}>{icons.warning}</Text>
            <Text color={semanticColors.status.warn}>
              {health === 'empty'
                ? 'No pricing data cached. Run d to download.'
                : 'Pricing data is stale. Run d to refresh.'}
            </Text>
          </Box>
        )}

        {/* Status block — spec §12.1 */}
        <Box flexDirection="column">
          <Box gap={GAP_ROW}>
            <Text dimColor>Status:</Text>
            <Text bold color={healthColor}>{health}</Text>
          </Box>
          <Box gap={GAP_ROW}>
            <Text dimColor>Updated:</Text>
            <Text dimColor>{formatDate(cache.newest)}</Text>
            <Text dimColor>{DOT_SEP}{cache.count.toLocaleString()} price entries</Text>
          </Box>
          <Box gap={GAP_ROW}>
            <Text dimColor>Regions:</Text>
            <Text color={colors.info}>{regionsCsv}</Text>
          </Box>
        </Box>

        {/* Footer note */}
        <Box marginTop={GAP_BETWEEN_SECTIONS}>
          <Text color={colors.info} dimColor>Pricing data is used by the scan and costs commands.</Text>
        </Box>

        {/* Region breakdown (§12.4) — only when usable */}
        {health === 'usable' && cache.regionBreakdown.length > 0 && (
          <Box flexDirection="column" marginTop={GAP_BETWEEN_SECTIONS}>
            <SectionTitle divider>by region</SectionTitle>
            <Box marginTop={GAP_BETWEEN_SECTIONS}>
              <DataTable
                columns={regionColumns}
                rows={regionRows}
              />
            </Box>
          </Box>
        )}
      </Box>
    </ScreenShell>
  );
}
