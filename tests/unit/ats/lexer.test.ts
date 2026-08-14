import { ETokenType, Lexer } from '@at/ats';
import { AtParseError } from '@at/core';
import { describe, expect, it } from 'vitest';

function tokenize(source: string): ReturnType<Lexer['Tokenize']> {
    return new Lexer(source, 'task.ats').Tokenize();
}

function types(source: string): ETokenType[] {
    return tokenize(source).map((token) => token.Type);
}

describe('lexer', () => {
    it('tokenizes variables', () => {
        const tokens = tokenize(
            '@var city: string = "北京"\n@var depth: select("简版", "详细") = "简版"\n@var token: password!\n',
        );
        const first = tokens[0];
        expect(first?.Type).toBe(ETokenType.AtVar);
        expect(first?.Line).toBe(1);
        expect(first?.Column).toBe(1);
        expect(types('@var city: string = "北京"\n')).toEqual([
            ETokenType.AtVar,
            ETokenType.Ident,
            ETokenType.Colon,
            ETokenType.Ident,
            ETokenType.Assign,
            ETokenType.String,
            ETokenType.Newline,
            ETokenType.Eof,
        ]);
        expect(tokens.some((token) => token.Type === ETokenType.Exclamation)).toBe(true);
    });

    it('tokenizes a step line with template and named argument', () => {
        const tokens = types('-> [Agent(`生成${city}日报`, timeout: 1800)]\n');
        expect(tokens).toEqual([
            ETokenType.Arrow,
            ETokenType.Lbracket,
            ETokenType.Ident,
            ETokenType.Lparen,
            ETokenType.Template,
            ETokenType.Comma,
            ETokenType.Ident,
            ETokenType.Colon,
            ETokenType.Number,
            ETokenType.Rparen,
            ETokenType.Rbracket,
            ETokenType.Newline,
            ETokenType.Eof,
        ]);
        const template = tokenize('`scripts/fetch.bat ${city}`')[0];
        expect(template?.Value).toBe('scripts/fetch.bat ${city}');
    });

    it('emits indentation tokens for select blocks', () => {
        const tokens = tokenize('-> [Select]\n\n    -> [Failure]\n        -> [Agent(`x`)]\n\n    -> [Default]\n');
        const kinds = tokens.map((token) => `${token.Type}:${token.Line}`);
        expect(kinds).toContain('INDENT:3');
        expect(kinds).toContain('INDENT:4');
        expect(kinds).toContain('DEDENT:6');
        expect(kinds).toContain('DEDENT:7');
    });

    it('tokenizes keywords, operators and booleans', () => {
        expect(types('[Start]\n[End]\n[Select]\n[Success]\n[Failure]\n[Default]\n[Case(${a} == "x")]\n')).toEqual([
            ETokenType.Lbracket,
            ETokenType.Start,
            ETokenType.Rbracket,
            ETokenType.Newline,
            ETokenType.Lbracket,
            ETokenType.End,
            ETokenType.Rbracket,
            ETokenType.Newline,
            ETokenType.Lbracket,
            ETokenType.Select,
            ETokenType.Rbracket,
            ETokenType.Newline,
            ETokenType.Lbracket,
            ETokenType.Success,
            ETokenType.Rbracket,
            ETokenType.Newline,
            ETokenType.Lbracket,
            ETokenType.Failure,
            ETokenType.Rbracket,
            ETokenType.Newline,
            ETokenType.Lbracket,
            ETokenType.Default,
            ETokenType.Rbracket,
            ETokenType.Newline,
            ETokenType.Lbracket,
            ETokenType.Case,
            ETokenType.Lparen,
            ETokenType.Template,
            ETokenType.OpEq,
            ETokenType.String,
            ETokenType.Rparen,
            ETokenType.Rbracket,
            ETokenType.Newline,
            ETokenType.Eof,
        ]);
        expect(types('-> [Script(`x`)]\n')).toContain(ETokenType.Ident);
    });

    it('skips comments and blank lines without changing indentation', () => {
        const tokens = tokenize('// a comment\n\n-> [Script(`x`)]  // trailing\n');
        expect(tokens.some((token) => token.Type === ETokenType.Comment)).toBe(true);
        expect(tokens.filter((token) => token.Type === ETokenType.Indent)).toHaveLength(0);
    });

    it('keeps the text of a trailing description', () => {
        const tokens = tokenize('@var city: string   # 要生成日报的城市\r\n');
        const description = tokens.find((token) => token.Type === ETokenType.Description);
        expect(description?.Value).toBe('要生成日报的城市');
    });

    it('does not emit a token for a whole-line comment', () => {
        const tokens = tokenize('// 整行注释\n-> [Script(`x`)]\n');
        expect(tokens.some((token) => token.Type === ETokenType.Comment)).toBe(false);
    });

    it('reports position in errors', () => {
        try {
            tokenize('@var city: string = "北京\n');
            expect.unreachable();
        } catch (error) {
            expect(error).toBeInstanceOf(AtParseError);
            const parseError = error as AtParseError;
            expect(parseError.Detail.Line).toBe(1);
            expect(parseError.Detail.Message).toContain('Unterminated string');
        }
    });

    it('rejects tabs for indentation', () => {
        expect(() => tokenize('-> [Script(`x`)]\n\t-> [Script(`y`)]\n')).toThrow(AtParseError);
    });

    it('rejects unexpected characters', () => {
        expect(() => tokenize('-> [Script(`x`)] ~\n')).toThrow(/Unexpected character/);
    });

    it('tracks line numbers across multiple lines', () => {
        const tokens = tokenize('a\nb\nc\n');
        expect(tokens[0]?.Line).toBe(1);
        expect(tokens[2]?.Line).toBe(2);
        expect(tokens[4]?.Line).toBe(3);
    });

    it('lexes a single equals as an assignment', () => {
        expect(types('@var city: string = "x"\n')).toContain(ETokenType.Assign);
    });
});
