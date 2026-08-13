import { IpcClient } from '@at/ipc';
import { createRuntimeLogger, ELogLevel } from '@at/logging';
import { PathService, PlatformService } from '@at/paths';

import { Runtime } from './runtime';

async function isRuntimeRunning(socketPath: string): Promise<boolean> {
    const client = new IpcClient(socketPath);
    try {
        await client.Connect();
        await client.SendRequest('runtime.ping', {});
        client.Close();
        return true;
    } catch {
        client.Close();
        return false;
    }
}

// 在当前进程内启动守护进程；导出以便合并后的单文件可执行程序同时承载 CLI 与 runtime。
export async function startRuntimeDaemon(argv: readonly string[] = process.argv): Promise<void> {
    const verbose = argv.includes('--verbose');
    const pathService = new PathService(new PlatformService());
    const logger = createRuntimeLogger(pathService.GetLogsRoot(), verbose ? ELogLevel.Debug : ELogLevel.Info);
    if (await isRuntimeRunning(pathService.GetRuntimeSocketPath())) {
        logger.Warn('Runtime is already running; exiting');
        process.exit(0);
    }
    const runtime = new Runtime({
        SocketPath: pathService.GetRuntimeSocketPath(),
        Logger: logger,
        PathService: pathService,
    });
    await runtime.Start();
    const shutdown = (): void => {
        runtime.Stop();
        // StopAll 异步中止运行，taskkill 链需要事件循环存活到宽限期结束；留出时间强制结束子进程后再退出。
        setTimeout(() => {
            process.exit(0);
        }, 2500).unref();
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

// 进程级入口：ping 探测与 Listen() 之间可能被并发进程抢先绑定管道，失败方必须静默退出，
// 而不是因 EADDRINUSE 产生未处理的 rejection 崩溃。
export function runRuntimeDaemon(argv: readonly string[] = process.argv): void {
    void startRuntimeDaemon(argv).catch((error: unknown) => {
        if (error instanceof Error && 'code' in error && error.code === 'EADDRINUSE') {
            process.exit(0);
        }
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exit(1);
    });
}
