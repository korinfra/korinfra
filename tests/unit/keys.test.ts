import { RESERVED_KEYS, RESERVED_KEYS_SET } from '../../src/cli/ui/keys.js';

describe('RESERVED_KEYS contract (G-5)', () => {
  it('RESERVED_KEYS_SET contains the correct number of physical key strings', () => {
    // Count all unique aliases across all named entries.
    // back = ['Escape', 'b'] — two physical keys from one named slot.
    const expected = Object.values(RESERVED_KEYS).flatMap(
      (def) => (def as { aliases: readonly string[] }).aliases,
    );
    expect(RESERVED_KEYS_SET.size).toBe(new Set(expected).size);
  });

  it('contains all spot-checked canonical keys', () => {
    expect(RESERVED_KEYS_SET.has('q')).toBe(true);
    expect(RESERVED_KEYS_SET.has('r')).toBe(true);
    expect(RESERVED_KEYS_SET.has('s')).toBe(true);
    expect(RESERVED_KEYS_SET.has('p')).toBe(true);
    expect(RESERVED_KEYS_SET.has('Enter')).toBe(true);
    expect(RESERVED_KEYS_SET.has('Escape')).toBe(true);
  });

  it('back key covers both Escape and b aliases', () => {
    expect(RESERVED_KEYS_SET.has('Escape')).toBe(true);
    expect(RESERVED_KEYS_SET.has('b')).toBe(true);
  });

  it('Space is represented as a single space character', () => {
    expect(RESERVED_KEYS_SET.has(' ')).toBe(true);
  });

  it('every named entry has at least one alias', () => {
    for (const [name, def] of Object.entries(RESERVED_KEYS)) {
      expect((def as { aliases: readonly string[] }).aliases.length).toBeGreaterThan(
        0,
        `${name} has no aliases`,
      );
    }
  });

  it('no alias is duplicated across different named entries', () => {
    const seen = new Map<string, string>();
    for (const [name, def] of Object.entries(RESERVED_KEYS)) {
      for (const alias of (def as { aliases: readonly string[] }).aliases) {
        if (seen.has(alias)) {
          throw new Error(
            `Alias '${alias}' is claimed by both '${seen.get(alias)}' and '${name}'`,
          );
        }
        seen.set(alias, name);
      }
    }
  });
});
