import { posix, win32 } from 'node:path';

import { ulidToDate } from '@at/core';

import type { IPlatformService } from './platform';

const APP_DIR_NAME = 'Automatic-Task';
const LINUX_APP_DIR_NAME = 'automatic-task';
const PIPE_PREFIX = 'automatic-task-runtime';
const SOCKET_FILE_NAME = 'automatic-task-runtime.sock';
const RUNTIME_LOCK_FILE_NAME = 'runtime.lock';
const MANIFEST_INDEX_FILE_NAME = 'manifest-index.json';
const TASKS_CONFIG_DIR_NAME = 'tasks';

function pad2(value: number): string {
    return String(value).padStart(2, '0');
}

export interface IPathService {
    GetAppRoot(): string;
    GetConfigRoot(): string;
    GetAppConfigPath(): string;
    GetTasksConfigRoot(): string;
    GetTaskConfigPath(taskId: string): string;
    GetPackagesRoot(): string;
    GetPackagePath(taskId: string, version: string): string;
    GetTempPackageRoot(): string;
    GetTempPackagePath(randomId: string): string;
    GetRunsRoot(): string;
    GetRunPath(runId: string): string;
    GetRunWorkspacePath(runId: string): string;
    GetRunMetadataPath(runId: string): string;
    GetRunStdoutPath(runId: string): string;
    GetRunStderrPath(runId: string): string;
    GetRunEventsPath(runId: string): string;
    GetLogsRoot(): string;
    GetRuntimeLogPath(): string;
    GetRuntimeErrorLogPath(): string;
    GetRuntimeDir(): string;
    GetRuntimeSocketPath(): string;
    GetRuntimeLockPath(): string;
    GetManifestIndexPath(): string;
}

// 项目所有持久化路径必须来自本服务。
export class PathService implements IPathService {
    private readonly Platform: IPlatformService;

    public constructor(platform: IPlatformService) {
        this.Platform = platform;
    }

    // 用平台自身的 path 模块保证 Windows 与 Linux 的目录布局正确。
    private Join(...segments: string[]): string {
        return (this.Platform.IsWindows() ? win32 : posix).join(...segments);
    }

    public GetAppRoot(): string {
        if (this.Platform.IsWindows()) {
            return this.Join(this.Platform.GetDataDirectory(), APP_DIR_NAME);
        }
        return this.Join(this.Platform.GetDataDirectory(), LINUX_APP_DIR_NAME);
    }

    public GetConfigRoot(): string {
        if (this.Platform.IsWindows()) {
            return this.Join(this.GetAppRoot(), 'config');
        }
        return this.Join(this.Platform.GetConfigDirectory(), LINUX_APP_DIR_NAME);
    }

    public GetAppConfigPath(): string {
        return this.Join(this.GetConfigRoot(), 'app.json');
    }

    public GetTasksConfigRoot(): string {
        return this.Join(this.GetConfigRoot(), TASKS_CONFIG_DIR_NAME);
    }

    public GetTaskConfigPath(taskId: string): string {
        return this.Join(this.GetTasksConfigRoot(), `${taskId}.json`);
    }

    public GetPackagesRoot(): string {
        return this.Join(this.GetAppRoot(), 'packages');
    }

    public GetPackagePath(taskId: string, version: string): string {
        return this.Join(this.GetPackagesRoot(), taskId, version);
    }

    public GetTempPackageRoot(): string {
        return this.Join(this.GetPackagesRoot(), '.tmp');
    }

    public GetTempPackagePath(randomId: string): string {
        return this.Join(this.GetTempPackageRoot(), randomId);
    }

    public GetRunsRoot(): string {
        return this.Join(this.GetAppRoot(), 'runs');
    }

    // 运行路径按 ULID 时间戳按日分区，便于在文件系统上按天清理历史。
    public GetRunPath(runId: string): string {
        const date = ulidToDate(runId);
        return this.Join(
            this.GetRunsRoot(),
            String(date.getFullYear()),
            pad2(date.getMonth() + 1),
            pad2(date.getDate()),
            runId,
        );
    }

    public GetRunWorkspacePath(runId: string): string {
        return this.Join(this.GetRunPath(runId), 'workspace');
    }

    public GetRunMetadataPath(runId: string): string {
        return this.Join(this.GetRunPath(runId), 'metadata.json');
    }

    public GetRunStdoutPath(runId: string): string {
        return this.Join(this.GetRunPath(runId), 'stdout.log');
    }

    public GetRunStderrPath(runId: string): string {
        return this.Join(this.GetRunPath(runId), 'stderr.log');
    }

    public GetRunEventsPath(runId: string): string {
        return this.Join(this.GetRunPath(runId), 'events.jsonl');
    }

    public GetLogsRoot(): string {
        if (this.Platform.IsWindows()) {
            return this.Join(this.GetAppRoot(), 'logs');
        }
        return this.Join(this.Platform.GetStateDirectory(), LINUX_APP_DIR_NAME);
    }

    public GetRuntimeLogPath(): string {
        return this.Join(this.GetLogsRoot(), 'runtime.log');
    }

    public GetRuntimeErrorLogPath(): string {
        return this.Join(this.GetLogsRoot(), 'runtime-error.log');
    }

    public GetRuntimeDir(): string {
        return this.Join(this.GetAppRoot(), 'runtime');
    }

    // Windows 使用每用户命名管道；Linux 使用 Unix 域套接字。
    public GetRuntimeSocketPath(): string {
        if (this.Platform.IsWindows()) {
            const safeUser = this.Platform.GetUsername().replace(/[^a-zA-Z0-9]+/g, '-');
            return `\\\\.\\pipe\\${PIPE_PREFIX}-${safeUser}`;
        }
        return this.Join(this.Platform.GetRuntimeDirectory(), SOCKET_FILE_NAME);
    }

    public GetRuntimeLockPath(): string {
        return this.Join(this.GetRuntimeDir(), RUNTIME_LOCK_FILE_NAME);
    }

    public GetManifestIndexPath(): string {
        return this.Join(this.GetRuntimeDir(), MANIFEST_INDEX_FILE_NAME);
    }
}
