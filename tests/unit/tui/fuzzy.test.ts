import { describe, expect, it } from 'vitest';

import { fuzzyMatch, fuzzyRank } from '../../../src/tui/fuzzy';

describe('fuzzyMatch', () => {
    it('returns undefined when the pattern is not a subsequence', () => {
        expect(fuzzyMatch('zzz', 'run task')).toBeUndefined();
        expect(fuzzyMatch('tr', 'run task')).toBeUndefined();
    });

    it('scores an empty pattern as a zero-cost match', () => {
        const match = fuzzyMatch('', 'anything');
        expect(match).toEqual({ Score: 0, Positions: [] });
    });

    it('reports the positions it matched', () => {
        const match = fuzzyMatch('rt', 'run task');
        expect(match?.Positions).toEqual([0, 4]);
    });

    it('prefers word boundaries over mid-word hits', () => {
        const boundary = fuzzyMatch('rt', 'run task');
        const middle = fuzzyMatch('rt', 'reformat');
        expect(boundary?.Score ?? 0).toBeGreaterThan(middle?.Score ?? 0);
    });

    it('prefers consecutive runs', () => {
        const consecutive = fuzzyMatch('task', 'task list');
        const scattered = fuzzyMatch('task', 't a s k');
        expect(consecutive?.Score ?? 0).toBeGreaterThan(scattered?.Score ?? 0);
    });

    it('indexes positions by code point, so wide characters stay aligned', () => {
        const candidate = '中文任务';
        const match = fuzzyMatch('任务', candidate);
        const chars = Array.from(candidate);
        expect(match?.Positions).toEqual([2, 3]);
        expect((match?.Positions ?? []).map((index) => chars[index]).join('')).toBe('任务');
    });
});

describe('fuzzyRank', () => {
    const items = [
        { Id: 'task.run', Label: '运行选中任务' },
        { Id: 'task.install', Label: '安装任务包' },
        { Id: 'view.reload', Label: '刷新' },
    ];
    const textOf = (item: { Id: string; Label: string }): string => `${item.Label} ${item.Id}`;

    it('drops candidates that do not match', () => {
        const results = fuzzyRank('zzzz', items, textOf);
        expect(results).toHaveLength(0);
    });

    it('returns everything for an empty pattern, in the original order', () => {
        const results = fuzzyRank('', items, textOf);
        expect(results.map((result) => result.Item.Id)).toEqual(['task.run', 'task.install', 'view.reload']);
    });

    it('sorts by score, keeping the original order among ties', () => {
        const results = fuzzyRank('task', items, textOf);
        expect(results.length).toBeGreaterThan(0);
        for (let index = 1; index < results.length; index += 1) {
            expect(results[index - 1]?.Match.Score ?? 0).toBeGreaterThanOrEqual(results[index]?.Match.Score ?? 0);
        }
    });

    it('ranks an exact prefix first', () => {
        const results = fuzzyRank('reload', items, textOf);
        expect(results[0]?.Item.Id).toBe('view.reload');
    });
});
