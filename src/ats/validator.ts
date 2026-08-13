import type { TVariableValue } from '@at/core';

import type {
    TChainNode,
    TExpressionNode,
    TSelectBranch,
    TSelectNode,
    TStepNode,
    TTaskAst,
    TTemplateNode,
    TVariableDeclaration,
} from './ast';
import { EComparisonOperator } from './ast';
import { builtinVariableType, isBuiltinVariable } from './builtins';

export type TValidationIssue = {
    Line: number;
    Column: number;
    Message: string;
};

const stepTypes = new Set(['Script', 'Agent', 'Docker']);

export class Validator {
    private readonly Issues: TValidationIssue[] = [];
    private readonly Variables = new Map<string, TVariableDeclaration>();
    private Values: ReadonlyMap<string, TVariableValue> | undefined;

    public Validate(ast: TTaskAst, values?: ReadonlyMap<string, TVariableValue>): TValidationIssue[] {
        this.Values = values;
        this.ValidateVariables(ast.Variables);
        for (const node of ast.Body) {
            this.ValidateChain(node);
        }
        return this.Issues;
    }

    private ValidateVariables(variables: TVariableDeclaration[]): void {
        for (const declaration of variables) {
            if (isBuiltinVariable(declaration.Name)) {
                this.Report(
                    declaration,
                    `"${declaration.Name}" is a built-in variable and cannot be declared`,
                    'It is provided automatically at run time; rename this variable',
                );
                continue;
            }
            if (this.Variables.has(declaration.Name)) {
                this.Report(
                    declaration,
                    `Duplicate variable "${declaration.Name}"`,
                    `The variable is already declared at line ${this.Variables.get(declaration.Name)?.Line}`,
                );
                continue;
            }
            this.Variables.set(declaration.Name, declaration);
            if (declaration.Type === 'select') {
                const options = declaration.Options ?? [];
                if (options.length === 0) {
                    this.Report(declaration, `Select variable "${declaration.Name}" must list at least one option`);
                }
                if (declaration.DefaultValue !== undefined) {
                    if (typeof declaration.DefaultValue !== 'string' || !options.includes(declaration.DefaultValue)) {
                        this.Report(
                            declaration,
                            `Default value of select variable "${declaration.Name}" must be one of its options`,
                        );
                    }
                }
            }
            this.CheckDefaultType(declaration);
            if (this.Values !== undefined) {
                this.CheckValueAgainstDeclaration(declaration);
            }
        }
    }

    private CheckDefaultType(declaration: TVariableDeclaration): void {
        const value = declaration.DefaultValue;
        if (value === undefined) {
            return;
        }
        const expected = this.TypeKind(declaration.Type);
        if (expected === 'string' && typeof value !== 'string') {
            this.Report(declaration, `Default value of "${declaration.Name}" must be a string`);
        } else if (expected === 'number' && typeof value !== 'number') {
            this.Report(declaration, `Default value of "${declaration.Name}" must be a number`);
        } else if (expected === 'boolean' && typeof value !== 'boolean') {
            this.Report(declaration, `Default value of "${declaration.Name}" must be true or false`);
        }
    }

    private CheckValueAgainstDeclaration(declaration: TVariableDeclaration): void {
        const value = this.Values?.get(declaration.Name);
        if (declaration.Required && value === undefined) {
            this.Report(
                declaration,
                `Required variable "${declaration.Name}" has no value`,
                'Set it in the task config',
            );
            return;
        }
        if (value === undefined) {
            return;
        }
        if (declaration.Type === 'select') {
            const options = declaration.Options ?? [];
            if (typeof value !== 'string' || !options.includes(value)) {
                this.Report(
                    declaration,
                    `Value of select variable "${declaration.Name}" must be one of: ${options.join(', ')}`,
                );
            }
            return;
        }
        const expected = this.TypeKind(declaration.Type);
        if (expected === 'number' && typeof value !== 'number') {
            this.Report(declaration, `Value of "${declaration.Name}" must be a number`);
        } else if (expected === 'boolean' && typeof value !== 'boolean') {
            this.Report(declaration, `Value of "${declaration.Name}" must be true or false`);
        } else if (expected === 'string' && typeof value !== 'string') {
            this.Report(declaration, `Value of "${declaration.Name}" must be a string`);
        }
    }

