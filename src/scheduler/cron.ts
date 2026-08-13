import { Cron } from 'croner';

export function isValidCron(expression: string): boolean {
    try {
        const cron = new Cron(expression);
        return cron.getPattern() !== undefined;
    } catch {
        return false;
    }
}

// 封装 croner：默认按系统本地时区解析，且正确处理夏令时偏移。
export class CronExpression {
    private readonly Cron: Cron;

    public constructor(expression: string, timezone?: string) {
        if (timezone === undefined || timezone === 'local') {
            this.Cron = new Cron(expression);
        } else {
            this.Cron = new Cron(expression, { timezone });
        }
    }

    public NextAfter(from: Date): Date | undefined {
        const next = this.Cron.nextRun(from);
        if (next instanceof Date) {
            return next;
        }
        return undefined;
    }
}
