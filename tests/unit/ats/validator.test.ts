import { parseAts, validateTaskAst } from '@at/ats';
import { describe, expect, it } from 'vitest';

function issues(
    source: string,
    values?: Record<string, string | number | boolean>,
): ReturnType<typeof validateTaskAst> {
    const ast = parseAts(source, 'task.ats');
    return validateTaskAst(ast, values === undefined ? undefined : new Map(Object.entries(values)));
}

function valid(source: string, values?: Record<string, string | number | boolean>): boolean {
    return issues(source, values).length === 0;
}

const BASE = `[Start]
-> [Script(\`echo hi\`)]
[End]
`;

describe('validator', () => {
    it('accepts a valid task', () => {
        expect(issues(BASE)).toHaveLength(0);
    });

    it('rejects duplicate variables', () => {
        expect(issues('@var city: string = "a"\n@var city: string = "b"\n' + BASE)).toHaveLength(1);
    });

    it('rejects unknown template variables', () => {
        expect(issues('[Start]\n-> [Script(`echo ${nope}`)]\n[End]\n')).toHaveLength(1);
    });

    it('accepts declared template variables', () => {
        expect(valid('@var city: string = "上海"\n[Start]\n-> [Script(`echo ${city}`)]\n[End]\n')).toBe(true);
    });

    it('rejects select variables without options', () => {
        expect(() => parseAts('@var depth: select() = "a"\n' + BASE, 'task.ats')).toThrow(/Expected a string option/);
    });

    it('rejects a default outside select options', () => {
        expect(issues('@var depth: select("简版", "详细") = "其他"\n' + BASE)).toHaveLength(1);
    });

    it('rejects a number default on a string variable', () => {
        expect(issues('@var city: string = 3\n' + BASE)).toHaveLength(1);
    });

    it('rejects script without a command', () => {
        expect(issues('[Start]\n-> [Script()]\n[End]\n')).toHaveLength(1);
    });

    it('rejects a non-positive timeout', () => {
        expect(issues('[Start]\n-> [Agent(`x`, timeout: 0)]\n[End]\n')).toHaveLength(1);
    });

    it('accepts a positive timeout', () => {
        expect(valid('[Start]\n-> [Agent(`x`, timeout: 30)]\n[End]\n')).toBe(true);
    });

    it('accepts a number variable as timeout', () => {
        expect(valid('@var secs: number = 30\n[Start]\n-> [Agent(`x`, timeout: ${secs})]\n[End]\n')).toBe(true);
    });

    it('rejects a non-number variable as timeout', () => {
        expect(issues('@var secs: string = "30"\n[Start]\n-> [Agent(`x`, timeout: ${secs})]\n[End]\n')).toHaveLength(1);
    });

    it('rejects an undeclared variable as timeout', () => {
        expect(issues('[Start]\n-> [Agent(`x`, timeout: ${secs})]\n[End]\n')).toHaveLength(1);
    });

    it('rejects a timeout template mixed with text', () => {
        expect(issues('@var secs: number = 30\n[Start]\n-> [Agent(`x`, timeout: `${secs}0`)]\n[End]\n')).toHaveLength(
            1,
        );
    });

    it('rejects unknown named arguments', () => {
        expect(issues('[Start]\n-> [Agent(`x`, mode: "fast")]\n[End]\n')).toHaveLength(1);
    });

    it('accepts docker remove flag', () => {
        expect(valid('[Start]\n-> [Docker(`alpine`, `echo hi`, timeout: 10, remove: false)]\n[End]\n')).toBe(true);
    });

    it('rejects too many positional arguments', () => {
        expect(issues('[Start]\n-> [Agent(`a`, `b`)]\n[End]\n')).toHaveLength(1);
    });

    it('rejects select without branches', () => {
        expect(() => parseAts('[Start]\n-> [Select]\n[End]\n', 'task.ats')).toThrow(/Expected indented branches/);
    });

    it('rejects duplicate default branches', () => {
        const source = `[Start]

-> [Select]

    -> [Default]
        -> [Script(\`a\`)]

    -> [Default]
        -> [Script(\`b\`)]

[End]
`;
        expect(issues(source)).toHaveLength(1);
    });

    it('rejects comparing different literal types', () => {
        const source = `[Start]

-> [Select]

    -> [Case(3 == "x")]
        -> [Script(\`a\`)]

    -> [Default]
        -> [Script(\`b\`)]

[End]
`;
        expect(issues(source)).toHaveLength(1);
    });

    it('accepts template to string comparisons', () => {
        const source = `@var depth: select("简版", "详细") = "简版"
[Start]

-> [Select]

    -> [Case(\${depth} == "详细")]
        -> [Script(\`a\`)]

    -> [Default]
        -> [Script(\`b\`)]

[End]
`;
        expect(valid(source)).toBe(true);
    });

    it('rejects order comparisons on non-number variables', () => {
        const source = `@var depth: string = "详细"
[Start]

-> [Select]

    -> [Case(\${depth} >= 3)]
        -> [Script(\`a\`)]

    -> [Default]
        -> [Script(\`b\`)]

[End]
`;
        expect(issues(source)).toHaveLength(1);
    });

    it('rejects order comparisons between literal types', () => {
        const source = `[Start]

-> [Select]

    -> [Case(3 > "x")]
        -> [Script(\`a\`)]

    -> [Default]
        -> [Script(\`b\`)]

[End]
`;
        expect(issues(source)).toHaveLength(1);
    });

    it('reports missing required variables when values are given', () => {
        const source = '@var token: password!\n' + BASE;
        expect(issues(source)).toHaveLength(0);
        expect(issues(source, {})).toHaveLength(1);
    });

    it('reports select values outside options when values are given', () => {
        const source = '@var depth: select("简版", "详细") = "简版"\n' + BASE;
        expect(valid(source, { depth: '其他' })).toBe(false);
        expect(valid(source, { depth: '详细' })).toBe(true);
    });
});
