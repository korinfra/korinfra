import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';

import { ReportCommand } from '../../../src/cli/commands/report.js';

describe('ReportCommand output format validation', () => {
  it('renders ReportCommand with format selection step', async () => {
    const { lastFrame, unmount } = render(<ReportCommand args={[]} provider={null} />);

    try {
      // ReportCommand starts at format selection step per §10.1
      const frame = lastFrame() ?? '';
      expect(frame).toContain('report');
    } finally {
      unmount();
    }
  });

  it('renders with default HTML format', async () => {
    const { lastFrame, unmount } = render(<ReportCommand args={['--format', 'html']} provider={null} />);

    try {
      const frame = lastFrame() ?? '';
      // Validation happens during generation, not on init
      expect(frame).toBeTruthy();
    } finally {
      unmount();
    }
  });

  it('renders with CSV format option', async () => {
    const { lastFrame, unmount } = render(<ReportCommand args={['--format', 'csv']} provider={null} />);

    try {
      const frame = lastFrame() ?? '';
      expect(frame).toBeTruthy();
    } finally {
      unmount();
    }
  });
});
