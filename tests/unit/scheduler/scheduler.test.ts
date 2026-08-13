import { ConfigManager } from '@at/config';
import { ERunStatus, ERunTrigger, EventBus, FakeClock, UlidGenerator } from '@at/core';
import type { IRunManager } from '@at/run';
import { CronExpression, isValidCron, Scheduler } from '@at/scheduler';
import { describe, expect, it } from 'vitest';

import { createTempDir, createTempPathService, createTestLogger, removeDir } from '../../helpers/test-utils';

describe('cron', () => {
    it('validates cron expressions', () => {
        expect(isValidCron('*/30 * * * *')).toBe(true);
        expect(isValidCron('0 9 * * *')).toBe(true);
        expect(isValidCron('not a cron')).toBe(false);
    });

    it('computes the next occurrence in local time', () => {
        const expression = new CronExpression('* * * * *');
        const from = new Date('2026-08-09T03:00:30Z');
        const next = expression.NextAfter(from);
        expect(next?.getTime()).toBe(new Date('2026-08-09T03:01:00Z').getTime());
    });

    it('supports seconds-level expressions', () => {
        const expression = new CronExpression('*/10 * * * * *');
        const from = new Date('2026-08-09T03:00:00Z');
        const next = expression.NextAfter(from);
        expect(next?.getTime()).toBe(new Date('2026-08-09T03:00:10Z').getTime());
    });
});

describe('scheduler', () => {
    it('triggers enabled tasks when the cron fires', () => {
        const root = createTempDir('at-sched-');
        try {
            const paths = createTempPathService(root);
            const { Logger: logger } = createTestLogger();
            const configManager = new ConfigManager(paths, logger);
            const clock = new FakeClock(new Date('2026-08-09T03:00:00Z'));
            const eventBus = new EventBus();
            const started: string[] = [];
            const runManager: IRunManager = {
                Start: (taskId) => {
                    started.push(taskId);
                    return {
                        RunId: new UlidGenerator().Next(),
                        TaskId: taskId,
                        PackageVersion: '1.0.0',
                        Trigger: ERunTrigger.Schedule,
                        Status: ERunStatus.Queued,
                    };
                },
                Stop: () => undefined,
                StopAll: () => undefined,
                GetRun: () => undefined,
                ListRuns: () => [],
                GetActiveRuns: () => [],
                HasActiveRun: () => false,
                WhenFinished: () => Promise.reject(new Error('not used')),
                RecoverInterrupted: () => undefined,
                Prune: () => 0,
                PruneWorkspaces: () => 0,
            };
            const config = configManager.CreateDefaultTaskConfig('daily-report', '1.0.0');
            config.enabled = true;
            config.schedule = { cron: '* * * * *' };
            configManager.SaveTaskConfig(config);
            const scheduler = new Scheduler({
                ConfigManager: configManager,
                RunManager: runManager,
                Logger: logger,
                Clock: clock,
                EventBus: eventBus,
            });
            scheduler.Tick();
            expect(started).toEqual([]);
            clock.Advance(60_000);
            scheduler.Tick();
            expect(started).toEqual(['daily-report']);
            clock.Advance(60_000);
            scheduler.Tick();
            expect(started).toEqual(['daily-report', 'daily-report']);
        } finally {
            removeDir(root);
        }
    });

    it('ignores disabled tasks', () => {
        const root = createTempDir('at-sched-');
        try {
            const paths = createTempPathService(root);
            const { Logger: logger } = createTestLogger();
            const configManager = new ConfigManager(paths, logger);
            const clock = new FakeClock(new Date('2026-08-09T03:00:00Z'));
            let started = 0;
            const runManager: IRunManager = {
                Start: () => {
                    started++;
                    return {
                        RunId: 'x',
                        TaskId: 'daily-report',
                        PackageVersion: '1.0.0',
                        Trigger: ERunTrigger.Schedule,
                        Status: ERunStatus.Queued,
                    };
                },
                Stop: () => undefined,
                StopAll: () => undefined,
                GetRun: () => undefined,
                ListRuns: () => [],
                GetActiveRuns: () => [],
                HasActiveRun: () => false,
                WhenFinished: () => Promise.reject(new Error('not used')),
                RecoverInterrupted: () => undefined,
                Prune: () => 0,
                PruneWorkspaces: () => 0,
            };
            const config = configManager.CreateDefaultTaskConfig('daily-report', '1.0.0');
            config.enabled = false;
            config.schedule = { cron: '* * * * *' };
            configManager.SaveTaskConfig(config);
            const scheduler = new Scheduler({
                ConfigManager: configManager,
                RunManager: runManager,
                Logger: logger,
                Clock: clock,
                EventBus: new EventBus(),
            });
            clock.Advance(120_000);
            scheduler.Tick();
            expect(started).toBe(0);
        } finally {
            removeDir(root);
        }
    });

    it('ignores tasks without a schedule', () => {
        const root = createTempDir('at-sched-');
        try {
            const paths = createTempPathService(root);
            const { Logger: logger } = createTestLogger();
            const configManager = new ConfigManager(paths, logger);
            const clock = new FakeClock(new Date('2026-08-09T03:00:00Z'));
            let started = 0;
            const runManager: IRunManager = {
                Start: () => {
                    started++;
                    return {
                        RunId: 'x',
                        TaskId: 'daily-report',
                        PackageVersion: '1.0.0',
                        Trigger: ERunTrigger.Schedule,
                        Status: ERunStatus.Queued,
                    };
                },
                Stop: () => undefined,
                StopAll: () => undefined,
                GetRun: () => undefined,
                ListRuns: () => [],
                GetActiveRuns: () => [],
                HasActiveRun: () => false,
                WhenFinished: () => Promise.reject(new Error('not used')),
                RecoverInterrupted: () => undefined,
                Prune: () => 0,
                PruneWorkspaces: () => 0,
            };
            const config = configManager.CreateDefaultTaskConfig('daily-report', '1.0.0');
            config.enabled = true;
            configManager.SaveTaskConfig(config);
            const scheduler = new Scheduler({
                ConfigManager: configManager,
                RunManager: runManager,
                Logger: logger,
                Clock: clock,
                EventBus: new EventBus(),
            });
            clock.Advance(120_000);
            scheduler.Tick();
            expect(started).toBe(0);
        } finally {
            removeDir(root);
        }
    });
});
