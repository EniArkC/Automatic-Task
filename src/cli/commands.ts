import { spawn } from 'node:child_process';
import { existsSync, readSync } from 'node:fs';
import { resolve } from 'node:path';

import { EExitCode, ERunStatus } from '@at/core';
import { IpcClient } from '@at/ipc';
import { PathService, PlatformService } from '@at/paths';
import { Command, CommanderError, Option } from 'commander';

import { AtClient } from './client';
import { exitCodeFor, RuntimeLauncher } from './runtime-launcher';

type TJsonable = Record<string, unknown> | unknown[] | string | number | boolean | undefined;

type THandlerOptions = {
    json: boolean;
};

function writeStdout(value: string): void {
    process.stdout.write(value);
}

function printJson(value: TJsonable): void {
    writeStdout(`${JSON.stringify(value)}\n`);
}

function asRecord(value: unknown): Record<string, unknown> {
    if (typeof value !== 'object' || value === undefined) {
        return {};
    }
    return value as Record<string, unknown>;
}

function asArray(value: unknown): Record<string, unknown>[] {
    if (!Array.isArray(value)) {
        return [];
    }
    return value.map((item) => asRecord(item));
}

function connected(): AtClient {
    return AtClient.Create();
}

function collect(value: string, previous: string[]): string[] {
    previous.push(value);
    return previous;
}

// Commander 选项解析器：拒绝非数字输入，避免 NaN 静默产生空结果。
function parseIntOption(value: string): number {
    const parsed = Number.parseInt(value, 10);
    if (Number.isNaN(parsed) || parsed < 0) {
        throw new CommanderError(
            1,
            'commander.invalidOptionArgument',
            `Expected a non-negative integer, got "${value}"`,
        );
    }
    return parsed;
}

async function ensureRuntimeForTui(): Promise<void> {
    const pathService = new PathService(new PlatformService());
    const socketPath = pathService.GetRuntimeSocketPath();
    const launcher = new RuntimeLauncher(socketPath);
    // 先切到交替缓冲区再等守护进程：TUI 以"连接中"状态启动，守护进程晚到与其他瞬时故障无异，
    // 不会在启动的约 0.7 秒里裸显示控制台。
    const { renderTui } = await import('@at/tui');
    const painting = renderTui(socketPath);
    // 吞掉 EnsureRunning 的拒绝：约 10 秒后抛错会杀死已在运行的 TUI，连接徽标是更好的报告渠道。
    void launcher.EnsureRunning(() => new IpcClient(socketPath)).catch(() => undefined);
    await painting;
}

function displayValue(value: unknown, fallback: string): string {
    return typeof value === 'string' ? value : fallback;
}

function readStdinLine(): string | undefined {
    try {
        const buffer = Buffer.alloc(1024);
        const bytes = readSync(0, buffer);
        if (bytes <= 0) {
            return undefined;
        }
        return buffer.toString('utf8', 0, bytes);
    } catch {
        return undefined;
    }
}

// 显示 y/N 提示，要求明确回答 y/Y。
function confirmDestructive(prompt: string, jsonMode: boolean): boolean {
    const target = jsonMode ? process.stderr : process.stdout;
    target.write(prompt);
    const input = readStdinLine();
    if (input === undefined) {
        return false;
    }
    const answer = input.trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
}

// 显示安装摘要并确认。JSON 模式提示走 stderr，stdout 保持机器可读。
function confirmInstall(
    manifest: Record<string, unknown>,
    preview: Record<string, unknown>,
    jsonMode: boolean,
): boolean {
    const target = jsonMode ? process.stderr : process.stdout;
    const lines = [
        `Task: ${displayValue(manifest.name, '?')} (${displayValue(manifest.id, '?')}@${displayValue(manifest.version, '?')})`,
        `Author: ${displayValue(manifest.author, '-')}`,
        `Scripts: ${displayValue(preview.scriptCount, '0')}`,
        `Uses Docker: ${displayValue(preview.usesDocker, 'false')}`,
        'Installing a package can run arbitrary code as your user. Install? [y/N] ',
    ];
    target.write(lines.join('\n'));
    const input = readStdinLine();
    if (input === undefined) {
        return false;
    }
    const answer = input.trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
}

