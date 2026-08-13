import { EStepStatus, type TExecutionContext, type TStepResult } from '@at/core';
import { AtExecutionError } from '@at/core';
import type { IProcessRunner } from '@at/process';
import { resultToStepResult } from '@at/process';

import { splitCommandParts, type TCommandPart, textPart } from './command-resolver';
import type { TStepEvents } from './types';

export type TDockerOptions = {
    Image: string;
    Command?: string | TCommandPart[];
    TimeoutSeconds?: number;
    Remove?: boolean;
    ContainerName?: string;
};

export interface IDockerExecutor {
    Execute(options: TDockerOptions, context: TExecutionContext, events?: TStepEvents): Promise<TStepResult>;
}

export class DockerExecutor implements IDockerExecutor {
    private readonly Runner: IProcessRunner;

    public constructor(runner: IProcessRunner) {
        this.Runner = runner;
    }

    public async Execute(
        options: TDockerOptions,
        context: TExecutionContext,
        events?: TStepEvents,
    ): Promise<TStepResult> {
        const available = await this.DockerAvailable();
        if (!available) {
            throw new AtExecutionError(
                'This task uses Docker, but the docker CLI was not found. Install Docker or remove the [Docker] step.',
            );
        }
        const args = ['run'];
        if (options.Remove !== false) {
            args.push('--rm');
        }
        if (options.ContainerName !== undefined) {
            args.push('--name', options.ContainerName);
        }
        // 挂载宿主工作区到容器 /workspace（步骤的工作目录），任务产生的文件在容器内可见。
        args.push('-v', context.Workspace, '--workdir', '/workspace');
        args.push(options.Image);
        if (options.Command !== undefined) {
            const parts = typeof options.Command === 'string' ? textPart(options.Command) : options.Command;
            for (const part of splitCommandParts(parts)) {
                args.push(part);
            }
        }
        const timeoutMs = options.TimeoutSeconds === undefined ? undefined : options.TimeoutSeconds * 1000;
        const result = await this.Runner.Run(
            {
                Command: 'docker',
                Args: args,
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
        return resultToStepResult(result);
    }

    private async DockerAvailable(): Promise<boolean> {
        const result = await this.Runner.Run({ Command: 'docker', Args: ['--version'], TimeoutMs: 5000 });
        return result.Status === EStepStatus.Success;
    }
}
