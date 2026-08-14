import { PassThrough } from 'node:stream';

import type { IpcClient } from '@at/ipc';
import { RenderTuiApp } from '@at/tui';
import { render } from 'ink';
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';

import {
    boxContentWidth,
    dashboardMetrics,
    frameHeight,
    frameMetrics,
    frameWidth,
    rowColumnWidths,
    runRowColumns,
    taskRowColumns,
} from '../../../src/tui/layout';
import { displayWidth, layout, padCells, truncateCells, wrapCells } from '../../../src/tui/theme';

// The whole interface is built on one promise: every line is exactly the frame
// width, whatever the terminal size. ink makes that easy to break -- it deletes
// cells a row never wrote (Output.get filters undefined entries and trims the
// line end), so a row that stops short pulls the right border of its box
// inward. These tests render the real component tree into a captured buffer and
// measure what ink emits, which is the only place the invariant is observable:
// a pseudo-terminal re-encodes runs of spaces as cursor moves, so reading the
// screen back cannot distinguish padding from a collapsed row.

type TFakeStream = {
    Frames: string[];
    Stdout: NodeJS.WriteStream;
    Stdin: NodeJS.ReadStream;
};

// ink talks to its streams as event emitters (raw-mode setup calls
// stdin.addListener), so plain objects are not enough -- these are real
// streams with the TTY fields ink reads, and stdout.write is swapped for a
// collector so each frame is kept whole instead of being concatenated.
function fakeStreams(columns: number, rows = 40): TFakeStream {
    const frames: string[] = [];
    const stdout = new PassThrough();
    Object.assign(stdout, { columns, rows, isTTY: true });
    stdout.write = (chunk: unknown): boolean => {
        frames.push(String(chunk));
        return true;
    };
    const stdin = new PassThrough();
    Object.assign(stdin, {
        isTTY: true,
        setRawMode: (): unknown => stdin,
        ref: (): unknown => stdin,
        unref: (): unknown => stdin,
    });
    return {
        Frames: frames,
        Stdout: stdout as unknown as NodeJS.WriteStream,
        Stdin: stdin as unknown as NodeJS.ReadStream,
    };
}

function fakeClient(tasks: unknown[], runs: unknown[]): IpcClient {
    const client = {
        Connect: (): Promise<void> => Promise.resolve(),
        Close: (): void => undefined,
        OnEvent: (): void => undefined,
        SendRequest: (method: string): Promise<unknown> => {
            if (method === 'task.list') {
                return Promise.resolve({ tasks });
            }
            if (method === 'run.list') {
                return Promise.resolve({ runs });
            }
            return Promise.resolve({});
        },
    };
    return client as unknown as IpcClient;
}

// The visible lines of the most recent frame, with the escape sequences that
// carry colour and cursor movement removed. ink interleaves bare cursor-control
// writes with the frames, so the last write is not necessarily the last frame:
// take the last one that still has visible text after stripping.
function frameLines(frames: string[]): string[] {
    const stripped = frames.map((frame) =>
        frame
            .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
            .split('\n')
            .map((line) => line.replace(/\r/g, ''))
            .filter((line) => line !== ''),
    );
    return stripped.filter((lines) => lines.length > 0).at(-1) ?? [];
}

async function renderApp(columns: number, tasks: unknown[], runs: unknown[], rows = 40): Promise<string[]> {
    const streams = fakeStreams(columns, rows);
    const instance = render(createElement(RenderTuiApp, { client: fakeClient(tasks, runs) }), {
        stdout: streams.Stdout,
        stdin: streams.Stdin,
        // debug 模式让 ink 每帧原样写进 stdout。默认路径在 CI 下（`is-in-ci` 认到
        // `CI` 环境变量）只把帧存进内部字段、根本不写流，假 stdout 会一片空白。
        debug: true,
        patchConsole: false,
        exitOnCtrlC: false,
    });
    // One macrotask is enough for the connect promise and the first reload to
    // settle, so the frame under test carries real data.
    await new Promise((resolve) => setTimeout(resolve, 200));
    // Snapshot before unmounting: teardown writes a cursor-restore frame that
    // carries no layout.
    const frames = [...streams.Frames];
    instance.unmount();
    return frameLines(frames);
}

const sampleTasks = [
    { taskId: 'hello-world', packageVersion: '1.0.0', enabled: true, schedule: '0 * * * *', overlap: 'skip' },
    { taskId: '中文任务名称很长很长很长很长', packageVersion: '2.11.3', enabled: false, overlap: 'queue' },
];

const sampleRuns = [
    {
        runId: 'run-0123456789abcdef',
        taskId: 'hello-world',
        status: 'success',
        startedAt: '2026-01-01T00:00:00.000Z',
        finishedAt: '2026-01-01T00:00:12.000Z',
    },
    { runId: 'run-fedcba9876543210', taskId: '中文任务名称很长很长很长很长', status: 'running' },
];

