import { AtParseError } from '@at/core';

import { ETokenType, keywordTokenType, type TToken } from './tokens';

const whitespacePattern = /[ \t]/;
const identStartPattern = /[a-zA-Z_]/;
const identContinuePattern = /[a-zA-Z0-9_-]/;
const digitPattern = /[0-9]/;

export class Lexer {
    private readonly Source: string;
    private readonly File: string;
    private Position = 0;
    private Line = 1;
    private Column = 1;
    private readonly Tokens: TToken[] = [];
    private readonly IndentStack: number[] = [0];
    private AtLineStart = true;

    public constructor(source: string, file: string) {
        this.Source = source;
        this.File = file;
    }

    public Tokenize(): TToken[] {
        while (this.Position < this.Source.length) {
            if (this.AtLineStart) {
                this.HandleLineStart();
                if (this.AtLineStart) {
                    continue;
                }
            }
            this.ScanToken();
        }
        this.CloseLine();
        while (this.IndentStack.length > 1) {
            this.IndentStack.pop();
            this.Emit(ETokenType.Dedent, '');
        }
        this.Emit(ETokenType.Eof, '');
        return this.Tokens;
    }

    private HandleLineStart(): void {
        const indentStart = this.Position;
        let indent = 0;
        while (this.Position < this.Source.length) {
            const char = this.Peek();
            if (char === ' ') {
                indent++;
                this.Advance();
            } else if (char === '\t') {
                this.Fail(
                    `Tab characters are not allowed for indentation at column ${indent + 1}`,
                    'Use spaces for indentation.',
                );
            } else {
                break;
            }
        }
        const rest = this.Peek();
        const restAfter = this.Peek(1);
        const isBlank = rest === '\n' || (rest === '\r' && restAfter === '\n') || rest === '';
        const isComment = rest === '/' && restAfter === '/';
        const isHash = rest === '#';
        if (isBlank || isComment) {
            // 空行和纯注释行不改变缩进层级。
            this.Position = indentStart;
            this.Column = 1;
            this.ScanLineEnd();
            return;
        }
        if (isHash) {
            // `#` 只允许作为 @var 行尾的参数说明，独立成行的 `#` 注释已废弃。
            this.Fail(`'#' is only allowed as the trailing description on an @var line`, `Use '//' for comments`);
        }
        const top = this.IndentStack[this.IndentStack.length - 1] ?? 0;
        this.AtLineStart = false;
        if (indent === top) {
            return;
        }
        if (indent > top) {
            this.IndentStack.push(indent);
            this.Emit(ETokenType.Indent, '');
            return;
        }
        while (this.IndentStack.length > 1) {
            this.IndentStack.pop();
            this.Emit(ETokenType.Dedent, '');
            if ((this.IndentStack[this.IndentStack.length - 1] ?? 0) === indent) {
                return;
            }
        }
        this.Fail(`Unexpected indentation of ${indent} columns`);
    }

