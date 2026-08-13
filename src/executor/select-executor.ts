import { evaluateExpression, truthy, type TSelectNode } from '@at/ats';
import { EStepStatus, type TExecutionContext, type TStepResult } from '@at/core';

import type { IChainExecutor } from './chain-executor';
import type { TStepEvents } from './types';

export interface ISelectExecutor {
    Execute(
        select: TSelectNode,
        context: TExecutionContext,
        events: TStepEvents | undefined,
        chain: IChainExecutor,
    ): Promise<TStepResult>;
}

const failureStatuses = new Set([EStepStatus.Failure, EStepStatus.Timeout, EStepStatus.Cancelled]);

export class SelectExecutor implements ISelectExecutor {
    public async Execute(
        select: TSelectNode,
        context: TExecutionContext,
        events: TStepEvents | undefined,
        chain: IChainExecutor,
    ): Promise<TStepResult> {
        events?.OnStepStarted?.(select);
        const lastResult = context.LastResult;
        for (const branch of select.Branches) {
            if (!this.Matches(branch, lastResult, context)) {
                continue;
            }
            // [Failure] 分支会把失败的运行改写成 success；不记下命中的分支，
            // 事后只能看到 "status": "success"，真正的失败被完全掩盖掉。
            events?.OnBranchSelected?.(select, branch);
            const result = await chain.ExecuteChain(branch.Body, { ...context, LastResult: lastResult }, events);
            events?.OnStepFinished?.(select, result);
            return result;
        }
        events?.OnBranchSelected?.(select, undefined);
        const skipped: TStepResult = {
            Status: EStepStatus.Skipped,
            Output: 'No [Select] branch matched; the task ends here.',
            DurationMs: 0,
        };
        events?.OnStepFinished?.(select, skipped);
        return skipped;
    }

    private Matches(
        branch: TSelectNode['Branches'][number],
        lastResult: TStepResult | undefined,
        context: TExecutionContext,
    ): boolean {
        if (branch.Kind === 'success') {
            // 尚无前序步骤视为成功（未发生错误）。
            return lastResult === undefined || lastResult.Status === EStepStatus.Success;
        }
        if (branch.Kind === 'failure') {
            return lastResult !== undefined && failureStatuses.has(lastResult.Status);
        }
        if (branch.Kind === 'case') {
            if (branch.Condition === undefined) {
                return false;
            }
            return truthy(evaluateExpression(branch.Condition, context.Variables));
        }
        return true;
    }
}