describe('tui layout', () => {
    it.each([140, 100, 80, 64, 56, 50, 40])(
        'renders every line at the frame width in a %i column terminal',
        async (columns) => {
            const lines = await renderApp(columns, sampleTasks, sampleRuns);
            const expected = frameWidth(columns);
            expect(lines.length).toBeGreaterThan(5);
            for (const line of lines) {
                expect({ line, width: displayWidth(line) }).toEqual({ line, width: expected });
            }
        },
    );

    it('fills the terminal width at every size', async () => {
        for (const columns of [200, 77]) {
            const lines = await renderApp(columns, sampleTasks, sampleRuns);
            expect(displayWidth(lines[0] ?? '')).toBe(columns - 1);
        }
    });

    // Root cause D: a frame as tall as the terminal makes ink fall back to
    // clearTerminal on every write, which is the flicker. Staying one row short
    // keeps it on the cheap eraseLines path.
    it.each([
        [100, 40],
        [100, 24],
        [100, 16],
        [80, 14],
        [56, 12],
    ])('fits inside a %i x %i terminal', async (columns, rows) => {
        const lines = await renderApp(columns, sampleTasks, sampleRuns, rows);
        expect(lines.length).toBeLessThanOrEqual(rows - 1);
        for (const line of lines) {
            expect({ line, width: displayWidth(line) }).toEqual({ line, width: frameWidth(columns) });
        }
    });

    it('renders empty lists without collapsing the panels', async () => {
        const lines = await renderApp(100, [], []);
        for (const line of lines) {
            expect({ line, width: displayWidth(line) }).toEqual({ line, width: frameWidth(100) });
        }
    });

    it('shows a borderless notice below the minimum size', async () => {
        const lines = await renderApp(30, sampleTasks, sampleRuns, 10);
        expect(lines.join('\n')).toContain('窗口过小');
        for (const line of lines) {
            expect(line).not.toMatch(/[│╭╰]/);
        }
    });
});

// The pure sizing functions carry the invariants that root causes A and C
// violated; they are cheap enough to check exhaustively.
describe('sizing engine', () => {
    it('splits the dashboard into panels that add up to the frame width', () => {
        for (let columns = layout.TwoColumnMin; columns <= 200; columns += 1) {
            const dash = dashboardMetrics(frameMetrics({ Columns: columns, Rows: 40 }, 1));
            expect({ columns, sum: dash.TaskWidth + layout.PanelGap + dash.RunWidth }).toEqual({
                columns,
                sum: frameWidth(columns),
            });
        }
    });

    it('splits the frame height into banner, content and footer', () => {
        for (let rows = layout.MinRows; rows <= 60; rows += 1) {
            const metrics = frameMetrics({ Columns: 100, Rows: rows }, 2);
            expect({ rows, sum: metrics.BannerRows + metrics.ContentRows + metrics.FooterRows }).toEqual({
                rows,
                sum: frameHeight(rows),
            });
        }
    });

    it('shrinks task row columns to exactly the row width', () => {
        for (let width = 12; width <= 120; width += 1) {
            const columns = taskRowColumns(width);
            const sum =
                rowColumnWidths.Marker +
                rowColumnWidths.Status +
                columns.Name +
                (columns.ShowVersion ? rowColumnWidths.Version : 0) +
                (columns.ShowSchedule ? rowColumnWidths.Schedule : 0);
            expect({ width, sum }).toEqual({ width, sum: width });
        }
    });

    it('shrinks run row columns to exactly the row width', () => {
        for (let width = 12; width <= 120; width += 1) {
            const columns = runRowColumns(width);
            const sum =
                rowColumnWidths.Marker +
                rowColumnWidths.Status +
                columns.Name +
                (columns.ShowId ? rowColumnWidths.Id : 0) +
                (columns.ShowDuration ? rowColumnWidths.Duration : 0);
            expect({ width, sum }).toEqual({ width, sum: width });
        }
    });
});

describe('cell helpers', () => {
    it('measures wide code points as two cells', () => {
        expect(displayWidth('abc')).toBe(3);
        expect(displayWidth('中文')).toBe(4);
        expect(displayWidth('中a文')).toBe(5);
    });

    it('pads to an exact cell width regardless of the characters used', () => {
        for (const text of ['', 'a', '中', '中文任务', '↑↓ 选择 · Tab 切换栏']) {
            expect(displayWidth(padCells(text, 20))).toBe(20);
        }
    });

    it('truncates to at most the requested width, never splitting a wide cell', () => {
        expect(truncateCells('中文任务名称', 5)).toBe('中文…');
        expect(displayWidth(truncateCells('中文任务名称', 5))).toBeLessThanOrEqual(5);
        expect(truncateCells('abc', 10)).toBe('abc');
    });

    it('treats newlines as hard line breaks so a multi-line message never leaks a bare \\n', () => {
        // AtParseError 的 message 是 `\n` 拼接的多行文本；若 wrapCells 把 `\n` 当普通
        // 字符计数，ink 的 <Text> 会把它渲染成真实换行，撑破 toast/confirm 的定高盒子。
        expect(wrapCells('task.ats:14:1\n# 旧的注释\n^', 20, 3)).toEqual(['task.ats:14:1', '# 旧的注释', '^']);
        // 任何一行都不该再含换行符，否则下游 padCells 会算错宽度。
        for (const line of wrapCells('a\nb\nc\nd', 8, 3)) {
            expect(line).not.toContain('\n');
        }
    });

    it('reserves the border and both gutters of a box', () => {
        expect(boxContentWidth(80)).toBe(76);
        expect(boxContentWidth(2)).toBe(1);
    });

    it('never exceeds the terminal, so the last column cannot wrap', () => {
        expect(frameWidth(200)).toBe(199);
        expect(frameWidth(80)).toBe(79);
        expect(frameWidth(10)).toBe(9);
    });
});
