import { compareSemver, isValidSemver } from '@at/core';
import { describe, expect, it } from 'vitest';

describe('semver', () => {
    it('accepts valid versions', () => {
        expect(isValidSemver('1.0.0')).toBe(true);
        expect(isValidSemver('1.2.3')).toBe(true);
        expect(isValidSemver('0.0.1')).toBe(true);
        expect(isValidSemver('2.0.0-beta.1')).toBe(true);
        expect(isValidSemver('1.0.0+build.5')).toBe(true);
        expect(isValidSemver('10.20.30-rc.1+build')).toBe(true);
    });

    it('rejects invalid versions', () => {
        expect(isValidSemver('1.0')).toBe(false);
        expect(isValidSemver('1')).toBe(false);
        expect(isValidSemver('v1.0.0')).toBe(false);
        expect(isValidSemver('01.0.0')).toBe(false);
        expect(isValidSemver('1.0.0.0')).toBe(false);
        expect(isValidSemver('')).toBe(false);
        expect(isValidSemver('1.0.0_')).toBe(false);
    });

    it('compares versions', () => {
        expect(compareSemver('1.0.0', '1.1.0')).toBeLessThan(0);
        expect(compareSemver('1.1.0', '1.0.0')).toBeGreaterThan(0);
        expect(compareSemver('1.0.0', '1.0.0')).toBe(0);
        expect(compareSemver('1.0.0', '2.0.0')).toBeLessThan(0);
        expect(compareSemver('0.9.9', '1.0.0')).toBeLessThan(0);
    });

    it('compares prereleases', () => {
        expect(compareSemver('1.0.0-beta', '1.0.0')).toBeLessThan(0);
        expect(compareSemver('1.0.0', '1.0.0-rc.1')).toBeGreaterThan(0);
        expect(compareSemver('1.0.0-rc.1', '1.0.0-rc.2')).toBeLessThan(0);
        expect(compareSemver('1.0.0-alpha.10', '1.0.0-alpha.2')).toBeGreaterThan(0);
        expect(compareSemver('1.0.0-rc', '1.0.0-rc.1')).toBeLessThan(0);
    });

    it('throws on invalid input', () => {
        expect(() => compareSemver('nope', '1.0.0')).toThrow(TypeError);
    });
});
