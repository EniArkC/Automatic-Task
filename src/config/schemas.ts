import { ELogLevel } from '@at/logging';
import Ajv, { type ValidateFunction } from 'ajv';

export const appConfigSchema = {
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    properties: {
        version: { type: 'integer', minimum: 1 },
        agent: {
            type: 'object',
            properties: {
                command: { type: 'string', minLength: 1 },
                args: { type: 'array', items: { type: 'string' } },
                model: { type: 'string' },
            },
            additionalProperties: false,
        },
        logging: {
            type: 'object',
            properties: {
                level: { enum: [ELogLevel.Debug, ELogLevel.Info, ELogLevel.Warn, ELogLevel.Error] },
                maxFileSizeMb: { type: 'number', minimum: 1 },
                maxFiles: { type: 'integer', minimum: 1 },
            },
            additionalProperties: false,
        },
        cleanup: {
            type: 'object',
            properties: {
                keepRunsDays: { type: 'integer', minimum: 0 },
                keepWorkspaceDays: { type: 'integer', minimum: 0 },
            },
            additionalProperties: false,
        },
    },
    additionalProperties: false,
} as const;

export const taskConfigSchema = {
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    required: ['taskId', 'packageVersion', 'enabled', 'overlap', 'variables'],
    properties: {
        taskId: { type: 'string', pattern: '^[a-z0-9-]{3,64}$' },
        packageVersion: { type: 'string', minLength: 1 },
        enabled: { type: 'boolean' },
        // schedule 在磁盘上可为 null，表示"无自动调度"。
        schedule: {
            type: ['object', 'null'],
            required: ['cron'],
            properties: {
                cron: { type: 'string', minLength: 1 },
                timezone: { type: 'string', minLength: 1 },
            },
            additionalProperties: false,
        },
        overlap: { enum: ['skip', 'queue', 'parallel'] },
        variables: {
            type: 'object',
            additionalProperties: { type: ['string', 'number', 'boolean'] },
        },
    },
    additionalProperties: false,
} as const;

let appConfigValidator: ValidateFunction | undefined;
let taskConfigValidator: ValidateFunction | undefined;

function getAppConfigValidator(): ValidateFunction {
    appConfigValidator ??= new Ajv({ allErrors: true, allowUnionTypes: true }).compile(appConfigSchema);
    return appConfigValidator;
}

function getTaskConfigValidator(): ValidateFunction {
    taskConfigValidator ??= new Ajv({ allErrors: true, allowUnionTypes: true }).compile(taskConfigSchema);
    return taskConfigValidator;
}

export function validateAppConfig(value: unknown): string[] {
    const validator = getAppConfigValidator();
    if (validator(value)) {
        return [];
    }
    return (validator.errors ?? []).map((error) => `${error.instancePath || '/'} ${error.message ?? 'invalid'}`);
}

export function validateTaskConfig(value: unknown): string[] {
    const validator = getTaskConfigValidator();
    if (validator(value)) {
        return [];
    }
    return (validator.errors ?? []).map((error) => `${error.instancePath || '/'} ${error.message ?? 'invalid'}`);
}
