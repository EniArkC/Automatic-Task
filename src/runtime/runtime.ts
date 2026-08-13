import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { parseAts } from '@at/ats';
import { ConfigManager, type TTaskConfig } from '@at/config';
import {
    AtError,
    AtIpcError,
    AtUserError,
    EExitCode,
    EOverlapPolicy,
    ERunTrigger,
    EVENT_RUN_CANCELLED,
    EVENT_RUN_CREATED,
    EVENT_RUN_FAILED,
    EVENT_RUN_FINISHED,
    EVENT_RUN_STARTED,
    EVENT_RUN_STEP_FINISHED,
    EVENT_RUN_STEP_OUTPUT,
    EVENT_RUN_STEP_STARTED,
    EVENT_TASK_DISABLED,
    EVENT_TASK_ENABLED,
    EVENT_TASK_INSTALLED,
    EVENT_TASK_UNINSTALLED,
    EventBus,
    isNullOrUndefined,
    SystemClock,
    UlidGenerator,
} from '@at/core';
import { createChainExecutor, DockerExecutor, PiAgentAdapter, ScriptExecutor, StepExecutor } from '@at/executor';
import {
    IPC_METHOD_APP_GET,
    IPC_METHOD_APP_SET,
    IPC_METHOD_LOGS_TAIL,
    IPC_METHOD_RUN_CANCEL,
    IPC_METHOD_RUN_GET,
    IPC_METHOD_RUN_LIST,
    IPC_METHOD_RUN_STOP,
    IPC_METHOD_RUNS_PRUNE,
    IPC_METHOD_RUNTIME_PING,
    IPC_METHOD_RUNTIME_SHUTDOWN,
    IPC_METHOD_RUNTIME_STATUS,
    IPC_METHOD_TASK_DISABLE,
    IPC_METHOD_TASK_ENABLE,
    IPC_METHOD_TASK_GET,
    IPC_METHOD_TASK_INSTALL,
    IPC_METHOD_TASK_INSTALL_INFO,
    IPC_METHOD_TASK_LIST,
    IPC_METHOD_TASK_RUN,
    IPC_METHOD_TASK_SCHEMA,
    IPC_METHOD_TASK_SET_CONFIG,
    IPC_METHOD_TASK_SET_SCHEDULE,
    IPC_METHOD_TASK_UNINSTALL,
    IPC_PROTOCOL,
    IpcServer,
    type TIpcConnection,
    type TIpcMessage,
} from '@at/ipc';
import type { ILogger } from '@at/logging';
import { ELogLevel, redactSecrets } from '@at/logging';
import { PackageManager } from '@at/package-manager';
import type { IPathService } from '@at/paths';
import { ProcessRunner } from '@at/process';
import { RunFiles, RunManager, RunStateMachine, serializeRunRecord } from '@at/run';
import { isValidCron, Scheduler } from '@at/scheduler';

export const RUNTIME_VERSION = '0.1.0';

// 自动清理的巡检间隔。清理粒度是「天」，一小时一次足够贴合配置，
// 也让长期开着的守护进程不必等重启才生效。
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
// 未配置时的默认保留天数，与 TUI 全局配置页显示的默认值一致。
const DEFAULT_KEEP_RUNS_DAYS = 30;
const DEFAULT_KEEP_WORKSPACE_DAYS = 7;

export type TRuntimeOptions = {
    SocketPath: string;
    Logger: ILogger;
    PathService: IPathService;
};

export interface IRuntime {
    Start(): Promise<void>;
    Stop(): void;
}

export class Runtime implements IRuntime {
    private readonly Options: TRuntimeOptions;
    private readonly Logger: ILogger;
    private readonly EventBus = new EventBus();
    private readonly Clock = new SystemClock();
    private readonly StateMachine = new RunStateMachine();
    private readonly IdGenerator = new UlidGenerator();
    private readonly ProcessRunner = new ProcessRunner();
    private readonly IpcServer: IpcServer;
    private readonly ConfigManager: ConfigManager;
    private readonly PackageManager: PackageManager;
    private readonly RunManager: RunManager;
    private readonly Scheduler: Scheduler;
    private StartedAt: Date | undefined;
    private CleanupTimer: NodeJS.Timeout | undefined;
    private Stopped = false;

