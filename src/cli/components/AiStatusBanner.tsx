/**
 * AiStatusBanner — persistent info banner shown when AI is unavailable.
 *
 * When ANTHROPIC_API_KEY is missing or the provider failed to initialize,
 * render a single info row above command results so the user understands why
 * deterministic rules are being used instead of AI.
 *
 * Usage: place above the result area in every AI-using command.
 * Only renders when `provider === null` AND `aiConfigured === true`.
 */

import React from 'react';
import { Box, Text } from 'ink';

import { colors, icons } from '../theme.js';
import { MARGIN_LEFT_CONTENT, GAP_BETWEEN_SECTIONS } from '../ui/spacing.js';

interface AiStatusBannerProps {
  /**
   * The resolved AI provider. When null the banner may show.
   */
  provider: unknown | null;
  /**
   * Whether AI was configured (i.e. ai.provider !== 'none' in config).
   * When false the banner is suppressed — the user explicitly opted out.
   */
  aiConfigured: boolean;
}

/**
 * Renders a single-line info banner when AI is configured but unavailable.
 * Returns null (nothing rendered) when AI is available or not configured.
 */
export function AiStatusBanner({ provider, aiConfigured }: AiStatusBannerProps): React.JSX.Element | null {
  if (provider !== null || !aiConfigured) return null;

  return (
    <Box
      marginLeft={MARGIN_LEFT_CONTENT}
      marginBottom={GAP_BETWEEN_SECTIONS}
    >
      <Text color={colors.info}>
        {icons.info}{' '}AI unavailable — using deterministic rules. Set ANTHROPIC_API_KEY in .korinfra/.env to enable AI.
      </Text>
    </Box>
  );
}
