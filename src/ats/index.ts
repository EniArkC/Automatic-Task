import { AtValidationError, type TVariableValue } from '@at/core';

import { Parser } from './parser';
import { type TValidationIssue, validateTaskAst } from './validator';

export * from './ast';
export * from './builtins';
export * from './lexer';
export * from './parser';
export * from './runtime';
export * from './template';
export * from './tokens';
export * from './validator';

export function parseAts(source: string, file: string): ReturnType<Parser['Parse']> {
    return new Parser(source, file).Parse();
}

function fileLine(issue: TValidationIssue): string {
    return `line ${issue.Line}:${issue.Column}`;
}

export function formatIssues(issues: TValidationIssue[]): string[] {
    return issues.map((issue) => `${fileLine(issue)} ${issue.Message}`);
}

// 完整流水线：词法、语法、校验，失败时抛出单一可操作的错误。
export function validateAts(
    source: string,
    file: string,
    values?: ReadonlyMap<string, TVariableValue>,
): ReturnType<Parser['Parse']> {
    const ast = new Parser(source, file).Parse();
    const issues = validateTaskAst(ast, values);
    if (issues.length > 0) {
        throw new AtValidationError(`Invalid task script "${file}"`, formatIssues(issues));
    }
    return ast;
}
