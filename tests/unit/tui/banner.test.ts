import { describe, expect, it } from 'vitest';

import { BIG_TITLE_ROWS, BIG_TITLE_WIDTH, bigTitleLetters } from '../../../src/tui/banner-font';

// The block-letter title spells the application name out of half-block glyphs,
// so the literal word never reaches the terminal. That makes these assertions
// the only place the spelling is checked: the terminal test at
// tests/integration/tui.test.ts can only look for the glyphs.
describe('banner-font', () => {
    it('spells the application name', () => {
        expect(bigTitleLetters.map((letter) => letter.Char).join('')).toBe('AUTOMATIC-TASK');
    });

    it('gives every letter the same number of rows', () => {
        for (const letter of bigTitleLetters) {
            expect(letter.Rows).toHaveLength(BIG_TITLE_ROWS);
        }
    });

    // Each row of a letter has to be the same width, or the rows below the
    // first would drift out of alignment with it.
    it('keeps every row of a letter the same width', () => {
        for (const letter of bigTitleLetters) {
            const width = letter.Rows[0]?.length ?? 0;
            for (const row of letter.Rows) {
                expect(row.length).toBe(width);
            }
        }
    });

    // The half-block glyphs are single-cell, so a pixel column is a terminal
    // column and the advertised width is just the sum of the letter widths.
    // frameMetrics decides whether the big banner fits from this number.
    it('reports the width the rows actually occupy', () => {
        const rendered = [0, 1, 2].map((row) => bigTitleLetters.map((letter) => letter.Rows[row]).join(''));
        for (const row of rendered) {
            expect(row.length).toBe(BIG_TITLE_WIDTH);
        }
    });

    it('draws only single-cell block characters', () => {
        for (const letter of bigTitleLetters) {
            for (const row of letter.Rows) {
                expect(row).toMatch(/^[█▀▄ ]*$/);
            }
        }
    });
});