    public constructor(options: TRuntimeOptions) {
        this.Options = options;
        this.Logger = options.Logger;
        this.ConfigManager = new ConfigManager(options.PathService, this.Logger);
        this.PackageManager = new PackageManager(options.PathService, this.ConfigManager, this.Logger);
        const stepExecutor = new StepExecutor(
            new ScriptExecutor(this.ProcessRunner),
            // 传读取函数而非快照：全局配置可被 app.set 改写，快照会让改动到守护进程重启才生效。
            new PiAgentAdapter(this.ProcessRunner, () => this.ConfigManager.LoadAppConfig().agent),
            new DockerExecutor(this.ProcessRunner),
        );
        const { Chain: chain } = createChainExecutor(stepExecutor);
        this.RunManager = new RunManager({
            PathService: options.PathService,
            ConfigManager: this.ConfigManager,
            PackageManager: this.PackageManager,
            EventBus: this.EventBus,
            Logger: this.Logger,
            ChainExecutor: chain,
            RunFiles: new RunFiles(options.PathService),
            StateMachine: this.StateMachine,
            Clock: this.Clock,
            IdGenerator: this.IdGenerator,
        });
        this.Scheduler = new Scheduler({
            ConfigManager: this.ConfigManager,
            RunManager: this.RunManager,
            Logger: this.Logger,
            Clock: this.Clock,
            EventBus: this.EventBus,
        });
        this.IpcServer = new IpcServer(options.SocketPath);
    }

    public async Start(): Promise<void> {
        this.StartedAt = this.Clock.Now();
        // 若 app.json 配置了日志级别，优先使用该级别。
        const appConfig = this.ConfigManager.LoadAppConfig();
        if (appConfig.logging?.level !== undefined) {
            this.Logger.SetLevel(appConfig.logging.level as ELogLevel);
        }
        this.Logger.Info('Runtime starting');
        this.WriteLockFile();
        this.ForwardEventsToIpc();
        this.IpcServer.OnMessage((connection, message) => {
            this.HandleMessage(connection, message);
        });
        await this.IpcServer.Listen();
        this.Logger.Info('IPC server listening', { socket: this.Options.SocketPath });
        this.Logger.Info('Runtime ready');
        // 后台初始化：恢复与清理不能阻塞启动。
        this.RunManager.RecoverInterrupted();
        this.PackageManager.CleanupTemp();
        this.RunCleanup();
        this.CleanupTimer = setInterval(() => {
            this.RunCleanup();
        }, CLEANUP_INTERVAL_MS);
        this.Scheduler.Start();
    }

    // 按 app.json 的 cleanup 配置自动清理。每次都重新读配置而不是用启动快照，
    // 这样 app.set 改完立刻生效，不用等守护进程重启。
    // 天数为 0 表示关闭该项清理——0 天在语义上等于「立刻删光」，
    // 那不该是自动行为，手动清理仍可通过 runs.prune days=0 触发。
    private RunCleanup(): void {
        const cleanup = this.ConfigManager.LoadAppConfig().cleanup;
        const keepRunsDays = cleanup?.keepRunsDays ?? DEFAULT_KEEP_RUNS_DAYS;
        const keepWorkspaceDays = cleanup?.keepWorkspaceDays ?? DEFAULT_KEEP_WORKSPACE_DAYS;
        try {
            // 先清工作区再清整目录：过期的 run 目录会被整体删掉，
            // 反过来会先删一遍马上要消失的 workspace，白做一次 IO。
            if (keepWorkspaceDays > 0) {
                this.RunManager.PruneWorkspaces(keepWorkspaceDays);
            }
            if (keepRunsDays > 0) {
                this.RunManager.Prune(keepRunsDays);
            }
        } catch (error) {
            // 清理是后台维护，失败不能影响守护进程本身。
            this.Logger.Warn('Automatic cleanup failed', { error });
        }
    }

    public Stop(): void {
        if (this.Stopped) {
            return;
        }
        this.Stopped = true;
        this.Logger.Info('Runtime shutting down');
        this.Scheduler.Stop();
        if (this.CleanupTimer !== undefined) {
            clearInterval(this.CleanupTimer);
            this.CleanupTimer = undefined;
        }
        // 终止所有运行中的任务，确保子进程不随守护进程残留。
        this.RunManager.StopAll();
        this.IpcServer.Close();
        this.RemoveLockFile();
        this.Logger.Info('Runtime stopped');
    }

