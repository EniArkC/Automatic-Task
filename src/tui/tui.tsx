import { IpcClient } from '@at/ipc';
import { render } from 'ink';

import { RenderTuiApp } from './app';
import {
    enterFullScreen,
    installFullScreenGuards,
    installResizeClear,
    installSynchronizedOutput,
    leaveFullScreen,
} from './screen';

export async function renderTui(socketPath: string): Promise<void> {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
        process.stderr.write(
            'The TUI needs an interactive terminal. Use the CLI commands instead (autotask list, autotask run ...).\n',
        );
        return;
    }
    // 切换缓冲区是一次写入，进程启动即替换控制台，而不是等第一帧 ink 渲染；
    // 从托盘打开 TUI 时不会闪现普通控制台窗口。
    enterFullScreen(process.stdout);
    const disposeGuards = installFullScreenGuards(process.stdout);
    // 必须在 render() 之前安装：resize 监听器按注册顺序触发，ink 自己的监听器同步重绘，
    // 缓冲区要在它之前而不是之后清除。
    const disposeResizeClear = installResizeClear(process.stdout);
    // 也要在 render() 之前包好：ink 在构造时就持有 stdout，之后替换 write 它照样经过。
    const disposeSync = installSynchronizedOutput(process.stdout);
    const client = new IpcClient(socketPath);
    // patchConsole 会把杂散的控制台输出变成清屏再重绘，在交替缓冲区里是可见的闪烁。
    const instance = render(<RenderTuiApp client={client} />, { patchConsole: false, exitOnCtrlC: true });
    try {
        await instance.waitUntilExit();
    } finally {
        client.Close();
        leaveFullScreen(process.stdout);
        disposeSync();
        disposeResizeClear();
        disposeGuards();
    }
}