async function ensureBackground(): Promise<void> {
    const client = connected();
    await client.Connect();
    client.Close();
    // 可执行文件旁有托盘程序就启动它。
    const trayExe = process.env.AT_TRAY_EXE;
    if (trayExe !== undefined && trayExe !== '' && existsSync(trayExe)) {
        spawn(trayExe, [], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    }
    process.exit(EExitCode.Success);
}

function humanTasks(tasks: unknown): void {
    for (const task of asArray(tasks)) {
        const enabled = task.enabled === true ? 'enabled' : 'disabled';
        const schedule = typeof task.schedule === 'string' ? task.schedule : '-';
        writeStdout(`${task.taskId as string}  ${enabled}  ${schedule}  v${task.packageVersion as string}\n`);
    }
}

function humanRuns(runs: unknown): void {
    for (const run of asArray(runs)) {
        writeStdout(`${run.status as string}  ${run.taskId as string}  ${run.runId as string}\n`);
    }
}

function fail(error: unknown): never {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(exitCodeFor(error));
}

function installPath(value: string): string {
    const path = resolve(value);
    if (!existsSync(path)) {
        process.stderr.write(`Package file "${value}" does not exist\n`);
        process.exit(EExitCode.InvalidUsage);
    }
    return path;
}

export function buildProgram(): Command {
    const program = new Command();
    program
        .name('autotask')
        .description('Automatic-Task - local automation task runner')
        .version('0.1.0')
        .allowExcessArguments(false);

    const jsonOption = (): Option => new Option('--json', 'machine-readable JSON output');

    program
        .command('list')
        .description('list installed tasks')
        .addOption(jsonOption())
        .action(async (options: THandlerOptions) => {
            const client = connected();
            await client.Connect();
            try {
                const result = asRecord(await client.Request('task.list', {}));
                if (options.json) {
                    printJson({ ok: true, tasks: result.tasks });
                } else {
                    humanTasks(result.tasks);
                }
            } catch (error) {
                fail(error);
            } finally {
                client.Close();
            }
        });

    program
        .command('run')
        .description('run a task manually')
        .argument('<taskId>', 'task id')
        .addOption(jsonOption())
        .action(async (taskId: string, options: THandlerOptions) => {
            const client = connected();
            await client.Connect();
            try {
                const result = asRecord(await client.Request('task.run', { taskId }));
                if (options.json) {
                    printJson({ ok: true, runId: result.runId });
                } else {
                    writeStdout(`Run started: ${result.runId as string}\n`);
                }
            } catch (error) {
                fail(error);
            } finally {
                client.Close();
            }
        });

    program
        .command('install')
        .description('install a task package (.atp)')
        .argument('<atpFile>', 'path to the .atp package')
        .option('--yes', 'skip the confirmation prompt')
        .addOption(jsonOption())
        .action(async (atpFile: string, options: THandlerOptions & { yes: boolean }) => {
            const path = installPath(atpFile);
            const client = connected();
            await client.Connect();
            try {
                const preview = asRecord(await client.Request('task.installInfo', { atpPath: path }));
                const manifest = asRecord(preview.manifest);
                if (!options.yes && !confirmInstall(manifest, preview, options.json)) {
                    if (options.json) {
                        process.stderr.write('Installation cancelled.\n');
                    } else {
                        writeStdout('Installation cancelled.\n');
                    }
                    return;
                }
                const result = asRecord(await client.Request('task.install', { atpPath: path }));
                if (options.json) {
                    printJson({ ok: true, taskId: result.taskId, version: result.version });
                } else {
                    writeStdout(`Installed ${result.taskId as string}@${result.version as string}\n`);
                    writeStdout(`Enable it with: autotask task enable ${String(result.taskId)}\n`);
                }
            } catch (error) {
                fail(error);
            } finally {
                client.Close();
            }
        });

    program
        .command('uninstall')
        .description('remove a task and its packages')
        .argument('<taskId>', 'task id')
        .option('--yes', 'skip the confirmation prompt')
        .addOption(jsonOption())
        .action(async (taskId: string, options: THandlerOptions & { yes: boolean }) => {
            if (
                !options.yes &&
                !confirmDestructive(`Uninstall "${taskId}" and delete its packages? [y/N] `, options.json)
            ) {
                if (options.json) {
                    process.stderr.write('Uninstall cancelled.\n');
                } else {
                    writeStdout('Uninstall cancelled.\n');
                }
                return;
            }
            const client = connected();
            await client.Connect();
            try {
                const result = asRecord(await client.Request('task.uninstall', { taskId }));
                if (options.json) {
                    printJson({ ok: true, taskId: result.uninstalled });
                } else {
                    writeStdout(`Uninstalled ${result.uninstalled as string}\n`);
                }
            } catch (error) {
                fail(error);
            } finally {
                client.Close();
            }
        });

    const task = program.command('task').description('manage task configuration');

    task.command('enable')
        .description('enable automatic scheduling for a task')
        .argument('<taskId>', 'task id')
        .addOption(jsonOption())
        .action(async (taskId: string, options: THandlerOptions) => {
            const client = connected();
            await client.Connect();
            try {
                const result = asRecord(await client.Request('task.enable', { taskId }));
                if (options.json) {
                    printJson({ ok: true, taskId: result.taskId, enabled: result.enabled });
                } else {
                    writeStdout(`Enabled ${result.taskId as string}\n`);
                }
            } catch (error) {
                fail(error);
            } finally {
                client.Close();
            }
        });

    task.command('disable')
        .description('disable automatic scheduling for a task')
        .argument('<taskId>', 'task id')
        .addOption(jsonOption())
        .action(async (taskId: string, options: THandlerOptions) => {
            const client = connected();
            await client.Connect();
            try {
                const result = asRecord(await client.Request('task.disable', { taskId }));
                if (options.json) {
                    printJson({ ok: true, taskId: result.taskId, enabled: result.enabled });
                } else {
                    writeStdout(`Disabled ${result.taskId as string}\n`);
                }
            } catch (error) {
                fail(error);
            } finally {
                client.Close();
            }
        });

    task.command('schedule')
        .description('set the cron schedule; omit the expression to clear it')
        .argument('<taskId>', 'task id')
        .argument('[cron]', 'cron expression')
        .addOption(jsonOption())
        .action(async (taskId: string, cron: string | undefined, options: THandlerOptions) => {
            const client = connected();
            await client.Connect();
            try {
                const result = asRecord(await client.Request('task.setSchedule', { taskId, cron }));
                if (options.json) {
                    printJson({ ok: true, taskId: result.taskId, schedule: result.schedule });
                } else {
                    const rawSchedule = result.schedule;
                    const schedule =
                        rawSchedule === undefined
                            ? 'none'
                            : typeof rawSchedule === 'string'
                              ? rawSchedule
                              : JSON.stringify(rawSchedule);
                    writeStdout(`Schedule for ${String(result.taskId)}: ${schedule}\n`);
                }
            } catch (error) {
                fail(error);
            } finally {
                client.Close();
            }
        });

    task.command('config')
        .description('show or update the task configuration')
        .argument('<taskId>', 'task id')
        .option('--set <name=value>', 'set a variable, repeatable', collect, [])
        .addOption(jsonOption())
        .action(async (taskId: string, options: THandlerOptions & { set: string[] }) => {
            const client = connected();
            await client.Connect();
            try {
                const variables: Record<string, unknown> = {};
                for (const assignment of options.set) {
                    const separator = assignment.indexOf('=');
                    if (separator <= 0) {
                        process.stderr.write(`Invalid --set "${assignment}", expected name=value\n`);
                        process.exit(EExitCode.InvalidUsage);
                    }
                    variables[assignment.slice(0, separator)] = assignment.slice(separator + 1);
                }
                const patch = Object.keys(variables).length > 0 ? { variables } : {};
                const result = asRecord(await client.Request('task.setConfig', { taskId, patch }));
                if (options.json) {
                    printJson({
                        ok: true,
                        taskId: result.taskId,
                        variables: result.variables,
                        overlap: result.overlap,
                    });
                } else {
                    writeStdout(`${taskId} variables:\n`);
                    for (const [name, value] of Object.entries(asRecord(result.variables))) {
                        writeStdout(`  ${name} = ${String(value)}\n`);
                    }
                }
            } catch (error) {
                fail(error);
            } finally {
                client.Close();
            }
        });

    program
        .command('status')
        .description('show runtime status')
        .addOption(jsonOption())
        .action(async (options: THandlerOptions) => {
            const client = connected();
            await client.Connect();
            try {
                const status = asRecord(await client.Request('runtime.status', {}));
                if (options.json) {
                    printJson({ ok: true, ...status });
                } else {
                    writeStdout(`Runtime started: ${status.startedAt as string}\n`);
                    writeStdout(`Protocol: ${status.protocol as string}  Version: ${status.version as string}\n`);
                    writeStdout(
                        `Tasks: ${status.tasks as number}  Active runs: ${(status.activeRuns as unknown[]).length}\n`,
                    );
                }
            } catch (error) {
                fail(error);
            } finally {
                client.Close();
            }
        });

    program
        .command('ps')
        .description('list active runs')
        .addOption(jsonOption())
        .action(async (options: THandlerOptions) => {
            const client = connected();
            await client.Connect();
            try {
                const result = asRecord(await client.Request('run.list', { limit: 50 }));
                const runs = asArray(result.runs).filter(
                    (run) => run.status === ERunStatus.Running || run.status === ERunStatus.Queued,
                );
                if (options.json) {
                    printJson({ ok: true, runs });
                } else {
                    humanRuns(runs);
                }
            } catch (error) {
                fail(error);
            } finally {
                client.Close();
            }
        });

    program
        .command('stop')
        .description('stop a run')
        .argument('<runId>', 'run id')
        .addOption(jsonOption())
        .action(async (runId: string, options: THandlerOptions) => {
            const client = connected();
            await client.Connect();
            try {
                await client.Request('run.stop', { runId });
                if (options.json) {
                    printJson({ ok: true, runId });
                } else {
                    writeStdout(`Stopping ${runId}\n`);
                }
            } catch (error) {
                fail(error);
            } finally {
                client.Close();
            }
        });

    program
        .command('runs')
        .description('list recent runs')
        .option('--limit <n>', 'maximum number of runs', parseIntOption, 20)
        .addOption(jsonOption())
        .action(async (options: THandlerOptions & { limit: number }) => {
            const client = connected();
            await client.Connect();
            try {
                const result = asRecord(await client.Request('run.list', { limit: options.limit }));
                if (options.json) {
                    printJson({ ok: true, runs: result.runs });
                } else {
                    humanRuns(result.runs);
                }
            } catch (error) {
                fail(error);
            } finally {
                client.Close();
            }
        });

    program
        .command('runs-prune')
        .description('delete run history older than N days')
        .option('--days <n>', 'keep runs younger than N days', parseIntOption, 30)
        .addOption(jsonOption())
        .action(async (options: THandlerOptions & { days: number }) => {
            const client = connected();
            await client.Connect();
            try {
                const result = asRecord(await client.Request('runs.prune', { days: options.days }));
                if (options.json) {
                    printJson({ ok: true, removed: result.removed });
                } else {
                    writeStdout(`Removed ${result.removed as number} run directories\n`);
                }
            } catch (error) {
                fail(error);
            } finally {
                client.Close();
            }
        });

    program
        .command('logs')
        .description('show the latest run output of a task')
        .argument('<taskId>', 'task id')
        .option('--lines <n>', 'number of lines', parseIntOption, 50)
        .addOption(jsonOption())
        .action(async (taskId: string, options: THandlerOptions & { lines: number }) => {
            const client = connected();
            await client.Connect();
            try {
                const result = asRecord(await client.Request('logs.tail', { taskId, lines: options.lines }));
                if (options.json) {
                    printJson({ ok: true, lines: result.lines });
                } else {
                    const lines = Array.isArray(result.lines) ? (result.lines as unknown[]) : [];
                    for (const line of lines) {
                        writeStdout(`${typeof line === 'string' ? line : JSON.stringify(line)}\n`);
                    }
                }
            } catch (error) {
                fail(error);
            } finally {
                client.Close();
            }
        });

    program
        .command('tui')
        .description('open the terminal UI')
        .action(() => {
            void ensureRuntimeForTui();
        });

    program
        .option('--background', 'start the runtime in the background')
        .action(async (options: { Background?: boolean }) => {
            if (options.Background === true) {
                await ensureBackground();
                return;
            }
            await ensureRuntimeForTui();
        });

    return program;
}

export async function runCli(argv: string[]): Promise<number> {
    const program = buildProgram();
    program.exitOverride();
    try {
        await program.parseAsync(argv, { from: 'node' });
        return EExitCode.Success;
    } catch (error) {
        if (error instanceof CommanderError) {
            if (error.code === 'commander.helpDisplayed' || error.code === 'commander.version') {
                return EExitCode.Success;
            }
            process.stderr.write(`${error.message}\n`);
            return EExitCode.InvalidUsage;
        }
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        return EExitCode.Generic;
    }
}
