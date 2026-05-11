/**
 * levenshtein calculates the Levenshtein distance between two strings.
 * It uses dynamic programming to compute the minimum number of single-character edits
 * (insertions, deletions, or substitutions) needed to transform one string into another.
 * Examples: levenshtein('scan', 'scans') → 1, levenshtein('abc', 'def') → 3
 */
export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      // dp is (m+1)×(n+1) — i and j are always in bounds
      const row = dp[i] as number[];
      const prevRow = dp[i - 1] as number[];
      row[j] = a[i - 1] === b[j - 1]
        ? (prevRow[j - 1] as number)
        : 1 + Math.min(prevRow[j] as number, row[j - 1] as number, prevRow[j - 1] as number);
    }
  }
  return (dp[m] as number[])[n] as number;
}
