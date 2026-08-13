import { FakeClock } from '@at/core';
import { describe, expect, it } from 'vitest';

describe('fake clock', () => {
    it('advances deterministically', () => {
        const clock = new FakeClock(new Date('2026-08-09T03:00:00Z'));
        expect(clock.Now().toISOString()).toBe('2026-08-09T03:00:00.000Z');
        clock.Advance(60_000);
        expect(clock.Now().toISOString()).toBe('2026-08-09T03:01:00.000Z');
    });
});