    private TypeKind(type: TVariableDeclaration['Type']): 'string' | 'number' | 'boolean' {
        if (type === 'number') {
            return 'number';
        }
        if (type === 'boolean') {
            return 'boolean';
        }
        return 'string';
    }

    private ValidateChain(node: TChainNode): void {
        if (node.Kind === 'step') {
            this.ValidateStep(node);
        } else {
            this.ValidateSelect(node);
        }
    }

    private ValidateStep(step: TStepNode): void {
        if (!stepTypes.has(step.StepType)) {
            this.Report(step, `Unknown step type "${step.StepType}"`, 'Use Script, Agent or Docker');
            return;
        }
        const positional = step.Arguments.filter((argument) => argument.Kind === 'positional');
        const named = step.Arguments.filter((argument) => argument.Kind === 'named');
        if (positional.length === 0) {
            this.Report(step, `${step.StepType} step requires a command`);
        }
        const positionalLimit = step.StepType === 'Docker' ? 2 : 1;
        if (positional.length > positionalLimit) {
            this.Report(
                step,
                `${step.StepType} step accepts at most ${positionalLimit} positional argument${positionalLimit > 1 ? 's' : ''}`,
            );
        }
        for (const argument of named) {
            const name = argument.Name ?? '';
            const isValidName = name === 'timeout' || (step.StepType === 'Docker' && name === 'remove');
            if (!isValidName) {
                this.Report(
                    argument,
                    `Unknown argument "${name}" for ${step.StepType} step`,
                    `Supported arguments: ${step.StepType === 'Docker' ? 'timeout, remove' : 'timeout'}`,
                );
            }
        }
        this.CheckTimeout(step);
        for (const argument of step.Arguments) {
            const value = argument.Value;
            if (typeof value === 'object' && value.Kind === 'template') {
                this.CheckTemplates(value);
            }
        }
    }

    // timeout 可以是正数字面量或 number 变量引用——字符串变量要到运行时才发现填不出秒数。
    private CheckTimeout(step: TStepNode): void {
        for (const argument of step.Arguments) {
            if (argument.Kind !== 'named' || argument.Name !== 'timeout') {
                continue;
            }
            const value = argument.Value;
            if (typeof value === 'object' && value.Kind === 'template') {
                this.CheckTimeoutTemplate(value);
                continue;
            }
            if (typeof value !== 'number' || value <= 0) {
                this.Report(
                    argument,
                    `timeout must be a positive number of seconds`,
                    `Got ${JSON.stringify(value)}; use a positive number or a number variable such as \${seconds}`,
                );
            }
        }
    }

    private CheckTimeoutTemplate(node: TTemplateNode): void {
        const variables = node.Segments.filter((segment) => segment.Kind === 'variable');
        if (variables.length !== 1 || node.Segments.length !== 1) {
            this.Report(node, 'timeout must be a single variable reference', 'Write timeout: ${seconds}'); // eslint-disable-line no-template-curly-in-string
            return;
        }
        const root = variables[0]?.Name.split('.')[0];
        const type = this.VariableType(root);
        if (type !== undefined && type !== 'number') {
            this.Report(node, `Variable "${root}" is ${type}; timeout needs a number`);
        }
    }

    private ValidateSelect(select: TSelectNode): void {
        if (select.Branches.length === 0) {
            this.Report(select, '[Select] must contain at least one branch');
        }
        const seen = new Map<string, TSelectBranch>();
        for (const branch of select.Branches) {
            const key = branch.Kind === 'case' ? 'case' : branch.Kind;
            if (seen.has(key)) {
                this.Report(
                    branch,
                    `Duplicate [${branch.Kind === 'case' ? 'Case' : branch.Kind === 'default' ? 'Default' : branch.Kind === 'success' ? 'Success' : 'Failure'}] branch in [Select]`,
                );
            }
            seen.set(key, branch);
            if (branch.Condition !== undefined) {
                this.ValidateExpression(branch.Condition);
            }
            for (const node of branch.Body) {
                this.ValidateChain(node);
            }
        }
    }

