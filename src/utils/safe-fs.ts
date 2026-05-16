// Hardened fs helpers for sensitive paths. Addressed threats:
//   1. world-readable default umask → explicit mode on every write
//   2. symlink redirection at the leaf path → lstat check + O_NOFOLLOW
//   3. TOCTOU between stat/lstat and the actual open → all reads/writes go
//      through a single openSync; mode is set via fchmod on the open fd BEFORE
//      content is written; the mode check on reads uses fstat on the same fd.
//   4. Pre-existing parent dir with broader mode → chmodSync after mkdirSync.
//
// Known limitation: only the leaf path component is symlink-checked. A symlink
// at an intermediate directory (e.g. ~/.korinfra/) is still followed.

import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

const NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;

function ignoreUnsupported(err: unknown): void {
  const code = (err as NodeJS.ErrnoException).code;
  if (code !== 'ENOSYS' && code !== 'EPERM' && process.platform !== 'win32') throw err;
}

function fchmod(fd: number, mode: number): void {
  try { fchmodSync(fd, mode); } catch (err) { ignoreUnsupported(err); }
}

function chmodPath(p: string, mode: number): void {
  try { chmodSync(p, mode); } catch (err) { ignoreUnsupported(err); }
}

function ensureDir(p: string, mode: number): void {
  mkdirSync(p, { recursive: true, mode });
  // mkdirSync follows a pre-existing symlink at `p`; refuse so writes inside
  // are not redirected. Note: this only checks the leaf dir component, not
  // deeper parents (a known limitation — full path validation would require
  // openat-style traversal).
  const st = lstatSync(p);
  if (st.isSymbolicLink()) throw new Error(`Refusing to use symlinked directory: ${p}`);
  // mkdirSync(..., { mode }) only applies on creation; tighten existing dirs.
  chmodPath(p, mode);
}

export function checkNoSymlink(p: string): void {
  try {
    const st = lstatSync(p);
    if (st.isSymbolicLink()) throw new Error(`Refusing to operate on symlink: ${p}`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

export interface SafeWriteOptions {
  mode: number;
  dirMode?: number;
}

export function safeWriteFile(p: string, data: string | Buffer, opts: SafeWriteOptions): void {
  ensureDir(dirname(p), opts.dirMode ?? 0o700);
  checkNoSymlink(p);
  const fd = openSync(
    p,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | NOFOLLOW,
    opts.mode,
  );
  try {
    // fchmod before write: O_CREAT keeps a pre-existing file's mode, so
    // without this the new content briefly lives under the old mode.
    fchmod(fd, opts.mode);
    // writeFileSync(fd, data) loops internally and handles partial writes.
    writeFileSync(fd, data);
  } finally {
    try { closeSync(fd); } catch { /* ignore */ }
  }
}

export interface SafeReadOptions {
  requireMode?: number;
}

export function safeReadFile(p: string, opts: SafeReadOptions = {}): string {
  checkNoSymlink(p);
  const fd = openSync(p, fsConstants.O_RDONLY | NOFOLLOW);
  try {
    if (opts.requireMode !== undefined) {
      const actualMode = fstatSync(fd).mode & 0o777;
      if ((actualMode & ~opts.requireMode) !== 0) {
        throw new Error(
          `Refusing to read file with overly-permissive mode: ${p} (mode ${actualMode.toString(8)}, expected ≤ ${opts.requireMode.toString(8)})`,
        );
      }
    }
    return readFileSync(fd, 'utf8');
  } finally {
    try { closeSync(fd); } catch { /* ignore */ }
  }
}

export function safeOpenAppend(p: string, opts: SafeWriteOptions): number {
  ensureDir(dirname(p), opts.dirMode ?? 0o700);
  checkNoSymlink(p);
  const fd = openSync(
    p,
    fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_WRONLY | NOFOLLOW,
    opts.mode,
  );
  try {
    fchmod(fd, opts.mode);
  } catch (err) {
    try { closeSync(fd); } catch { /* ignore */ }
    throw err;
  }
  return fd;
}
