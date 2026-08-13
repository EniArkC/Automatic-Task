import { spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';

import { IpcClient } from '@at/ipc';
import { PathService, PlatformService } from '@at/paths';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildAtp, manifestEntry, taskAtsEntry } from '../helpers/atp-fixtures';
import { createTempDir, removeDir } from '../helpers/test-utils';

let appRoot = '';
let testUser = '';
let runtimeProcess: ReturnType<typeof spawn> | undefined;

const REPO_ROOT = join(__dirname, '..', '..');

function cli(
    args: string[],
    env: Record<string, string> = {},
    input?: string,
): { stdout: string; stderr: string; code: number; error: string } {
    const result = spawnSync(process.execPath, ['--import', 'tsx', join(REPO_ROOT, 'src', 'cli', 'main.ts'), ...args], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        timeout: 30000,
        input,
        env: { ...process.env, LOCALAPPDATA: appRoot, USERNAME: testUser, USER: testUser, ...env },
    });
    return {
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
        code: result.status ?? -1,
        error: result.error?.message ?? '',
    };
}

function cliJson(args: string[]): Record<string, unknown> {
    const result = cli(args);
    if (result.stdout.trim() === '') {
        throw new Error(
            `empty stdout for ${args.join(' ')}; stderr: ${result.stderr}; code: ${result.code}; error: ${result.error}`,
        );
    }
    const parsed: unknown = JSON.parse(result.stdout);
    if (typeof parsed !== 'object' || parsed === undefined) {
        throw new Error(`expected JSON output for ${args.join(' ')}; got: ${result.stdout}`);
    }
    return parsed as Record<string, unknown>;
}

