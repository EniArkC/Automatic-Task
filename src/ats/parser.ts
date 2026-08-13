import { AtParseError } from '@at/core';

import type {
    TChainNode,
    TExpressionNode,
    TLiteralValue,
    TSelectBranch,
    TSelectNode,
    TStepArgument,
    TStepNode,
    TTaskAst,
    TVariableDeclaration,
} from './ast';
import { EComparisonOperator, ELogicalOperator } from './ast';
import { Lexer } from './lexer';
import { parseTemplate } from './template';
import { ETokenType, type TToken, variableNamePattern } from './tokens';

const stepTypes = new Set(['Script', 'Agent', 'Docker']);
const stringTypes = new Set(['string', 'text', 'password', 'path']);
const booleanLiterals: Record<string, boolean> = { true: true, false: false };

export class Parser {
    private readonly Source: string;
    private readonly File: string;
    private Tokens: TToken[] = [];
    private Index = 0;
    private readonly SourceLines: string[];

    public constructor(source: string, file: string) {
        this.Source = source;
        this.File = file;
        this.SourceLines = source.split('\n');
    }

    public Parse(): TTaskAst {
        this.Tokens = new Lexer(this.Source, this.File).Tokenize();
        this.Index = 0;
        this.SkipSeparators();
        const variables: TVariableDeclaration[] = [];
        while (this.Peek().Type === ETokenType.AtVar) {
            variables.push(this.ParseVariable());
            this.SkipSeparators();
        }
        this.Expect(ETokenType.Lbracket, 'Expected [Start] to open the task');
        this.Expect(ETokenType.Start, 'Expected [Start] to open the task');
        this.Expect(ETokenType.Rbracket, 'Expected ] after Start');
        this.SkipSeparators();
        const body = this.ParseChain();
        if (this.Peek().Type === ETokenType.Lbracket && this.Peek(1).Type === ETokenType.Start) {
            this.Error(this.Peek(1), 'Duplicate [Start] is not allowed', 'Each task has exactly one [Start]');
        }
        this.Expect(ETokenType.Lbracket, 'Expected [End] to close the task');
        this.Expect(ETokenType.End, 'Expected [End] to close the task');
        this.Expect(ETokenType.Rbracket, 'Expected ] after End');
        this.SkipSeparators();
        if (this.Peek().Type !== ETokenType.Eof) {
            this.Error(this.Peek(), `Unexpected ${this.Describe(this.Peek())} after [End]`);
        }
        return { Variables: variables, Body: body };
    }

    private ParseVariable(): TVariableDeclaration {
        const atVar = this.Advance();
        this.Expect(ETokenType.Ident, 'Expected a variable name after @var');
        const nameToken = this.Previous();
        const name = nameToken.Value;
        // 模板只接受 variableNamePattern（[a-zA-Z_][a-zA-Z0-9_]*），
        // 含连字符的名字在模板中无法声明引用。
        if (!variableNamePattern.test(name)) {
            this.Error(nameToken, `Invalid variable name "${name}"`, 'Variable names use [a-zA-Z_][a-zA-Z0-9_]*');
        }
        this.Expect(ETokenType.Colon, `Expected ':' after variable name "${name}"`);
        this.Expect(ETokenType.Ident, 'Expected a variable type after the colon');
        const typeToken = this.Previous();
        const typeResult = this.ParseVariableType(typeToken);
        let required = false;
        let defaultValue: TLiteralValue | undefined;
        if (this.Peek().Type === ETokenType.Exclamation) {
            required = true;
            this.Advance();
        }
        if (this.Peek().Type === ETokenType.Assign) {
            this.Advance();
            defaultValue = this.ParseLiteral();
        }
        // 声明行尾的注释就是这个参数的说明。词法层只在行中产出 Comment（整行注释到不了这里），
        // 所以「紧跟在声明之后」等价于「与 @var 同一行」。空注释（`#` 后无字符）不算说明。
        let description: string | undefined;
        if (this.Peek().Type === ETokenType.Comment) {
            const text = this.Advance().Value;
            description = text === '' ? undefined : text;
        }
        return {
            Name: name,
            Type: typeResult.Type,
            Required: required,
            DefaultValue: defaultValue,
            Options: typeResult.Options,
            Description: description,
            Line: atVar.Line,
            Column: atVar.Column,
        };
    }

