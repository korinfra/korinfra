/**
 * ChangesCommand — audit recent AWS API activity from CloudTrail.
 *
 * Uses DirectPipeline (no AI). One pipeline step fetches CloudTrail events.
 * The `j` key cycles the time window: 24h → 48h → 7d (168h).
 * The `r` key re-fetches with the current window.
 *
 * Key contract (G-5, X-1):
 *   NavHints = navigation only: :, ?, b, q
 *   ActionBar = domain actions: r (refresh), j (cycle window)
 */

import React, { useMemo, useState } from 'react';
import { Box, Text } from 'ink';

import { DirectPipeline } from '../components/DirectPipeline.js';
import type { PipelineContext, PipelineStep, CommandResultView } from '../components/DirectPipeline.js';
import { CommandHeader } from '../components/CommandHeader.js';
import { ScreenShell } from '../components/ScreenShell.js';
import { DataTable } from '../components/DataTable.js';
import type { ColumnDef } from '../components/DataTable.js';
import { InteractionHints, IH_COMMAND, IH_HELP, IH_BACK, IH_QUIT } from '../components/InteractionHints.js';
import { EmptyState } from '../components/EmptyState.js';
import { colors } from '../theme.js';
import { MARGIN_LEFT_RESULT } from '../ui/spacing.js';
import { joinDot } from '../ui/text.js';
import { truncateWidth, padEndWidth } from '../ui/width.js';
import type { TuiAction } from '../actions.js';
import { getChangesTool } from '../../tools/get-changes.js';
import { useGlobalOverlay } from '../hooks/useGlobalOverlay.js';
import { useConfig } from '../hooks/useConfig.js';

// ─── Types ───────────────────────────────────────────────────────────────────

interface CloudTrailEvent {
  eventId: string;
  eventTime: string;
  eventName: string;
  eventSource: string;
  username: string;
  resourceType: string;
  resourceName: string;
  awsRegion: string;
  errorCode?: string;
}

interface ChangesResult {
  events: CloudTrailEvent[];
  count: number;
  region: string;
  hours: number;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const HOUR_CYCLE = [24, 48, 168] as const;
type HourWindow = typeof HOUR_CYCLE[number];

function hoursLabel(h: HourWindow): string {
  if (h === 168) return '7d';
  return `${h}h`;
}

// ─── Formatters ──────────────────────────────────────────────────────────────

function formatEventTime(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso.slice(0, 19);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
  } catch {
    return iso.slice(0, 8);
  }
}

// ─── Table columns ────────────────────────────────────────────────────────────

const CHANGES_COLS: ColumnDef<CloudTrailEvent>[] = [
  {
    key: 'eventTime',
    label: 'Time',
    width: 10,
    priority: 1,
    renderCell: (value) => {
      const iso = value instanceof Date ? value.toISOString() : typeof value === 'string' ? value : '';
      return <Text dimColor>{formatEventTime(iso)}</Text>;
    },
  },
  {
    key: 'username',
    label: 'User',
    width: 22,
    priority: 2,
    renderCell: (value, _row, w) => <Text color={colors.info}>{padEndWidth(truncateWidth(typeof value === 'string' ? value : '—', w - 1), w)}</Text>,
  },
  {
    key: 'eventName',
    label: 'Action',
    width: 32,
    priority: 1,
    renderCell: (value, _row, w) => <Text>{padEndWidth(truncateWidth(typeof value === 'string' ? value : '', w - 1), w)}</Text>,
  },
  {
    key: 'resourceName',
    label: 'Resource',
    width: 32,
    priority: 3,
    renderCell: (value, _row, w) => <Text dimColor>{padEndWidth(truncateWidth(typeof value === 'string' ? value : '—', w - 1), w)}</Text>,
  },
  {
    key: 'awsRegion',
    label: 'Region',
    width: 14,
    priority: 4,
    renderCell: (value, _row, w) => <Text dimColor>{padEndWidth(typeof value === 'string' ? value : '', w)}</Text>,
  },
];

// ─── Component ────────────────────────────────────────────────────────────────

