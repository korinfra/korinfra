/**
 * StatusLine — single-row contextual metadata strip.
 *
 * Renders source, AWS profile/region, pricing freshness, and any extra
 * metadata as a dot-separated line. On narrow terminals the Box flexWrap
 * lets segments flow onto a second row rather than truncating.
 *
 * Design rules:
 * - DOT_SEP_RULE: separator via {DOT_SEP} only, never inline the dot separator literal
 * - VRHYTHM_RULE: no marginTop/marginBottom magic numbers
 * - AI state removed — lives on ActionBar `r` key label only
 * - Labels muted, values normal weight
 */

import React from 'react';
import { Box, Text } from 'ink';

import { colors, semanticColors } from '../theme.js';
import { DOT_SEP } from '../ui/text.js';

// ─── Types ───────────────────────────────────────────────────────────────────

interface StatusLineProps {
  /** Primary data source, e.g. "scan 8bbd1846" | "Cost Explorer" | "local config" */
  source: string;
  /** AWS profile name */
  profile?: string | undefined;
  /** AWS region */
  region?: string | undefined;
  /** Scan ID (displayed separately from source when needed) */
  scanId?: string;
  /** Pricing cache freshness, e.g. "fresh 2m" | "stale 3d" */
  pricingFreshness?: string;
  /** Any additional metadata segments rendered at the end */
  extraMeta?: string[];
}

// ─── Subcomponent: a single DOT_SEP + colored value pair ────────────────────

interface SegmentProps {
  /** Muted label shown before the value (without trailing colon — caller adds it). */
  label?: string;
  /** Value content. */
  children: React.ReactNode;
  /** Optional color for the value text. */
  color?: string;
  /** Whether this is the very first segment (suppresses leading DOT_SEP). */
  first?: boolean;
}

function Segment({ label, children, color, first = false }: SegmentProps): React.JSX.Element {
  return (
    <Box gap={0}>
      {!first && <Text dimColor>{DOT_SEP}</Text>}
      {label !== undefined && <Text color={colors.muted}>{label} </Text>}
      <Text color={color}>{children}</Text>
    </Box>
  );
}

// ─── Component ───────────────────────────────────────────────────────────────

export function StatusLine({
  source,
  profile,
  region,
  scanId,
  pricingFreshness,
  extraMeta,
}: StatusLineProps): React.JSX.Element {
  // Collect visible segments in order, tracking whether first has been emitted.
  const segments: React.JSX.Element[] = [];
  let isFirst = true;

  function push(el: React.JSX.Element): void {
    segments.push(el);
    isFirst = false;
  }

  // source: scan 8bbd1846
  push(
    <Segment key="source" label="source:" first={isFirst} {...(colors.brand !== undefined ? { color: colors.brand } : {})}>
      {source}
    </Segment>,
  );

  // scanId — only when different from what's already in source
  if (scanId !== undefined && !source.includes(scanId)) {
    push(
      <Segment key="scanId" first={false} {...(colors.brand !== undefined ? { color: colors.brand } : {})}>
        {scanId}
      </Segment>,
    );
  }

  // profile
  if (profile !== undefined) {
    push(
      <Segment key="profile" label="profile" first={false} {...(colors.info !== undefined ? { color: colors.info } : {})}>
        {profile}
      </Segment>,
    );
  }

  // region
  if (region !== undefined) {
    push(
      <Segment key="region" label="region" first={false} {...(colors.info !== undefined ? { color: colors.info } : {})}>
        {region}
      </Segment>,
    );
  }

  // Pricing freshness
  if (pricingFreshness !== undefined) {
    const freshColor = pricingFreshness.startsWith('stale') ? semanticColors.badge.stale : semanticColors.status.pass;
    push(
      <Segment key="pricing" label="pricing" first={false} {...(freshColor !== undefined ? { color: freshColor } : {})}>
        {pricingFreshness}
      </Segment>,
    );
  }

  // Extra metadata
  if (extraMeta !== undefined) {
    for (const [i, meta] of extraMeta.entries()) {
      push(
        <Segment key={`extra-${i}`} first={false}>
          {meta}
        </Segment>,
      );
    }
  }

  return (
    <Box flexWrap="wrap" gap={0}>
      {segments}
    </Box>
  );
}
