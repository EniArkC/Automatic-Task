import { PassThrough } from 'node:stream';

import type { IpcClient } from '@at/ipc';
import { RenderTuiApp } from '@at/tui';
import { render } from 'ink';
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';

import { frameMetrics, frameWidth, overlayBox } from '../../../src/tui/layout';
import { displayWidth } from '../../../src/tui/theme';

// A sub-window has to be opaque. ink has no compositing layer: an absolutely
// positioned box covers exactly the cells it writes, and every cell it skips
// shows whatever the frame underneath had drawn there. The first version used
// paddingX={1}, which ink reserves but never writes, so a column of the
// dashboard's box-drawing characters bled through down each side of the card.
//
// This opens the command palette and checks the card's own rows: inside the
// overlay's column span, every row must be the full overlay width and must not
// contain any of the characters only the frame underneath draws.
const frameGlyphs = /[│─╭╮╰╯]/;

// The sizes the second test sweeps. The terminal starts somewhere the sweep
// never asks for, so the first step is a real resize.
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
                    tasks: [{ taskId: 'hello-world', packageVersion: '1.0.0', enabled: true, schedule: '0 * * * *' }],
                });
            }
            if (method === 'run.list') {
                return Promise.resolve({
                    runs: [
                        {
                            runId: 'run-0123456789abcdef',
                            taskId: 'hello-world',
                            status: 'failed',
                            startedAt: '2026-01-01T00:00:00.000Z',
                            finishedAt: '2026-01-01T00:00:00.107Z',
                        },
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
    return new Promise((resolve) => setTimeout(resolve, 200));
}

// The cells of `line` covered by the overlay, measured in display cells so a
// CJK label counts for two.
function slice(line: string, left: number, width: number): string {
    let cell = 0;
    let out = '';
    for (const char of line) {
        const size = displayWidth(char);
        if (cell >= left && cell + size <= left + width) {
            out += char;
        }
        cell += size;
    }
    return out;
}

describe('overlay opacity', () => {
    it.each([
        [100, 30],
        [76, 24],
        [56, 20],
    ])(
        'covers every cell it owns in a %i x %i terminal',
        async (columns, rows) => {
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

            const instance = render(createElement(RenderTuiApp, { client: fakeClient() }), {
                stdout: stdout as unknown as NodeJS.WriteStream,
                stdin: stdin as unknown as NodeJS.ReadStream,
                debug: true,
                patchConsole: false,
                exitOnCtrlC: false,
            });

            try {
                await settle();
                // Ctrl+P opens the command palette.
                stdin.write('\x10');
                frames.length = 0;
                await settle();

                const lines = frameLines(frames);
                expect(lines.join('\n')).toContain('命令面板');

                const box = overlayBox(frameMetrics({ Columns: columns, Rows: rows }, 1));
                const covered = lines
                    .map((line, row) => ({ row, text: slice(line, box.Left, box.Width) }))
                    .filter((entry) => entry.row >= box.Top && entry.row < box.Top + box.Height);

                expect(covered.length).toBe(box.Height);
                // The overlay's own border is the first and last row; the rows in
                // between belong to the card and must carry none of the frame's
                // glyphs, and each must span the full card width.
                const bled = covered
                    .slice(1, -1)
                    .filter(
                        (entry) => frameGlyphs.test(entry.text.slice(1, -1)) || displayWidth(entry.text) !== box.Width,
                    )
                    .map((entry) => ({ row: entry.row, width: displayWidth(entry.text), text: entry.text }));
                expect(bled).toEqual([]);
            } finally {
                instance.unmount();
            }
        },
        30000,
    );

    it('keeps the frame at its full width while an overlay is open', async () => {
        const frames: string[] = [];
        const stdout = new PassThrough();
        Object.assign(stdout, { columns: 100, rows: 30, isTTY: true });
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

        const instance = render(createElement(RenderTuiApp, { client: fakeClient() }), {
            stdout: stdout as unknown as NodeJS.WriteStream,
            stdin: stdin as unknown as NodeJS.ReadStream,
            debug: true,
            patchConsole: false,
            exitOnCtrlC: false,
        });

        try {
            await settle();
            stdin.write('\x10');
            frames.length = 0;
            await settle();

            const lines = frameLines(frames);
            const ragged = lines
                .filter((line) => displayWidth(line) !== frameWidth(100))
                .map((line) => ({ width: displayWidth(line), line }));
            expect(ragged).toEqual([]);
        } finally {
            instance.unmount();
        }
    }, 30000);

    // Covering the card's own rectangle is not enough. A cell is not the unit
    // the terminal draws in: if the frame underneath has a CJK glyph straddling
    // the card's left edge, the card overwrites its second cell and orphans the
    // first, which still renders two columns wide -- the row shifts right by one
    // and the border stops lining up. Which glyph lands on the edge depends on
    // the terminal width, so the defect appeared and vanished as the window was
    // dragged, and vanished for good when the card was closed.
    it('keeps the frame square while the palette is open across a size sweep', async () => {
        const frames: string[] = [];
        const stdout = new PassThrough();
        Object.assign(stdout, { columns: 80, rows: 26, isTTY: true });
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
            debug: true,
            patchConsole: false,
            exitOnCtrlC: false,
        });

        try {
            await settle();
            stdin.write('\x10');
            await settle();
            // The sweep is only meaningful with the card actually open.
            expect(frameLines(frames).join('\n')).toContain('命令面板');

            const bad: unknown[] = [];
            for (const [columns, rows] of sizes) {
                resizable.columns = columns;
                resizable.rows = rows;
                // Cleared before the emit, not after: ink's resize handler
                // renders synchronously, so clearing afterwards throws away the
                // very frame under test and leaves nothing if the animation
                // happens not to tick during the settle window.
                frames.length = 0;
                stdout.emit('resize');
                await settle();

                const lines = frameLines(frames);
                if (lines.length === 0) {
                    bad.push({ columns, rows, empty: true });
                    continue;
                }
                if (lines.length > rows - 1) {
                    bad.push({ columns, rows, tall: lines.length });
                }
                for (const line of lines) {
                    if (displayWidth(line) !== frameWidth(columns)) {
                        bad.push({ columns, rows, width: displayWidth(line), line });
                    }
                }
            }
            expect(bad).toEqual([]);
        } finally {
            instance.unmount();
        }
    }, 30000);
});
