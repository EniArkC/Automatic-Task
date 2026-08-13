import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';

import { EStepStatus, isNull, type TStepResult } from '@at/core';

export type TProcessOptions = {
    Command: string;
    Args?: string[];
    Cwd?: string;
    Env?: Record<string, string>;
    TimeoutMs?: number;
    AbortSignal?: AbortSignal;
    KillGraceMs?: number;
};

export type TProcessEvents = {
    OnStdout?: (data: string) => void;
    OnStderr?: (data: string) => void;
};

export type TProcessResult = {
    Status: EStepStatus;
    ExitCode?: number;
    Stdout: string;
    Stderr: string;
    DurationMs: number;
};

export interface IProcessHandle {
    readonly Pid: number;
    Kill(): Promise<void>;
    Wait(): Promise<TProcessResult>;
}

export interface IProcessRunner {
    Run(options: TProcessOptions, events?: TProcessEvents): Promise<TProcessResult>;
    Spawn(options: TProcessOptions, events?: TProcessEvents): IProcessHandle;
}

const DEFAULT_KILL_GRACE_MS = 3000;
const MAX_OUTPUT_CHARS = 5 * 1024 * 1024;
const MAX_ERROR_CHARS = 2000;

function isWindows(): boolean {
    return process.platform === 'win32';
}

// pkg 会把无扩展名的 `node` 重定向到自身并破坏 `-e` 参数，显式补 .exe 保住 PATH 上的真实命令。
function normalizeCommand(command: string): string {
    if (!isWindows() || command.includes('\\') || command.includes('/') || /\.\w+$/.test(command)) {
        return command;
    }
    return `${command}.exe`;
}

// 长时间运行的步骤输出量大时限制内存占用。
function appendOutput(current: string, chunk: string): string {
    if (current.length >= MAX_OUTPUT_CHARS) {
        return current;
    }
    const next = current + chunk;
    return next.length > MAX_OUTPUT_CHARS ? next.slice(next.length - MAX_OUTPUT_CHARS) : next;
}

function taskKill(pid: number, force: boolean): Promise<void> {
    const args = ['/PID', String(pid), '/T'];
    if (force) {
        args.push('/F');
    }
    return new Promise((resolve) => {
        const killer = spawn('taskkill', args, { windowsHide: true, stdio: 'ignore' });
        killer.on('exit', () => {
            resolve();
        });
        killer.on('error', () => {
            resolve();
        });
    });
}

// 每个进程以独立进程组启动，以便终止整棵进程树。
class ProcessHandle implements IProcessHandle {
    private readonly Child: ChildProcess;
    private readonly Options: TProcessOptions;
    private readonly Events: TProcessEvents | undefined;
    private readonly StartedAt = Date.now();
    private Stdout = '';
    private Stderr = '';
    private Exited = false;
    private Killed = false;
    private TimedOut = false;
    private Cancelled = false;
    private KillGraceTimer: ReturnType<typeof setTimeout> | undefined;
    private TimeoutTimer: ReturnType<typeof setTimeout> | undefined;

