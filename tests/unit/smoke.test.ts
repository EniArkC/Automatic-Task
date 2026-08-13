import { describe, expect, it } from 'vitest';

describe('toolchain smoke test', () => {
    it('vitest runs', () => {
        expect(1 + 1).toBe(2);
    });
});
