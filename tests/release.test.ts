import { describe, expect, it } from 'vitest';
import { isNewer } from '../src/platform/release.js';

describe('release versions', () => {
  it('compares numerically and ignores the v prefix and pre-release tags', () => {
    expect(isNewer('v0.10.0', '0.9.3')).toBe(true);
    expect(isNewer('1.0.0', '1.0.0')).toBe(false);
    expect(isNewer('1.0', '1.0.1')).toBe(false);
    expect(isNewer('1.2.0-beta', '1.1.9')).toBe(true);
  });
});