    // 实时输出经 IPC 事件推送给 TUI/CLI，绝不轮询文件。
    private ForwardEventsToIpc(): void {
        const forwarded = [
            EVENT_RUN_CREATED,
            EVENT_RUN_STARTED,
            EVENT_RUN_STEP_STARTED,
            EVENT_RUN_STEP_OUTPUT,
            EVENT_RUN_STEP_FINISHED,
            EVENT_RUN_FINISHED,
            EVENT_RUN_FAILED,
            EVENT_RUN_CANCELLED,
            EVENT_TASK_INSTALLED,
            EVENT_TASK_UNINSTALLED,
            EVENT_TASK_ENABLED,
            EVENT_TASK_DISABLED,
        ];
        for (const type of forwarded) {
            this.EventBus.On(type, (event) => {
                this.IpcServer.Broadcast({ protocol: IPC_PROTOCOL, type: event.Type, ...event.Payload });
            });
        }
    }

    private HandleMessage(connection: TIpcConnection, message: TIpcMessage): void {
        if (!('method' in message)) {
            return;
        }
        void this.Dispatch(connection, message);
    }

    private async Dispatch(
        connection: TIpcConnection,
        message: Extract<TIpcMessage, { method: string }>,
    ): Promise<void> {
        const params = message.params ?? {};
        try {
            const result = await this.Invoke(message.method, params);
            connection.Send({ protocol: IPC_PROTOCOL, id: message.id, ok: true, result });
        } catch (error) {
            connection.Send({
                protocol: IPC_PROTOCOL,
                id: message.id,
                ok: false,
                error: {
                    code: this.ErrorCode(error),
                    message: this.ErrorMessage(error),
                    exitCode: error instanceof AtError ? error.ExitCode : 1,
                },
            });
        }
    }

    private async Invoke(method: string, params: Record<string, unknown>): Promise<unknown> {
        switch (method) {
            case IPC_METHOD_RUNTIME_PING:
                return { pong: true, protocol: IPC_PROTOCOL, version: RUNTIME_VERSION };
            case IPC_METHOD_RUNTIME_STATUS:
                return this.Status();
            case IPC_METHOD_RUNTIME_SHUTDOWN:
                setTimeout(() => {
                    this.Stop();
                }, 100);
                return { stopping: true };
            case IPC_METHOD_APP_GET:
                return this.ConfigManager.LoadAppConfig();
            case IPC_METHOD_APP_SET:
                return this.AppSet(this.RequireObject(params, 'patch'));
            case IPC_METHOD_TASK_LIST:
                return this.TaskList();
            case IPC_METHOD_TASK_GET:
                return this.TaskGet(this.RequireString(params, 'taskId'));
            case IPC_METHOD_TASK_SCHEMA:
                return this.TaskSchema(this.RequireString(params, 'taskId'));
            case IPC_METHOD_TASK_INSTALL_INFO: {
                const preview = await this.PackageManager.Inspect(this.RequireString(params, 'atpPath'));
                return {
                    manifest: {
                        spec: preview.Manifest.spec,
                        id: preview.Manifest.id,
                        name: preview.Manifest.name,
                        version: preview.Manifest.version,
                        description: preview.Manifest.description,
                        author: preview.Manifest.author,
                    },
                    scriptCount: preview.ScriptCount,
                    usesDocker: preview.UsesDocker,
                    files: preview.Files,
                };
            }
            case IPC_METHOD_TASK_INSTALL:
                return this.TaskInstall(this.RequireString(params, 'atpPath'));
            case IPC_METHOD_TASK_UNINSTALL:
                return this.TaskUninstall(this.RequireString(params, 'taskId'));
            case IPC_METHOD_TASK_ENABLE:
                return this.TaskSetEnabled(this.RequireString(params, 'taskId'), true);
            case IPC_METHOD_TASK_DISABLE:
                return this.TaskSetEnabled(this.RequireString(params, 'taskId'), false);
            case IPC_METHOD_TASK_SET_SCHEDULE:
                return this.TaskSetSchedule(this.RequireString(params, 'taskId'), this.OptionalString(params, 'cron'));
            case IPC_METHOD_TASK_SET_CONFIG:
                return this.TaskSetConfig(this.RequireString(params, 'taskId'), this.RequireObject(params, 'patch'));
            case IPC_METHOD_TASK_RUN:
                return this.TaskRun(this.RequireString(params, 'taskId'), this.OptionalObject(params, 'variables'));
            case IPC_METHOD_RUN_GET: {
                const record = this.RunManager.GetRun(this.RequireString(params, 'runId'));
                return record === undefined ? undefined : serializeRunRecord(record);
            }
            case IPC_METHOD_RUN_LIST: {
                const limit = this.OptionalNumber(params, 'limit') ?? 50;
                const taskId = this.OptionalString(params, 'taskId');
                return { runs: this.RunManager.ListRuns({ TaskId: taskId, Limit: limit }).map(serializeRunRecord) };
            }
            case IPC_METHOD_RUN_STOP:
            case IPC_METHOD_RUN_CANCEL:
                this.RunManager.Stop(this.RequireString(params, 'runId'));
                return { stopped: true };
            case IPC_METHOD_RUNS_PRUNE: {
                const days = this.OptionalNumber(params, 'days') ?? 30;
                return { removed: this.RunManager.Prune(days) };
            }
            case IPC_METHOD_LOGS_TAIL:
                return this.LogsTail(
                    this.RequireString(params, 'taskId'),
                    this.OptionalString(params, 'runId'),
                    this.OptionalNumber(params, 'lines') ?? 50,
                );
            default:
                throw new AtIpcError(`Unknown IPC method "${method}"`);
        }
    }