    public constructor(options: TProcessOptions, events?: TProcessEvents) {
        this.Options = options;
        this.Events = events;
        const env = { ...process.env, ...options.Env };
        this.Child = spawn(normalizeCommand(options.Command), options.Args ?? [], {
            cwd: options.Cwd,
            env,
            windowsHide: true,
            detached: !isWindows(),
            // stdin 显式关掉：留 pipe 会让读 stdin 的步骤永远等不到 EOF 而挂起，且步骤本就不喂输入。
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        this.Child.stdout?.on('data', (chunk: Buffer) => {
            const text = chunk.toString('utf8');
            this.Stdout = appendOutput(this.Stdout, text);
            this.Events?.OnStdout?.(text);
        });
        this.Child.stderr?.on('data', (chunk: Buffer) => {
            const text = chunk.toString('utf8');
            this.Stderr = appendOutput(this.Stderr, text);
            this.Events?.OnStderr?.(text);
        });
    }

    public get Pid(): number {
        const pid = this.Child.pid;
        return pid ?? -1;
    }

    public Wait(): Promise<TProcessResult> {
        if (!isNull(this.Child.exitCode) || !isNull(this.Child.signalCode)) {
            // 子进程在调用 Wait() 前已结束。
            this.Exited = true;
            return Promise.resolve(this.BuildResult());
        }
        return new Promise((resolve) => {
            const finish = (): void => {
                if (this.Exited) {
                    return;
                }
                this.Exited = true;
                this.ClearTimers();
                resolve(this.BuildResult());
            };
            this.Child.on('error', (error) => {
                // spawn 失败（如命令不存在）转为带提示的错误而非崩溃；不嵌入命令行，因其可能包含密钥。
                const code = 'code' in error && typeof error.code === 'string' ? error.code : undefined;
                this.Stderr = `${this.Stderr}Failed to start process${code === undefined ? '' : ` (${code})`}\n`;
                finish();
            });
            this.Child.on('close', finish);
            // 孙进程持有 stdio 管道时 'close' 可能永不触发；进程退出后尽快收尾，避免永久挂起。
            this.Child.on('exit', () => {
                if (this.Exited) {
                    return;
                }
                const fallback = setTimeout(() => {
                    finish();
                }, 5000);
                this.Child.once('close', () => {
                    clearTimeout(fallback);
                });
            });
            if (this.Options.TimeoutMs !== undefined && this.Options.TimeoutMs > 0) {
                this.TimeoutTimer = setTimeout(() => {
                    if (!this.Exited) {
                        this.TimedOut = true;
                        this.TerminateGracefully().catch(() => {
                            /* 终止失败不影响结果。 */
                        });
                    }
                }, this.Options.TimeoutMs);
            }
            this.Options.AbortSignal?.addEventListener('abort', () => {
                if (!this.Exited) {
                    this.Cancelled = true;
                    this.TerminateGracefully().catch(() => {
                        /* 终止失败不影响结果。 */
                    });
                }
            });
        });
    }

    private BuildResult(): TProcessResult {
        let status = EStepStatus.Success;
        if (this.TimedOut) {
            status = EStepStatus.Timeout;
        } else if (this.Cancelled || this.Killed) {
            status = EStepStatus.Cancelled;
        } else if (this.Child.exitCode !== 0) {
            status = EStepStatus.Failure;
        }
        return {
            Status: status,
            ExitCode: this.Child.exitCode ?? undefined,
            Stdout: this.Stdout,
            Stderr: this.Stderr,
            DurationMs: Date.now() - this.StartedAt,
        };
    }

    public async Kill(): Promise<void> {
        if (this.Exited) {
            return;
        }
        this.Killed = true;
        await this.TerminateGracefully();
    }

    private async TerminateGracefully(): Promise<void> {
        await this.Terminate(false);
        const graceMs = this.Options.KillGraceMs ?? DEFAULT_KILL_GRACE_MS;
        this.KillGraceTimer = setTimeout(() => {
            if (!this.Exited) {
                this.Terminate(true).catch(() => {
                    /* 进程可能已退出。 */
                });
            }
        }, graceMs);
    }

    private async Terminate(force: boolean): Promise<void> {
        const pid = this.Pid;
        if (pid <= 0) {
            return;
        }
        try {
            if (isWindows()) {
                await taskKill(pid, force);
            } else {
                // 子进程以 detached 启动，负 pid 指向整个进程组。
                process.kill(-pid, force ? 'SIGKILL' : 'SIGTERM');
            }
        } catch {
            // 进程可能已退出。
        }
    }

    private ClearTimers(): void {
        if (this.KillGraceTimer !== undefined) {
            clearTimeout(this.KillGraceTimer);
            this.KillGraceTimer = undefined;
        }
        if (this.TimeoutTimer !== undefined) {
            clearTimeout(this.TimeoutTimer);
            this.TimeoutTimer = undefined;
        }
    }
}

export class ProcessRunner implements IProcessRunner {
    public Run(options: TProcessOptions, events?: TProcessEvents): Promise<TProcessResult> {
        return this.Spawn(options, events).Wait();
    }

    public Spawn(options: TProcessOptions, events?: TProcessEvents): IProcessHandle {
        return new ProcessHandle(options, events);
    }
}

// 失败原因。超时/被杀时 stderr 常为空，若直接透传，错误信息是空的，运行记录看不到任何信息。
// 所以 stderr 为空时退回 stdout 末尾，再没有就合成一条说明状态的文字。
function describeFailure(result: TProcessResult): string {
    const stderr = result.Stderr.trim();
    if (stderr !== '') {
        return stderr.slice(0, MAX_ERROR_CHARS);
    }
    const reason =
        result.Status === EStepStatus.Timeout
            ? `Process timed out after ${result.DurationMs}ms and was killed`
            : result.Status === EStepStatus.Cancelled
              ? `Process was cancelled after ${result.DurationMs}ms`
              : `Process exited with code ${result.ExitCode ?? 'unknown'}`;
    const stdout = result.Stdout.trim();
    if (stdout === '') {
        return `${reason}; it produced no output.`;
    }
    return `${reason}. Last output: ${stdout.slice(-MAX_ERROR_CHARS)}`;
}

export function resultToStepResult(result: TProcessResult): TStepResult {
    return {
        Status: result.Status,
        ExitCode: result.ExitCode,
        Output: result.Stdout + result.Stderr,
        DurationMs: result.DurationMs,
        Error: result.Status === EStepStatus.Success ? undefined : describeFailure(result),
    };
}
