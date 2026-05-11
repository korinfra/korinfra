## Summary

<!-- 1-3 sentences: what does this PR do and why? -->

## Type of change

- [ ] Bug fix (non-breaking change)
- [ ] New feature (non-breaking change)
- [ ] Breaking change
- [ ] Documentation
- [ ] Refactor / cleanup
- [ ] CI/tooling

## Verification checklist

All items must pass before merge:

- [ ] `npm run typecheck` passes
- [ ] `npm run lint` passes (or `npm run lint:fix` was run)
- [ ] `npm run test` passes
- [ ] `npm run build` succeeds
- [ ] Tested manually in terminal (if modifying CLI/TUI)

## TUI changes checklist

**Only required if modifying `src/cli/`:**

- [ ] Spacing uses constants from `src/cli/ui/spacing.ts` (no inline `marginTop`/`marginLeft`)
- [ ] Severity labels use `SEVERITY_LABELS` from `src/cli/ui/text.ts` (no hardcoded `'CRITICAL'`, etc.)
- [ ] Separators use `DOT_SEP` from `src/cli/ui/text.ts` (no inline `' · '`)
- [ ] `ActionBar` contains only domain actions; no navigation keys
- [ ] `NavHints` contains only navigation keys; no domain actions
- [ ] All screens wrapped in `ScreenShell` (no manual CommandHeader replication)
- [ ] Tested at multiple terminal widths (56, 72, 80+ columns)

## Security checklist

**Only required if touching AWS/AI/credentials/storage code:**

- [ ] No raw AWS credentials, ARNs, or account IDs in logs
- [ ] Redaction applied before any AI provider call
- [ ] No new external HTTP calls without rate limiting (`p-throttle`)
- [ ] All sensitive config validated via cosmiconfig + Zod

## Documentation updates

- [ ] Inline comments added for non-obvious logic
- [ ] `README.md` or `docs/*.md` updated (if new command or feature)

## Related issues

Closes # (link to issue this fixes)
