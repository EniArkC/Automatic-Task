import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { AtValidationError, isValidSemver } from '@at/core';
import type { ILogger } from '@at/logging';
import type { IPathService } from '@at/paths';

import { validateAppConfig, validateTaskConfig } from './schemas';
import {
    createDefaultAppConfig,
    createDefaultTaskConfig,
    parseTaskConfig,
    serializeTaskConfig,
    type TAppConfig,
    type TTaskConfig,
} from './task-config';

export interface IConfigManager {
    LoadAppConfig(): TAppConfig;
    SaveAppConfig(config: TAppConfig): void;
    GetTaskConfig(taskId: string): TTaskConfig | undefined;
    ListTaskConfigs(): TTaskConfig[];
    SaveTaskConfig(config: TTaskConfig): void;
    DeleteTaskConfig(taskId: string): void;
    CreateDefaultTaskConfig(taskId: string, packageVersion: string): TTaskConfig;
}

function backupCorruptFile(file: string, logger: ILogger): void {
    try {
        const backup = `${file}.corrupt-${Date.now()}`;
        renameSync(file, backup);
        logger.Warn(`Backed up corrupt config file`, { file, backup });
    } catch (error) {
        logger.Error('Failed to back up corrupt config file', { file, error });
    }
}

// 所有配置读写都经由本管理器，业务代码不得直接触碰配置文件。
export class ConfigManager implements IConfigManager {
    private readonly PathService: IPathService;
    private readonly Logger: ILogger;
    private readonly AppConfig: TAppConfig;

    public constructor(pathService: IPathService, logger: ILogger) {
        this.PathService = pathService;
        this.Logger = logger;
        this.AppConfig = this.LoadAppConfig();
    }

    public LoadAppConfig(): TAppConfig {
        const file = this.PathService.GetAppConfigPath();
        return (
            this.ReadJsonFile<TAppConfig>(file, createDefaultAppConfig(), validateAppConfig, 'app config') ??
            createDefaultAppConfig()
        );
    }

    public SaveAppConfig(config: TAppConfig): void {
        this.WriteJsonAtomic(this.PathService.GetAppConfigPath(), config);
    }

    public GetTaskConfig(taskId: string): TTaskConfig | undefined {
        const file = this.PathService.GetTaskConfigPath(taskId);
        if (!this.FileExists(file)) {
            return undefined;
        }
        const parsed = this.ReadJsonFile<TTaskConfig>(file, undefined, validateTaskConfig, 'task config');
        if (parsed === undefined) {
            return undefined;
        }
        const config = parseTaskConfig(parsed);
        if (config === undefined) {
            backupCorruptFile(file, this.Logger);
            this.Logger.Error('Invalid task config content', { file, taskId });
            return undefined;
        }
        return config;
    }

    public ListTaskConfigs(): TTaskConfig[] {
        const root = this.PathService.GetTasksConfigRoot();
        const configs: TTaskConfig[] = [];
        try {
            const entries = readdirSync(root, { withFileTypes: true });
            for (const entry of entries) {
                if (!entry.isFile() || !entry.name.endsWith('.json')) {
                    continue;
                }
                const config = this.GetTaskConfig(entry.name.slice(0, -5));
                if (config !== undefined) {
                    configs.push(config);
                }
            }
        } catch (error) {
            if (this.IsMissingFileError(error)) {
                return configs;
            }
            this.Logger.Error('Failed to list task configs', { root, error });
        }
        return configs;
    }

    public SaveTaskConfig(config: TTaskConfig): void {
        const errors = validateTaskConfig(serializeTaskConfig(config));
        if (errors.length > 0) {
            throw new AtValidationError(`Invalid task config for "${config.taskId}"`, errors);
        }
        if (!isValidSemver(config.packageVersion)) {
            throw new AtValidationError(`Invalid package version "${config.packageVersion}" for "${config.taskId}"`);
        }
        this.WriteJsonAtomic(this.PathService.GetTaskConfigPath(config.taskId), serializeTaskConfig(config));
    }

    public DeleteTaskConfig(taskId: string): void {
        rmSync(this.PathService.GetTaskConfigPath(taskId), { force: true });
    }

    public CreateDefaultTaskConfig(taskId: string, packageVersion: string): TTaskConfig {
        return createDefaultTaskConfig(taskId, packageVersion);
    }

    private ReadJsonFile<T>(
        file: string,
        fallback: T | undefined,
        validate: (value: unknown) => string[],
        label: string,
    ): T | undefined {
        try {
            const raw = readFileSync(file, 'utf8');
            // Windows 工具常写入 UTF-8 BOM；解析前剔除，
            // 避免有效文件被误判为损坏。
            const content = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
            const parsed: unknown = JSON.parse(content);
            const errors = validate(parsed);
            if (errors.length > 0) {
                backupCorruptFile(file, this.Logger);
                this.Logger.Error(`Invalid ${label}, restored defaults`, { file, errors });
                return fallback;
            }
            return parsed as T;
        } catch (error) {
            if (this.IsMissingFileError(error)) {
                return fallback;
            }
            // 损坏文件绝不能使运行时崩溃；备份后恢复默认。
            backupCorruptFile(file, this.Logger);
            this.Logger.Error(`Failed to read ${label}`, { file, error });
            return fallback;
        }
    }

    // 原子写入：临时文件 + 重命名，崩溃时不会留下写了一半的 JSON。
    private WriteJsonAtomic(file: string, data: unknown): void {
        const dir = dirname(file);
        mkdirSync(dir, { recursive: true });
        const tmp = `${file}.tmp`;
        writeFileSync(tmp, this.EncodeJson(data), 'utf8');
        renameSync(tmp, file);
    }

    private EncodeJson(data: unknown): string {
        return JSON.stringify(data, undefined, 2);
    }

    private FileExists(file: string): boolean {
        try {
            return statSync(file).isFile();
        } catch {
            return false;
        }
    }

    private IsMissingFileError(error: unknown): boolean {
        return error instanceof Error && 'code' in error && error.code === 'ENOENT';
    }
}
