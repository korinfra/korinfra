/**
 * ResultViewport — smart scrollable viewport for result blocks.
 *
 * Problem: pipelines call `items.slice(offset, offset + viewportHeight)` — one React element
 * can render one row or twenty rows, causing CostChart, ResourceTable, ScanSummary, or
 * recommendation lists to overflow short terminals and push the footer out of view.
 *
 * Solution: receive an array of ResultBlock items (each declares its estimated row count),
 * slice by estimated rendered rows (not element count), and keep footer outside the scrollable area.
 */

import React, { useState } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';

import { GAP_BETWEEN_SECTIONS } from '../ui/spacing.js';
import { useMouseScroll } from '../hooks/useMouseScroll.js';

export interface ResultBlock {
  key: string;
  /** Estimated terminal rows this block will render. */
  rows: number;
  element: React.JSX.Element;
  /** Compact fallback for when the block is taller than viewport. */
  compact?: React.JSX.Element;
}

interface ResultViewportProps {
  blocks: ResultBlock[];
  viewportRows: number;
  isActive?: boolean;
}

/**
 * Smart scrollable viewport for result blocks.
 * Tracks scroll offset by block index and sums estimated rows.
 */
export function ResultViewport({
  blocks,
  viewportRows,
  isActive = false,
}: ResultViewportProps): React.JSX.Element {
  // useStdout is called but not dereferenced to avoid unused variable warning during hook initialization
  useStdout();

  const [scrollOffset, setScrollOffset] = useState(0);

  // Rows consumed by the above/below scroll indicator (1 content + 1 marginBottom).
  const INDICATOR_ROWS = 2;

  // Helper to count how many blocks fit in one viewport page
  function countBlocksForViewport(startOffset: number): number {
    const limit = startOffset > 0
      ? Math.max(4, viewportRows - INDICATOR_ROWS)
      : viewportRows;
    let rows = 0;
    let count = 0;
    for (let i = startOffset; i < blocks.length; i++) {
      rows += blocks[i]?.rows ?? 0;
      count++;
      if (rows >= limit) break;
    }
    return Math.max(1, count);
  }

  // Subtract rows consumed by the above indicator when scrolled so visible blocks
  // don't overflow the allocated viewport area and push the group header off screen.
  const rowsForBlocks = scrollOffset > 0
    ? Math.max(4, viewportRows - INDICATOR_ROWS)
    : viewportRows;

  let accumulatedRows = 0;
  const visibleBlocks: ResultBlock[] = [];
  const blocksAboveCount = scrollOffset;

  // Collect visible blocks until we exceed viewport height
  for (let i = scrollOffset; i < blocks.length; i++) {
    const block = blocks[i];
    if (!block) continue;
    const blockRows = block.rows;
    if (accumulatedRows + blockRows <= rowsForBlocks) {
      visibleBlocks.push(block);
      accumulatedRows += blockRows;
    } else if (visibleBlocks.length === 0) {
      // Always show at least one block, even if it exceeds viewport
      visibleBlocks.push(block);
      accumulatedRows += blockRows;
    } else {
      break;
    }
  }

  // Count blocks below the visible area
  const blocksBelowCount = blocks.length - scrollOffset - visibleBlocks.length;

  // Handle scroll input when active
  useInput(
    (_input, key) => {
      if (!isActive) return;

      let newOffset = scrollOffset;
      if (key.upArrow && scrollOffset > 0) {
        newOffset = scrollOffset - 1;
      } else if (key.downArrow && blocksBelowCount > 0) {
        newOffset = scrollOffset + 1;
      } else if (key.pageUp && scrollOffset > 0) {
        const pageCount = countBlocksForViewport(Math.max(0, scrollOffset - 1));
        newOffset = Math.max(0, scrollOffset - pageCount);
      } else if (key.pageDown && blocksBelowCount > 0) {
        const pageCount = countBlocksForViewport(scrollOffset);
        newOffset = Math.min(blocks.length - 1, scrollOffset + pageCount);
      } else if (key.home) {
        newOffset = 0;
      } else if (key.end && blocksBelowCount > 0) {
        newOffset = blocks.length - 1;
      }

      if (newOffset !== scrollOffset) {
        setScrollOffset(newOffset);
      }
    },
    { isActive },
  );

  useMouseScroll(
    () => { if (scrollOffset > 0) setScrollOffset((o) => o - 1); },
    () => { if (blocksBelowCount > 0) setScrollOffset((o) => Math.min(blocks.length - 1, o + 1)); },
    { isActive, hasOverflow: scrollOffset > 0 || blocksBelowCount > 0 },
  );

  return (
    <Box flexDirection="column">
      {/* Scroll indicator above — hidden when at top (scrollOffset === 0) */}
      {blocksAboveCount > 0 && (
        <Box marginBottom={GAP_BETWEEN_SECTIONS} marginLeft={2}>
          <Text dimColor>↑ {blocksAboveCount} {blocksAboveCount === 1 ? 'section' : 'sections'} above</Text>
        </Box>
      )}

      {/* Visible blocks */}
      {visibleBlocks.map((block) => (
        <Box key={block.key} flexDirection="column" height={Math.min(block.rows, viewportRows)} overflow={block.rows > viewportRows ? 'hidden' : undefined}>
          {block.rows > viewportRows ? (block.compact ?? block.element) : block.element}
          {block.rows > viewportRows && (
            <Box marginTop={GAP_BETWEEN_SECTIONS}>
              <Text dimColor>Chart collapsed to fit viewport</Text>
            </Box>
          )}
        </Box>
      ))}

      {/* Scroll indicator below — hidden when all content is visible */}
      {blocksBelowCount > 0 && (
        <Box marginTop={GAP_BETWEEN_SECTIONS} marginLeft={2}>
          <Text dimColor>↓ {blocksBelowCount} {blocksBelowCount === 1 ? 'section' : 'sections'} below</Text>
        </Box>
      )}
    </Box>
  );
}
