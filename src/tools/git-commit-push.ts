/**
 * MCP tool: git_commit_push
 * Creates a branch, stages only .tf/.tf.json changes, commits, and pushes to origin.
 * Used by the fix agent when --pr is requested.
 *
 * Security: never stages .korinfra/, .env, secrets, or binary files.
 * Ensures .korinfra/ is in .gitignore before committing.
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { jsonResult, errorResult } from './types.js';
import type { ToolDefinition } from './types.js';

function run(cmd: string, cwd: string): string {
  return execSync(cmd, { encoding: 'utf8', cwd, stdio: ['ignore', 'pipe', 'pipe'] });
}

/** Ensure .korinfra/ is listed in .gitignore at git repo root. */
function ensureGitignore(cwd: string): void {
  // Always write to git root, not TF subdirectory — subdirs don't need it.
  let repoRoot: string;
  try {
    repoRoot = run('git rev-parse --show-toplevel', cwd).trim();
  } catch {
    repoRoot = cwd;
  }
  const gitignorePath = path.join(repoRoot, '.gitignore');
  const entry = '.korinfra/';
  if (existsSync(gitignorePath)) {
    const content = readFileSync(gitignorePath, 'utf8');
    if (!content.includes(entry)) {
      appendFileSync(gitignorePath, `\n# korinfra internal files\n${entry}\n`);
    }
  } else {
    appendFileSync(gitignorePath, `# korinfra internal files\n${entry}\n`);
  }
}

export const gitCommitPushTool: ToolDefinition = {
  name: 'git_commit_push',
  description:
    'Create a new git branch, stage only modified .tf and .tf.json files, commit with a message, and push to origin. ' +
    'Returns the branch name so it can be used as the PR head. ' +
    'Only Terraform files are staged — never secrets, .env, or internal tool files.',
  inputSchema: {
    type: 'object',
    properties: {
      branch: {
        type: 'string',
        description: 'Branch name to create (e.g. korinfra/fix-s3-logging). Must be a valid git ref.',
        maxLength: 200,
      },
      message: {
        type: 'string',
        description: 'Commit message.',
        maxLength: 500,
      },
      cwd: {
        type: 'string',
        description: 'Working directory (absolute path). Defaults to process.cwd().',
      },
    },
    required: ['branch', 'message'],
    additionalProperties: false,
  },
  // eslint-disable-next-line @typescript-eslint/require-await -- handler interface requires Promise return
  handler: async (args) => {
    try {
      const branch = typeof args['branch'] === 'string' ? args['branch'].trim() : '';
      const message = typeof args['message'] === 'string' ? args['message'].trim() : '';
      const cwd = typeof args['cwd'] === 'string' ? args['cwd'] : process.cwd();

      if (!branch) return errorResult('branch must be a non-empty string');
      if (!message) return errorResult('message must be a non-empty string');

      // Capture current branch so we can restore it after pushing
      let originalBranch: string | null = null;
      try {
        originalBranch = run('git rev-parse --abbrev-ref HEAD', cwd).trim();
        if (originalBranch === 'HEAD') originalBranch = null; // detached HEAD
      } catch { /* ignore */ }

      // Validate branch name: no shell injection, no path traversal sequences.
      const validBranch = /^[a-zA-Z0-9]([a-zA-Z0-9._/-]*[a-zA-Z0-9])?$/.test(branch);
      if (
        branch.length > 255 ||
        !validBranch ||
        branch.includes('..') ||
        branch.includes('//') ||
        branch.startsWith('-')
      ) {
        return errorResult('branch name contains invalid characters');
      }

      // Ensure .korinfra/ is excluded from git before staging anything
      ensureGitignore(cwd);

      // Untrack .korinfra/ if it was previously staged/committed (e.g. older git add -A)
      try {
        const tracked = run('git ls-files .korinfra', cwd).trim();
        if (tracked) {
          run('git rm -r --cached .korinfra', cwd);
        }
      } catch { /* not tracked — ignore */ }

      // If branch already exists, append a short timestamp to make it unique
      let finalBranch = branch;
      try {
        run(`git rev-parse --verify ${branch}`, cwd);
        // Branch exists — add timestamp suffix
        finalBranch = `${branch}-${Date.now().toString(36)}`;
      } catch {
        // Branch doesn't exist — proceed with original name
      }
      // Branch from remote main/master so local-only commits never leak into the PR.
      // Working-directory edits (the agent's .tf changes) survive the checkout.
      let branched = false;
      for (const base of ['origin/main', 'origin/master']) {
        try {
          run(`git rev-parse --verify ${base}`, cwd);
          try { run('git fetch origin', cwd); } catch { /* offline — use cached ref */ }
          run(`git checkout -b ${finalBranch} ${base}`, cwd);
          branched = true;
          break;
        } catch { /* base not available, try next */ }
      }
      if (!branched) run(`git checkout -b ${finalBranch}`, cwd);

      // Stage only Terraform files + .gitignore — never secrets or tool internals.
      // Stage patterns separately so a missing *.tf.json doesn't abort the whole add.
      try { run('git add -- "*.tf"', cwd); } catch { /* no .tf files changed */ }
      try { run('git add -- "*.tf.json"', cwd); } catch { /* no .tf.json files — expected */ }
      try {
        const gitignoreStatus = run('git status --porcelain .gitignore', cwd).trim();
        if (gitignoreStatus) run('git add .gitignore', cwd);
      } catch { /* ignore */ }

      // Check if there's anything to commit
      const status = run('git status --porcelain', cwd);
      if (!status.trim()) {
        return jsonResult({ branch: finalBranch, committed: false, note: 'No Terraform file changes to commit' });
      }

      // Strip control characters (incl. newlines) before shell-escaping to prevent multi-message injection.
      const safeMsg = message
        // eslint-disable-next-line no-control-regex -- intentionally strips control chars before shell injection
        .replace(/[\x00-\x1f\x7f]/g, ' ')
        .replace(/'/g, "'\\''");
      run(`git commit -m '${safeMsg}'`, cwd);
      run(`git push -u origin ${finalBranch}`, cwd);

      // Restore original branch so repo isn't left on the fix branch
      if (originalBranch && originalBranch !== finalBranch) {
        try { run(`git checkout ${originalBranch}`, cwd); } catch { /* ignore — non-fatal */ }
      }

      return jsonResult({ branch: finalBranch, committed: true, pushed: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return errorResult(`git operation failed: ${msg}`);
    }
  },
};
