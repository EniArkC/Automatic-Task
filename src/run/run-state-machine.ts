import { AtRuntimeError, ERunStatus } from '@at/core';

// 运行状态流转集中于此；业务代码不得直接赋值状态。
export class RunStateMachine {
    private static readonly Allowed: ReadonlyMap<ERunStatus, readonly ERunStatus[]> = new Map([
        [
            ERunStatus.Queued,
            [ERunStatus.Running, ERunStatus.Cancelled, ERunStatus.Skipped, ERunStatus.Interrupted, ERunStatus.Failure],
        ],
        [
            ERunStatus.Running,
            [ERunStatus.Success, ERunStatus.Failure, ERunStatus.Cancelled, ERunStatus.Timeout, ERunStatus.Interrupted],
        ],
        [ERunStatus.Success, []],
        [ERunStatus.Failure, []],
        [ERunStatus.Cancelled, []],
        [ERunStatus.Timeout, []],
        [ERunStatus.Skipped, []],
        [ERunStatus.Interrupted, []],
    ]);

    public CanTransition(from: ERunStatus, to: ERunStatus): boolean {
        const allowed = RunStateMachine.Allowed.get(from) ?? [];
        return allowed.includes(to);
    }

    public Transition(from: ERunStatus, to: ERunStatus): ERunStatus {
        if (!this.CanTransition(from, to)) {
            throw new AtRuntimeError(`Illegal run status transition: ${from} -> ${to}`);
        }
        return to;
    }
}
