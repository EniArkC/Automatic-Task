import type { IConfigManager } from '@at/config';
import { ERunTrigger, EVENT_SCHEDULER_TRIGGERED, type EventBus, type IClock } from '@at/core';
import type { ILogger } from '@at/logging';
import type { IRunManager } from '@at/run';

import { CronExpression, isValidCron } from './cron';

const TICK_INTERVAL_MS = 1000;

export interface IScheduler {
    Start(): void;
    Stop(): void;
    Tick(): void;
}

type TScheduleEntry = {
    Cron: string;
    Next: Date;
};

// 调度器只读 TaskConfig，不涉及包。
export class Scheduler implements IScheduler {
    private readonly ConfigManager: IConfigManager;
    private readonly RunManager: IRunManager;
    private readonly Logger: ILogger;
    private readonly Clock: IClock;
    private readonly EventBus: EventBus;
    private readonly NextRuns = new Map<string, TScheduleEntry>();
    private Timer: ReturnType<typeof setInterval> | undefined;

    public constructor(options: {
        ConfigManager: IConfigManager;
        RunManager: IRunManager;
        Logger: ILogger;
        Clock: IClock;
        EventBus: EventBus;
    }) {
        this.ConfigManager = options.ConfigManager;
        this.RunManager = options.RunManager;
        this.Logger = options.Logger;
        this.Clock = options.Clock;
        this.EventBus = options.EventBus;
    }

    public Start(): void {
        if (this.Timer !== undefined) {
            return;
        }
        this.Timer = setInterval(() => {
            this.Tick();
        }, TICK_INTERVAL_MS);
    }

    public Stop(): void {
        if (this.Timer !== undefined) {
            clearInterval(this.Timer);
            this.Timer = undefined;
        }
    }

    // 以秒级精度轮询已启用的任务配置。
    public Tick(): void {
        const now = this.Clock.Now();
        for (const config of this.ConfigManager.ListTaskConfigs()) {
            if (!config.enabled) {
                this.DropEntry(config.taskId);
                continue;
            }
            const cron = config.schedule?.cron;
            if (cron === undefined) {
                this.DropEntry(config.taskId);
                continue;
            }
            if (!isValidCron(cron)) {
                this.Logger.Error('Task has an invalid cron expression', { taskId: config.taskId, cron });
                this.DropEntry(config.taskId);
                continue;
            }
            const expression = new CronExpression(cron, config.schedule?.timezone);
            const entry = this.NextRuns.get(config.taskId);
            if (entry === undefined || entry.Cron !== cron) {
                // 时区非法时 croner 在 nextRun 抛错；不能因此弄崩调度循环。
                let next: Date | undefined;
                try {
                    next = expression.NextAfter(now);
                } catch (error) {
                    this.Logger.Error('Task cron has an invalid timezone', { taskId: config.taskId, error });
                    this.DropEntry(config.taskId);
                    continue;
                }
                if (next === undefined) {
                    this.DropEntry(config.taskId);
                    continue;
                }
                // 首次触发只排期，不立即执行。
                this.NextRuns.set(config.taskId, { Cron: cron, Next: next });
                continue;
            }
            if (now >= entry.Next) {
                const next = expression.NextAfter(now);
                if (next === undefined) {
                    // 合法但永不触发的表达式（如 2 月 30 日）不能变成每秒重试的死循环。
                    this.DropEntry(config.taskId);
                    this.Logger.Warn('Task cron has no next occurrence; scheduling dropped', {
                        taskId: config.taskId,
                        cron,
                    });
                    continue;
                }
                this.NextRuns.set(config.taskId, { Cron: cron, Next: next });
                this.EventBus.Emit(EVENT_SCHEDULER_TRIGGERED, { taskId: config.taskId });
                this.Logger.Info('Scheduler triggered task', { taskId: config.taskId });
                try {
                    this.RunManager.Start(config.taskId, { Trigger: ERunTrigger.Schedule });
                } catch (error) {
                    this.Logger.Error('Scheduler failed to start task', { taskId: config.taskId, error });
                }
            }
        }
    }

    private DropEntry(taskId: string): void {
        this.NextRuns.delete(taskId);
    }
}
