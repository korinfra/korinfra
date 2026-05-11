import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getVersion, getVersionInfo } from '../../src/utils/version.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const pkgJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')) as {
  name: string;
  version: string;
  description: string;
};

describe('getVersion', () => {
  it('returns a semver-like string', () => {
    expect(getVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('matches the version in package.json exactly', () => {
    expect(getVersion()).toBe(pkgJson.version);
  });
});

describe('getVersionInfo', () => {
  it('returns an object with version, name, and description', () => {
    const info = getVersionInfo();
    expect(info).toHaveProperty('version');
    expect(info).toHaveProperty('name');
    expect(info).toHaveProperty('description');
  });

  it('name is "korinfra"', () => {
    expect(getVersionInfo().name).toBe('korinfra');
  });

  it('values match package.json exactly', () => {
    const info = getVersionInfo();
    expect(info.version).toBe(pkgJson.version);
    expect(info.name).toBe(pkgJson.name);
    expect(info.description).toBe(pkgJson.description);
  });
});
