import { EExitCode } from '@at/core';

import { runCli } from './index';

// 打包单文件用的隐藏开关：一个二进制同时承载 CLI 和运行时守护进程。
const RUNTIME_DAEMON_FLAG = '--runtime-daemon';

async function bootstrap(): Promise<void> {
    if (process.argv.slice(2).includes(RUNTIME_DAEMON_FLAG)) {
        // 懒加载，普通 CLI 调用不承担守护进程模块图的加载开销。
        const { runRuntimeDaemon } = await import('@at/runtime');
        runRuntimeDaemon(process.argv.filter((argument) => argument !== RUNTIME_DAEMON_FLAG));
        return;
    }
    process.exitCode = await runCli(process.argv);
}

void bootstrap().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = EExitCode.Generic;
});
