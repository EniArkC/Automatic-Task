import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { type IPty, spawn as ptySpawn } from 'node-pty';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTempDir, interactiveEnv, removeDir } from '../helpers/test-utils';

// The TUI renders through ink, which measures text with string-width. The
// packaged exe runs a small-icu Node build where Intl.Segmenter crashes, so
// the build aliases string-width to v4. These tests drive the real TUI in a
// real pseudo-terminal (ConPTY) and must stay green to catch regressions in
// the render path (width measurement, ink initialization order, and the
// console inheritance of the single autotask.exe shell).
let appRoot = '';
let testUser = '';
let runtimeProcess: ReturnType<typeof spawn> | undefined;

const REPO_ROOT = join(__dirname, '..', '..');
const AUTOTASK_EXE = join(REPO_ROOT, 'dist', 'autotask.exe');

function startPty(command: string, args: string[]): IPty {
    return ptySpawn(command, args, {
        name: 'xterm-256color',
        cols: 100,
        rows: 30,
        cwd: REPO_ROOT,
        env: interactiveEnv({ LOCALAPPDATA: appRoot, USERNAME: testUser, USER: testUser }),
    });
}

function waitFor(predicate: (text: string) => boolean, text: () => string, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
        const deadline = Date.now() + timeoutMs;
        const poll = (): void => {
            if (predicate(text())) {
                resolve();
                return;
            }
            if (Date.now() > deadline) {
                reject(new Error(`timed out; output so far:\n${text()}`));
                return;
            }
            setTimeout(poll, 200);
        };
        poll();
    });
}

beforeAll(() => {
    appRoot = createTempDir('at-tui-');
    testUser = `at-tui-${process.pid}`;
    const runtimeEnv = { ...process.env, LOCALAPPDATA: appRoot, USERNAME: testUser, USER: testUser };
    runtimeProcess = spawn(process.execPath, ['--import', 'tsx', join(REPO_ROOT, 'src', 'runtime', 'main.ts')], {
        cwd: REPO_ROOT,
        stdio: 'ignore',
        env: runtimeEnv,
    });
});

afterAll(() => {
    runtimeProcess?.kill();
    removeDir(appRoot);
});

describe('tui', () => {
    it('renders the dashboard in a real terminal and quits on q', async () => {
        const pty = startPty(process.execPath, ['--import', 'tsx', join(REPO_ROOT, 'src', 'cli', 'main.ts'), 'tui']);
        let output = '';
        let exitCode: number | undefined;
        pty.onData((chunk) => {
            output += chunk;
        });
        pty.onExit((event) => {
            exitCode = event.exitCode;
        });

        // Strip ANSI escapes so assertions match the visible text.
        const clean = (): string => output.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
        // At this terminal size the banner draws the title as block letters, so
        // the literal word is not in the output; the half-block glyphs are what
        // proves the banner rendered. The title's spelling is covered in
        // tests/unit/tui/banner.test.ts.
        await waitFor((text) => text.includes('▀') && text.includes('运行记录'), clean, 20000);
        expect(clean()).toContain('任务');
        expect(clean()).toContain('运行记录');
        expect(clean()).toContain('q 退出');
        pty.write('q');
        await waitFor(
            () => exitCode !== undefined,
            () => output,
            10000,
        );
        expect(exitCode).toBe(0);
        pty.kill();
    });

    it('forwards output and exit codes through the packaged autotask.exe', () => {
        if (!existsSync(AUTOTASK_EXE)) {
            return; // Requires pnpm package; covered by the manual release checks.
        }
        // Direct spawn (like PowerShell / Node): the parent supplies pipe
        // handles, which the shell forwards to the embedded CLI, and the
        // exit code is relayed. The interactive (ConPTY) path needs a real
        // terminal and is covered by manual release checks.
        const version = spawnSync(AUTOTASK_EXE, ['--version'], {
            encoding: 'utf8',
            timeout: 30000,
        });
        expect(version.status).toBe(0);
        expect(version.stdout).toContain('0.1.0');

        const missing = spawnSync(AUTOTASK_EXE, ['run', 'no-such-task'], {
            encoding: 'utf8',
            timeout: 30000,
        });
        expect(missing.status).toBe(3);
    });
});
