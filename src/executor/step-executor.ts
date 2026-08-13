import { resolveVariable, type TArgumentValue, type TStepNode } from '@at/ats';
import { type TExecutionContext, type TStepResult } from '@at/core';

import type { IAgentExecutor } from './agent-executor';
import { partsToText, type TCommandPart } from './command-resolver';
import type { IDockerExecutor } from './docker-executor';
import type { IScriptExecutor } from './script-executor';
import type { TStepDetail, TStepEvents, TVariableMap } from './types';

// 命令行里可能带密钥（token、密码等），日志与事件都会落盘，先截断再上报。
const MAX_TARGET_CHARS = 500;

function clipTarget(text: string): string {
    return text.length > MAX_TARGET_CHARS ? `${text.slice(0, MAX_TARGET_CHARS)}…` : text;
}

// 把参数拆成「脚本写死的文本」与「变量值」两类片段。命令行按片段切分时，
// 变量值整体算一个参数——值里的空格不会把它切成两个参数。
function argumentToParts(value: TArgumentValue, variables: TVariableMap): TCommandPart[] {
    if (typeof value !== 'object') {
        return [{ Kind: 'text', Text: String(value) }];
    }
    const parts: TCommandPart[] = [];
    for (const segment of value.Segments) {
        if (segment.Kind === 'text') {
            parts.push({ Kind: 'text', Text: segment.Text });
        } else {
            const resolved = resolveVariable(segment.Name, variables);
            parts.push({ Kind: 'value', Text: resolved === undefined ? '' : String(resolved) });
        }
    }
    return parts;
}

export interface IStepExecutor {
    Execute(step: TStepNode, context: TExecutionContext, events?: TStepEvents): Promise<TStepResult>;
}

export class StepExecutor implements IStepExecutor {
    private readonly ScriptExecutor: IScriptExecutor;
    private readonly AgentExecutor: IAgentExecutor;
    private readonly DockerExecutor: IDockerExecutor;

    public constructor(script: IScriptExecutor, agent: IAgentExecutor, docker: IDockerExecutor) {
        this.ScriptExecutor = script;
        this.AgentExecutor = agent;
        this.DockerExecutor = docker;
    }

    public async Execute(step: TStepNode, context: TExecutionContext, events?: TStepEvents): Promise<TStepResult> {
        const positional = step.Arguments.filter((argument) => argument.Kind === 'positional');
        const named = step.Arguments.filter((argument) => argument.Kind === 'named');
        const timeout = this.NamedTimeout(named, context.Variables);
        // 变量替换在这里已完成，detail 记的是真正要执行的东西而非模板原文；
        // 必须在 OnStepStarted 之前算好：步骤挂死时只有 started 事件会落盘。
        const target = this.DescribeTarget(step, positional, context.Variables);
        const detail: TStepDetail = {
            StepType: step.StepType,
            Line: step.Line,
            Column: step.Column,
            Target: clipTarget(target),
            TimeoutSeconds: timeout,
        };
        events?.OnStepStarted?.(step, detail);
        let result: TStepResult;
        switch (step.StepType) {
            case 'Script': {
                const command = this.PositionalParts(positional, context.Variables);
                result = await this.ScriptExecutor.Execute(command, context, timeout, events);
                break;
            }
            case 'Agent': {
                const prompt = partsToText(this.PositionalParts(positional, context.Variables));
                result = await this.AgentExecutor.Execute({ Prompt: prompt, TimeoutSeconds: timeout }, context, events);
                break;
            }
            case 'Docker': {
                const image = partsToText(this.PositionalParts(positional, context.Variables));
                const command =
                    positional[1] === undefined ? undefined : argumentToParts(positional[1].Value, context.Variables);
                const remove = this.NamedBoolean(named, 'remove');
                const containerName = context.RunId === undefined ? undefined : `at-${context.RunId.toLowerCase()}`;
                result = await this.DockerExecutor.Execute(
                    {
                        Image: image,
                        Command: command,
                        TimeoutSeconds: timeout,
                        Remove: remove,
                        ContainerName: containerName,
                    },
                    context,
                    events,
                );
                break;
            }
        }
        events?.OnStepFinished?.(step, result, detail);
        return result;
    }

    // 日志用的一行描述：Script 是命令行，Agent 是提示词，Docker 是「镜像 + 容器内命令」。
    private DescribeTarget(step: TStepNode, positional: TStepNode['Arguments'], variables: TVariableMap): string {
        const first = partsToText(this.PositionalParts(positional, variables));
        if (step.StepType !== 'Docker' || positional[1] === undefined) {
            return first;
        }
        return `${first} ${partsToText(argumentToParts(positional[1].Value, variables))}`;
    }

    private PositionalParts(positional: TStepNode['Arguments'], variables: TVariableMap): TCommandPart[] {
        const value = positional[0]?.Value;
        return value === undefined ? [] : argumentToParts(value, variables);
    }

    // timeout 允许写模板变量，值在运行时解析。解析不出正数就当没设超时——
    // 校验期已拦下类型不对的声明，这里只兜运行期配错值的情况。
    private NamedTimeout(named: TStepNode['Arguments'], variables: TVariableMap): number | undefined {
        const argument = named.find((item) => item.Name === 'timeout');
        if (argument === undefined) {
            return undefined;
        }
        const value = argument.Value;
        if (typeof value === 'number') {
            return value;
        }
        if (typeof value !== 'object') {
            return undefined;
        }
        const seconds = Number(partsToText(argumentToParts(value, variables)));
        return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
    }

    private NamedBoolean(named: TStepNode['Arguments'], name: string): boolean | undefined {
        const argument = named.find((item) => item.Name === name);
        if (argument === undefined || typeof argument.Value !== 'boolean') {
            return undefined;
        }
        return argument.Value;
    }
}
