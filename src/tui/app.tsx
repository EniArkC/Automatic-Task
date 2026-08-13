import type { IpcClient } from '@at/ipc';
import { Box, Text, useApp, useInput } from 'ink';
import { type ReactElement, type ReactNode, useEffect, useState } from 'react';

import {
    countHintRows,
    RenderBanner,
    RenderFooter,
    RenderFrame,
    RenderPanel,
    RenderScrollBox,
    RenderTooSmall,
    type TConnectionBadge,
    type TKeyHint,
    type TScrollRow,
    useTerminalSize,
} from './components';
import { type TRunRow, type TTaskRow, type TTuiAction, type TTuiState, useTui } from './hooks';
import {
    boxContentWidth,
    confirmBox,
    confirmContentWidth,
    dashboardMetrics,
    frameMetrics,
    logRows,
    overlayBox,
    runRowColumns,
    taskRowColumns,
    type TDashboardMetrics,
    type TFrameMetrics,
    toastBox,
    toastContentWidth,
} from './layout';
import { RenderConfirm, RenderToast } from './overlay';
import { RenderCommandPalette, type TCommand } from './overlays/command-palette';
import { RenderFilePicker } from './overlays/file-picker';
import { RenderOptionSelect, type TOption } from './overlays/option-select';
import { RenderSettingsForm } from './settings-form';
import { RenderTaskForm } from './task-form';
import {
    clampOffset,
    formatClock,
    formatDuration,
    layout,
    padCells,
    palette,
    shortId,
    statusMeta,
    wrapCells,
} from './theme';

type TView =
    | { Kind: 'dashboard' }
    | { Kind: 'config'; TaskId: string }
    | { Kind: 'settings' }
    | { Kind: 'logs'; RunId: string; TaskId: string | undefined };

type TFocus = 'tasks' | 'runs';

// 子窗口状态只能放这里：RenderFrame 是唯一能承载 overlay 的地方，表单通过回调申请而不是自己渲染。
type TOverlay =
    | { Kind: 'palette' }
    | { Kind: 'file' }
    | { Kind: 'option'; Title: string; Options: TOption[]; Index: number; OnPick: (value: string) => void }
    | { Kind: 'confirm'; Title: string; Message: string; OnConfirm: () => void };

function connectionBadge(state: TTuiState): TConnectionBadge {
    if (state.Connection === 'connected') {
        return { Glyph: '●', Color: palette.Success, Label: '已连接' };
    }
    if (state.Connection === 'connecting') {
        return { Glyph: '◌', Color: palette.Warning, Label: '连接中' };
    }
    return { Glyph: '○', Color: palette.Danger, Label: '未连接' };
}

function runDuration(run: TRunRow, now: number): string {
    if (run.startedAt === undefined) {
        return '-';
    }
    const started = Date.parse(run.startedAt);
    if (Number.isNaN(started)) {
        return '-';
    }
    const end = run.finishedAt === undefined ? now : Date.parse(run.finishedAt);
    return formatDuration((Number.isNaN(end) ? now : end) - started);
}