    private ScanToken(): void {
        const char = this.Peek();
        if (char === '\n' || (char === '\r' && this.Peek(1) === '\n')) {
            this.ScanLineEnd();
            return;
        }
        if (whitespacePattern.test(char)) {
            this.Advance();
            return;
        }
        if (char === '/') {
            if (this.Peek(1) === '/') {
                this.ScanComment();
            } else {
                this.Fail(`Unexpected '/'`, `Use '//' for comments`);
            }
            return;
        }
        if (char === '#') {
            this.ScanDescription();
            return;
        }
        if (char === '"') {
            this.ScanString();
            return;
        }
        if (char === '`') {
            this.ScanTemplate();
            return;
        }
        if (char === '@') {
            this.ScanAtVar();
            return;
        }
        if (char === '$' && this.Peek(1) === '{') {
            this.ScanBareTemplate();
            return;
        }
        if (char === '-' && this.Peek(1) === '>') {
            const startColumn = this.Column;
            this.Advance();
            this.Advance();
            this.Emit(ETokenType.Arrow, '->', startColumn);
            return;
        }
        if (digitPattern.test(char)) {
            this.ScanNumber();
            return;
        }
        if (identStartPattern.test(char)) {
            this.ScanIdent();
            return;
        }
        switch (char) {
            case '[':
                this.Advance();
                this.Emit(ETokenType.Lbracket, '[', this.Column - 1);
                return;
            case ']':
                this.Advance();
                this.Emit(ETokenType.Rbracket, ']', this.Column - 1);
                return;
            case '(':
                this.Advance();
                this.Emit(ETokenType.Lparen, '(', this.Column - 1);
                return;
            case ')':
                this.Advance();
                this.Emit(ETokenType.Rparen, ')', this.Column - 1);
                return;
            case ':':
                this.Advance();
                this.Emit(ETokenType.Colon, ':', this.Column - 1);
                return;
            case ',':
                this.Advance();
                this.Emit(ETokenType.Comma, ',', this.Column - 1);
                return;
            case '!':
                this.Advance();
                if (this.Peek() === '=') {
                    const startColumn = this.Column - 1;
                    this.Advance();
                    this.Emit(ETokenType.OpNe, '!=', startColumn);
                } else {
                    this.Emit(ETokenType.Exclamation, '!', this.Column - 1);
                }
                return;
            case '=':
                this.Advance();
                if (this.Peek() === '=') {
                    const startColumn = this.Column - 1;
                    this.Advance();
                    this.Emit(ETokenType.OpEq, '==', startColumn);
                } else {
                    this.Emit(ETokenType.Assign, '=', this.Column - 1);
                }
                return;
            case '>':
                this.Advance();
                if (this.Peek() === '=') {
                    const startColumn = this.Column - 1;
                    this.Advance();
                    this.Emit(ETokenType.OpGte, '>=', startColumn);
                } else {
                    this.Emit(ETokenType.OpGt, '>', this.Column - 1);
                }
                return;
            case '<':
                this.Advance();
                if (this.Peek() === '=') {
                    const startColumn = this.Column - 1;
                    this.Advance();
                    this.Emit(ETokenType.OpLte, '<=', startColumn);
                } else {
                    this.Emit(ETokenType.OpLt, '<', this.Column - 1);
                }
                return;
            case '&':
                this.Advance();
                if (this.Peek() === '&') {
                    const startColumn = this.Column - 1;
                    this.Advance();
                    this.Emit(ETokenType.And, '&&', startColumn);
                } else {
                    this.Fail(`Unexpected '&'; use '&&' for logical and`);
                }
                return;
            case '|':
                this.Advance();
                if (this.Peek() === '|') {
                    const startColumn = this.Column - 1;
                    this.Advance();
                    this.Emit(ETokenType.Or, '||', startColumn);
                } else {
                    this.Fail(`Unexpected '|'; use '||' for logical or`);
                }
                return;
            default:
                this.Fail(`Unexpected character '${char}'`);
        }
    }

    private ScanAtVar(): void {
        const startColumn = this.Column;
        this.Advance();
        for (const expectedChar of 'var') {
            if (this.Peek() !== expectedChar) {
                this.Fail(`Expected '@var' to declare a variable`);
            }
            this.Advance();
        }
        this.Emit(ETokenType.AtVar, '@var', startColumn);
    }

    private ScanIdent(): void {
        const start = this.Position;
        const startColumn = this.Column;
        while (identContinuePattern.test(this.Peek())) {
            this.Advance();
        }
        const value = this.Source.slice(start, this.Position);
        const keyword = keywordTokenType(value);
        if (keyword !== undefined) {
            this.Emit(keyword, value, startColumn);
        } else if (value === 'true' || value === 'false') {
            this.Emit(ETokenType.Boolean, value, startColumn);
        } else {
            this.Emit(ETokenType.Ident, value, startColumn);
        }
    }

    private ScanNumber(): void {
        const start = this.Position;
        const startColumn = this.Column;
        while (digitPattern.test(this.Peek())) {
            this.Advance();
        }
        if (this.Peek() === '.' && digitPattern.test(this.Peek(1))) {
            this.Advance();
            while (digitPattern.test(this.Peek())) {
                this.Advance();
            }
        }
        this.Emit(ETokenType.Number, this.Source.slice(start, this.Position), startColumn);
    }

    private ScanString(): void {
        const startLine = this.Line;
        const startColumn = this.Column;
        this.Advance();
        let value = '';
        while (true) {
            const char = this.Peek();
            if (char === '') {
                this.Fail('Unterminated string literal', 'Close the string with "', startLine, startColumn);
            }
            if (char === '"') {
                this.Advance();
                break;
            }
            if (char === '\\') {
                this.Advance();
                const escaped = this.Peek();
                this.Advance();
                switch (escaped) {
                    case 'n':
                        value += '\n';
                        break;
                    case 't':
                        value += '\t';
                        break;
                    case 'r':
                        value += '\r';
                        break;
                    case '"':
                        value += '"';
                        break;
                    case '\\':
                        value += '\\';
                        break;
                    case '':
                        this.Fail('Unterminated string literal', 'Close the string with "', startLine, startColumn);
                        break;
                    default:
                        this.Fail(`Invalid escape sequence '\\${escaped}'`, undefined, startLine, startColumn);
                }
                continue;
            }
            value += char;
            this.Advance();
        }
        this.Emit(ETokenType.String, value, startColumn);
    }