    private ParseVariableType(typeToken: TToken): { Type: TVariableDeclaration['Type']; Options?: string[] } {
        const value = typeToken.Value;
        if (stringTypes.has(value) || value === 'number' || value === 'boolean') {
            return { Type: value as TVariableDeclaration['Type'] };
        }
        if (value === 'select') {
            this.Expect(ETokenType.Lparen, `Expected '(' after select`);
            const options = this.ParseSelectOptions(typeToken.Line, typeToken.Column);
            return { Type: 'select', Options: options };
        }
        return this.Error(
            typeToken,
            `Unknown variable type "${value}"`,
            'Use string, text, password, number, boolean, path or select',
        );
    }

    private ParseSelectOptions(line: number, column: number): string[] {
        const options: string[] = [];
        this.Expect(ETokenType.String, 'Expected a string option in select');
        options.push(this.Previous().Value);
        while (this.Peek().Type === ETokenType.Comma) {
            this.Advance();
            this.Expect(ETokenType.String, 'Expected a string option after the comma');
            options.push(this.Previous().Value);
        }
        this.Expect(ETokenType.Rparen, `Expected ')' to close select options`);
        return options;
    }

    private ParseLiteral(): TLiteralValue {
        const token = this.Peek();
        switch (token.Type) {
            case ETokenType.String:
                this.Advance();
                return token.Value;
            case ETokenType.Number: {
                this.Advance();
                const value = Number(token.Value);
                if (Number.isNaN(value)) {
                    this.Error(token, `Invalid number "${token.Value}"`);
                }
                return value;
            }
            case ETokenType.Boolean:
                this.Advance();
                return booleanLiterals[token.Value] ?? false;
            default:
                return this.Error(token, `Expected a literal value, found ${this.Describe(token)}`);
        }
    }

    private ParseChain(): TChainNode[] {
        const chain: TChainNode[] = [];
        this.SkipSeparators();
        while (this.Peek().Type === ETokenType.Arrow) {
            chain.push(this.ParseStep());
            this.SkipSeparators();
        }
        return chain;
    }

    private ParseStep(): TChainNode {
        this.Expect(ETokenType.Arrow, 'Expected ->');
        this.Expect(ETokenType.Lbracket, 'Expected [ after ->');
        const token = this.Peek();
        switch (token.Type) {
            case ETokenType.Select:
                this.Advance();
                this.Expect(ETokenType.Rbracket, 'Expected ] after Select');
                return this.ParseSelectBody(token.Line, token.Column);
            case ETokenType.Ident: {
                if (!stepTypes.has(token.Value)) {
                    this.Error(token, `Unknown step type "${token.Value}"`, 'Use Script, Agent or Docker');
                }
                this.Advance();
                return this.ParseStepBody(token);
            }
            case ETokenType.Start:
                return this.Error(token, 'Duplicate [Start] is not allowed', 'Each task has exactly one [Start]');
            case ETokenType.End:
                return this.Error(token, 'Unexpected [End] inside the task body');
            case ETokenType.Success:
            case ETokenType.Failure:
            case ETokenType.Default:
            case ETokenType.Case:
                return this.Error(token, `[${token.Value}] is only allowed inside a [Select] block`);
            default:
                return this.Error(token, `Expected a step, found ${this.Describe(token)}`);
        }
    }

    private ParseStepBody(typeToken: TToken): TStepNode {
        this.Expect(ETokenType.Lparen, `Expected '(' after ${typeToken.Value}`);
        const argumentsList: TStepArgument[] = [];
        while (this.Peek().Type !== ETokenType.Rparen) {
            argumentsList.push(this.ParseStepArgument());
            if (this.Peek().Type === ETokenType.Comma) {
                this.Advance();
            } else if (this.Peek().Type !== ETokenType.Rparen) {
                this.Error(this.Peek(), `Expected ',' or ')' in ${typeToken.Value} arguments`);
            }
        }
        this.Expect(ETokenType.Rparen, `Expected ')' to close ${typeToken.Value} arguments`);
        this.Expect(ETokenType.Rbracket, `Expected ']' after ${typeToken.Value} arguments`);
        return {
            Kind: 'step',
            StepType: typeToken.Value as TStepNode['StepType'],
            Arguments: argumentsList,
            Line: typeToken.Line,
            Column: typeToken.Column,
        };
    }