// 运行开始时间格式化为 `MM-DD HH:mm:ss`，替代原始 ULID 显示在运行行和日志页标题。
function formatRunTime(startedAt: string | undefined): string {
    if (startedAt === undefined) {
        return '--------';
    }
    const date = new Date(startedAt);
    if (Number.isNaN(date.getTime())) {
        return '--------';
    }
    const pad = (value: number): string => String(value).padStart(2, '0');
    return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

// 行恰好占 `width` 格：尾列固定宽，名称在定宽 Box 内取余量，截断防止长名称把尾部挤出面板。
function RenderTaskLine({
    task,
    selected,
    focused,
    width,
}: {
    task: TTaskRow;
    selected: boolean;
    focused: boolean;
    width: number;
}): ReactElement {
    const columns = taskRowColumns(width);
    const scheduleText = task.schedule === undefined || task.schedule === '' ? '手动' : task.schedule;
    return (
        <Box width={width} flexShrink={0}>
            <Text color={selected && focused ? palette.Selected : palette.Muted}>{selected ? '›' : ' '}</Text>
            <Text color={task.enabled === true ? palette.Success : palette.Muted}>
                {task.enabled === true ? ' ◉ ' : ' ◎ '}
            </Text>
            <Box width={columns.Name} flexShrink={0}>
                <Text
                    bold={selected}
                    color={selected ? (focused ? palette.Selected : palette.Title) : undefined}
                    wrap="truncate"
                >
                    {task.taskId}
                </Text>
            </Box>
            {columns.ShowVersion ? (
                <Text color={palette.Muted}>{padCells(` ${task.packageVersion ?? ''}`, 9)}</Text>
            ) : undefined}
            {columns.ShowSchedule ? <Text color={palette.Muted}>{padCells(scheduleText, 12)}</Text> : undefined}
        </Box>
    );
}

function RenderRunLine({
    run,
    selected,
    focused,
    now,
    width,
}: {
    run: TRunRow;
    selected: boolean;
    focused: boolean;
    now: number;
    width: number;
}): ReactElement {
    const columns = runRowColumns(width);
    const meta = statusMeta(run.status ?? '');
    return (
        <Box width={width} flexShrink={0}>
            <Text color={selected && focused ? palette.Selected : palette.Muted}>{selected ? '›' : ' '}</Text>
            <Text color={meta.Color}>{` ${meta.Glyph} `}</Text>
            <Box width={columns.Name} flexShrink={0}>
                <Text
                    bold={selected}
                    color={selected ? (focused ? palette.Selected : palette.Title) : undefined}
                    wrap="truncate"
                >
                    {run.taskId ?? '-'}
                </Text>
            </Box>
            {columns.ShowId ? (
                <Text color={palette.Muted}>{padCells(formatRunTime(run.startedAt), 17)}</Text>
            ) : undefined}
            {columns.ShowDuration ? <Text color={palette.Muted}>{padCells(runDuration(run, now), 8)}</Text> : undefined}
        </Box>
    );
}

async function loadLogs(
    client: IpcClient,
    runId: string,
    taskId: string | undefined,
    dispatch: (action: TTuiAction) => void,
): Promise<void> {
    try {
        const result = (await client.SendRequest('logs.tail', { taskId, runId, lines: 400 })) as { lines?: unknown };
        const lines = Array.isArray(result.lines) ? result.lines.map((line) => String(line)) : [];
        dispatch({ Type: 'logs', Lines: lines });
    } catch (error) {
        dispatch({ Type: 'notice', Message: error instanceof Error ? error.message : String(error), Kind: 'error' });
    }
}

function RenderDashboard({
    state,
    dash,
    focus,
    taskIndex,
    runIndex,
    taskOffset,
    runOffset,
    blurred,
}: {
    state: TTuiState;
    dash: TDashboardMetrics;
    focus: TFocus;
    taskIndex: number;
    runIndex: number;
    taskOffset: number;
    runOffset: number;
    blurred: boolean;
}): ReactElement {
    const taskInner = boxContentWidth(dash.TaskWidth);
    const runInner = boxContentWidth(dash.RunWidth);

    const taskItems: TScrollRow[] = state.Tasks.slice(taskOffset, taskOffset + dash.ListRows).map((task, position) => ({
        Key: task.taskId,
        Node: (
            <RenderTaskLine
                task={task}
                selected={taskOffset + position === taskIndex}
                focused={!blurred && focus === 'tasks'}
                width={taskInner - 1}
            />
        ),
    }));

    const runItems: TScrollRow[] = state.Runs.slice(runOffset, runOffset + dash.ListRows).map((run, position) => ({
        Key: run.runId,
        Node: (
            <RenderRunLine
                run={run}
                selected={runOffset + position === runIndex}
                focused={!blurred && focus === 'runs'}
                now={state.Now}
                width={runInner - 1}
            />
        ),
    }));

    const tasks = (
        <RenderPanel
            title="任务"
            hint={`${String(state.Tasks.length)} 个`}
            width={dash.TaskWidth}
            rows={dash.ListRows}
            focused={!blurred && focus === 'tasks'}
        >
            <RenderScrollBox
                rows={dash.ListRows}
                width={taskInner}
                total={state.Tasks.length}
                offset={taskOffset}
                items={taskItems}
                empty="暂无任务，按 ^P 打开命令面板安装 .atp 包"
            />
        </RenderPanel>
    );

    const runs = (
        <RenderPanel
            title="运行记录"
            hint={`${String(state.Runs.length)} 条`}
            width={dash.RunWidth}
            rows={dash.ListRows}
            focused={!blurred && focus === 'runs'}
        >
            <RenderScrollBox
                rows={dash.ListRows}
                width={runInner}
                total={state.Runs.length}
                offset={runOffset}
                items={runItems}
                empty="暂无运行记录"
            />
        </RenderPanel>
    );

    if (!dash.TwoColumn) {
        return (
            <Box flexDirection="column" width={dash.TaskWidth} flexShrink={0}>
                {tasks}
                {runs}
            </Box>
        );
    }
    return (
        <Box width={dash.TaskWidth + layout.PanelGap + dash.RunWidth} flexShrink={0}>
            {tasks}
            <Box width={layout.PanelGap} flexShrink={0} />
            {runs}
        </Box>
    );
}

function RenderRunLogs({
    state,
    width,
    rows,
    runId,
    offset,
}: {
    state: TTuiState;
    width: number;
    rows: number;
    runId: string;
    offset: number;
}): ReactElement {
    const inner = boxContentWidth(width);
    const started = state.Runs.find((entry) => entry.runId === runId)?.startedAt;
    const items: TScrollRow[] = state.LogLines.slice(offset, offset + rows).map((line, position) => ({
        Key: `log-${String(offset + position)}`,
        Node: (
            <Box width={inner - 1} flexShrink={0}>
                <Text wrap="truncate">{line}</Text>
            </Box>
        ),
    }));
    return (
        <RenderPanel
            title={`日志 · ${shortId(runId)} · ${formatRunTime(started)}`}
            hint={`${String(state.LogLines.length)} 行`}
            width={width}
            rows={rows}
            focused
        >
            <RenderScrollBox
                rows={rows}
                width={inner}
                total={state.LogLines.length}
                offset={offset}
                items={items}
                empty="暂无输出"
            />
        </RenderPanel>
    );
}

// 仪表盘提示按焦点分组：只列出当前这一栏真正能用的键。以前无论焦点在哪都把
// 运行/启停/停止全摆出来，按下去却打在另一栏的选中项上。
const dashboardHeadHints: TKeyHint[] = [
    { Key: '↑↓', Label: '选择' },
    { Key: 'Tab', Label: '切换栏' },
    { Key: '↵', Label: '打开' },
];

const taskFocusHints: TKeyHint[] = [
    { Key: 'e', Label: '运行' },
    { Key: '空格', Label: '启停' },
];

const runFocusHints: TKeyHint[] = [{ Key: 'x', Label: '停止' }];

const dashboardTailHints: TKeyHint[] = [
    { Key: 'r', Label: '刷新' },
    { Key: '^P', Label: '命令' },
    { Key: 'q', Label: '退出' },
];

const logHints: TKeyHint[] = [
    { Key: '↑↓', Label: '滚动' },
    { Key: 'PgUp/PgDn', Label: '翻页' },
    { Key: 'g/G', Label: '首/末' },
    { Key: 'r', Label: '刷新' },
    { Key: 'Esc', Label: '返回' },
    { Key: 'q', Label: '退出' },
];

const configHints: TKeyHint[] = [
    { Key: '↑↓', Label: '选择' },
    { Key: '↵', Label: '编辑/选项' },
    { Key: '←→', Label: '切换选项' },
    { Key: 's', Label: '保存' },
    { Key: 'r', Label: '刷新' },
    { Key: 'Esc', Label: '返回' },
    { Key: 'q', Label: '退出' },
];

function hintsFor(view: TView, focus: TFocus): TKeyHint[] {
    if (view.Kind === 'logs') {
        return logHints;
    }
    if (view.Kind === 'config' || view.Kind === 'settings') {
        return configHints;
    }
    return [...dashboardHeadHints, ...(focus === 'tasks' ? taskFocusHints : runFocusHints), ...dashboardTailHints];
}

export function RenderTuiApp({ client }: { client: IpcClient }): ReactElement {
    const { State: state, Dispatch: dispatch, Reload: reload } = useTui(client);
    const { exit } = useApp();
    const size = useTerminalSize();

    const [view, setView] = useState<TView>({ Kind: 'dashboard' });
    const [overlay, setOverlay] = useState<TOverlay | undefined>(undefined);
    const [focus, setFocus] = useState<TFocus>('tasks');
    const [taskIndex, setTaskIndex] = useState(0);
    const [runIndex, setRunIndex] = useState(0);
    const [taskOffset, setTaskOffset] = useState(0);
    const [runOffset, setRunOffset] = useState(0);
    const [logOffset, setLogOffset] = useState(0);

    // 分两遍计算而非迭代：提示行打包需要框架宽度，页脚高度需要提示行数，但宽度不依赖二者。
    const hints = hintsFor(view, focus);
    const probe = frameMetrics(size, 1);
    const hintRows = countHintRows(hints, boxContentWidth(probe.Width), layout.MaxHintRows);
    const metrics: TFrameMetrics = frameMetrics(size, hintRows);
    const dash = dashboardMetrics(metrics);
    const box = overlayBox(metrics);

    const boundedTask = Math.min(taskIndex, Math.max(0, state.Tasks.length - 1));
    const boundedRun = Math.min(runIndex, Math.max(0, state.Runs.length - 1));
    // 派生而非存储：clampOffset 是纯幂等函数，每帧重算零开销，resize 时无需渲染阶段 setState 也能保持偏移正确。
    const visibleTaskOffset = clampOffset(state.Tasks.length, dash.ListRows, boundedTask, taskOffset);
    const visibleRunOffset = clampOffset(state.Runs.length, dash.ListRows, boundedRun, runOffset);

    const selectedTask = state.Tasks[boundedTask];
    const selectedRun = state.Runs[boundedRun];

    const notify = (message: string, kind: 'info' | 'error'): void => {
        dispatch({ Type: 'notice', Message: message, Kind: kind });
    };

    // toast 自动消失。key 取序号+消息，相同通知再次到达会重新计时而不是继承上一次的剩余时间。
    const notice = state.Notice;
    const noticeSeq = state.NoticeSeq;
    useEffect(() => {
        if (notice === undefined) {
            return undefined;
        }
        const timer = setTimeout(() => {
            dispatch({ Type: 'notice', Message: undefined });
        }, layout.ToastMs);
        return () => {
            clearTimeout(timer);
        };
    }, [notice, noticeSeq, dispatch]);

    const call = async (method: string, params: Record<string, unknown>, success: string): Promise<void> => {
        try {
            await client.SendRequest(method, params);
            notify(success, 'info');
            reload();
        } catch (error) {
            notify(error instanceof Error ? error.message : String(error), 'error');
        }
    };

    const openLogs = (run: TRunRow): void => {
        dispatch({ Type: 'selectRun', RunId: run.runId });
        dispatch({ Type: 'logs', Lines: [] });
        setLogOffset(0);
        setView({ Kind: 'logs', RunId: run.runId, TaskId: run.taskId });
        void loadLogs(client, run.runId, run.taskId, dispatch);
    };

    const install = (path: string): void => {
        const trimmed = path.trim();
        if (trimmed === '') {
            return;
        }
        void call('task.install', { atpPath: trimmed }, `已安装 ${trimmed}`);
    };

    const moveTask = (next: number): void => {
        setTaskIndex(next);
        setTaskOffset(clampOffset(state.Tasks.length, dash.ListRows, next, visibleTaskOffset));
    };

    const moveRun = (next: number): void => {
        setRunIndex(next);
        setRunOffset(clampOffset(state.Runs.length, dash.ListRows, next, visibleRunOffset));
    };

    const rows = logRows(metrics);
    const maxLogOffset = Math.max(0, state.LogLines.length - rows);

    useInput(
        (input, key) => {
            if (metrics.TooSmall) {
                if (input === 'q') {
                    exit();
                }
                return;
            }

            if (view.Kind === 'logs') {
                if (key.escape) {
                    setView({ Kind: 'dashboard' });
                    dispatch({ Type: 'selectRun', RunId: undefined });
                    return;
                }
                if (input === 'q') {
                    exit();
                    return;
                }
                if (key.upArrow) {
                    setLogOffset((value) => Math.max(0, value - 1));
                    return;
                }
                if (key.downArrow) {
                    setLogOffset((value) => Math.min(maxLogOffset, value + 1));
                    return;
                }
                if (key.pageUp) {
                    setLogOffset((value) => Math.max(0, value - rows));
                    return;
                }
                if (key.pageDown) {
                    setLogOffset((value) => Math.min(maxLogOffset, value + rows));
                    return;
                }
                if (input === 'g') {
                    setLogOffset(0);
                    return;
                }
                if (input === 'G') {
                    setLogOffset(maxLogOffset);
                    return;
                }
                if (input === 'r') {
                    void loadLogs(client, view.RunId, view.TaskId, dispatch);
                }
                return;
            }

            if (key.ctrl && input === 'p') {
                setOverlay({ Kind: 'palette' });
                return;
            }
            if (input === 'q') {
                exit();
                return;
            }
            if (key.tab) {
                setFocus((value) => (value === 'tasks' ? 'runs' : 'tasks'));
                return;
            }
            if (key.upArrow) {
                if (focus === 'tasks') {
                    moveTask(Math.max(0, boundedTask - 1));
                } else {
                    moveRun(Math.max(0, boundedRun - 1));
                }
                return;
            }
            if (key.downArrow) {
                if (focus === 'tasks') {
                    moveTask(Math.min(state.Tasks.length - 1, boundedTask + 1));
                } else {
                    moveRun(Math.min(state.Runs.length - 1, boundedRun + 1));
                }
                return;
            }
            if (key.return) {
                // 回车打开什么取决于焦点在哪栏：任务栏开配置表单，运行栏开日志。
                if (focus === 'tasks') {
                    if (selectedTask !== undefined) {
                        setView({ Kind: 'config', TaskId: selectedTask.taskId });
                    }
                } else if (selectedRun !== undefined) {
                    openLogs(selectedRun);
                }
                return;
            }
            // 运行/启停只对任务栏生效，停止只对运行记录栏生效：焦点不在对应栏时按键直接落空，
            // 而不是作用到另一栏的选中项上。
            if (input === 'e' && focus === 'tasks' && selectedTask !== undefined) {
                void call('task.run', { taskId: selectedTask.taskId }, `已触发 ${selectedTask.taskId}`);
                return;
            }
            if (input === ' ' && focus === 'tasks' && selectedTask !== undefined) {
                const method = selectedTask.enabled === true ? 'task.disable' : 'task.enable';
                void call(
                    method,
                    { taskId: selectedTask.taskId },
                    `${selectedTask.taskId} 已${selectedTask.enabled === true ? '停用' : '启用'}`,
                );
                return;
            }
            if (input === 'x' && focus === 'runs' && selectedRun !== undefined) {
                void call('run.stop', { runId: selectedRun.runId }, `已请求停止 ${shortId(selectedRun.runId)}`);
                return;
            }
            if (input === 'r') {
                reload();
                notify('已刷新', 'info');
            }
        },
        // 任意时刻只有一个输入处理器生效：两个表单视图和子窗口打开时各自独占键盘。
        { isActive: view.Kind !== 'config' && view.Kind !== 'settings' && overlay === undefined },
    );

    // 确认卡打开期间独占键盘：y/回车确认，n/Esc 取消。
    // 必须放在下面的提前返回之前——hook 不能出现在条件返回之后，否则跨过"过小"阈值时 hook 顺序会变。
    useInput(
        (input, key) => {
            if (overlay?.Kind !== 'confirm') {
                return;
            }
            if (input === 'y' || key.return) {
                const confirmed = overlay;
                setOverlay(undefined);
                confirmed.OnConfirm();
            } else if (input === 'n' || key.escape) {
                setOverlay(undefined);
            }
        },
        { isActive: overlay?.Kind === 'confirm' },
    );

    if (metrics.TooSmall) {
        return <RenderTooSmall columns={size.Columns} rows={size.Rows} />;
    }

    // 命令面板收纳没有仪表盘快捷键的动作：全局配置、装卸任务包、清理日志。
    const command = (id: string, label: string, hint: string, run: () => void): TCommand => ({
        Id: id,
        Label: label,
        Hint: hint,
        Run: () => {
            setOverlay(undefined);
            run();
        },
    });
    const commands: TCommand[] = [
        command('app.config', '全局配置', '', () => {
            setView({ Kind: 'settings' });
        }),
        command('task.install', '安装任务包', '', () => {
            setOverlay({ Kind: 'file' });
        }),
        command('task.uninstall', '卸载任务包', '', () => {
            // 先选包再确认：焦点可能停在运行记录栏，不能默认卸载任务栏的选中项。
            if (state.Tasks.length === 0) {
                notify('没有已安装的任务包', 'error');
                return;
            }
            setOverlay({
                Kind: 'option',
                Title: '选择要卸载的任务包',
                Options: state.Tasks.map((task) => ({
                    Value: task.taskId,
                    Label: task.taskId,
                    Hint: task.packageVersion ?? '',
                })),
                Index: 0,
                OnPick: (taskId) => {
                    setOverlay({
                        Kind: 'confirm',
                        Title: '卸载任务包',
                        Message: `将删除任务包 ${taskId} 及其配置，且不可恢复。确认？`,
                        OnConfirm: () => {
                            void call('task.uninstall', { taskId }, `已卸载 ${taskId}`);
                        },
                    });
                },
            });
        }),
        command('runs.clear', '清理全部缓存', '', () => {
            setOverlay({
                Kind: 'confirm',
                Title: '清理全部缓存',
                Message: '将删除所有已结束运行的记录、日志与工作区文件，且不可恢复。确认？',
                OnConfirm: () => {
                    void call('runs.prune', { days: 0 }, '已清空全部缓存');
                },
            });
        }),
    ];

    const closeOverlay = (): void => {
        setOverlay(undefined);
    };

    let overlayNode: ReactNode = undefined;
    if (overlay?.Kind === 'palette') {
        overlayNode = <RenderCommandPalette box={box} commands={commands} OnCancel={closeOverlay} />;
    } else if (overlay?.Kind === 'file') {
        overlayNode = (
            <RenderFilePicker
                box={box}
                title="选择 .atp 任务包"
                root={process.env.USERPROFILE ?? process.cwd()}
                extension=".atp"
                OnPick={(path) => {
                    closeOverlay();
                    install(path);
                }}
                OnCancel={closeOverlay}
            />
        );
    } else if (overlay?.Kind === 'option') {
        const picker = overlay;
        overlayNode = (
            <RenderOptionSelect
                box={box}
                title={picker.Title}
                options={picker.Options}
                index={picker.Index}
                OnMove={(next) => {
                    setOverlay({ ...picker, Index: next });
                }}
                OnPick={(value) => {
                    closeOverlay();
                    picker.OnPick(value);
                }}
                OnCancel={closeOverlay}
            />
        );
    } else if (overlay?.Kind === 'confirm') {
        // 确认卡按内容定高：高度必须等于实际写出的行数，多余高度会露出底层框架。
        const confirmWidth = confirmContentWidth(metrics);
        const confirmLines = wrapCells(overlay.Message, confirmWidth, layout.ConfirmMaxLines);
        const confirmFooter = 'y 确认 · n/Esc 取消';
        overlayNode = (
            <RenderConfirm
                box={confirmBox(metrics, confirmWidth, confirmLines.length + 2)}
                title={overlay.Title}
                lines={confirmLines}
                footer={confirmFooter}
            />
        );
    }

    const blurred = overlay !== undefined;

    // 渲染在子窗口之后，子窗口打开时弹出的通知不会被卡片盖住。
    const toastLines = notice === undefined ? [] : wrapCells(notice, toastContentWidth(metrics), layout.ToastMaxLines);
    const toastNode =
        toastLines.length === 0 ? undefined : (
            <RenderToast
                box={toastBox(metrics, toastContentWidth(metrics), toastLines.length)}
                lines={toastLines}
                color={state.NoticeKind === 'error' ? palette.Danger : palette.Success}
                glyph={state.NoticeKind === 'error' ? '✗' : '✓'}
            />
        );

    return (
        <RenderFrame
            width={metrics.Width}
            height={metrics.Height}
            overlay={
                <>
                    {overlayNode}
                    {toastNode}
                </>
            }
        >
            <RenderBanner
                frame={state.Frame}
                width={metrics.Width}
                badge={connectionBadge(state)}
                clock={formatClock(state.Now)}
                big={metrics.BigBanner}
            />
            {view.Kind === 'config' ? (
                <RenderTaskForm
                    client={client}
                    taskId={view.TaskId}
                    metrics={metrics}
                    frame={state.Frame}
                    overlayOpen={blurred}
                    OnClose={() => {
                        setView({ Kind: 'dashboard' });
                    }}
                    OnNotice={notify}
                    OnReload={reload}
                    OnOpenOptions={(title, options, index, onPick) => {
                        setOverlay({ Kind: 'option', Title: title, Options: options, Index: index, OnPick: onPick });
                    }}
                />
            ) : view.Kind === 'settings' ? (
                <RenderSettingsForm
                    client={client}
                    metrics={metrics}
                    frame={state.Frame}
                    overlayOpen={blurred}
                    OnClose={() => {
                        setView({ Kind: 'dashboard' });
                    }}
                    OnNotice={notify}
                />
            ) : view.Kind === 'logs' ? (
                <RenderRunLogs
                    state={state}
                    width={metrics.Width}
                    rows={rows}
                    runId={view.RunId}
                    offset={Math.min(logOffset, maxLogOffset)}
                />
            ) : (
                <RenderDashboard
                    state={state}
                    dash={dash}
                    focus={focus}
                    taskIndex={boundedTask}
                    runIndex={boundedRun}
                    taskOffset={visibleTaskOffset}
                    runOffset={visibleRunOffset}
                    blurred={blurred}
                />
            )}
            <RenderFooter width={metrics.Width} hints={hints} maxRows={layout.MaxHintRows} />
        </RenderFrame>
    );
}
