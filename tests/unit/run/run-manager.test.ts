import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { ConfigManager } from '@at/config';
import { EOverlapPolicy, ERunStatus, ERunTrigger, EventBus, FakeClock, UlidGenerator } from '@at/core';
import { createChainExecutor, DockerExecutor, PiAgentAdapter, ScriptExecutor, StepExecutor } from '@at/executor';
import { PackageManager } from '@at/package-manager';
import { ProcessRunner } from '@at/process';
import { RunFiles, RunManager, RunStateMachine } from '@at/run';
import { afterEach, describe, expect, it } from 'vitest';

import { buildAtp, manifestEntry, taskAtsEntry } from '../../helpers/atp-fixtures';
import { createTempDir, createTempPathService, createTestLogger, removeDir } from '../../helpers/test-utils';

const runner = new ProcessRunner();

type TManager = {
    Runs: RunManager;
    Root: string;
    EventBus: EventBus;
    Clock: FakeClock;
    Install(taskId: string, ats?: string, version?: string): Promise<void>;
    SetOverlap(taskId: string, policy: EOverlapPolicy): void;
};

function createManager(): TManager {
    const root = createTempDir('at-run-');
    const paths = createTempPathService(root);
    const { Logger: logger } = createTestLogger();
    const configManager = new ConfigManager(paths, logger);
    const packageManager = new PackageManager(paths, configManager, logger);
    const eventBus = new EventBus();
    const clock = new FakeClock(new Date('2026-08-09T03:00:00Z'));
    const stepExecutor = new StepExecutor(
        new ScriptExecutor(runner),
        new PiAgentAdapter(runner, { command: process.execPath, args: ['-e', "console.log('agent-done')"] }),
        new DockerExecutor(runner),
    );
    const { Chain: chain } = createChainExecutor(stepExecutor);
    const runs = new RunManager({
        PathService: paths,
        ConfigManager: configManager,
        PackageManager: packageManager,
        EventBus: eventBus,
        Logger: logger,
        ChainExecutor: chain,
        RunFiles: new RunFiles(paths),
        StateMachine: new RunStateMachine(),
        Clock: clock,
        IdGenerator: new UlidGenerator(),
    });
    const install = async (taskId: string, ats?: string, version = '1.0.0'): Promise<void> => {
        const atp = join(root, `${taskId}-${version}.atp`);
        await buildAtp(atp, [manifestEntry({ id: taskId, version }), taskAtsEntry(ats)]);
        await packageManager.Install(atp);
    };
    const setOverlap = (taskId: string, policy: EOverlapPolicy): void => {
        const taskConfig = configManager.GetTaskConfig(taskId);
        if (taskConfig !== undefined) {
            taskConfig.overlap = policy;
            configManager.SaveTaskConfig(taskConfig);
        }
    };
    return { Runs: runs, Root: root, EventBus: eventBus, Clock: clock, Install: install, SetOverlap: setOverlap };
}

const SCRIPT_SOURCE =
    '@var city: string = "run"\n[Start]\n-> [Script(`node -e "console.log(process.argv[1])" ${city}`)]\n[End]\n';

function findRunFile(root: string, runId: string, name: string): string {
    const visit = (dir: string): string | undefined => {
        const entries = readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const full = join(dir, entry.name);
            if (entry.isDirectory()) {
                const found = visit(full);
                if (found !== undefined) {
                    return found;
                }
            } else if (entry.name === name && full.includes(runId)) {
                return full;
            }
        }
        return undefined;
    };
    const found = visit(root);
    if (found === undefined) {
        throw new Error(`run file ${name} not found for ${runId}`);
    }
    return found;
}

