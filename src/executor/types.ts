import type { TChainNode, TSelectNode, TStepKind } from '@at/ats';
import type { TStepResult, TVariableValue } from '@at/core';

// 步骤真正要执行的东西。只有 StepExecutor 这一层同时知道「节点类型」和
// 「变量替换后的命令/提示词/镜像」，再往上层就没了——所以由它随生命周期事件报出，
// 否则日志里只剩一个 'step' 字样，出错时无从判断。
export type TStepDetail = {
    StepType: TStepKind;
    // task.ats 里的行列，日志可直接指到源码位置。
    Line: number;
    Column: number;
    // Script 是命令行，Agent 是提示词，Docker 是镜像（含容器内命令）。
    Target: string;
    TimeoutSeconds?: number;
};

export type TStepEvents = {
    OnOutput?: (stream: 'stdout' | 'stderr', data: string) => void;
    OnStepStarted?: (node: TChainNode, detail?: TStepDetail) => void;
    OnStepFinished?: (node: TChainNode, result: TStepResult, detail?: TStepDetail) => void;
    // 命中的分支；undefined 表示无分支匹配、任务到此结束。
    // [Failure] 分支会把失败的运行改写成 success，不记下走了哪条分支就完全看不出来。
    OnBranchSelected?: (node: TSelectNode, branch: TSelectNode['Branches'][number] | undefined) => void;
};

export type TVariableMap = ReadonlyMap<string, TVariableValue>;
