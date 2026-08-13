import { spawn } from 'node:child_process';
import { join } from 'node:path';

import { type IPty, spawn as ptySpawn } from 'node-pty';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTempDir, interactiveEnv, removeDir } from '../helpers/test-utils';

// Resize survival test. The sweep drives a real ConPTY through a range of
// sizes and back to a size it has already visited; the assertion is only that
// the app keeps drawing at every step, because a PTY cannot be measured (see
// the comment at the assertion). Frame geometry is asserted in
// tests/unit/tui/resize.test.ts.
//
// The terminal starts at a size the sweep never asks for. Resizing to the size
// already in effect is a no-op all the way down -- ink does not repaint, and
// log-update skips the write when the frame is unchanged -- so a settled,
// perfectly healthy TUI would emit nothing and read as "stopped drawing".
const start: [number, number] = [80, 26];

let appRoot = '';
let testUser = '';
let runtimeProcess: ReturnType<typeof spawn> | undefined;

const REPO_ROOT = join(__dirname, '..', '..');

const sizes: [number, number][] = [
    [50, 24],
    [40, 20],
    [76, 30],
    [100, 16],
    [56, 12],
    [140, 40],
    [50, 24],
];

function clean(text: string): string {
    return text.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
}

function settle(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// Polls instead of sleeping a fixed span. A fixed window has to be long enough
// for the worst case, and the worst case here is the whole suite running in
// parallel: the TUI process gets preempted and a healthy repaint can land well
// after a window sized for an idle machine. Polling waits only as long as it
// has to, and a step that never draws still fails.
async function waitForDraw(read: () => string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        if (clean(read()).trim().length > 0) {
            return true;
        }
        if (Date.now() >= deadline) {
            return false;
        }
        await settle(50);
    }
}

beforeAll(() => {
    appRoot = createTempDir('at-resize-');
    testUser = `at-resize-${process.pid}`;
    runtimeProcess = spawn(process.execPath, ['--import', 'tsx', join(REPO_ROOT, 'src', 'runtime', 'main.ts')], {
        cwd: REPO_ROOT,
        stdio: 'ignore',
        env: { ...process.env, LOCALAPPDATA: appRoot, USERNAME: testUser, USER: testUser },
    });
});

afterAll(() => {
    runtimeProcess?.kill();
    removeDir(appRoot);
});

describe('tui resize', () => {
    it('keeps drawing across a size sweep in a real terminal', async () => {
        const pty: IPty = ptySpawn(
            process.execPath,
            ['--import', 'tsx', join(REPO_ROOT, 'src', 'cli', 'main.ts'), 'tui'],
            {
                name: 'xterm-256color',
                cols: start[0],
                rows: start[1],
                cwd: REPO_ROOT,
                env: interactiveEnv({ LOCALAPPDATA: appRoot, USERNAME: testUser, USER: testUser }),
            },
        );
        let output = '';
        pty.onData((chunk) => {
            output += chunk;
        });

        try {
            // Wait for the first frame before the sweep begins; the process
            // still has to start Node, connect, and render.
            expect(await waitForDraw(() => output, 20000)).toBe(true);
            // A short quiet period so the startup burst does not spill into the
            // first step's capture.
            await settle(500);

            for (const [cols, rows] of sizes) {
                // Cleared before the resize, not after: bytes that arrive
                // promptly would otherwise be wiped by our own bookkeeping.
                output = '';
                pty.resize(cols, rows);
                const drew = await waitForDraw(() => output, 5000);
                // Survival, not geometry: a PTY re-encodes runs of spaces as
                // cursor moves, so a line read back off the screen cannot be
                // told apart from a line that collapsed. Width is asserted in
                // tests/unit/tui/resize.test.ts, against ink's own output. What
                // this can prove is that the app kept drawing through the
                // resize instead of crashing or going silent -- including the
                // return to the starting size, which a stateful bug fails.
                expect({ cols, rows, drew }).toEqual({ cols, rows, drew: true });
            }
        } finally {
            pty.kill();
        }
    }, 60000);
});