export interface ChangesCommandProps {
  args: string[];
  onBack?: (() => void) | undefined;
  onAction?: ((action: TuiAction) => void) | undefined;
}

export function ChangesCommand({ args: _args, onBack, onAction }: ChangesCommandProps): React.JSX.Element {
  const { helpOpen, paletteOpen } = useGlobalOverlay();
  const { config } = useConfig();

  const [hours, setHours] = useState<HourWindow>(24);
  const [runKey, setRunKey] = useState(0);
  const [pipelineHasError, setPipelineHasError] = useState(false);

  const region = config?.aws?.default_region ?? 'us-east-1';
  const profile = config?.aws?.default_profile ?? undefined;

  const pipelineSteps = useMemo((): PipelineStep[] => [
    {
      name: 'Fetching CloudTrail events',
      completedName: 'Fetched CloudTrail events',
      key: 'changes',
      getDetail: (result) => {
        const r = result as ChangesResult | null;
        return r ? `${r.count} event${r.count !== 1 ? 's' : ''}` : '';
      },
      run: async (_ctx: PipelineContext): Promise<ChangesResult> => {
        const toolResult = await getChangesTool.handler({
          region,
          hours,
          ...(profile !== undefined ? { profile } : {}),
        });

        if (toolResult.isError === true) {
          const msg = toolResult.content[0]?.text ?? 'Unknown error from CloudTrail';
          throw new Error(msg);
        }

        const text = toolResult.content[0]?.text ?? '{}';
        const parsed = JSON.parse(text) as ChangesResult;
        return parsed;
      },
    },
  ], [region, profile, hours]);

  const renderResult = (ctx: PipelineContext): CommandResultView => {
    const data = ctx.results.get('changes') as ChangesResult | undefined;
    const events = data?.events ?? [];

    if (events.length === 0) {
      return {
        items: [
          <Box key="empty" marginLeft={MARGIN_LEFT_RESULT}>
            <EmptyState
              message={`No CloudTrail events in the last ${hoursLabel(hours)}`}
              hint="Try a longer window with j (48h, 7d), or check CloudTrail is enabled in this region."
            />
          </Box>,
        ],
        actions: [
          { key: 'r', label: 'refresh', action: { type: 'run-again' as const } },
          { key: 'j', label: `window: ${hoursLabel(hours)}`, action: { type: 'sort-toggle' as const } },
        ],
      };
    }

    return {
      items: [
        <DataTable<CloudTrailEvent>
          key="changes-table"
          columns={CHANGES_COLS}
          rows={events}
          selectedIndex={0}
          getRowKey={(row) => row.eventId}
          {...(ctx.viewportHeight ? { pageSize: ctx.viewportHeight } : {})}
        />,
      ],
      actions: [
        { key: 'r', label: 'refresh', action: { type: 'run-again' as const } },
        { key: 'j', label: `window: ${hoursLabel(hours)}`, action: { type: 'sort-toggle' as const } },
      ],
    };
  };

  const subtitle = joinDot(`last ${hoursLabel(hours)}`, region);

  return (
    <ScreenShell
      header={
        <CommandHeader
          command="changes"
          description="AWS API activity"
          scope={subtitle}
          variant="compact"
        />
      }
      hints={pipelineHasError ? undefined : <InteractionHints hints={[IH_COMMAND, IH_HELP, ...(onBack !== undefined ? [IH_BACK] : []), IH_QUIT]} />}
    >
      <DirectPipeline
        key={runKey}
        steps={pipelineSteps}
        renderResult={renderResult}
        onRunAgain={() => setRunKey((k) => k + 1)}
        onBack={onBack}
        onAction={(action) => {
          if (action.type === 'run-again') { setRunKey((k) => k + 1); return; }
          if (action.type === 'sort-toggle') {
            setHours((prev) => {
              const idx = HOUR_CYCLE.indexOf(prev);
              return HOUR_CYCLE[(idx + 1) % HOUR_CYCLE.length] ?? 24;
            });
            setRunKey((k) => k + 1);
            return;
          }
          onAction?.(action);
        }}
        onError={setPipelineHasError}
        overlayActive={helpOpen || paletteOpen}
      />
    </ScreenShell>
  );
}
