import { AtExecutionError, type TVariableValue } from '@at/core';

import type { TExpressionNode, TLiteralValue, TTemplateNode } from './ast';
import { EComparisonOperator, ELogicalOperator } from './ast';

export function resolveVariable(
    name: string,
    variables: ReadonlyMap<string, TVariableValue>,
): TVariableValue | undefined {
    const root = name.split('.')[0] ?? name;
    return variables.get(root);
}

export function resolveTemplate(node: TTemplateNode, variables: ReadonlyMap<string, TVariableValue>): string {
    let result = '';
    for (const segment of node.Segments) {
        if (segment.Kind === 'text') {
            result += segment.Text;
        } else {
            const value = resolveVariable(segment.Name, variables);
            result += value === undefined ? '' : String(value);
        }
    }
    return result;
}

function toNumber(value: TLiteralValue): number {
    const number = typeof value === 'number' ? value : Number(value);
    if (Number.isNaN(number)) {
        throw new AtExecutionError(`Cannot use "${String(value)}" as a number`);
    }
    return number;
}

export function truthy(value: TLiteralValue): boolean {
    if (typeof value === 'boolean') {
        return value;
    }
    if (typeof value === 'number') {
        return value !== 0;
    }
    // 模板恒解析为字符串；把字面量 "false" 视为假值，
    // 布尔变量才能在 `!${flag}` 等条件中生效。
    return value !== '' && value.toLowerCase() !== 'false';
}

// 模板求值结果恒为字符串，所以 `Case(${n} == 1)` 需要让数字变量
// 与数字字面量做宽松比较，而不是悄悄失败。
function looseEqual(left: TLiteralValue, right: TLiteralValue): boolean {
    if (left === right) {
        return true;
    }
    if (typeof left === 'number' && typeof right === 'string') {
        const parsed = Number(right);
        return !Number.isNaN(parsed) && left === parsed;
    }
    if (typeof left === 'string' && typeof right === 'number') {
        const parsed = Number(left);
        return !Number.isNaN(parsed) && parsed === right;
    }
    if (typeof left === 'boolean' && typeof right === 'string') {
        return left === (right === 'true');
    }
    if (typeof left === 'string' && typeof right === 'boolean') {
        return (left === 'true') === right;
    }
    return false;
}

export function evaluateExpression(
    node: TExpressionNode,
    variables: ReadonlyMap<string, TVariableValue>,
): TLiteralValue {
    if (node.Kind === 'literal') {
        return node.Value;
    }
    if (node.Kind === 'template') {
        return resolveTemplate(node.Template, variables);
    }
    if (node.Kind === 'not') {
        return !truthy(evaluateExpression(node.Operand, variables));
    }
    if (node.Operator === ELogicalOperator.And) {
        const left = evaluateExpression(node.Left, variables);
        return !truthy(left) ? false : truthy(evaluateExpression(node.Right, variables));
    }
    if (node.Operator === ELogicalOperator.Or) {
        const left = evaluateExpression(node.Left, variables);
        return truthy(left) ? true : truthy(evaluateExpression(node.Right, variables));
    }
    const left = evaluateExpression(node.Left, variables);
    const right = evaluateExpression(node.Right, variables);
    if (node.Operator === EComparisonOperator.Eq) {
        return looseEqual(left, right);
    }
    if (node.Operator === EComparisonOperator.Ne) {
        return !looseEqual(left, right);
    }
    if (node.Operator === EComparisonOperator.Gt) {
        return toNumber(left) > toNumber(right);
    }
    if (node.Operator === EComparisonOperator.Gte) {
        return toNumber(left) >= toNumber(right);
    }
    if (node.Operator === EComparisonOperator.Lt) {
        return toNumber(left) < toNumber(right);
    }
    return toNumber(left) <= toNumber(right);
}
