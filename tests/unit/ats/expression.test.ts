import { evaluateExpression, parseAts, type TExpressionNode } from '@at/ats';
import { describe, expect, it } from 'vitest';

function caseCondition(source: string): TExpressionNode | undefined {
    const ast = parseAts(source, 'task.ats');
    const select = ast.Body[0];
    if (select === undefined || select.Kind !== 'select') {
        return undefined;
    }
    return select.Branches[0]?.Condition;
}

describe('expression precedence', () => {
    it('&& binds tighter than ||', () => {
        const expr = caseCondition(`[Start]
-> [Select]
    -> [Case(\${a} == 1 || \${b} == 2 && \${c} == 3)]
        -> [Script(\`x\`)]
    -> [Default]
        -> [Script(\`y\`)]
[End]
`);
        expect(expr?.Kind).toBe('binary');
        if (expr?.Kind === 'binary') {
            expect(expr.Operator).toBe('||');
            expect(expr.Right.Kind).toBe('binary');
        }
    });

    it('evaluates || short-circuit semantics', () => {
        const expr = caseCondition(`@var a: number = 1
@var b: number = 2
[Start]
-> [Select]
    -> [Case(\${a} == 1 || \${b} == 2)]
        -> [Script(\`x\`)]
    -> [Default]
        -> [Script(\`y\`)]
[End]
`);
        const vars = new Map<string, string | number | boolean>([
            ['a', 1],
            ['b', 2],
        ]);
        const result = evaluateExpression(expr!, vars);
        expect(result).toBe(true);
    });

    it('compares number variables against numeric literals', () => {
        const expr = caseCondition(`@var n: number = 1
[Start]
-> [Select]
    -> [Case(\${n} == 1)]
        -> [Script(\`x\`)]
    -> [Default]
        -> [Script(\`y\`)]
[End]
`);
        const result = evaluateExpression(expr!, new Map<string, string | number | boolean>([['n', 1]]));
        expect(result).toBe(true);
    });

    it('compares boolean variables against true/false literals', () => {
        const expr = caseCondition(`@var flag: boolean = true
[Start]
-> [Select]
    -> [Case(\${flag} == true)]
        -> [Script(\`x\`)]
    -> [Default]
        -> [Script(\`y\`)]
[End]
`);
        const result = evaluateExpression(expr!, new Map<string, string | number | boolean>([['flag', true]]));
        expect(result).toBe(true);
    });

    it('parses parenthesized expressions', () => {
        const expr = caseCondition(`[Start]
-> [Select]
    -> [Case((\${a} == 1 || \${b} == 2) && \${c} == 3)]
        -> [Script(\`x\`)]
    -> [Default]
        -> [Script(\`y\`)]
[End]
`);
        expect(expr?.Kind).toBe('binary');
        if (expr?.Kind === 'binary') {
            expect(expr.Operator).toBe('&&');
        }
    });

    it('evaluates not with &&', () => {
        const expr = caseCondition(`@var a: boolean = false
@var b: number = 1
[Start]
-> [Select]
    -> [Case(!\${a} && \${b} == 1)]
        -> [Script(\`x\`)]
    -> [Default]
        -> [Script(\`y\`)]
[End]
`);
        const result = evaluateExpression(
            expr!,
            new Map<string, string | number | boolean>([
                ['a', false],
                ['b', 1],
            ]),
        );
        expect(result).toBe(true);
        const result2 = evaluateExpression(
            expr!,
            new Map<string, string | number | boolean>([
                ['a', true],
                ['b', 1],
            ]),
        );
        expect(result2).toBe(false);
    });
});
