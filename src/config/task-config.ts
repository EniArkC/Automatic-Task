import { EOverlapPolicy, type TVariableValue } from '@at/core';
import { isNull, isNullOrUndefined } from '@at/core';

export type TScheduleConfig = {
    cron: string;
    timezone?: string;
};

export type TTaskConfig = {
    taskId: string;
    packageVersion: string;
    enabled: boolean;
    schedule?: TScheduleConfig;
    overlap: EOverlapPolicy;
    variables: Record<string, TVariableValue>;
};

export type TAgentConfig = {
    command?: string;
    args?: string[];
    model?: string;
};

export type TLoggingConfig = {
    level?: string;
    maxFileSizeMb?: number;
    maxFiles?: number;
};

export type TCleanupConfig = {
    keepRunsDays?: number;
    keepWorkspaceDays?: number;
};

export type TAppConfig = {
    version: number;
    agent?: TAgentConfig;
    logging?: TLoggingConfig;
    cleanup?: TCleanupConfig;
};

export function createDefaultAppConfig(): TAppConfig {
    return { version: 1 };
}

export function createDefaultTaskConfig(taskId: string, packageVersion: string): TTaskConfig {
    return {
        taskId,
        packageVersion,
        enabled: false,
        overlap: EOverlapPolicy.Skip,
        variables: {},
    };
}

// 序列化为磁盘形态：缺省 schedule 显式表示，工具可区分"无调度"与"未知"。
export function serializeTaskConfig(config: TTaskConfig): Record<string, unknown> {
    const serialized: Record<string, unknown> = {
        taskId: config.taskId,
        packageVersion: config.packageVersion,
        enabled: config.enabled,
        overlap: config.overlap,
        variables: config.variables,
    };
    if (config.schedule !== undefined) {
        serialized.schedule = config.schedule;
    }
    return serialized;
}

// 解析磁盘形态；null 的 schedule 在内部映射为 undefined。
export function parseTaskConfig(value: unknown): TTaskConfig | undefined {
    if (typeof value !== 'object' || isNull(value)) {
        return undefined;
    }
    const raw = value as Record<string, unknown>;
    const taskId = raw.taskId;
    const packageVersion = raw.packageVersion;
    const enabled = raw.enabled;
    const overlap = raw.overlap;
    const variables = raw.variables;
    if (
        typeof taskId !== 'string' ||
        typeof packageVersion !== 'string' ||
        typeof enabled !== 'boolean' ||
        typeof overlap !== 'string' ||
        typeof variables !== 'object' ||
        isNull(variables)
    ) {
        return undefined;
    }
    const scheduleValue = raw.schedule;
    let schedule: TScheduleConfig | undefined;
    if (!isNullOrUndefined(scheduleValue) && typeof scheduleValue === 'object') {
        const scheduleRaw = scheduleValue as Record<string, unknown>;
        if (typeof scheduleRaw.cron !== 'string') {
            return undefined;
        }
        schedule = { cron: scheduleRaw.cron };
        if (typeof scheduleRaw.timezone === 'string') {
            schedule.timezone = scheduleRaw.timezone;
        }
    }
    return {
        taskId,
        packageVersion,
        enabled,
        schedule,
        overlap: overlap as EOverlapPolicy,
        variables: variables as Record<string, TVariableValue>,
    };
}
