export type TVariableValue = string | number | boolean;

export enum EOverlapPolicy {
    Skip = 'skip',
    Queue = 'queue',
    Parallel = 'parallel',
}

export enum ERunStatus {
    Queued = 'queued',
    Running = 'running',
    Success = 'success',
    Failure = 'failure',
    Cancelled = 'cancelled',
    Timeout = 'timeout',
    Skipped = 'skipped',
    Interrupted = 'interrupted',
}

export enum ERunTrigger {
    Manual = 'manual',
    Schedule = 'schedule',
}

export enum EStepStatus {
    Success = 'success',
    Failure = 'failure',
    Timeout = 'timeout',
    Cancelled = 'cancelled',
    Skipped = 'skipped',
}

export type TStepResult = {
    Status: EStepStatus;
    ExitCode?: number;
    Output: string;
    DurationMs: number;
    Error?: string;
};

export type TExecutionEnvironment = {
    Variables: ReadonlyMap<string, TVariableValue>;
    Workspace: string;
    PackagePath: string;
    AbortSignal: AbortSignal;
    OverrideEnv?: Record<string, string>;
    RunId?: string;
};

export type TExecutionContext = TExecutionEnvironment & {
    LastResult?: TStepResult;
};