    private Status(): Record<string, unknown> {
        return {
            startedAt: this.StartedAt?.toISOString(),
            protocol: IPC_PROTOCOL,
            version: RUNTIME_VERSION,
            tasks: this.ConfigManager.ListTaskConfigs().length,
            activeRuns: this.RunManager.GetActiveRuns().map((record) => ({
                runId: record.RunId,
                taskId: record.TaskId,
                status: record.Status,
            })),
            scheduler: { running: true },
        };
    }

    private TaskList(): Record<string, unknown> {
        // 任务实际运行配置中的 packageVersion，原样上报；多版本共存时报告最新版会造成误导。
        const configs = this.ConfigManager.ListTaskConfigs();
        const tasks = configs.map((config) => ({
            taskId: config.taskId,
            packageVersion: config.packageVersion,
            enabled: config.enabled,
            schedule: config.schedule?.cron,
            overlap: config.overlap,
        }));
        return { tasks };
    }

    private TaskGet(taskId: string): Record<string, unknown> {
        const config = this.ConfigManager.GetTaskConfig(taskId);
        if (config === undefined) {
            throw new AtUserError(`Task "${taskId}" does not exist. Install it with: autotask install <file>.atp`, {
                exitCode: EExitCode.TaskNotFound,
            });
        }
        const pkg = this.PackageManager.GetPackage(taskId, config.packageVersion);
        return {
            taskId,
            name: pkg?.Manifest.name,
            description: pkg?.Manifest.description,
            author: pkg?.Manifest.author,
            version: pkg?.Version,
            enabled: config.enabled,
            schedule: config.schedule?.cron,
            overlap: config.overlap,
            variables: config.variables,
            packagePath: pkg?.Path,
        };
    }

    // 暴露 @var 声明供客户端渲染配置表单：task.get 只带已设置的值，无法表达类型、select 选项或是否必填。
    // 值按优先级（声明默认值 → 保存的配置）合并，编辑器可在 schema 旁展示生效值。
    private TaskSchema(taskId: string): Record<string, unknown> {
        const config = this.RequireTaskConfig(taskId);
        const pkg = this.PackageManager.GetPackage(taskId, config.packageVersion);
        if (pkg === undefined) {
            throw new AtUserError(
                `Package "${taskId}@${config.packageVersion}" is not installed; reinstall it with: autotask install <file>.atp`,
                { exitCode: EExitCode.TaskNotFound },
            );
        }
        const ast = parseAts(this.PackageManager.ReadTaskAts(taskId, pkg.Version), 'task.ats');
        const variables = ast.Variables.map((declaration) => {
            const configured = config.variables[declaration.Name];
            return {
                name: declaration.Name,
                type: declaration.Type,
                required: declaration.Required,
                defaultValue: declaration.DefaultValue,
                options: declaration.Options,
                description: declaration.Description,
                // 密码绝不回传；客户端只显示占位符，仅在用户重新输入时发送值。
                configured: declaration.Type === 'password' ? undefined : configured,
                hasConfigured: configured !== undefined,
            };
        });
        return { taskId, version: pkg.Version, variables };
    }

