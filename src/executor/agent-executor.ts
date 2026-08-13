import type { TAgentConfig } from '@at/config';
import { EStepStatus, type TExecutionContext, type TStepResult } from '@at/core';
import { AtExecutionError } from '@at/core';
import type { IProcessRunner } from '@at/process';
import { resultToStepResult } from '@at/process';

import type { TStepEvents } from './types';

export type TAgentInput = {
    Prompt: string;
    TimeoutSeconds?: number;
};

// 适配器隔离 agent 后端，替换内置 agent 只需新增一个适配器。
export interface IAgentExecutor {
    Execute(input: TAgentInput, context: TExecutionContext, events?: TStepEvents): Promise<TStepResult>;
}

const DEFAULT_AGENT_COMMAND = 'pi';

// 配置可直接给快照，也可给读取函数。守护进程必须给函数：全局配置运行期可改（app.set 写回 app.json），
// 快照会让改动直到守护进程重启才生效。
export type TAgentConfigSource = TAgentConfig | (() => TAgentConfig | undefined) | undefined;

export class PiAgentAdapter implements IAgentExecutor {
    private readonly Runner: IProcessRunner;
    private readonly AgentConfigSource: TAgentConfigSource;

    public constructor(runner: IProcessRunner, agentConfig?: TAgentConfigSource) {
        this.Runner = runner;
        this.AgentConfigSource = agentConfig;
    }

    private ResolveConfig(): TAgentConfig | undefined {
        return typeof this.AgentConfigSource === 'function' ? this.AgentConfigSource() : this.AgentConfigSource;
    }

    public async Execute(input: TAgentInput, context: TExecutionContext, events?: TStepEvents): Promise<TStepResult> {
        const agentConfig = this.ResolveConfig();
        const command = agentConfig?.command ?? DEFAULT_AGENT_COMMAND;
        const fixedArgs = agentConfig?.args ?? [];
        // 空串等同未配置：表单里清空模型字段留下 ""，原样传下去会变成 `-m ""`，
        // 多数 CLI 会当成非法模型名而不是"用默认模型"。
        const model = agentConfig?.model ?? '';
        const modelArgs = model === '' ? [] : ['-m', model];
        const timeoutMs = input.TimeoutSeconds === undefined ? undefined : input.TimeoutSeconds * 1000;
        const result = await this.Runner.Run(
            {
                Command: command,
                Args: [...fixedArgs, ...modelArgs, input.Prompt],
                Cwd: context.Workspace,
                TimeoutMs: timeoutMs,
                AbortSignal: context.AbortSignal,
                Env: context.OverrideEnv,
            },
            {
                OnStdout: events?.OnOutput === undefined ? undefined : (data) => events.OnOutput?.('stdout', data),
                OnStderr: events?.OnOutput === undefined ? undefined : (data) => events.OnOutput?.('stderr', data),
            },
        );
        if (result.Status === EStepStatus.Failure && result.Stderr.includes('Failed to start process')) {
            throw new AtExecutionError(
                `Agent command "${command}" is not available. Install it or set agent.command in the app config.`,
            );
        }
        return resultToStepResult(result);
    }
}
