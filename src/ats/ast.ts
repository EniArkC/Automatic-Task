import { EStepStatus } from '@at/core';

export type TVariableType = 'string' | 'text' | 'password' | 'number' | 'boolean' | 'path' | 'select';

export type TLiteralValue = string | number | boolean;

export type TStepKind = 'Script' | 'Agent' | 'Docker';

export type TTemplateSegment = { Kind: 'text'; Text: string } | { Kind: 'variable'; Name: string };

export type TTemplateNode = {
    Kind: 'template';
    Segments: TTemplateSegment[];
    Raw: string;
    Line: number;
    Column: number;
};

export type TArgumentValue = TTemplateNode | TLiteralValue;

export type TStepArgument = {
    Kind: 'positional' | 'named';
    Name?: string;
    Value: TArgumentValue;
    Line: number;
    Column: number;
};

export enum EComparisonOperator {
    Eq = '==',
    Ne = '!=',
    Gt = '>',
    Gte = '>=',
    Lt = '<',
    Lte = '<=',
}

export enum ELogicalOperator {
    And = '&&',
    Or = '||',
}

export type TExpressionNode =
    | { Kind: 'literal'; Value: TLiteralValue; Line: number; Column: number }
    | { Kind: 'template'; Template: TTemplateNode; Line: number; Column: number }
    | {
          Kind: 'binary';
          Operator: EComparisonOperator | ELogicalOperator;
          Left: TExpressionNode;
          Right: TExpressionNode;
          Line: number;
          Column: number;
      }
    | { Kind: 'not'; Operand: TExpressionNode; Line: number; Column: number };

export type TStepNode = {
    Kind: 'step';
    StepType: TStepKind;
    Arguments: TStepArgument[];
    Line: number;
    Column: number;
};

export type TSelectBranchKind = 'success' | 'failure' | 'case' | 'default';

export type TSelectBranch = {
    Kind: TSelectBranchKind;
    Condition?: TExpressionNode;
    Body: TChainNode[];
    Line: number;
    Column: number;
};

export type TSelectNode = {
    Kind: 'select';
    Branches: TSelectBranch[];
    Line: number;
    Column: number;
};

export type TChainNode = TStepNode | TSelectNode;

export type TVariableDeclaration = {
    Name: string;
    Type: TVariableType;
    Required: boolean;
    DefaultValue?: TLiteralValue;
    Options?: string[];
    // 声明行尾注释的文本，作为该参数的说明展示给用户；没有注释时为 undefined。
    Description?: string;
    Line: number;
    Column: number;
};

export type TTaskAst = {
    Variables: TVariableDeclaration[];
    Body: TChainNode[];
};

export type TStepOutcome = {
    Status: EStepStatus;
    ExitCode?: number;
    Output: string;
    DurationMs: number;
    Error?: string;
};