    private async TaskInstall(atpPath: string): Promise<Record<string, unknown>> {
        const installed = await this.PackageManager.Install(atpPath);
        this.EventBus.Emit(EVENT_TASK_INSTALLED, { taskId: installed.TaskId, version: installed.Version });
        return { taskId: installed.TaskId, version: installed.Version };
    }

    private TaskUninstall(taskId: string): Record<string, unknown> {
        this.PackageManager.Uninstall(taskId);
        this.EventBus.Emit(EVENT_TASK_UNINSTALLED, { taskId });
        return { uninstalled: taskId };
    }

    private TaskSetEnabled(taskId: string, enabled: boolean): Record<string, unknown> {
        const config = this.RequireTaskConfig(taskId);
        config.enabled = enabled;
        this.ConfigManager.SaveTaskConfig(config);
        this.EventBus.Emit(enabled ? EVENT_TASK_ENABLED : EVENT_TASK_DISABLED, { taskId });
        return { taskId, enabled };
    }

    private TaskSetSchedule(taskId: string, cron: string | undefined): Record<string, unknown> {
        const config = this.RequireTaskConfig(taskId);
        if (cron === undefined) {
            config.schedule = undefined;
        } else {
            if (!isValidCron(cron)) {
                throw new AtUserError(`Invalid cron expression "${cron}"`);
            }
            config.schedule = { cron };
        }
        this.ConfigManager.SaveTaskConfig(config);
        return { taskId, schedule: config.schedule?.cron };
    }