async function pingUntilReady(socketPath: string): Promise<void> {
    for (let attempt = 0; attempt < 60; attempt++) {
        const client = new IpcClient(socketPath);
        try {
            await client.Connect();
            await client.SendRequest('runtime.ping', {});
            client.Close();
            return;
        } catch {
            client.Close();
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error('runtime did not become ready');
}

beforeAll(async () => {
    appRoot = createTempDir('at-it-');
    // A per-user pipe means tests must use their own user identity, or they
    // would collide with a runtime the developer is already running.
    testUser = `at-test-${process.pid}`;
    const runtimeEnv = { ...process.env, LOCALAPPDATA: appRoot, USERNAME: testUser, USER: testUser };
    runtimeProcess = spawn(process.execPath, ['--import', 'tsx', join(REPO_ROOT, 'src', 'runtime', 'main.ts')], {
        cwd: REPO_ROOT,
        stdio: 'ignore',
        windowsHide: true,
        env: runtimeEnv,
    });
    const paths = new PathService(new PlatformService(runtimeEnv, 'win32'));
    await pingUntilReady(paths.GetRuntimeSocketPath());
});

afterAll(async () => {
    if (runtimeProcess !== undefined) {
        const exitPromise = new Promise<void>((resolve) => {
            runtimeProcess?.once('exit', () => {
                resolve();
            });
        });
        const paths = new PathService(
            new PlatformService({ LOCALAPPDATA: appRoot, USERNAME: testUser, USER: testUser }, 'win32'),
        );
        const client = new IpcClient(paths.GetRuntimeSocketPath());
        try {
            await client.Connect();
            await client.SendRequest('runtime.shutdown', {});
            client.Close();
        } catch {
            client.Close();
            runtimeProcess.kill();
        }
        await Promise.race([exitPromise, new Promise((resolve) => setTimeout(resolve, 3000))]);
        runtimeProcess = undefined;
    }
    removeDir(appRoot);
});

describe('cli end-to-end', () => {
    it('reports runtime status as JSON', () => {
        const status = cliJson(['status', '--json']);
        expect(status.ok).toBe(true);
        expect(status.protocol).toBe('at/ipc/v1');
    });

    it('installs, enables and lists a task', async () => {
        const atp = join(appRoot, 'demo.atp');
        const source =
            '@var city: string = "北京"\n[Start]\n-> [Script(`node -e "console.log(process.argv[1])" ${city}`)]\n[End]\n';
        await buildAtp(atp, [manifestEntry({ id: 'demo-task', name: 'Demo Task' }), taskAtsEntry(source)]);

        const installed = cliJson(['install', atp, '--yes', '--json']);
        expect(installed.ok).toBe(true);
        expect(installed.taskId).toBe('demo-task');

        const enabled = cliJson(['task', 'enable', 'demo-task', '--json']);
        expect(enabled.enabled).toBe(true);

        const listed = cliJson(['list', '--json']);
        const tasks = listed.tasks as Record<string, unknown>[];
        expect(tasks.some((task) => task.taskId === 'demo-task' && task.enabled === true)).toBe(true);
    });

    it('runs a task and shows its output', async () => {
        const run = cliJson(['run', 'demo-task', '--json']);
        expect(run.ok).toBe(true);
        const runId = run.runId as string;
        expect(runId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);

        let status = 'queued';
        for (let i = 0; i < 40 && status !== 'success'; i++) {
            const detail = cliJson(['runs', '--json']) as { runs?: Record<string, unknown>[] };
            const record = detail.runs?.find((entry) => entry.runId === runId);
            status = typeof record?.status === 'string' ? record.status : 'queued';
            await new Promise((resolve) => setTimeout(resolve, 250));
        }
        expect(status).toBe('success');

        const logs = cliJson(['logs', 'demo-task', '--json']);
        expect(JSON.stringify(logs)).toContain('北京');
    });

    it('updates task variables through the CLI', () => {
        const updated = cliJson(['task', 'config', 'demo-task', '--set', 'city=上海', '--json']);
        const variables = updated.variables as Record<string, unknown>;
        expect(variables.city).toBe('上海');
    });

    it('supports schedule, ps and stop', async () => {
        const scheduled = cliJson(['task', 'schedule', 'demo-task', '*/5 * * * *', '--json']);
        expect(scheduled.schedule).toBe('*/5 * * * *');

        const longSource = '[Start]\n-> [Script(`node -e "setTimeout(() => {}, 60000)"`)]\n[End]\n';
        const atp = join(appRoot, 'long.atp');
        await buildAtp(atp, [manifestEntry({ id: 'long-task' }), taskAtsEntry(longSource)]);
        cliJson(['install', atp, '--yes', '--json']);

        const run = cliJson(['run', 'long-task', '--json']);
        const runId = run.runId as string;
        await new Promise((resolve) => setTimeout(resolve, 800));

        const ps = cliJson(['ps', '--json']);
        const active = ps.runs as Record<string, unknown>[];
        expect(active.some((entry) => entry.runId === runId)).toBe(true);

        const stopped = cliJson(['stop', runId, '--json']);
        expect(stopped.ok).toBe(true);
    });

    it('handles unknown tasks with actionable errors', () => {
        const result = cli(['run', 'does-not-exist', '--json']);
        expect(result.code).not.toBe(0);
        expect(result.stdout).toBe('');
    });

    it('supports multiple concurrent clients', () => {
        const results = Array.from({ length: 3 }, () => cli(['status', '--json']));
        for (const result of results) {
            expect(JSON.parse(result.stdout)).toMatchObject({ ok: true });
        }
    });

    it('requires confirmation before installing', async () => {
        const atp = join(appRoot, 'confirm.atp');
        const source = '[Start]\n-> [Script(`node -e "console.log(1)"`)]\n[End]\n';
        await buildAtp(atp, [manifestEntry({ id: 'confirm-task' }), taskAtsEntry(source)]);

        // Declining leaves the task uninstalled; in JSON mode the notice
        // goes to stderr so stdout stays machine-readable.
        const declined = cli(['install', atp, '--json'], {}, 'n\n');
        expect(declined.stderr).toContain('cancelled');
        expect(declined.stdout.trim()).toBe('');
        const afterDecline = cliJson(['list', '--json']);
        const tasksAfterDecline = afterDecline.tasks as Record<string, unknown>[];
        expect(tasksAfterDecline.some((task) => task.taskId === 'confirm-task')).toBe(false);

        // Accepting installs it.
        const accepted = cli(['install', atp, '--json'], {}, 'y\n');
        expect(JSON.parse(accepted.stdout)).toMatchObject({ ok: true, taskId: 'confirm-task' });
    });

    it('allows only one runtime process at a time', () => {
        // A second runtime must detect the running one and exit immediately.
        const result = spawnSync(process.execPath, ['--import', 'tsx', join(REPO_ROOT, 'src', 'runtime', 'main.ts')], {
            cwd: REPO_ROOT,
            encoding: 'utf8',
            timeout: 15000,
            env: { ...process.env, LOCALAPPDATA: appRoot, USERNAME: testUser, USER: testUser },
        });
        expect(result.status).toBe(0);
        expect(result.stdout ?? '').toBe('');

        // The original runtime must still answer.
        const status = cliJson(['status', '--json']);
        expect(status.ok).toBe(true);
    });
});
