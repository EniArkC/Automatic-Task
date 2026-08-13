import type { TChainNode } from '@at/ats';
import { EStepStatus, type TExecutionContext, type TStepResult } from '@at/core';

import type { ISelectExecutor } from './select-executor';
import { SelectExecutor } from './select-executor';
import type { IStepExecutor } from './step-executor';
import type { TStepEvents } from './types';

export interface IChainExecutor {
    ExecuteChain(nodes: TChainNode[], context: TExecutionContext, events?: TStepEvents): Promise<TStepResult>;
}

// 顺序执行步骤。失败、超时、取消都不中断链路：由后续 [Select] 的 Failure 分支响应。
// 被跳过的 [Select]（无分支匹配）意味着任务到此结束；只有真正的 abort 信号才会提前终止链路。
export class ChainExecutor implements IChainExecutor {
    private readonly StepExecutor: IStepExecutor;
    private readonly SelectExecutor: ISelectExecutor;

    public constructor(stepExecutor: IStepExecutor, selectExecutor: ISelectExecutor) {
        this.StepExecutor = stepExecutor;
        this.SelectExecutor = selectExecutor;
    }

    public async ExecuteChain(
        nodes: TChainNode[],
        context: TExecutionContext,
        events?: TStepEvents,
    ): Promise<TStepResult> {
        let lastResult: TStepResult | undefined = context.LastResult;
        for (const node of nodes) {
            if (context.AbortSignal.aborted) {
                return {
                    Status: EStepStatus.Cancelled,
                    Output: 'Run was cancelled',
                    DurationMs: 0,
                };
            }
            const nextContext: TExecutionContext = { ...context, LastResult: lastResult };
            let result: TStepResult;
            if (node.Kind === 'step') {
                result = await this.StepExecutor.Execute(node, nextContext, events);
            } else {
                result = await this.SelectExecutor.Execute(node, nextContext, events, this);
            }
            lastResult = result;
            if (result.Status === EStepStatus.Skipped) {
                break;
            }
        }
        return (
            lastResult ?? {
                Status: EStepStatus.Success,
                Output: '',
                DurationMs: 0,
            }
        );
    }
}

export function createChainExecutor(stepExecutor: IStepExecutor): { Chain: ChainExecutor; Select: SelectExecutor } {
    const select = new SelectExecutor();
    return { Chain: new ChainExecutor(stepExecutor, select), Select: select };
}
