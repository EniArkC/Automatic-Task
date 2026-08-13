import {
    EComparisonOperator,
    ELogicalOperator,
    evaluateExpression,
    parseTemplate,
    resolveTemplate,
    type TExpressionNode,
} from '@at/ats';
import { describe, expect, it } from 'vitest';

function variables(record: Record<string, string | number | boolean>): ReadonlyMap<string, string | number | boolean> {
    return new Map(Object.entries(record));
}

function templateExpression(raw: string): TExpressionNode {
    return { Kind: 'template', Template: parseTemplate(raw, 1, 1, 'task.ats'), Line: 1, Column: 1 };
}

function literal(value: string | number | boolean): TExpressionNode {
    return { Kind: 'literal', Value: value, Line: 1, Column: 1 };
}

function binary(
    operator: EComparisonOperator | ELogicalOperator,
    left: TExpressionNode,
    right: TExpressionNode,
): TExpressionNode {
    return { Kind: 'binary', Operator: operator, Left: left, Right: right, Line: 1, Column: 1 };
}

function notNode(operand: TExpressionNode): TExpressionNode {
    return { Kind: 'not', Operand: operand, Line: 1, Column: 1 };
}

describe('template', () => {
    it('parses plain text templates', () => {
        const node = parseTemplate('scripts/fetch.bat', 1, 1, 'task.ats');
        expect(node.Segments).toEqual([{ Kind: 'text', Text: 'scripts/fetch.bat' }]);
    });

    it('parses variable references', () => {
        const node = parseTemplate('hello ${city} and ${depth}', 1, 1, 'task.ats');
        expect(node.Segments).toEqual([
            { Kind: 'text', Text: 'hello ' },
            { Kind: 'variable', Name: 'city' },
            { Kind: 'text', Text: ' and ' },
            { Kind: 'variable', Name: 'depth' },
        ]);
    });

    it('resolves variables to strings', () => {
        const node = parseTemplate('fetch ${city} depth=${depth}', 1, 1, 'task.ats');
        expect(resolveTemplate(node, variables({ city: '上海', depth: '详细' }))).toBe('fetch 上海 depth=详细');
    });
});

describe('expression evaluation', () => {
    it('evaluates equality against templates', () => {
        const expression = binary(EComparisonOperator.Eq, templateExpression('${depth}'), literal('详细'));
        expect(evaluateExpression(expression, variables({ depth: '详细' }))).toBe(true);
        expect(evaluateExpression(expression, variables({ depth: '简版' }))).toBe(false);
    });

    it('evaluates numeric comparisons', () => {
        const expression = binary(EComparisonOperator.Gte, literal(3), literal(2));
        expect(evaluateExpression(expression, variables({}))).toBe(true);
    });

    it('evaluates logical operators', () => {
        const expression = binary(ELogicalOperator.And, literal(true), literal(false));
        expect(evaluateExpression(expression, variables({}))).toBe(false);
    });

    it('evaluates not', () => {
        const expression = notNode(literal(true));
        expect(evaluateExpression(expression, variables({}))).toBe(false);
    });
});
