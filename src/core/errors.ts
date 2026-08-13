import { EExitCode } from './exit-code';

export enum EErrorKind {
    User = 'user',
    Package = 'package',
    Parse = 'parse',
    Validation = 'validation',
    Runtime = 'runtime',
    Execution = 'execution',
    Ipc = 'ipc',
    System = 'system',
}

export type TErrorOptions = {
    exitCode?: EExitCode;
    cause?: unknown;
};

const exitCodeByKind: Record<EErrorKind, EExitCode> = {
    [EErrorKind.User]: EExitCode.Generic,
    [EErrorKind.Package]: EExitCode.PackageInvalid,
    [EErrorKind.Parse]: EExitCode.PackageInvalid,
    [EErrorKind.Validation]: EExitCode.PackageInvalid,
    [EErrorKind.Runtime]: EExitCode.Generic,
    [EErrorKind.Execution]: EExitCode.ExecutionFailed,
    [EErrorKind.Ipc]: EExitCode.RuntimeUnavailable,
    [EErrorKind.System]: EExitCode.Generic,
};

function defaultExitCode(kind: EErrorKind): EExitCode {
    return exitCodeByKind[kind];
}

export class AtError extends Error {
    public readonly Kind: EErrorKind;
    public readonly ExitCode: EExitCode;

    public constructor(kind: EErrorKind, message: string, options: TErrorOptions = {}) {
        super(message, options.cause === undefined ? undefined : { cause: options.cause });
        this.name = 'AtError';
        this.Kind = kind;
        this.ExitCode = options.exitCode ?? defaultExitCode(kind);
    }
}

export class AtUserError extends AtError {
    public constructor(message: string, options: TErrorOptions = {}) {
        super(EErrorKind.User, message, options);
        this.name = 'AtUserError';
    }
}

export class AtPackageError extends AtError {
    public constructor(message: string, options: TErrorOptions = {}) {
        super(EErrorKind.Package, message, options);
        this.name = 'AtPackageError';
    }
}

export class AtValidationError extends AtError {
    public readonly Detail: string[];

    public constructor(message: string, detail: string[] = [], options: TErrorOptions = {}) {
        super(EErrorKind.Validation, message, options);
        this.name = 'AtValidationError';
        this.Detail = detail;
    }
}

export class AtRuntimeError extends AtError {
    public constructor(message: string, options: TErrorOptions = {}) {
        super(EErrorKind.Runtime, message, options);
        this.name = 'AtRuntimeError';
    }
}

export class AtExecutionError extends AtError {
    public constructor(message: string, options: TErrorOptions = {}) {
        super(EErrorKind.Execution, message, options);
        this.name = 'AtExecutionError';
    }
}

export class AtIpcError extends AtError {
    public constructor(message: string, options: TErrorOptions = {}) {
        super(EErrorKind.Ipc, message, options);
        this.name = 'AtIpcError';
    }
}

export class AtSystemError extends AtError {
    public constructor(message: string, options: TErrorOptions = {}) {
        super(EErrorKind.System, message, options);
        this.name = 'AtSystemError';
    }
}

export type TParseErrorDetail = {
    File: string;
    Line: number;
    Column: number;
    Message: string;
    Snippet?: string;
    Suggestion?: string;
};

function formatSnippet(line: string, column: number): string {
    const caret = `${' '.repeat(Math.max(column - 1, 0))}^`;
    return `${line}\n${caret}`;
}

function formatParseError(detail: TParseErrorDetail): string {
    const parts: string[] = [`${detail.File}:${detail.Line}:${detail.Column}`, detail.Message];
    if (detail.Snippet !== undefined) {
        parts.push(formatSnippet(detail.Snippet, detail.Column));
    }
    if (detail.Suggestion !== undefined) {
        parts.push(`Suggestion: ${detail.Suggestion}`);
    }
    return parts.join('\n');
}

export class AtParseError extends AtError {
    public readonly Detail: TParseErrorDetail;

    public constructor(detail: TParseErrorDetail, options: TErrorOptions = {}) {
        super(EErrorKind.Parse, formatParseError(detail), options);
        this.name = 'AtParseError';
        this.Detail = detail;
    }
}