    private ParseStepArgument(): TStepArgument {
        const token = this.Peek();
        if (token.Type === ETokenType.Ident) {
            const next = this.Peek(1);
            if (next.Type === ETokenType.Colon) {
                this.Advance();
                this.Advance();
                const value = this.ParseArgumentValue();
                return { Kind: 'named', Name: token.Value, Value: value, Line: token.Line, Column: token.Column };
            }
            this.Error(token, `Expected ':' after argument name "${token.Value}"`);
        }
        const value = this.ParseArgumentValue();
        return { Kind: 'positional', Value: value, Line: token.Line, Column: token.Column };
    }

    private ParseArgumentValue(): TStepArgument['Value'] {
        const token = this.Peek();
        if (token.Type === ETokenType.Template) {
            this.Advance();
            return parseTemplate(token.Value, token.Line, token.Column, this.File);
        }
        return this.ParseLiteral();
    }

    private ParseSelectBody(line: number, column: number): TSelectNode {
        this.Expect(ETokenType.Newline, `Expected a newline after [Select]`);
        this.SkipNewlines();
        this.Expect(ETokenType.Indent, 'Expected indented branches after [Select]');
        const branches: TSelectBranch[] = [];
        while (this.Peek().Type === ETokenType.Arrow) {
            branches.push(this.ParseBranch());
            this.SkipSeparators();
        }
        if (branches.length === 0) {
            this.Error(this.Peek(), '[Select] must contain at least one branch');
        }
        this.Expect(ETokenType.Dedent, 'Expected the Select block to be closed');
        return { Kind: 'select', Branches: branches, Line: line, Column: column };
    }

    private ParseBranch(): TSelectBranch {
        this.Expect(ETokenType.Arrow, 'Expected -> before the branch');
        this.Expect(ETokenType.Lbracket, 'Expected [ after ->');
        const token = this.Peek();
        let kind: TSelectBranch['Kind'];
        switch (token.Type) {
            case ETokenType.Success:
                kind = 'success';
                break;
            case ETokenType.Failure:
                kind = 'failure';
                break;
            case ETokenType.Default:
                kind = 'default';
                break;
            case ETokenType.Case:
                kind = 'case';
                break;
            default:
                this.Error(token, `Expected Success, Failure, Case or Default branch, found ${this.Describe(token)}`);
        }
        this.Advance();
        let condition: TExpressionNode | undefined;
        if (kind === 'case') {
            this.Expect(ETokenType.Lparen, 'Expected ( after Case');
            condition = this.ParseExpression();
            this.Expect(ETokenType.Rparen, 'Expected ) to close the Case condition');
        }
        this.Expect(ETokenType.Rbracket, 'Expected ] after the branch type');
        this.Expect(ETokenType.Newline, 'Expected a newline after the branch header');
        this.SkipNewlines();
        this.Expect(ETokenType.Indent, 'Expected indented steps inside the branch');
        const body = this.ParseChain();
        if (body.length === 0) {
            this.Error(token, 'Branch body must contain at least one step');
        }
        this.Expect(ETokenType.Dedent, 'Expected the branch body to be closed');
        return { Kind: kind, Condition: condition, Body: body, Line: token.Line, Column: token.Column };
    }

    private ParseExpression(): TExpressionNode {
        return this.ParseOr();
    }

    private ParseOr(): TExpressionNode {
        let node = this.ParseAnd();
        while (this.Peek().Type === ETokenType.Or) {
            const operator = this.Advance();
            const right = this.ParseAnd();
            node = {
                Kind: 'binary',
                Operator: ELogicalOperator.Or,
                Left: node,
                Right: right,
                Line: operator.Line,
                Column: operator.Column,
            };
        }
        return node;
    }

