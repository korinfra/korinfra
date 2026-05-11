import React, { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';

import { DataTable } from '../../../src/cli/components/DataTable.js';
import type { ColumnDef } from '../../../src/cli/components/DataTable.js';

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface Row {
  id: string;
  name: string;
}

const COLUMNS: ColumnDef<Row>[] = [
  { key: 'name', label: 'Name', priority: 1 },
];

function TableHarness(): React.JSX.Element {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const rows: Row[] = Array.from({ length: 30 }, (_, i) => ({
    id: `row-${i + 1}`,
    name: `row-${i + 1}`,
  }));

  return (
    <DataTable<Row>
      columns={COLUMNS}
      rows={rows}
      selectedIndex={selectedIndex}
      onSelect={setSelectedIndex}
      getRowKey={(row) => row.id}
      pageSize={5}
    />
  );
}

describe('DataTable viewport scroll behavior', () => {
  it('keeps selection moving and advances viewport only when selection exits visible rows', async () => {
    const { lastFrame, stdin, unmount } = render(<TableHarness />);

    await wait(100);
    const initial = lastFrame() ?? '';
    expect(initial).toContain('1–5 of 30');
    expect(initial).toContain('row-1');
    expect(initial).toContain('row-5');

    // Move selection to row 6 (5 downward moves from row 1).
    stdin.write('jjjjj');
    await wait(100);

    const after = lastFrame() ?? '';
    expect(after).toContain('2–6 of 30');
    expect(after).toContain('row-6');
    expect(after).toContain('↑ 1 above');

    unmount();
  });

  it('keeps Page/Home/End handlers and mouse-scroll ownership in DataTable source', async () => {
    const fs = await import('node:fs/promises');
    const src = await fs.readFile(
      new URL('../../../src/cli/components/DataTable.tsx', import.meta.url),
      'utf8',
    );

    expect(src).toContain('key.pageUp');
    expect(src).toContain('key.pageDown');
    expect(src).toContain('key.home');
    expect(src).toContain('key.end');
    expect(src).toContain('useMouseScroll(');
  });
});