    private ValidateExpression(node: TExpressionNode): void {
        switch (node.Kind) {
            case 'literal':
                return;
            case 'template':
                this.CheckTemplates(node.Template);
                return;
            case 'not':
                this.ValidateExpression(node.Operand);
                return;
            case 'binary': {
                this.ValidateExpression(node.Left);
                this.ValidateExpression(node.Right);
                if (node.Operator === EComparisonOperator.Eq || node.Operator === EComparisonOperator.Ne) {
                    this.CheckComparableTypes(node.Left, node.Right);
                }
                if (
                    node.Operator === EComparisonOperator.Gt ||
                    node.Operator === EComparisonOperator.Gte ||
                    node.Operator === EComparisonOperator.Lt ||
                    node.Operator === EComparisonOperator.Lte
                ) {
                    this.CheckOrderableTypes(node.Left, node.Right);
                }
            }
        }
    }

    // 关系运算只对数字有意义；否则引用字符串变量的模板只能拖到运行时才报错。
    private CheckOrderableTypes(left: TExpressionNode, right: TExpressionNode): void {
        this.CheckOrderableOperand(left);
        this.CheckOrderableOperand(right);
        const leftLiteral = this.LiteralType(left);
        const rightLiteral = this.LiteralType(right);
        if (leftLiteral !== undefined && rightLiteral !== undefined && leftLiteral !== rightLiteral) {
            this.Report(right, `Cannot order ${leftLiteral} against ${rightLiteral}`);
        }
    }

    private CheckOrderableOperand(node: TExpressionNode): void {
        if (node.Kind !== 'template') {
            return;
        }
        const variable = node.Template.Segments.find((segment) => segment.Kind === 'variable');
        const root = variable?.Name.split('.')[0];
        const type = this.VariableType(root);
        if (type !== undefined && type !== 'number') {
            this.Report(node, `Variable "${root}" is ${type}; order comparisons need a number`);
        }
    }

    private CheckComparableTypes(left: TExpressionNode, right: TExpressionNode): void {
        const leftType = this.LiteralType(left);
        const rightType = this.LiteralType(right);
        if (leftType !== undefined && rightType !== undefined && leftType !== rightType) {
            this.Report(
                right,
                `Cannot compare ${leftType} with ${rightType}`,
                'Use the same literal types in comparisons',
            );
        }
    }

    private LiteralType(node: TExpressionNode): string | undefined {
        if (node.Kind === 'literal') {
            return typeof node.Value;
        }
        return undefined;
    }

    private CheckTemplates(value: TTemplateNode): void {
        for (const segment of value.Segments) {
            if (segment.Kind === 'variable') {
                const root = segment.Name.split('.')[0] ?? segment.Name;
                if (!this.Variables.has(root) && !isBuiltinVariable(root)) {
                    this.Report(value, `Unknown variable \${${segment.Name}}`, `Declare it with @var ${root}: ...`);
                }
            }
        }
    }

    // 内置变量不出现在 @var 声明里，类型要单独查。
    private VariableType(root: string | undefined): TVariableDeclaration['Type'] | undefined {
        if (root === undefined) {
            return undefined;
        }
        return this.Variables.get(root)?.Type ?? builtinVariableType(root);
    }

    private Report(node: { Line: number; Column: number }, message: string, suggestion?: string): void {
        this.Issues.push({
            Line: node.Line,
            Column: node.Column,
            Message: suggestion === undefined ? message : `${message}. ${suggestion}`,
        });
    }
}

export function validateTaskAst(ast: TTaskAst, values?: ReadonlyMap<string, TVariableValue>): TValidationIssue[] {
    return new Validator().Validate(ast, values);
}