    private ParseAnd(): TExpressionNode {
        let node = this.ParseNot();
        while (this.Peek().Type === ETokenType.And) {
            const operator = this.Advance();
            const right = this.ParseNot();
            node = {
                Kind: 'binary',
                Operator: ELogicalOperator.And,
                Left: node,
                Right: right,
                Line: operator.Line,
                Column: operator.Column,
            };
        }
        return node;
    }

    private ParseNot(): TExpressionNode {
        if (this.Peek().Type === ETokenType.Exclamation) {
            const operator = this.Advance();
            return { Kind: 'not', Operand: this.ParseNot(), Line: operator.Line, Column: operator.Column };
        }
        return this.ParseComparison();
    }

    private ParseComparison(): TExpressionNode {
        const left = this.ParseOperand();
        const token = this.Peek();
        let operator: EComparisonOperator | undefined;
        switch (token.Type) {
            case ETokenType.OpEq:
                operator = EComparisonOperator.Eq;
                break;
            case ETokenType.OpNe:
                operator = EComparisonOperator.Ne;
                break;
            case ETokenType.OpGt:
                operator = EComparisonOperator.Gt;
                break;
            case ETokenType.OpGte:
                operator = EComparisonOperator.Gte;
                break;
            case ETokenType.OpLt:
                operator = EComparisonOperator.Lt;
                break;
            case ETokenType.OpLte:
                operator = EComparisonOperator.Lte;
                break;
            default:
                return left;
        }
        this.Advance();
        const right = this.ParseOperand();
        return { Kind: 'binary', Operator: operator, Left: left, Right: right, Line: token.Line, Column: token.Column };
    }

    private ParseOperand(): TExpressionNode {
        const token = this.Peek();
        switch (token.Type) {
            case ETokenType.Template:
                this.Advance();
                return {
                    Kind: 'template',
                    Template: parseTemplate(token.Value, token.Line, token.Column, this.File),
                    Line: token.Line,
                    Column: token.Column,
                };
            case ETokenType.String:
            case ETokenType.Number:
            case ETokenType.Boolean: {
                const value = this.ParseLiteral();
                return { Kind: 'literal', Value: value, Line: token.Line, Column: token.Column };
            }
            case ETokenType.Lparen: {
                this.Advance();
                const inner = this.ParseExpression();
                this.Expect(ETokenType.Rparen, 'Expected ) to close the expression');
                return inner;
            }
            default:
                return this.Error(token, `Expected a value in the expression, found ${this.Describe(token)}`);
        }
    }

    private SkipSeparators(): void {
        while (true) {
            const type = this.Peek().Type;
            if (type === ETokenType.Newline || type === ETokenType.Comment) {
                this.Advance();
            } else {
                return;
            }
        }
    }

    private SkipNewlines(): void {
        while (this.Peek().Type === ETokenType.Newline) {
            this.Advance();
        }
    }

    private Peek(offset = 0): TToken {
        const token = this.Tokens[this.Index + offset];
        if (token === undefined) {
            const last = this.Tokens[this.Tokens.length - 1];
            return last ?? { Type: ETokenType.Eof, Value: '', Line: 1, Column: 1 };
        }
        return token;
    }

    private Advance(): TToken {
        const token = this.Peek();
        this.Index++;
        return token;
    }

    private Previous(): TToken {
        const token = this.Tokens[this.Index - 1];
        return token ?? this.Tokens[0] ?? { Type: ETokenType.Eof, Value: '', Line: 1, Column: 1 };
    }

    private Expect(type: ETokenType, message: string): TToken {
        const token = this.Peek();
        if (token.Type !== type) {
            this.Error(token, message);
        }
        return this.Advance();
    }

    private Describe(token: TToken): string {
        if (token.Type === ETokenType.Eof) {
            return 'end of file';
        }
        return `'${token.Value}'`;
    }

    private Error(token: TToken, message: string, suggestion?: string): never {
        const lineText = this.SourceLines[token.Line - 1] ?? '';
        const firstTokenLine = token.Line;
        throw new AtParseError({
            File: this.File,
            Line: firstTokenLine,
            Column: token.Column,
            Message: message,
            Snippet: lineText,
            Suggestion: suggestion,
        });
    }
}
