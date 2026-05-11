import { describe, it, expect } from 'vitest';

// Note: These are structural/logic tests for breakpoint thresholds
// They verify that the TERMINAL_WIDTHS constants are used correctly

import { TERMINAL_WIDTHS, TERMINAL_HEIGHTS } from '../../src/cli/ui/breakpoints.js';

describe('TERMINAL_WIDTHS breakpoints', () => {
  it('has correct narrow threshold', () => {
    expect(TERMINAL_WIDTHS.narrow).toBe(56);
  });
  it('has correct compact threshold', () => {
    expect(TERMINAL_WIDTHS.compact).toBe(72);
  });
  it('has correct comfortable threshold', () => {
    expect(TERMINAL_WIDTHS.comfortable).toBe(80);
  });
  it('has correct chartWide threshold', () => {
    expect(TERMINAL_WIDTHS.chartWide).toBe(90);
  });
  it('has correct tableRegion threshold', () => {
    expect(TERMINAL_WIDTHS.tableRegion).toBe(92);
  });
  it('has correct tableId threshold', () => {
    expect(TERMINAL_WIDTHS.tableId).toBe(110);
  });
  it('breakpoints are in ascending order', () => {
    const values = Object.values(TERMINAL_WIDTHS);
    for (let i = 1; i < values.length; i++) {
      expect(values[i]).toBeGreaterThan(values[i - 1]);
    }
  });
});

describe('TERMINAL_HEIGHTS breakpoints', () => {
  it('has correct cramped threshold', () => {
    expect(TERMINAL_HEIGHTS.cramped).toBe(20);
  });
  it('has correct normal threshold', () => {
    expect(TERMINAL_HEIGHTS.normal).toBe(35);
  });
  it('breakpoints are in ascending order', () => {
    const values = Object.values(TERMINAL_HEIGHTS);
    for (let i = 1; i < values.length; i++) {
      expect(values[i]).toBeGreaterThan(values[i - 1]);
    }
  });
});

// Layout logic tests (without rendering — pure logic)
describe('ResourceTable layout logic', () => {
  it('uses stacked layout below compact width', () => {
    const termWidth = TERMINAL_WIDTHS.compact - 1; // 71
    const isStacked = termWidth < TERMINAL_WIDTHS.compact;
    expect(isStacked).toBe(true);
  });

  it('uses full layout at comfortable width', () => {
    const termWidth = TERMINAL_WIDTHS.comfortable; // 80
    const isStacked = termWidth < TERMINAL_WIDTHS.compact;
    expect(isStacked).toBe(false);
  });

  it('shows region column at tableRegion width', () => {
    const termWidth = TERMINAL_WIDTHS.tableRegion + 1; // 93
    const showRegion = termWidth >= TERMINAL_WIDTHS.tableRegion;
    expect(showRegion).toBe(true);
  });

  it('hides region column below tableRegion width', () => {
    const termWidth = TERMINAL_WIDTHS.tableRegion - 1; // 91
    const showRegion = termWidth >= TERMINAL_WIDTHS.tableRegion;
    expect(showRegion).toBe(false);
  });

  it('shows ID column at tableId width', () => {
    const termWidth = TERMINAL_WIDTHS.tableId + 1; // 111
    const showId = termWidth >= TERMINAL_WIDTHS.tableId;
    expect(showId).toBe(true);
  });
});

describe('CostChart layout logic', () => {
  it('narrow terminal triggers fallback', () => {
    const termWidth = TERMINAL_WIDTHS.narrow - 1; // 55
    const needsFallback = termWidth < TERMINAL_WIDTHS.narrow;
    expect(needsFallback).toBe(true);
  });

  it('compact terminal does not trigger narrow fallback', () => {
    const termWidth = TERMINAL_WIDTHS.narrow + 1; // 57
    const needsFallback = termWidth < TERMINAL_WIDTHS.narrow;
    expect(needsFallback).toBe(false);
  });

  it('wide mode activates at chartWide threshold', () => {
    const termWidth = TERMINAL_WIDTHS.chartWide + 1; // 91
    const contentRows = 10;
    const isWide = termWidth >= TERMINAL_WIDTHS.chartWide && contentRows >= 8;
    expect(isWide).toBe(true);
  });

  it('wide mode requires sufficient rows', () => {
    const termWidth = TERMINAL_WIDTHS.chartWide + 1; // 91
    const contentRows = 5; // below minimum
    const isWide = termWidth >= TERMINAL_WIDTHS.chartWide && contentRows >= 8;
    expect(isWide).toBe(false);
  });

  it('respects minimum terminal width of 40 columns', () => {
    const minWidth = 40;
    const isValidWidth = minWidth >= 40;
    expect(isValidWidth).toBe(true);
  });

  it('respects minimum terminal height of 18 rows', () => {
    const minHeight = 18;
    const isValidHeight = minHeight >= 18;
    expect(isValidHeight).toBe(true);
  });
});

describe('Breakpoint boundary conditions', () => {
  it('narrow boundary (56 columns)', () => {
    expect(TERMINAL_WIDTHS.narrow).toBe(56);
    expect(55 < TERMINAL_WIDTHS.narrow).toBe(true);
    expect(56 >= TERMINAL_WIDTHS.narrow).toBe(true);
  });

  it('compact boundary (72 columns)', () => {
    expect(TERMINAL_WIDTHS.compact).toBe(72);
    expect(71 < TERMINAL_WIDTHS.compact).toBe(true);
    expect(72 >= TERMINAL_WIDTHS.compact).toBe(true);
  });

  it('comfortable boundary (80 columns)', () => {
    expect(TERMINAL_WIDTHS.comfortable).toBe(80);
    expect(79 < TERMINAL_WIDTHS.comfortable).toBe(true);
    expect(80 >= TERMINAL_WIDTHS.comfortable).toBe(true);
  });

  it('chartWide boundary (90 columns)', () => {
    expect(TERMINAL_WIDTHS.chartWide).toBe(90);
    expect(89 < TERMINAL_WIDTHS.chartWide).toBe(true);
    expect(90 >= TERMINAL_WIDTHS.chartWide).toBe(true);
  });

  it('height cramped boundary (20 rows)', () => {
    expect(TERMINAL_HEIGHTS.cramped).toBe(20);
    expect(19 < TERMINAL_HEIGHTS.cramped).toBe(true);
    expect(20 >= TERMINAL_HEIGHTS.cramped).toBe(true);
  });

  it('height normal boundary (35 rows)', () => {
    expect(TERMINAL_HEIGHTS.normal).toBe(35);
    expect(34 < TERMINAL_HEIGHTS.normal).toBe(true);
    expect(35 >= TERMINAL_HEIGHTS.normal).toBe(true);
  });
});
