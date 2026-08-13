import { PassThrough } from 'node:stream';

import type { IpcClient } from '@at/ipc';
import { RenderTuiApp } from '@at/tui';
import { render } from 'ink';
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';

import { frameWidth } from '../../../src/tui/layout';
import { displayWidth } from '../../../src/tui/theme';

// Acceptance test for resizing. The layout used to assume a 56-column minimum
// frame, so anything narrower wrote past ink's grid and the right border slid
// inward -- 294 ragged lines at 50 columns. This drives one mounted app through
// a sweep of sizes and measures the frame after each one.
//
// The measurement is done on ink's own output rather than through a
// pseudo-terminal on purpose: a PTY re-encodes runs of spaces as cursor moves,
// so a line read back off the screen cannot be distinguished from a line that
// collapsed. tests/integration/tui-resize.test.ts covers the PTY side, but only
// for survival.
//
// The sweep ends where it started: an implementation that carries state between
// sizes (a stale scroll offset, a memoized width) fails that last step even
// though it passed the identical first one.
const sizes: [number, number][] = [
    [50, 24],
    [40, 20],
    [76, 30],
    [100, 16],
    [56, 12],
    [140, 40],
    [50, 24],
];

type TResizable = NodeJS.WriteStream & { columns: number; rows: number };

function fakeClient(): IpcClient {
    const client = {
        Connect: (): Promise<void> => Promise.resolve(),
        Close: (): void => undefined,
        OnEvent: (): void => undefined,
        SendRequest: (method: string): Promise<unknown> => {
            if (method === 'task.list') {
                return Promise.resolve({
                    tasks: [
                        { taskId: 'hello-world', packageVersion: '1.0.0', enabled: true, schedule: '0 * * * *' },
                        { taskId: '中文任务名称很长很长很长很长', packageVersion: '2.11.3', enabled: false },
                    ],
                });
            }
            if (method === 'run.list') {
                return Promise.resolve({
                    runs: [
                        {
                            runId: 'run-0123456789abcdef',
                            taskId: 'hello-world',
                            status: 'success',
                            startedAt: '2026-01-01T00:00:00.000Z',
                            finishedAt: '2026-01-01T00:00:12.000Z',
                        },
                        { runId: 'run-fedcba9876543210', taskId: '中文任务名称很长很长很长很长', status: 'running' },
                    ],
                });
            }
            return Promise.resolve({});
        },
    };
    return client as unknown as IpcClient;
}

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

function settle(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 120));
}

describe('tui resize', () => {
    it('keeps every line at the frame width across a size sweep', async () => {
        const frames: string[] = [];
        const stdout = new PassThrough();
        Object.assign(stdout, { columns: sizes[0]?.[0], rows: sizes[0]?.[1], isTTY: true });
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

        const resizable = stdout as unknown as TResizable;
        const instance = render(createElement(RenderTuiApp, { client: fakeClient() }), {
            stdout: resizable,
            stdin: stdin as unknown as NodeJS.ReadStream,
            // debug 模式让 ink 每帧原样写进 stdout。默认路径在 CI 下（`is-in-ci`
            // 认到 `CI` 环境变量）只把帧存进内部字段、根本不写流。
            debug: true,
            patchConsole: false,
            exitOnCtrlC: false,
        });

        try {
            await settle();
            for (const [columns, rows] of sizes) {
                resizable.columns = columns;
                resizable.rows = rows;
                // Cleared before the emit, not after: ink's resize handler
                // renders synchronously, so clearing afterwards throws away the
                // very frame under test.
                frames.length = 0;
                stdout.emit('resize');
                await settle();

                const lines = frameLines(frames);
                expect({ columns, rows, empty: lines.length === 0 }).toEqual({ columns, rows, empty: false });
                expect(lines.length).toBeLessThanOrEqual(rows - 1);
                const ragged = lines
                    .filter((line) => displayWidth(line) !== frameWidth(columns))
                    .map((line) => ({ columns, rows, width: displayWidth(line), line }));
                expect(ragged).toEqual([]);
            }
        } finally {
            instance.unmount();
        }
    }, 30000);
});
