/**
 * Centralized layout spacing constants.
 * Use these everywhere instead of magic numbers in JSX.
 *
 * VRHYTHM_RULE: vertical rhythm is enforced via three constants only.
 *   GAP_AFTER_HEADER  — gap between CommandHeader and first content section
 *   GAP_BETWEEN_SECTIONS — default vertical gap between content sections
 *   GAP_BEFORE_ACTIONS — gap before sticky action bar / NavHints
 * No other marginTop/marginBottom values should appear in component JSX.
 */

export const PADDING_X = 1;
export const GAP_ROW = 1;

/** Horizontal gap between an icon and its following text label (accounts for double-width Unicode). */
export const GAP_ICON_TEXT = 2;
export const MARGIN_LEFT_CONTENT = 1;

/** Gap after CommandHeader before first content section. */
export const GAP_AFTER_HEADER = 1;

/** Default vertical gap between content sections. */
export const GAP_BETWEEN_SECTIONS = 1;

/** Gap before sticky action bar or NavHints. */
export const GAP_BEFORE_ACTIONS = 1;

/** Wider gap (2 rows) for section separators that need more visual breathing room. */
export const GAP_SECTION_WIDE = 2;

/** Indentation for agent result panel and tool result detail rows. */
export const MARGIN_LEFT_RESULT = 2;

/** Indentation for tool timeline result text (one level deeper than MARGIN_LEFT_CONTENT). */
export const MARGIN_LEFT_TOOL_DETAIL = 3;
