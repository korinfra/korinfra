import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sep } from 'node:path';
import { assertInsideRoot } from '../../../src/tools/types.js';

// ─── Mock process.cwd ─────────────────────────────────────────────────────────

describe('assertInsideRoot', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('with normal project directory', () => {
    beforeEach(() => {
      // Use system separator; on Windows sep is '\', on Unix is '/'
      const rootPath = `C${sep}home${sep}user${sep}project`;
      vi.spyOn(process, 'cwd').mockReturnValue(rootPath);
    });

    it('does not throw when path equals cwd', () => {
      const rootPath = `C${sep}home${sep}user${sep}project`;
      expect(() => {
        assertInsideRoot(rootPath);
      }).not.toThrow();
    });

    it('does not throw when path is inside a subdirectory of cwd', () => {
      const subdirPath = `C${sep}home${sep}user${sep}project${sep}subdir`;
      const deepPath = `C${sep}home${sep}user${sep}project${sep}deep${sep}nested${sep}path`;

      expect(() => {
        assertInsideRoot(subdirPath);
      }).not.toThrow();

      expect(() => {
        assertInsideRoot(deepPath);
      }).not.toThrow();
    });

    it('throws when path is outside cwd', () => {
      const otherPath = `C${sep}home${sep}user${sep}other`;
      const unrelatedPath = `D${sep}etc${sep}passwd`;

      expect(() => {
        assertInsideRoot(otherPath);
      }).toThrow('must be inside the project directory');

      expect(() => {
        assertInsideRoot(unrelatedPath);
      }).toThrow('must be inside the project directory');
    });

    it('includes the path in the error message', () => {
      const otherPath = `C${sep}home${sep}user${sep}other`;
      expect(() => {
        assertInsideRoot(otherPath);
      }).toThrow(otherPath);
    });

    it('allows custom label in error message', () => {
      const otherPath = `C${sep}home${sep}user${sep}other`;
      expect(() => {
        assertInsideRoot(otherPath, 'config file');
      }).toThrow('config file must be inside the project directory');
    });

    it('respects the label parameter in the default message', () => {
      const unrelatedPath = `D${sep}etc${sep}passwd`;
      expect(() => {
        assertInsideRoot(unrelatedPath, 'terraform file');
      }).toThrow('terraform file must be inside the project directory');
    });
  });

  describe('with filesystem root (Unix)', () => {
    beforeEach(() => {
      vi.spyOn(process, 'cwd').mockReturnValue('/');
    });

    it('throws when cwd is filesystem root', () => {
      expect(() => {
        assertInsideRoot('/');
      }).toThrow('cannot safely contain paths');

      expect(() => {
        assertInsideRoot('/home/user/project');
      }).toThrow('cannot safely contain paths');
    });

    it('includes root in the error message', () => {
      expect(() => {
        assertInsideRoot('/home/user');
      }).toThrow('/');
    });
  });

  describe('with Windows drive root (C:)', () => {
    beforeEach(() => {
      vi.spyOn(process, 'cwd').mockReturnValue('C:\\');
    });

    it('throws when cwd is a drive root', () => {
      expect(() => {
        assertInsideRoot('C:\\Users\\test');
      }).toThrow('cannot safely contain paths');
    });
  });

  describe('with Windows drive root without backslash (C:)', () => {
    beforeEach(() => {
      vi.spyOn(process, 'cwd').mockReturnValue('C:');
    });

    it('throws when cwd is drive letter with colon only', () => {
      expect(() => {
        assertInsideRoot('C:\\project');
      }).toThrow('cannot safely contain paths');
    });
  });

  describe('with Windows UNC paths', () => {
    beforeEach(() => {
      // Real UNC path: starts with \\ (four backslashes in source code = two actual backslashes)
      vi.spyOn(process, 'cwd').mockReturnValue('\\\\\\\\server\\\\share');
    });

    it('throws when cwd matches the UNC root pattern', () => {
      // The regex /^\\\\[?.]?\\/i tests for \\server\ or \\.\ or \\?\ patterns
      // The string '\\\\\\\\server\\\\share' (4 backslashes = 2 actual) matches
      expect(() => {
        assertInsideRoot('\\\\\\\\server\\\\share\\\\folder');
      }).toThrow('cannot safely contain paths');
    });
  });

  describe('with Windows extended-length paths', () => {
    beforeEach(() => {
      vi.spyOn(process, 'cwd').mockReturnValue('\\\\?\\C:\\');
    });

    it('throws when cwd is an extended-length path root', () => {
      expect(() => {
        assertInsideRoot('\\\\?\\C:\\project');
      }).toThrow('cannot safely contain paths');
    });
  });

  describe('path normalization edge cases', () => {
    beforeEach(() => {
      vi.spyOn(process, 'cwd').mockReturnValue(`C${sep}home${sep}user${sep}project`);
    });

    it('correctly identifies subpaths without ambiguity (no false positives)', () => {
      const projectOtherPath = `C${sep}home${sep}user${sep}project-other`;
      const subdirPath = `C${sep}home${sep}user${sep}project${sep}subdir`;

      // Should NOT accept paths with similar prefix but wrong separator position
      expect(() => {
        assertInsideRoot(projectOtherPath);
      }).toThrow('must be inside the project directory');

      // But actual subdirectories should pass
      expect(() => {
        assertInsideRoot(subdirPath);
      }).not.toThrow();
    });

    it('handles paths without trailing separator in cwd', () => {
      const rootPath = `C${sep}home${sep}user${sep}project`;
      // cwd is set without trailing separator above
      // It should match exactly
      expect(() => {
        assertInsideRoot(rootPath);
      }).not.toThrow();
    });
  });

  describe('case sensitivity (depends on filesystem)', () => {
    beforeEach(() => {
      const rootPath = `C${sep}home${sep}user${sep}project`;
      vi.spyOn(process, 'cwd').mockReturnValue(rootPath);
    });

    it('performs exact string comparison (case-sensitive)', () => {
      const upperPath = `C${sep}home${sep}user${sep}Project`;

      // The function uses exact string comparison, so case matters
      expect(() => {
        assertInsideRoot(upperPath);
      }).toThrow('must be inside the project directory');
    });
  });

  describe('defensive checks for dangerous roots', () => {
    it('rejects Unix root when detected', () => {
      vi.spyOn(process, 'cwd').mockReturnValue('/');

      expect(() => {
        assertInsideRoot('/any/path');
      }).toThrow('cannot safely contain paths');
    });

    it('rejects Windows drive root variations', () => {
      const testCases = ['C:\\', 'D:\\', 'd:\\', 'Z:\\'];

      for (const rootPath of testCases) {
        vi.clearAllMocks();
        vi.spyOn(process, 'cwd').mockReturnValue(rootPath);

        expect(() => {
          assertInsideRoot(`${rootPath}project`);
        }).toThrow('cannot safely contain paths');
      }
    });
  });
});
