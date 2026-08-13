import { type TExecutionContext, type TStepResult } from '@at/core';
import type { IProcessRunner } from '@at/process';
import { resultToStepResult } from '@at/process';

import { buildCmdLine, partsToText, resolveCommand, type TCommandPart } from './command-resolver';
import type { TStepEvents } from './types';

function toEvents(events: TStepEvents | undefined): {
    OnStdout?: (data: string) => void;
    OnStderr?: (data: string) => void;
} {
    return {
        OnStdout: events?.OnOutput === undefined ? undefined : (data) => events.OnOutput?.('stdout', data),
        OnStderr: events?.OnOutput === undefined ? undefined : (data) => events.OnOutput?.('stderr', data),
    };
}

export interface IScriptExecutor {
    Execute(
        command: string | TCommandPart[],
        context: TExecutionContext,
        timeoutSeconds?: number,
        events?: TStepEvents,
    ): Promise<TStepResult>;
}

export class ScriptExecutor implements IScriptExecutor {
    private readonly Runner: IProcessRunner;

    public constructor(runner: IProcessRunner) {
        this.Runner = runner;
    }

    public async Execute(
        command: string | TCommandPart[],
        context: TExecutionContext,
        timeoutSeconds?: number,
        events?: TStepEvents,
    ): Promise<TStepResult> {
        const resolved = resolveCommand(command, context.PackagePath);
        const timeoutMs = timeoutSeconds === undefined ? undefined : timeoutSeconds * 1000;
        if (resolved.ResolvedPath !== undefined && resolved.Command === undefined) {
            // 批处理必须经 cmd 运行，解析出的路径是不依赖 cwd 的入口。
            const line = buildCmdLine(resolved.ResolvedPath, resolved.Args);
            const result = await this.Runner.Run(
                {
                    Command: process.env.ComSpec ?? 'cmd.exe',
                    Args: ['/d', '/s', '/c', line],
                    Cwd: context.Workspace,
                    TimeoutMs: timeoutMs,
                    AbortSignal: context.AbortSignal,
                    Env: context.OverrideEnv,
                },
                toEvents(events),
            );
            return resultToStepResult(result);
        }
        const result = await this.Runner.Run(
            {
                Command: resolved.Command ?? (typeof command === 'string' ? command : partsToText(command)),
                Args: resolved.Args,
                Cwd: context.Workspace,
                TimeoutMs: timeoutMs,
                AbortSignal: context.AbortSignal,
                Env: context.OverrideEnv,
            },
            toEvents(events),
        );
        return resultToStepResult(result);
    }
}
