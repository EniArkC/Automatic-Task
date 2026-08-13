export interface IClock {
    Now(): Date;
}

export class SystemClock implements IClock {
    public Now(): Date {
        return new Date();
    }
}

// 仅测试用：手动推进的时钟，保证调度器测试结果可确定。
export class FakeClock implements IClock {
    private Current: Date;

    public constructor(start: Date = new Date(0)) {
        this.Current = start;
    }

    public Now(): Date {
        return this.Current;
    }

    public Advance(ms: number): void {
        this.Current = new Date(this.Current.getTime() + ms);
    }

    public Set(time: Date): void {
        this.Current = time;
    }
}
