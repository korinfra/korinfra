/**
 * Format a cost value for display.
 * - Zero / non-finite: "$0"
 * - Sub-$1: "$0.45"
 * - Under $1000: "$123"
 * - $1000+: "$1.2k", "$12.3k", "$123k", "$1.2M"
 */
export function formatCost(usd: number, currency = 'USD'): string {
  const symbol = currency === 'USD' ? '$' : `${currency} `;
  if (!Number.isFinite(usd) || usd === 0) return `${symbol}0`;
  const abs = Math.abs(usd);
  const sign = usd < 0 ? '-' : '';
  if (abs < 1) return sign + symbol + abs.toFixed(2);
  if (abs < 1_000) return sign + symbol + Math.round(abs).toString();
  if (abs < 1_000_000) return sign + symbol + (abs / 1_000).toFixed(1) + 'k';
  return sign + symbol + (abs / 1_000_000).toFixed(1) + 'M';
}

// ─── Shared text processing ───────────────────────────────────────────────

/** Strip structured data markers (SCAN_SUMMARY, COST_CHART, etc.) from AI result text using balanced-brace/bracket matching. */
export function stripStructuredData(text: string): string {
  const prefixes = ['SCAN_SUMMARY:', 'COST_CHART:', 'RECOMMENDATIONS:', 'RESOURCE_LIST:'];
  let result = text;
  for (const prefix of prefixes) {
    const idx = result.indexOf(prefix);
    if (idx === -1) continue;
    const jsonStart = idx + prefix.length;
    const openChar = result[jsonStart];
    if (openChar !== '{' && openChar !== '[') continue;
    const closeChar = openChar === '{' ? '}' : ']';
    let depth = 0;
    let end = -1;
    for (let i = jsonStart; i < result.length; i++) {
      if (result[i] === openChar) depth++;
      else if (result[i] === closeChar) {
        depth--;
        if (depth === 0) { end = i + 1; break; }
      }
    }
    if (end !== -1) {
      const trailingEnd = result[end] === '\n' ? end + 1 : end;
      result = result.slice(0, idx) + result.slice(trailingEnd);
    }
  }
  return result.trim();
}

// ─── Agent output sanitizer ───────────────────────────────────────────────────

/**
 * Sentinel used internally to protect fenced code blocks during sanitization.
 * Chosen to be something that never appears in real agent output.
 */
const FENCE_PLACEHOLDER_PREFIX = '\x00FENCE\x00';

/**
 * Sanitize raw agent text before it reaches the TUI renderer.
 *
 * Strips known internal markup that must never appear in user-facing output:
 *   - <tool_call>...</tool_call> blocks (and <tool_result>...</tool_result>)
 *   - <thinking>...</thinking> and <parameter name="scratchpad">...</scratchpad> blocks
 *   - Residual standalone opening/closing tags for those same patterns
 *
 * Content inside triple-backtick fenced code blocks is preserved — the sanitizer
 * replaces fences with sentinels before stripping, then restores them after,
 * so legitimate code examples containing XML are never stripped.
 *
 * Does NOT strip arbitrary XML-like tags, column-0 JSON, or markdown formatting —
 * those are user-visible content and must not be removed.
 */
export function sanitizeAgentText(text: string): string {
  // Step 1: extract fenced code blocks and replace with sentinels so we never
  // strip content the user asked the agent to generate as code examples.
  const fences: string[] = [];
  const withoutFences = text.replace(/```[\s\S]*?```/g, (match) => {
    const idx = fences.push(match) - 1;
    return `${FENCE_PLACEHOLDER_PREFIX}${idx}\x00`;
  });

  // Step 2: strip known internal block tags (multiline, case-insensitive).
  const BLOCK_TAGS = ['tool_call', 'tool_result', 'thinking', 'scratchpad'];
  let result = withoutFences;
  for (const tag of BLOCK_TAGS) {
    // Full block: <tag ...>...</tag>
    result = result.replace(new RegExp(`<${tag}[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi'), '');
    // Orphaned opening tag (no matching close) e.g. <tool_call> alone on a line
    result = result.replace(new RegExp(`^[ \\t]*<${tag}[^>]*>[ \\t]*$`, 'gim'), '');
    // Orphaned closing tag
    result = result.replace(new RegExp(`^[ \\t]*<\\/${tag}>[ \\t]*$`, 'gim'), '');
  }

  // Step 3: collapse runs of blank lines created by stripping blocks (max 1 blank line).
  result = result.replace(/\n{3,}/g, '\n\n');

  // Step 3b: fix numbered list formatting — add space after "N." when followed immediately by
  // a non-whitespace character (e.g. "1.Audit" → "1. Audit"). Safe for version strings because
  // those appear mid-line, not at line start (requires ^).
  result = result.replace(/^(\d+)\.(\S)/gm, '$1. $2');

  // Step 4: restore fenced code blocks.
  result = result.replace(new RegExp(`${FENCE_PLACEHOLDER_PREFIX}(\\d+)\x00`, 'g'), (_match, idx: string) => {
    return fences[parseInt(idx, 10)] ?? '';
  });

  return result.trim();
}

/** Strip markdown formatting for streaming preview — returns last 4 visible lines. */
export function stripMarkdownForStream(text: string): string {
  return text
    .split('\n')
    .map((line) =>
      line
        .replace(/^#{1,6}\s+/, '')
        .replace(/\*\*(.+?)\*\*/g, '$1')
        .replace(/`([^`]+)`/g, '$1')
        .replace(/^\s*[-*]\s/, '  \u2022 ')
        .replace(/[\u{FE00}-\u{FE0F}]/gu, '')
        .replace(/[\u{200D}]/gu, '')
        .trimEnd()
    )
    .filter((l) => {
      const t = l.trim();
      return t.length > 0 && !t.match(/^[-=`]{3,}$/) && !t.startsWith('```');
    })
    .slice(-4)
    .join('\n');
}