describe('run manager', () => {
    const contexts: TManager[] = [];

    afterEach(() => {
        for (const context of contexts) {
            removeDir(context.Root);
        }
        contexts.length = 0;
    });

    function setup(): TManager {
        const context = createManager();
        contexts.push(context);
        return context;
    }

    it('creates queued runs and executes them to success', async () => {
        const manager = setup();
        await manager.Install('daily-report', SCRIPT_SOURCE);
        const record = manager.Runs.Start('daily-report', { Trigger: ERunTrigger.Manual });
        expect(record.Status).toBe(ERunStatus.Queued);
        const finished = await manager.Runs.WhenFinished(record.RunId);
        expect(finished.Status).toBe(ERunStatus.Success);
        expect(finished.StartedAt).toBeDefined();
        expect(finished.FinishedAt).toBeDefined();
        const stdoutFile = findRunFile(manager.Root, record.RunId, 'stdout.log');
        expect(readFileSync(stdoutFile, 'utf8')).toContain('run');
    });

    it('marks runs as failure when steps fail', async () => {
        const manager = setup();
        await manager.Install('failing', '[Start]\n-> [Script(`node -e "process.exit(1)"`)]\n[End]\n');
        const record = manager.Runs.Start('failing', { Trigger: ERunTrigger.Manual });
        const finished = await manager.Runs.WhenFinished(record.RunId);
        expect(finished.Status).toBe(ERunStatus.Failure);
        expect(finished.Error).toBeDefined();
    });

    it('skips runs while another instance is active', async () => {
        const manager = setup();
        await manager.Install('slow', '[Start]\n-> [Script(`node -e "setTimeout(() => {}, 3000)"`)]\n[End]\n');
        const first = manager.Runs.Start('slow', { Trigger: ERunTrigger.Manual });
        const second = manager.Runs.Start('slow', { Trigger: ERunTrigger.Manual });
        expect(second.Status).toBe(ERunStatus.Skipped);
        const finished = await manager.Runs.WhenFinished(first.RunId);
        expect(finished.Status).toBe(ERunStatus.Success);
    });

    it('queues runs with the queue overlap policy', async () => {
        const manager = setup();
        await manager.Install('slow', '[Start]\n-> [Script(`node -e "setTimeout(() => {}, 1500)"`)]\n[End]\n');
        manager.SetOverlap('slow', EOverlapPolicy.Queue);
        const first = manager.Runs.Start('slow', { Trigger: ERunTrigger.Manual });
        const second = manager.Runs.Start('slow', { Trigger: ERunTrigger.Manual });
        expect(second.Status).toBe(ERunStatus.Queued);
        const firstFinished = await manager.Runs.WhenFinished(first.RunId);
        expect(firstFinished.Status).toBe(ERunStatus.Success);
        const secondFinished = await manager.Runs.WhenFinished(second.RunId);
        expect(secondFinished.Status).toBe(ERunStatus.Success);
        expect(secondFinished.StartedAt).toBeDefined();
    });

    it('runs in parallel with the parallel overlap policy', async () => {
        const manager = setup();
        await manager.Install('slow', '[Start]\n-> [Script(`node -e "setTimeout(() => {}, 1500)"`)]\n[End]\n');
        manager.SetOverlap('slow', EOverlapPolicy.Parallel);
        const first = manager.Runs.Start('slow', { Trigger: ERunTrigger.Manual });
        const second = manager.Runs.Start('slow', { Trigger: ERunTrigger.Manual });
        expect(second.Status).toBe(ERunStatus.Queued);
        const both = await Promise.all([
            manager.Runs.WhenFinished(first.RunId),
            manager.Runs.WhenFinished(second.RunId),
        ]);
        expect(both.every((record) => record.Status === ERunStatus.Success)).toBe(true);
    });

    it('cancels an active run', async () => {
        const manager = setup();
        await manager.Install('long', '[Start]\n-> [Script(`node -e "setTimeout(() => {}, 120000)"`)]\n[End]\n');
        const record = manager.Runs.Start('long', { Trigger: ERunTrigger.Manual });
        await new Promise((resolve) => setTimeout(resolve, 700));
        manager.Runs.Stop(record.RunId);
        const finished = await manager.Runs.WhenFinished(record.RunId);
        expect(finished.Status).toBe(ERunStatus.Cancelled);
    });

    it('lists runs newest first', async () => {
        const manager = setup();
        await manager.Install('daily-report', SCRIPT_SOURCE);
        const first = manager.Runs.Start('daily-report', { Trigger: ERunTrigger.Manual });
        await manager.Runs.WhenFinished(first.RunId);
        const second = manager.Runs.Start('daily-report', { Trigger: ERunTrigger.Manual });
        await manager.Runs.WhenFinished(second.RunId);
        const listed = manager.Runs.ListRuns({ Limit: 10 });
        expect(listed.length).toBe(2);
        expect(listed[0]?.RunId).toBe(second.RunId);
        expect(listed[1]?.RunId).toBe(first.RunId);
    });

    it('recovers interrupted runs on restart', async () => {
        const manager = setup();
        await manager.Install('daily-report', SCRIPT_SOURCE);
        const record = manager.Runs.Start('daily-report', { Trigger: ERunTrigger.Manual });
        await manager.Runs.WhenFinished(record.RunId);
        // Simulate a crash by rewriting the metadata as running.
        const metadataFile = findRunFile(manager.Root, record.RunId, 'metadata.json');
        const metadata = JSON.parse(readFileSync(metadataFile, 'utf8')) as Record<string, unknown>;
        metadata.status = 'running';
        writeFileSync(metadataFile, JSON.stringify(metadata));
        manager.Runs.RecoverInterrupted();
        const recovered = manager.Runs.GetRun(record.RunId);
        expect(recovered?.Status).toBe(ERunStatus.Interrupted);
    });

    it('redacts secrets in run metadata', async () => {
        const manager = setup();
        await manager.Install('secret-task', '[Start]\n-> [Script(`echo hi`)]\n[End]\n');
        const record = manager.Runs.Start('secret-task', {
            Trigger: ERunTrigger.Manual,
            Variables: { token: 'super-secret-value' },
        });
        await manager.Runs.WhenFinished(record.RunId);
        const metadataFile = findRunFile(manager.Root, record.RunId, 'metadata.json');
        const content = readFileSync(metadataFile, 'utf8');
        expect(content).not.toContain('super-secret-value');
        expect(content).toContain('****');
    });

    it('prune never deletes an active run directory', async () => {
        const manager = setup();
        await manager.Install('long', '[Start]\n-> [Script(`node -e "setTimeout(() => {}, 60000)"`)]\n[End]\n');
        const record = manager.Runs.Start('long', { Trigger: ERunTrigger.Manual });
        await new Promise((resolve) => setTimeout(resolve, 700));
        // A 0-day prune would remove everything except active runs.
        const removed = manager.Runs.Prune(0);
        expect(removed).toBe(0);
        const stillThere = manager.Runs.GetRun(record.RunId);
        expect(stillThere?.Status).toBe(ERunStatus.Running);
        manager.Runs.Stop(record.RunId);
        await manager.Runs.WhenFinished(record.RunId);
    });

    it('pruneWorkspaces deletes the workspace but keeps metadata and logs', async () => {
        const manager = setup();
        await manager.Install('daily-report', SCRIPT_SOURCE);
        const record = manager.Runs.Start('daily-report', { Trigger: ERunTrigger.Manual });
        await manager.Runs.WhenFinished(record.RunId);
        const metadataFile = findRunFile(manager.Root, record.RunId, 'metadata.json');
        const runDir = join(metadataFile, '..');
        expect(existsSync(join(runDir, 'workspace'))).toBe(true);
        // 走到保留期之后，工作区应该消失而日志留下。
        manager.Clock.Advance(3 * 24 * 60 * 60 * 1000);
        const removed = manager.Runs.PruneWorkspaces(1);
        expect(removed).toBe(1);
        expect(existsSync(join(runDir, 'workspace'))).toBe(false);
        expect(existsSync(metadataFile)).toBe(true);
        expect(manager.Runs.GetRun(record.RunId)?.TaskId).toBe('daily-report');
    });

    it('pruneWorkspaces never touches an active run', async () => {
        const manager = setup();
        await manager.Install('long', '[Start]\n-> [Script(`node -e "setTimeout(() => {}, 60000)"`)]\n[End]\n');
        const record = manager.Runs.Start('long', { Trigger: ERunTrigger.Manual });
        await new Promise((resolve) => setTimeout(resolve, 700));
        expect(manager.Runs.PruneWorkspaces(0)).toBe(0);
        expect(manager.Runs.GetRun(record.RunId)?.Status).toBe(ERunStatus.Running);
        manager.Runs.Stop(record.RunId);
        await manager.Runs.WhenFinished(record.RunId);
    });

    it('fails a queued run cleanly when its task becomes invalid', async () => {
        const manager = setup();
        await manager.Install('slow', '[Start]\n-> [Script(`node -e "setTimeout(() => {}, 4000)"`)]\n[End]\n');
        manager.SetOverlap('slow', EOverlapPolicy.Queue);
        const first = manager.Runs.Start('slow', { Trigger: ERunTrigger.Manual });
        const second = manager.Runs.Start('slow', { Trigger: ERunTrigger.Manual });
        expect(second.Status).toBe(ERunStatus.Queued);
        // Point the task at a package version that does not exist while the
        // queued run waits; draining must mark it as failure, not stall.
        const paths = createTempPathService(manager.Root);
        const { Logger: logger } = createTestLogger();
        const configManager = new ConfigManager(paths, logger);
        const taskConfig = configManager.GetTaskConfig('slow');
        if (taskConfig !== undefined) {
            taskConfig.packageVersion = '9.9.9';
            configManager.SaveTaskConfig(taskConfig);
        }
        manager.Runs.Stop(first.RunId);
        await manager.Runs.WhenFinished(first.RunId);
        const finished = await manager.Runs.WhenFinished(second.RunId);
        expect(finished.Status).toBe(ERunStatus.Failure);
    });

    it('stopAll aborts running runs and clears the queue', async () => {
        const manager = setup();
        await manager.Install('slow', '[Start]\n-> [Script(`node -e "setTimeout(() => {}, 60000)"`)]\n[End]\n');
        manager.SetOverlap('slow', EOverlapPolicy.Queue);
        const first = manager.Runs.Start('slow', { Trigger: ERunTrigger.Manual });
        const second = manager.Runs.Start('slow', { Trigger: ERunTrigger.Manual });
        expect(second.Status).toBe(ERunStatus.Queued);
        await new Promise((resolve) => setTimeout(resolve, 700));
        manager.Runs.StopAll();
        const firstDone = await manager.Runs.WhenFinished(first.RunId);
        expect(firstDone.Status).toBe(ERunStatus.Cancelled);
        const secondDone = await manager.Runs.WhenFinished(second.RunId);
        expect(secondDone.Status).toBe(ERunStatus.Cancelled);
    });

    it('emits lifecycle events', async () => {
        const manager = setup();
        await manager.Install('daily-report', SCRIPT_SOURCE);
        const types: string[] = [];
        for (const type of ['run.created', 'run.started', 'run.finished']) {
            manager.EventBus.On(type, () => {
                types.push(type);
            });
        }
        const record = manager.Runs.Start('daily-report', { Trigger: ERunTrigger.Manual });
        await manager.Runs.WhenFinished(record.RunId);
        expect(types).toContain('run.created');
        expect(types).toContain('run.started');
        expect(types).toContain('run.finished');
    });
});
