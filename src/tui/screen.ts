// TUI 的全屏（交替缓冲区）处理。
//
// 转义序列内联而非取自 ansi-escapes：该包不是本包的声明依赖，pnpm 严格隔离下导入会失败，
// 不值得为几个常量引入一个依赖。
const ENTER_ALT_SCREEN = '\u001B[?1049h';
const LEAVE_ALT_SCREEN = '\u001B[?1049l';
const SHOW_CURSOR = '\u001B[?25h';
// 清空整个缓冲区并把光标归位——见下方 installResizeClear。
const CLEAR_SCREEN = '\u001B[2J\u001B[H';
// 同步输出（DEC 私有模式 2026）：成对包住一帧，终端在收到结束序列前不把中间状态刷到屏幕。
// ink 的重绘是「擦掉上一帧的 N 行」紧接着「重画整帧」，两步在同一次 write 里；帧一大，
// 终端就可能在两步之间刷新一次，后写的下半部分先空一瞬，表现为下半屏持续闪烁。
const BEGIN_SYNC = '\u001B[?2026h';
const END_SYNC = '\u001B[?2026l';

// 最多四条路径会请求离开交替缓冲区（正常退出、信号、未捕获异常、未处理拒绝），
// 离开两次会让终端回滚过头。
let entered = false;
// 切换到交替屏幕缓冲区。不清屏也不动光标：新的交替缓冲区本就从第 1 行空起，
// 正好是 ink 第一次 logUpdate 要开始的位置。
export function enterFullScreen(stream: NodeJS.WriteStream): void {
    if (entered) {
        return;
    }
    entered = true;
    stream.write(ENTER_ALT_SCREEN);
}

// 把 ink 的每一次帧写入包进同步输出序列。
//
// ink 每帧写 eraseLines(上一帧行数) + 整帧文本：擦除自下而上、重画自上而下，同一次 write。
// 终端不保证按 write 边界呈现——帧越大越可能在擦完、还没画完的中间态刷一次屏，此时下半部分
// 已被擦掉而尚未重写，只有下半屏在闪。包上 DEC 2026 后整帧是原子更新，不再呈现中间态；
// 不认识该模式的终端会忽略这两个序列（私有模式的标准行为），所以无需能力探测。
//
// 只包住成帧的写入：判据是写入里含 eraseLines 或 clearTerminal——ink 只在重绘帧时才发这两者。
export function installSynchronizedOutput(stream: NodeJS.WriteStream): () => void {
    const original = stream.write.bind(stream);
    const patched = (chunk: unknown, ...rest: unknown[]): boolean => {
        if (typeof chunk === 'string' && (chunk.includes('[2K') || chunk.includes('[2J'))) {
            return (original as (...args: unknown[]) => boolean)(BEGIN_SYNC + chunk + END_SYNC, ...rest);
        }
        return (original as (...args: unknown[]) => boolean)(chunk, ...rest);
    };
    stream.write = patched;
    return () => {
        stream.write = original;
    };
}

// 终端尺寸实际变化时擦除交替缓冲区。
//
// ink 增量重绘：log-update 每帧前写 eraseLines(previousLineCount)，其中 previousLineCount
// 是上一帧的*逻辑*高度。终端变窄时控制台宿主会重排已显示内容——与旧框架等宽的一行变成两
// 物理行——物理高度超过 ink 记录的值，擦除不够，旧框架底部残留在新框架之下：边框错位、背景文字透出。
//
// 两点保证它正确：
//  - 必须在 render() 之前安装：监听器按注册顺序触发，ink 自己的 resize 监听器会同步重绘，
//    之后再清会擦掉想保留的框架。
//  - 只在真实尺寸变化时触发：拖拽窗口边缘会爆发一串报告相同尺寸的事件；框架未变时 ink 跳过写入，
//    此时清屏只会留下一片空白。
export function installResizeClear(stream: NodeJS.WriteStream): () => void {
    let columns = stream.columns;
    let rows = stream.rows;
    const onResize = (): void => {
        if (stream.columns === columns && stream.rows === rows) {
            return;
        }
        columns = stream.columns;
        rows = stream.rows;
        if (entered) {
            stream.write(CLEAR_SCREEN);
        }
    };
    stream.on('resize', onResize);
    return () => {
        stream.off('resize', onResize);
    };
}

export function leaveFullScreen(stream: NodeJS.WriteStream): void {
    if (!entered) {
        return;
    }
    entered = false;
    // 显式恢复光标：ink 渲染时隐藏光标，若在隐藏与恢复之间崩溃，终端将没有可见光标。
    stream.write(LEAVE_ALT_SCREEN + SHOW_CURSOR);
}

// 无论进程如何结束都归还终端。返回值移除所有监听器，正常退出不会把它们遗留到进程结束。
export function installFullScreenGuards(stream: NodeJS.WriteStream): () => void {
    const onExit = (): void => {
        leaveFullScreen(stream);
    };
    const onSigint = (): void => {
        leaveFullScreen(stream);
        process.exit(130);
    };
    const onSigterm = (): void => {
        leaveFullScreen(stream);
        process.exit(143);
    };
    // 离开交替缓冲区时内容即被丢弃，错误必须在之后写入才能保留——并且写 stderr，
    // 它本就不在缓冲区里。
    const onFailure = (error: unknown): void => {
        leaveFullScreen(stream);
        process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
        process.exit(1);
    };

    process.on('exit', onExit);
    process.on('SIGINT', onSigint);
    process.on('SIGTERM', onSigterm);
    process.on('uncaughtException', onFailure);
    process.on('unhandledRejection', onFailure);

    return () => {
        process.off('exit', onExit);
        process.off('SIGINT', onSigint);
        process.off('SIGTERM', onSigterm);
        process.off('uncaughtException', onFailure);
        process.off('unhandledRejection', onFailure);
    };
}