    private TaskSetConfig(taskId: string, patch: Record<string, unknown>): Record<string, unknown> {
        const config = this.RequireTaskConfig(taskId);
        const variables = patch.variables;
        if (variables !== undefined) {
            if (typeof variables !== 'object') {
                throw new AtUserError('variables must be an object');
            }
            const nextVariables = { ...config.variables };
            for (const [name, value] of Object.entries(variables as Record<string, unknown>)) {
                if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
                    throw new AtUserError(`Variable "${name}" must be a string, number or boolean`);
                }
                // patch 为增量语义：只覆盖出现的键，未提及的保持不变。
                nextVariables[name] = value;
            }
            config.variables = nextVariables;
        }
        const overlap = patch.overlap;
        if (overlap !== undefined) {
            if (overlap !== 'skip' && overlap !== 'queue' && overlap !== 'parallel') {
                throw new AtUserError('overlap must be one of skip, queue, parallel');
            }
            config.overlap = overlap as EOverlapPolicy;
        }
        this.ConfigManager.SaveTaskConfig(config);
        // 密码变量不回传客户端：CLI 会打印返回值，机密必须保持掩码。
        return {
            taskId,
            variables: redactSecrets(config.variables),
            overlap: config.overlap,
        };
    }

    private TaskRun(taskId: string, variables: Record<string, unknown> | undefined): Record<string, unknown> {
        const record = this.RunManager.Start(taskId, {
            Trigger: ERunTrigger.Manual,
            Variables: variables as Record<string, string | number | boolean> | undefined,
        });
        return { runId: record.RunId, status: record.Status };
    }

    private AppSet(patch: Record<string, unknown>): Record<string, unknown> {
        const config = this.ConfigManager.LoadAppConfig();
        const agent = patch.agent;
        if (agent !== undefined) {
            if (typeof agent !== 'object' || isNullOrUndefined(agent)) {
                throw new AtUserError('agent must be an object');
            }
            const nextAgent: { command?: string; args?: string[]; model?: string } = {};
            const raw = agent as Record<string, unknown>;
            if (raw.command !== undefined) {
                if (typeof raw.command !== 'string' || raw.command === '') {
                    throw new AtUserError('agent.command must be a non-empty string');
                }
                nextAgent.command = raw.command;
            }
            if (raw.args !== undefined) {
                if (!Array.isArray(raw.args) || !raw.args.every((item) => typeof item === 'string')) {
                    throw new AtUserError('agent.args must be an array of strings');
                }
                nextAgent.args = raw.args;
            }
            if (raw.model !== undefined) {
                if (typeof raw.model !== 'string') {
                    throw new AtUserError('agent.model must be a string');
                }
                nextAgent.model = raw.model;
            }
            config.agent = { ...config.agent, ...nextAgent };
        }
        const logging = patch.logging;
        if (logging !== undefined) {
            if (typeof logging !== 'object' || isNullOrUndefined(logging)) {
                throw new AtUserError('logging must be an object');
            }
            const nextLogging: { level?: string; maxFileSizeMb?: number; maxFiles?: number } = {};
            const rawLogging = logging as Record<string, unknown>;
            if (rawLogging.level !== undefined) {
                const level = rawLogging.level;
                if (level !== 'debug' && level !== 'info' && level !== 'warn' && level !== 'error') {
                    throw new AtUserError('logging.level must be one of debug, info, warn, error');
                }
                nextLogging.level = level;
            }
            if (rawLogging.maxFileSizeMb !== undefined) {
                const size = rawLogging.maxFileSizeMb;
                if (typeof size !== 'number' || size < 1) {
                    throw new AtUserError('logging.maxFileSizeMb must be a positive number');
                }
                nextLogging.maxFileSizeMb = size;
            }
            if (rawLogging.maxFiles !== undefined) {
                const files = rawLogging.maxFiles;
                if (typeof files !== 'number' || !Number.isInteger(files) || files < 1) {
                    throw new AtUserError('logging.maxFiles must be a positive integer');
                }
                nextLogging.maxFiles = files;
            }
            config.logging = { ...config.logging, ...nextLogging };
        }
        const cleanup = patch.cleanup;
        if (cleanup !== undefined) {
            if (typeof cleanup !== 'object' || isNullOrUndefined(cleanup)) {
                throw new AtUserError('cleanup must be an object');
            }
            const nextCleanup: { keepRunsDays?: number; keepWorkspaceDays?: number } = {};
            const rawCleanup = cleanup as Record<string, unknown>;
            if (rawCleanup.keepRunsDays !== undefined) {
                const days = rawCleanup.keepRunsDays;
                if (typeof days !== 'number' || !Number.isInteger(days) || days < 0) {
                    throw new AtUserError('cleanup.keepRunsDays must be a non-negative integer');
                }
                nextCleanup.keepRunsDays = days;
            }
            if (rawCleanup.keepWorkspaceDays !== undefined) {
                const days = rawCleanup.keepWorkspaceDays;
                if (typeof days !== 'number' || !Number.isInteger(days) || days < 0) {
                    throw new AtUserError('cleanup.keepWorkspaceDays must be a non-negative integer');
                }
                nextCleanup.keepWorkspaceDays = days;
            }
            config.cleanup = { ...config.cleanup, ...nextCleanup };
        }
        this.ConfigManager.SaveAppConfig(config);
        // 日志级别对运行中的守护进程立即生效。
        if (config.logging?.level !== undefined) {
            this.Logger.SetLevel(config.logging.level as ELogLevel);
        }
        return { version: config.version, agent: config.agent, logging: config.logging, cleanup: config.cleanup };
    }

    private LogsTail(taskId: string, runId: string | undefined, lines: number): Record<string, unknown> {
        const run =
            runId === undefined
                ? this.RunManager.ListRuns({ TaskId: taskId, Limit: 1 })[0]
                : this.RunManager.GetRun(runId);
        if (run === undefined) {
            return { lines: [] };
        }
        const merged: string[] = [];
        for (const file of [
            this.Options.PathService.GetRunStdoutPath(run.RunId),
            this.Options.PathService.GetRunStderrPath(run.RunId),
        ]) {
            try {
                const content = readFileSync(file, 'utf8');
                for (const line of content.split('\n')) {
                    if (line !== '') {
                        merged.push(line);
                    }
                }
            } catch {
                // 某个流可能尚未生成；仍展示另一个。
            }
        }
        // 步骤挂死、超时被杀、命令没启动起来时 stdout/stderr 一个字节都没有，面板全空
        // （执行失败但日志为空）。此时退回步骤时间线：至少能展示执行到哪一步、下一步要执行什么、卡在哪一步。
        if (merged.length === 0) {
            merged.push(...this.ReadEventTimeline(run.RunId));
        }
        // 失败原因单独补一行；它落在 metadata.json 里，此前从未出现在日志面板上。
        if (run.Error !== undefined && run.Error !== '') {
            merged.push(`[error] ${run.Error}`);
        }
        return { lines: merged.slice(Math.max(0, merged.length - lines)) };
    }

    // 把 events.jsonl 渲染成人能读的步骤时间线。任何一行坏了都跳过——日志读取不该因一条脏数据失败。
    private ReadEventTimeline(runId: string): string[] {
        let content: string;
        try {
            content = readFileSync(this.Options.PathService.GetRunEventsPath(runId), 'utf8');
        } catch {
            return [];
        }
        const rendered: string[] = [];
        for (const raw of content.split('\n')) {
            if (raw === '') {
                continue;
            }
            let event: { type?: unknown; timestamp?: unknown; data?: unknown };
            try {
                event = JSON.parse(raw) as typeof event;
            } catch {
                continue;
            }
            const type = typeof event.type === 'string' ? event.type : 'event';
            const time = typeof event.timestamp === 'string' ? event.timestamp.slice(11, 19) : '--:--:--';
            const data =
                typeof event.data === 'object' && !isNullOrUndefined(event.data)
                    ? (event.data as Record<string, unknown>)
                    : {};
            const fields = Object.entries(data)
                .filter(([, value]) => value !== undefined && value !== '')
                .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`);
            rendered.push(`[${time}] ${type}${fields.length === 0 ? '' : ` ${fields.join(' ')}`}`);
        }
        return rendered;
    }

    private RequireTaskConfig(taskId: string): TTaskConfig {
        const config = this.ConfigManager.GetTaskConfig(taskId);
        if (config === undefined) {
            throw new AtUserError(`Task "${taskId}" does not exist. Install it with: autotask install <file>.atp`, {
                exitCode: EExitCode.TaskNotFound,
            });
        }
        return config;
    }

    private RequireString(params: Record<string, unknown>, key: string): string {
        const value = params[key];
        if (typeof value !== 'string' || value === '') {
            throw new AtIpcError(`Missing or invalid parameter "${key}"`);
        }
        return value;
    }

    private OptionalString(params: Record<string, unknown>, key: string): string | undefined {
        const value = params[key];
        return typeof value === 'string' ? value : undefined;
    }

    private OptionalNumber(params: Record<string, unknown>, key: string): number | undefined {
        const value = params[key];
        return typeof value === 'number' ? value : undefined;
    }

    private RequireObject(params: Record<string, unknown>, key: string): Record<string, unknown> {
        const value = params[key];
        if (typeof value !== 'object' || value === undefined) {
            throw new AtIpcError(`Missing or invalid parameter "${key}"`);
        }
        return value as Record<string, unknown>;
    }

    private OptionalObject(params: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
        const value = params[key];
        if (typeof value !== 'object' || value === undefined) {
            return undefined;
        }
        return value as Record<string, unknown>;
    }

    private ErrorCode(error: unknown): string {
        if (error instanceof AtError) {
            return error.Kind;
        }
        return 'system';
    }

    private ErrorMessage(error: unknown): string {
        return error instanceof Error ? error.message : String(error);
    }

    private WriteLockFile(): void {
        const lockPath = this.Options.PathService.GetRuntimeLockPath();
        try {
            mkdirSync(dirname(lockPath), { recursive: true });
            writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), 'utf8');
        } catch (error) {
            this.Logger.Warn('Failed to write runtime lock file', { lockPath, error });
        }
    }

    private RemoveLockFile(): void {
        try {
            rmSync(this.Options.PathService.GetRuntimeLockPath(), { force: true });
        } catch (error) {
            this.Logger.Warn('Failed to remove runtime lock file', { error });
        }
    }
}
