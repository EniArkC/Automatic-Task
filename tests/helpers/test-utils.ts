import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ILogTransport, TLogEntry } from '@at/logging';
import { ELogLevel, Logger } from '@at/logging';
import type { IPathService, IPlatformService } from '@at/paths';
import { PathService } from '@at/paths';

export function createTempDir(prefix: string): string {
    return mkdtempSync(join(tmpdir(), prefix));
}

export function removeDir(dir: string): void {
    rmSync(dir, { recursive: true, force: true });
}

// 给需要表现得像交互式终端的子进程用的环境变量。ink 通过 `is-in-ci` 判断环境，
// 只要设了 `CI`（或 `CONTINUOUS_INTEGRATION`，或任意 `CI_*`）就为真，它的 CI 分支
// 会把帧存进内部字段而不写进 stdout。对构建日志来说这是对的默认行为，但伪终端测试
// 跑的是真实渲染路径：一旦继承了这些变量，TUI 一个字节都不会画出来，所有断言都会
// 表现成"应用停止绘制"。这些变量属于测试运行器，不属于被测进程，所以在这里剔除。
export function interactiveEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
    const isCiKey = (key: string): boolean => key === 'CI' || key === 'CONTINUOUS_INTEGRATION' || key.startsWith('CI_');
    const kept = Object.entries(process.env).filter(([key]) => !isCiKey(key));
    return { ...Object.fromEntries(kept), ...overrides };
}

export function createTempPathService(root: string): IPathService {
    const platform: IPlatformService = {
        IsWindows: () => true,
        IsLinux: () => false,
        GetHomeDirectory: () => root,
        GetDataDirectory: () => root,
        GetConfigDirectory: () => root,
        GetStateDirectory: () => root,
        GetRuntimeDirectory: () => root,
        GetTempDirectory: () => root,
        GetUsername: () => 'tester',
    };
    return new PathService(platform);
}

export class MemoryTransport implements ILogTransport {
    public readonly Entries: TLogEntry[] = [];

    public Write(entry: TLogEntry): void {
        this.Entries.push(entry);
    }
}

export function createTestLogger(): { Logger: Logger; Transport: MemoryTransport } {
    const transport = new MemoryTransport();
    return { Logger: new Logger([transport], ELogLevel.Debug), Transport: transport };
}
