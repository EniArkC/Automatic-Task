export enum ETokenType {
    AtVar = 'AT_VAR',
    Ident = 'IDENT',
    String = 'STRING',
    Template = 'TEMPLATE',
    Number = 'NUMBER',
    Boolean = 'BOOLEAN',
    Arrow = 'ARROW',
    Lbracket = 'LBRACKET',
    Rbracket = 'RBRACKET',
    Lparen = 'LPAREN',
    Rparen = 'RPAREN',
    Colon = 'COLON',
    Comma = 'COMMA',
    Exclamation = 'EXCLAMATION',
    Assign = 'ASSIGN',
    OpEq = 'OP_EQ',
    OpNe = 'OP_NE',
    OpGt = 'OP_GT',
    OpGte = 'OP_GTE',
    OpLt = 'OP_LT',
    OpLte = 'OP_LTE',
    And = 'AND',
    Or = 'OR',
    Not = 'NOT',
    Start = 'START',
    End = 'END',
    Select = 'SELECT',
    Success = 'SUCCESS',
    Failure = 'FAILURE',
    Default = 'DEFAULT',
    Case = 'CASE',
    Comment = 'COMMENT',
    Newline = 'NEWLINE',
    Indent = 'INDENT',
    Dedent = 'DEDENT',
    Eof = 'EOF',
}

export type TToken = {
    Type: ETokenType;
    Value: string;
    Line: number;
    Column: number;
};

const keywords: Record<string, ETokenType> = {
    Start: ETokenType.Start,
    End: ETokenType.End,
    Select: ETokenType.Select,
    Success: ETokenType.Success,
    Failure: ETokenType.Failure,
    Default: ETokenType.Default,
    Case: ETokenType.Case,
};

export function keywordTokenType(value: string): ETokenType | undefined {
    return keywords[value];
}

export const identPattern = /^[a-zA-Z_][a-zA-Z0-9_-]*$/;
export const variableNamePattern = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
