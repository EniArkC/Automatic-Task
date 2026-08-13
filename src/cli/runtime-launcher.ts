import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AtError, AtIpcError, EExitCode, ERunStatus } from '@at/core';
import type { IpcClient } from '@at/ipc';

function repoRoot(): string {
    return join(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

function moduleDir(): string {
    return dirname(fileURLToPath(import.meta.url));
}

type TRuntimeTarget = {
    Command: string;
    Args: string[];
    Env?: NodeJS.ProcessEnv;
};

export type { TRuntimeTarget };

// 定位运行时入口。打包单文件时 CLI 与守护进程在同一二进制，用隐藏的 --runtime-daemon
// 开关重启自己；esbuild 打包的 dist 文件同理；tsx 开发入口是最后手段。
export function resolveRuntimeEntry(): TRuntimeTarget {
    const fromEnv = process.env.AT_RUNTIME_ENTRY;
    if (fromEnv !== undefined && fromEnv !== '') {
        return { Command: fromEnv, Args: [] };
    }
    // `process.pkg` 只在 pkg 构建的二进制内存在；此时 process.execPath 是 exe 本身，不是 node 解释器。
    if ('pkg' in process) {
        // pkg 补丁了 child_process.spawn：PKG_EXECPATH 未设置时会盖上自身路径，子进程据此把
        // --runtime-daemon 当脚本加载而启动即死。pkg 只在变量缺失时填充，设成别的值即可走正常入口。
        return {
            Command: process.execPath,
            Args: ['--runtime-daemon'],
            Env: { ...process.env, PKG_EXECPATH: 'AT_RUNTIME_DAEMON' },
        };
    }
    // esbuild 打包时本模块就是 dist/at.js，守护进程是同一个文件，按模块位置解析。
    const bundle = join(moduleDir(), 'at.js');
    if (existsSync(bundle)) {
        return { Command: process.execPath, Args: [bundle, '--runtime-daemon'] };
    }
    return {
        Command: process.execPath,
        Args: ['--import', 'tsx', join(repoRoot(), 'src', 'runtime', 'main.ts')],
    };
}

// 守护进程 detached 启动，不依赖当前工作目录。
function spawnRuntime(): void {
    const target = resolveRuntimeEntry();
    const child = spawn(target.Command, target.Args, {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: target.Env ?? process.env,
    });
    // 二进制缺失会异步触发 'error'，没有监听器 CLI 会崩溃；EnsureRunning 重试到超时再报错。
    child.on('error', () => {
        /* 留给 ping 循环重试。 */
    });
    child.unref();
}

export class RuntimeLauncher {
    private readonly SocketPath: string;

    public constructor(socketPath: string) {
        this.SocketPath = socketPath;
    }

    public async EnsureRunning(createClient: () => IpcClient): Promise<void> {
        if (await this.Ping(createClient)) {
            return;
        }
        spawnRuntime();
        // 引导通常在一秒内完成，最多等 10 秒。
        for (let attempt = 0; attempt < 40; attempt++) {
            await new Promise((resolve) => setTimeout(resolve, 250));
            if (await this.Ping(createClient)) {
                return;
            }
        }
        throw new AtIpcError('Runtime did not start; check the logs in %LOCALAPPDATA%\\Automatic-Task\\logs');
    }

    private async Ping(createClient: () => IpcClient): Promise<boolean> {
        const client = createClient();
        try {
            await client.Connect();
            await client.SendRequest('runtime.ping', {});
            return true;
        } catch {
            return false;
        } finally {
            client.Close();
        }
    }
}

export function exitCodeFor(error: unknown): number {
    if (error instanceof AtError) {
        return error.ExitCode;
    }
    return EExitCode.Generic;
}

export function exitCodeForRunStatus(status: ERunStatus | undefined): number {
    switch (status) {
        case ERunStatus.Timeout:
            return EExitCode.Timeout;
        case ERunStatus.Cancelled:
            return EExitCode.Cancelled;
        case ERunStatus.Failure:
            return EExitCode.ExecutionFailed;
        default:
            return EExitCode.Generic;
    }
}
