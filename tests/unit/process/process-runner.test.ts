import { EStepStatus } from '@at/core';
import { ProcessRunner, resultToStepResult } from '@at/process';
import { describe, expect, it } from 'vitest';

const runner = new ProcessRunner();

function nodeSource(source: string): { Command: string; Args: string[] } {
    return { Command: process.execPath, Args: ['-e', source] };
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

describe('process runner', () => {
    it('captures stdout and succeeds', async () => {
        const result = await runner.Run(nodeSource("console.log('hello world')"));
        expect(result.Status).toBe(EStepStatus.Success);
        expect(result.Stdout).toContain('hello world');
        expect(result.ExitCode).toBe(0);
    });

    it('reports non-zero exit codes as failure', async () => {
        const result = await runner.Run(nodeSource('process.exit(3)'));
        expect(result.Status).toBe(EStepStatus.Failure);
        expect(result.ExitCode).toBe(3);
    });

    // 子进程的 stdin 必须是关闭的。默认的 'pipe' 会留一根父进程永不写也永不关的
    // 管道，子进程读它等到的是一个不会到达的 EOF：CLI 只要在非交互模式下顺手读
    // 一次 stdin（opencode 就是这样），步骤会一直挂到超时且不产出任何输出。
    it('closes stdin so a child reading it sees eof instead of hanging', async () => {
        const source =
            "let n = 0; process.stdin.on('data', (c) => { n += c.length; }); " +
            "process.stdin.on('end', () => { console.log('eof:' + n); });";
        const result = await runner.Run({ ...nodeSource(source), TimeoutMs: 10000 });
        expect(result.Status).toBe(EStepStatus.Success);
        expect(result.Stdout).toContain('eof:0');
    });

    it('separates stdout and stderr', async () => {
        const result = await runner.Run(nodeSource("console.log('out'); console.error('err')"));
        expect(result.Stdout).toContain('out');
        expect(result.Stdout).not.toContain('err');
        expect(result.Stderr).toContain('err');
    });

    it('streams output through events', async () => {
        const chunks: string[] = [];
        const result = await runner.Run(nodeSource("console.log('streamed')"), {
            OnStdout: (data) => {
                chunks.push(data);
            },
        });
        expect(result.Stdout).toContain('streamed');
        expect(chunks.join('')).toContain('streamed');
    });

    it('respects the working directory', async () => {
        const cwd = process.cwd();
        const result = await runner.Run({ ...nodeSource('console.log(process.cwd())'), Cwd: cwd });
        expect(result.Stdout.trim()).toBe(cwd);
    });

    it('passes environment variables', async () => {
        const result = await runner.Run({
            ...nodeSource('console.log(process.env.AT_TEST_VAR)'),
            Env: { AT_TEST_VAR: 'value-42' },
        });
        expect(result.Stdout.trim()).toBe('value-42');
    });

    it('kills a process after the timeout', async () => {
        const started = Date.now();
        const result = await runner.Run({ ...nodeSource('setTimeout(() => {}, 120000)'), TimeoutMs: 1000 });
        expect(result.Status).toBe(EStepStatus.Timeout);
        expect(Date.now() - started).toBeLessThan(15000);
    });

    it('cancels on abort', async () => {
        const controller = new AbortController();
        const resultPromise = runner.Run({
            ...nodeSource('setTimeout(() => {}, 120000)'),
            AbortSignal: controller.signal,
        });
        setTimeout(() => {
            controller.abort();
        }, 500);
        const result = await resultPromise;
        expect(result.Status).toBe(EStepStatus.Cancelled);
    });

    it('kills the whole process tree', async () => {
        const source = [
            "const { spawn } = require('child_process');",
            "const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)']);",
            'console.log("CHILD_PID=" + child.pid);',
            'setTimeout(() => {}, 120000);',
        ].join(' ');
        const output: string[] = [];
        const handle = runner.Spawn(nodeSource(source), {
            OnStdout: (data) => {
                output.push(data);
            },
        });
        const waitPromise = handle.Wait();
        const childPid = await new Promise<number>((resolve) => {
            const poll = setInterval(() => {
                const match = /CHILD_PID=(?<pid>\d+)/.exec(output.join(''));
                const pid = Number(match?.groups?.pid ?? 0);
                if (pid > 0) {
                    clearInterval(poll);
                    resolve(pid);
                }
            }, 50);
            setTimeout(() => {
                clearInterval(poll);
                resolve(0);
            }, 5000);
        });
        expect(childPid).toBeGreaterThan(0);
        await handle.Kill();
        const result = await waitPromise;
        expect(result.Status).toBe(EStepStatus.Cancelled);
        // The grandchild must be dead too, not just the direct child.
        let childAlive = true;
        for (let i = 0; i < 50; i++) {
            try {
                process.kill(childPid, 0);
            } catch {
                childAlive = false;
                break;
            }
            await sleep(100);
        }
        expect(childAlive).toBe(false);
    });

    it('reports a missing command as a failure', async () => {
        const result = await runner.Run({ Command: 'definitely-not-a-real-command-xyz', Args: [] });
        expect(result.Status).toBe(EStepStatus.Failure);
        expect(result.Stderr).toContain('Failed to start process');
    });
});

// 失败的运行记录里 Error 字段必须永远有内容。子进程被超时杀掉时往往一个字节都不吐，
// 早先直接把空 stderr 传上去，运行记录里就只剩一条 Error: ""——这正是「执行失败但日志是空的」。
describe('failure description', () => {
    it('explains a silent timeout that produced no output', () => {
        const step = resultToStepResult({
            Status: EStepStatus.Timeout,
            ExitCode: undefined,
            Stdout: '',
            Stderr: '',
            DurationMs: 30000,
        });
        expect(step.Error).toContain('timed out after 30000ms');
        expect(step.Error).toContain('no output');
    });

    it('falls back to trailing stdout when stderr is empty', () => {
        const step = resultToStepResult({
            Status: EStepStatus.Failure,
            ExitCode: 7,
            Stdout: 'connecting…\nlast line before dying',
            Stderr: '',
            DurationMs: 120,
        });
        expect(step.Error).toContain('exited with code 7');
        expect(step.Error).toContain('last line before dying');
    });

    it('explains a cancelled process', () => {
        const step = resultToStepResult({
            Status: EStepStatus.Cancelled,
            ExitCode: undefined,
            Stdout: '',
            Stderr: '',
            DurationMs: 500,
        });
        expect(step.Error).toContain('cancelled');
    });

    it('prefers stderr when there is any', () => {
        const step = resultToStepResult({
            Status: EStepStatus.Failure,
            ExitCode: 1,
            Stdout: 'noise',
            Stderr: 'the real reason',
            DurationMs: 10,
        });
        expect(step.Error).toBe('the real reason');
    });

    it('leaves a successful result without an error', () => {
        const step = resultToStepResult({
            Status: EStepStatus.Success,
            ExitCode: 0,
            Stdout: 'ok',
            Stderr: '',
            DurationMs: 10,
        });
        expect(step.Error).toBeUndefined();
    });
});
