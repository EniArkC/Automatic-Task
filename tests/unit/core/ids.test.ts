import { isValidUlid, UlidGenerator, ulidToDate, ulidToTimestamp } from '@at/core';
import { describe, expect, it } from 'vitest';

describe('ulid', () => {
    it('generates 26-char Crockford base32 ids', () => {
        const generator = new UlidGenerator();
        const id = generator.Next();
        expect(id).toHaveLength(26);
        expect(isValidUlid(id)).toBe(true);
        expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    });

    it('is unique across many ids', () => {
        const generator = new UlidGenerator();
        const ids = new Set<string>();
        for (let i = 0; i < 10000; i++) {
            ids.add(generator.Next());
        }
        expect(ids.size).toBe(10000);
    });

    it('is time-ordered', () => {
        const generator = new UlidGenerator();
        const ids = Array.from({ length: 1000 }, () => generator.Next());
        const sorted = [...ids].sort();
        expect(ids).toEqual(sorted);
    });

    it('encodes the creation time', () => {
        const generator = new UlidGenerator();
        const before = Date.now();
        const id = generator.Next();
        const after = Date.now();
        const timestamp = ulidToTimestamp(id);
        expect(timestamp).toBeGreaterThanOrEqual(before);
        expect(timestamp).toBeLessThanOrEqual(after);
        expect(ulidToDate(id).getTime()).toBe(timestamp);
    });

    it('rejects malformed ids', () => {
        expect(isValidUlid('short')).toBe(false);
        expect(isValidUlid('A'.repeat(25))).toBe(false);
        expect(isValidUlid('Z'.repeat(26))).toBe(false);
        expect(isValidUlid('0'.repeat(26))).toBe(true);
        // 26 chars but the timestamp overflows 48 bits.
        expect(isValidUlid('Z'.repeat(10) + '0'.repeat(16))).toBe(false);
    });
});
