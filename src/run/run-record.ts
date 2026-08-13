import { ERunStatus, ERunTrigger, type TVariableValue } from '@at/core';
import { isNull } from '@at/core';

export type TRunRecord = {
    RunId: string;
    TaskId: string;
    PackageVersion: string;
    Trigger: ERunTrigger;
    Status: ERunStatus;
    StartedAt?: string;
    FinishedAt?: string;
    Variables?: Record<string, TVariableValue>;
    Error?: string;
};

export function serializeRunRecord(record: TRunRecord): Record<string, unknown> {
    const serialized: Record<string, unknown> = {
        runId: record.RunId,
        taskId: record.TaskId,
        packageVersion: record.PackageVersion,
        trigger: record.Trigger,
        status: record.Status,
    };
    if (record.StartedAt !== undefined) {
        serialized.startedAt = record.StartedAt;
    }
    if (record.FinishedAt !== undefined) {
        serialized.finishedAt = record.FinishedAt;
    }
    if (record.Variables !== undefined) {
        serialized.variables = record.Variables;
    }
    if (record.Error !== undefined) {
        serialized.error = record.Error;
    }
    return serialized;
}

export function parseRunRecord(value: unknown): TRunRecord | undefined {
    if (typeof value !== 'object' || isNull(value)) {
        return undefined;
    }
    const raw = value as Record<string, unknown>;
    if (
        typeof raw.runId !== 'string' ||
        typeof raw.taskId !== 'string' ||
        typeof raw.packageVersion !== 'string' ||
        typeof raw.trigger !== 'string' ||
        typeof raw.status !== 'string'
    ) {
        return undefined;
    }
    const record: TRunRecord = {
        RunId: raw.runId,
        TaskId: raw.taskId,
        PackageVersion: raw.packageVersion,
        Trigger: raw.trigger as ERunTrigger,
        Status: raw.status as ERunStatus,
    };
    if (typeof raw.startedAt === 'string') {
        record.StartedAt = raw.startedAt;
    }
    if (typeof raw.finishedAt === 'string') {
        record.FinishedAt = raw.finishedAt;
    }
    if (typeof raw.variables === 'object' && !isNull(raw.variables)) {
        record.Variables = raw.variables as Record<string, TVariableValue>;
    }
    if (typeof raw.error === 'string') {
        record.Error = raw.error;
    }
    return record;
}