    private ScanTemplate(): void {
        const startLine = this.Line;
        const startColumn = this.Column;
        this.Advance();
        let value = '';
        let braces = 0;
        while (true) {
            const char = this.Peek();
            if (char === '') {
                this.Fail('Unterminated template literal', 'Close the template with `', startLine, startColumn);
            }
            if (char === '`' && braces === 0) {
                this.Advance();
                break;
            }
            if (char === '$' && this.Peek(1) === '{') {
                braces++;
                value += char;
                this.Advance();
                value += this.Peek();
                this.Advance();
                continue;
            }
            if (char === '}' && braces > 0) {
                braces--;
            }
            value += char;
            this.Advance();
        }
        this.Emit(ETokenType.Template, value, startColumn);
    }

    private ScanBareTemplate(): void {
        // `Case(${depth} == "详细")` 使用无反引号的裸模板。
        const startColumn = this.Column;
        const start = this.Position;
        this.Advance();
        this.Advance();
        let braces = 1;
        while (braces > 0 && this.Position < this.Source.length) {
            const char = this.Peek();
            if (char === '}') {
                braces--;
            } else if (char === '\n' || char === '\r') {
                this.Fail('Unterminated variable expression', 'Close the expression with }', this.Line, this.Column);
            }
            this.Advance();
        }
        if (braces > 0) {
            this.Fail('Unterminated variable expression', 'Close the expression with }', this.Line, this.Column);
        }
        this.Emit(ETokenType.Template, this.Source.slice(start, this.Position), startColumn);
    }

    // `//` 行尾注释。整行 `//` 注释在 HandleLineStart 就被吞掉，这里的都是行中注释，
    // parser 用 SkipSeparators 跳过，永远不会成为 @var 的参数说明。
    private ScanComment(): void {
        // 跳过两个 '/'，文本从它们之后开始。
        this.Advance();
        this.Advance();
        const start = this.Position;
        while (this.Position < this.Source.length && this.Peek() !== '\n') {
            this.Advance();
        }
        // 剔除 CRLF 的 '\r'。
        this.Emit(ETokenType.Comment, this.Source.slice(start, this.Position).replace(/\r$/, '').trim());
    }

    // `#` 只作为 @var 行尾的参数说明出现（TUI 配置界面直接显示）。
    // 独立成行的 `#` 在 HandleLineStart 已被拦截报错，所以能到这里的
    // `#` 必然位于行中；parser 只在紧跟 @var 声明处消费 Description。
    private ScanDescription(): void {
        this.Advance();
        const start = this.Position;
        while (this.Position < this.Source.length && this.Peek() !== '\n') {
            this.Advance();
        }
        this.Emit(ETokenType.Description, this.Source.slice(start, this.Position).replace(/\r$/, '').trim());
    }

    private ScanLineEnd(): void {
        while (this.Position < this.Source.length) {
            const char = this.Peek();
            if (char === '\n') {
                this.Advance();
                break;
            }
            if (char === '\r' && this.Peek(1) === '\n') {
                this.Advance();
                this.Advance();
                break;
            }
            if (char === '\r') {
                this.Advance();
                continue;
            }
            this.Advance();
        }
        this.Emit(ETokenType.Newline, '\n');
        this.AtLineStart = true;
    }

    private CloseLine(): void {
        if (this.Tokens.length === 0 || this.Tokens[this.Tokens.length - 1]?.Type !== ETokenType.Newline) {
            this.Emit(ETokenType.Newline, '\n');
        }
    }

    private Emit(type: ETokenType, value: string, column?: number): void {
        this.Tokens.push({ Type: type, Value: value, Line: this.Line, Column: column ?? this.Column });
    }

    private Peek(offset = 0): string {
        return this.Source[this.Position + offset] ?? '';
    }

    private Advance(): void {
        const char = this.Source[this.Position];
        this.Position++;
        if (char === '\n') {
            this.Line++;
            this.Column = 1;
        } else {
            this.Column++;
        }
    }

    private Fail(message: string, suggestion?: string, line?: number, column?: number): never {
        throw new AtParseError({
            File: this.File,
            Line: line ?? this.Line,
            Column: column ?? this.Column,
            Message: message,
            Snippet: this.SourceLine(),
            Suggestion: suggestion,
        });
    }

    private SourceLine(): string {
        const start = this.Source.lastIndexOf('\n', this.Position - 1) + 1;
        const end = this.Source.indexOf('\n', this.Position);
        return this.Source.slice(start, end < 0 ? undefined : end);
    }
}
