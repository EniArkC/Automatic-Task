import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { type TChainNode, type TTaskAst, type TVariableDeclaration, validateAts, validateTaskAst } from '@at/ats';
import type { IConfigManager, TTaskConfig } from '@at/config';
import {
    AtRuntimeError,
    AtUserError,
    AtValidationError,
    EExitCode,
    EOverlapPolicy,
    ERunStatus,
    ERunTrigger,
    EStepStatus,
    EVENT_RUN_CANCELLED,
    EVENT_RUN_CREATED,
    EVENT_RUN_FAILED,
    EVENT_RUN_FINISHED,
    EVENT_RUN_STARTED,
    EVENT_RUN_STEP_FINISHED,
    EVENT_RUN_STEP_OUTPUT,
    EVENT_RUN_STEP_STARTED,
    type EventBus,
    type IClock,
    type IIdGenerator,
    type TVariableValue,
} from '@at/core';
import type { IChainExecutor, TStepDetail } from '@at/executor';
import type { ILogger } from '@at/logging';
import { redactSecrets } from '@at/logging';
import type { IPackageManager } from '@at/package-manager';
import type { IPathService } from '@at/paths';

import type { IRunFiles } from './run-files';
import { parseRunRecord, type TRunRecord } from './run-record';
import { RunStateMachine } from './run-state-machine';

export type TStartRunOptions = {
    Trigger: ERunTrigger;
    Variables?: Record<string, TVariableValue>;
};

export interface IRunManager {
    Start(taskId: string, options: TStartRunOptions): TRunRecord;
    Stop(runId: string): void;
    StopAll(): void;
    GetRun(runId: string): TRunRecord | undefined;
    ListRuns(options?: { TaskId?: string; Limit?: number }): TRunRecord[];
    GetActiveRuns(): TRunRecord[];
    HasActiveRun(taskId: string): boolean;
    WhenFinished(runId: string): Promise<TRunRecord>;
    RecoverInterrupted(): void;
    Prune(olderThanDays: number): number;
    PruneWorkspaces(olderThanDays: number): number;
}

// 配置值来自 CLI --set（字符串）或手改 JSON；数字/布尔变量按声明类型强转，保证校验与求值一致。
function coerceValue(declaration: TVariableDeclaration, value: TVariableValue): TVariableValue {
    if (declaration.Type === 'number') {
        if (typeof value === 'string') {
            const parsed = Number(value);
            return Number.isNaN(parsed) ? value : parsed;
        }
        return value;
    }
    if (declaration.Type === 'boolean') {
        if (typeof value === 'string') {
            const lower = value.toLowerCase();
            if (lower === 'true') {
                return true;
            }
            if (lower === 'false') {
                return false;
            }
        }
        return value;
    }
    return typeof value === 'string' ? value : String(value);
}

function resolveVariables(
    declarations: TVariableDeclaration[],
    configVariables: Record<string, TVariableValue> | undefined,
    overrides: Record<string, TVariableValue> | undefined,
): ReadonlyMap<string, TVariableValue> {
    const byName = new Map(declarations.map((declaration) => [declaration.Name, declaration]));
    const resolved = new Map<string, TVariableValue>();
    for (const declaration of declarations) {
        if (declaration.DefaultValue !== undefined) {
            resolved.set(declaration.Name, declaration.DefaultValue);
        }
    }
    for (const [name, value] of Object.entries(configVariables ?? {})) {
        const declaration = byName.get(name);
        resolved.set(name, declaration === undefined ? value : coerceValue(declaration, value));
    }
    for (const [name, value] of Object.entries(overrides ?? {})) {
        const declaration = byName.get(name);
        resolved.set(name, declaration === undefined ? value : coerceValue(declaration, value));
    }
    return resolved;
}

function statusToRunStatus(status: EStepStatus): ERunStatus {
    switch (status) {
        case EStepStatus.Success:
            return ERunStatus.Success;
        case EStepStatus.Failure:
            return ERunStatus.Failure;
        case EStepStatus.Timeout:
            return ERunStatus.Timeout;
        case EStepStatus.Cancelled:
            return ERunStatus.Cancelled;
        case EStepStatus.Skipped:
            return ERunStatus.Skipped;
        default:
            return ERunStatus.Failure;
    }
}

// 事件与日志共用的一组字段。detail 只有步骤节点才有（[Select] 没有）。
function stepDetailData(detail: TStepDetail | undefined): Record<string, unknown> {
    if (detail === undefined) {
        return {};
    }
    return {
        stepType: detail.StepType,
        line: detail.Line,
        column: detail.Column,
        target: detail.Target,
        timeoutSeconds: detail.TimeoutSeconds,
    };
}

// 日志正文里的一行人话，例如 `[Agent] task.ats:4:5 你是谁？`。
function describeNode(node: TChainNode, detail: TStepDetail | undefined): string {
    if (detail === undefined) {
        return `[Select] task.ats:${node.Line}:${node.Column}`;
    }
    return `[${detail.StepType}] task.ats:${detail.Line}:${detail.Column} ${detail.Target}`;
}

// 运行目录位于 runs/<year>/<month>/<day>/<runId>。
function walkRunDirs(runsRoot: string): string[] {
    const results: string[] = [];
    const visit = (dir: string, depth: number): void => {
        if (depth > 4) {
            return;
        }
        let entries;
        try {
            entries = readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            if (!entry.isDirectory()) {
                continue;
            }
            const full = join(dir, entry.name);
            if (depth === 3) {
                results.push(full);
            } else {
                visit(full, depth + 1);
            }
        }
    };
    visit(runsRoot, 0);
    return results;
}

// RunManager 负责运行生命周期、overlap 策略与崩溃恢复。
export class RunManager implements IRunManager {
    private readonly PathService: IPathService;
    private readonly ConfigManager: IConfigManager;
    private readonly PackageManager: IPackageManager;
    private readonly EventBus: EventBus;
    private readonly Logger: ILogger;
    private readonly ChainExecutor: IChainExecutor;
    private readonly RunFiles: IRunFiles;
    private readonly StateMachine: RunStateMachine;
    private readonly Clock: IClock;
    private readonly IdGenerator: IIdGenerator;
    private readonly Active = new Map<string, { Controller: AbortController; Promise: Promise<TRunRecord> }>();
    // 排队中的运行保留各自的变量覆盖值，执行时用请求时的值而非配置当前值。
    private readonly Queue = new Map<string, { RunId: string; Variables?: Record<string, TVariableValue> }[]>();

    public constructor(options: {
        PathService: IPathService;
        ConfigManager: IConfigManager;
        PackageManager: IPackageManager;
        EventBus: EventBus;
        Logger: ILogger;
        ChainExecutor: IChainExecutor;
        RunFiles: IRunFiles;
        StateMachine: RunStateMachine;
        Clock: IClock;
        IdGenerator: IIdGenerator;
    }) {
        this.PathService = options.PathService;
        this.ConfigManager = options.ConfigManager;
        this.PackageManager = options.PackageManager;
        this.EventBus = options.EventBus;
        this.Logger = options.Logger;
        this.ChainExecutor = options.ChainExecutor;
        this.RunFiles = options.RunFiles;
        this.StateMachine = options.StateMachine;
        this.Clock = options.Clock;
        this.IdGenerator = options.IdGenerator;
    }

    public Start(taskId: string, options: TStartRunOptions): TRunRecord {
        const config = this.LoadTaskConfig(taskId);
        const packageInfo = this.PackageManager.GetPackage(taskId, config.packageVersion);
        if (packageInfo === undefined) {
            throw new AtUserError(
                `Package "${taskId}@${config.packageVersion}" is not installed. Reinstall it with: autotask install <file>.atp`,
                { exitCode: EExitCode.TaskNotFound },
            );
        }
        const ast = this.LoadAndValidateAts(taskId, config, options.Variables);
        const variables = resolveVariables(ast.Variables, config.variables, options.Variables);
        const record: TRunRecord = {
            RunId: this.IdGenerator.Next(),
            TaskId: taskId,
            PackageVersion: packageInfo.Version,
            Trigger: options.Trigger,
            Status: ERunStatus.Queued,
            Variables: redactSecrets(Object.fromEntries(variables)) as Record<string, TVariableValue>,
        };
        this.RunFiles.CreateRunDirectory(record.RunId);
        this.RunFiles.WriteMetadata(record);
        this.EventBus.Emit(EVENT_RUN_CREATED, { runId: record.RunId, taskId });
        this.Logger.Info('Run created', { taskId, runId: record.RunId, trigger: options.Trigger });

        if (this.HasActiveRun(taskId)) {
            const policy = config.overlap;
            if (policy === EOverlapPolicy.Skip) {
                this.MarkSkipped(record);
                return record;
            }
            if (policy === EOverlapPolicy.Queue) {
                const pending = this.Queue.get(taskId) ?? [];
                pending.push({ RunId: record.RunId, Variables: options.Variables });
                this.Queue.set(taskId, pending);
                this.Logger.Info('Run queued because of overlap policy', { taskId, runId: record.RunId });
                return record;
            }
        }
        this.ExecuteRun(record.RunId, ast, variables, config);
        return record;
    }

    public Stop(runId: string): void {
        const entry = this.Active.get(runId);
        if (entry !== undefined) {
            entry.Controller.abort();
            return;
        }
        // 排队中的运行在启动前仍可取消。
        for (const [taskId, pending] of this.Queue) {
            const index = pending.findIndex((entry) => entry.RunId === runId);
            if (index >= 0) {
                pending.splice(index, 1);
                const record = this.RunFiles.ReadMetadata(runId);
                if (record !== undefined && record.Status === ERunStatus.Queued) {
                    this.PersistFinalState(record, ERunStatus.Cancelled, 'Cancelled while queued');
                    this.EmitFinalEvent(taskId, runId, ERunStatus.Cancelled);
                }
            }
        }
    }

    // 中止所有运行并清空队列；运行时关闭时调用，确保任务子进程不残留于守护进程之外。
    public StopAll(): void {
        for (const entry of this.Active.values()) {
            entry.Controller.abort();
        }
        for (const [taskId, pending] of this.Queue) {
            const remaining = [...pending];
            pending.length = 0;
            for (const entry of remaining) {
                const record = this.RunFiles.ReadMetadata(entry.RunId);
                if (record !== undefined && record.Status === ERunStatus.Queued) {
                    this.PersistFinalState(record, ERunStatus.Cancelled, 'Runtime shut down while queued');
                    this.EmitFinalEvent(taskId, entry.RunId, ERunStatus.Cancelled);
                }
            }
        }
        this.Queue.clear();
    }

    public GetRun(runId: string): TRunRecord | undefined {
        return this.RunFiles.ReadMetadata(runId);
    }

    public ListRuns(options?: { TaskId?: string; Limit?: number }): TRunRecord[] {
        const records: TRunRecord[] = [];
        const limit = options?.Limit ?? 100;
        for (const dir of walkRunDirs(this.PathService.GetRunsRoot())) {
            const record = this.ReadRunMetadata(join(dir, 'metadata.json'));
            if (record === undefined) {
                continue;
            }
            if (options?.TaskId !== undefined && record.TaskId !== options.TaskId) {
                continue;
            }
            records.push(record);
        }
        // ULID 按时间有序，按 run id 排序即新的在前。
        records.sort((left, right) => (left.RunId < right.RunId ? 1 : -1));
        return records.slice(0, limit);
    }

    public GetActiveRuns(): TRunRecord[] {
        const records: TRunRecord[] = [];
        for (const runId of this.Active.keys()) {
            const record = this.RunFiles.ReadMetadata(runId);
            if (record !== undefined) {
                records.push(record);
            }
        }
        return records;
    }

    public HasActiveRun(taskId: string): boolean {
        for (const runId of this.Active.keys()) {
            const record = this.RunFiles.ReadMetadata(runId);
            if (record?.TaskId === taskId) {
                return true;
            }
        }
        return false;
    }

    public WhenFinished(runId: string): Promise<TRunRecord> {
        const entry = this.Active.get(runId);
        if (entry !== undefined) {
            return entry.Promise;
        }
        const record = this.RunFiles.ReadMetadata(runId);
        if (record !== undefined) {
            return Promise.resolve(record);
        }
        throw new AtRuntimeError(`Run "${runId}" does not exist`);
    }

    public RecoverInterrupted(): void {
        for (const dir of walkRunDirs(this.PathService.GetRunsRoot())) {
            const record = this.ReadRunMetadata(join(dir, 'metadata.json'));
            if (record === undefined) {
                continue;
            }
            if (record.Status === ERunStatus.Running || record.Status === ERunStatus.Queued) {
                // 上次运行时崩溃；未完成的运行标记为 interrupted。
                this.PersistFinalState(record, ERunStatus.Interrupted, 'Runtime restarted before this run finished.');
                this.Logger.Warn('Run marked as interrupted after restart', {
                    runId: record.RunId,
                    taskId: record.TaskId,
                });
            }
        }
    }

    public Prune(olderThanDays: number): number {
        let removed = 0;
        for (const dir of this.CollectExpiredRunDirs(olderThanDays)) {
            try {
                rmSync(dir, { recursive: true, force: true });
                removed++;
            } catch (error) {
                this.Logger.Warn('Failed to prune run directory', { dir, error });
            }
        }
        this.Logger.Info('Run history pruned', { olderThanDays, removed });
        return removed;
    }

    // 只删 run 目录下的 workspace/（步骤的工作目录、Docker 的 /workspace 挂载源），
    // 保留 metadata.json 与日志。工作区是任务跑出来的中间产物，通常很大又不用留；
    // 日志小且要用来排查，所以两者各有各的保留天数。
    public PruneWorkspaces(olderThanDays: number): number {
        let removed = 0;
        for (const dir of this.CollectExpiredRunDirs(olderThanDays)) {
            const workspace = join(dir, 'workspace');
            if (!existsSync(workspace)) {
                continue;
            }
            try {
                rmSync(workspace, { recursive: true, force: true });
                removed++;
            } catch (error) {
                this.Logger.Warn('Failed to prune run workspace', { dir, error });
            }
        }
        this.Logger.Info('Run workspaces pruned', { olderThanDays, removed });
        return removed;
    }

    // 早于保留期且已结束的 run 目录。两种清理共用同一套判定，
    // 差别只在删整个目录还是只删 workspace/。
    private CollectExpiredRunDirs(olderThanDays: number): string[] {
        const cutoff = this.Clock.Now().getTime() - olderThanDays * 24 * 60 * 60 * 1000;
        const expired: string[] = [];
        for (const dir of walkRunDirs(this.PathService.GetRunsRoot())) {
            const record = this.ReadRunMetadata(join(dir, 'metadata.json'));
            if (record !== undefined) {
                // 绝不动仍在执行的运行：目录正被 RunFiles 持续写入，workspace 也正被步骤使用。
                if (record.Status === ERunStatus.Running || record.Status === ERunStatus.Queued) {
                    continue;
                }
            }
            let age = 0;
            if (record?.StartedAt !== undefined) {
                age = new Date(record.StartedAt).getTime();
            }
            if (age === 0) {
                try {
                    age = statSync(dir).mtimeMs;
                } catch {
                    continue;
                }
            }
            if (age < cutoff) {
                expired.push(dir);
            }
        }
        return expired;
    }

    private LoadTaskConfig(taskId: string): TTaskConfig {
        const config = this.ConfigManager.GetTaskConfig(taskId);
        if (config === undefined) {
            throw new AtUserError(`Task "${taskId}" does not exist. Install it with: autotask install <file>.atp`, {
                exitCode: EExitCode.TaskNotFound,
            });
        }
        return config;
    }

    private LoadAndValidateAts(
        taskId: string,
        config: TTaskConfig,
        overrides: Record<string, TVariableValue> | undefined,
    ): TTaskAst {
        const source = this.PackageManager.ReadTaskAts(taskId, config.packageVersion);
        const ast = validateAts(source, 'task.ats');
        const values = resolveVariables(ast.Variables, config.variables, overrides);
        const issues = validateTaskAst(ast, values);
        if (issues.length > 0) {
            throw new AtValidationError(
                `Task "${taskId}" is not runnable with the current configuration`,
                issues.map((issue) => `task.ats:${issue.Line}:${issue.Column} ${issue.Message}`),
            );
        }
        return ast;
    }

    private ExecuteRun(
        runId: string,
        ast: TTaskAst,
        variables: ReadonlyMap<string, TVariableValue>,
        config: TTaskConfig,
    ): void {
        const controller = new AbortController();
        const promise = this.Run(runId, ast, variables, config, controller);
        // 追踪的 promise 存入 active 表，运行结束后清理，避免悬空 promise。
        const tracked = promise.then(
            (record) => {
                this.Active.delete(runId);
                this.DrainQueue(config.taskId);
                return record;
            },
            (error: unknown) => {
                this.Logger.Error('Run execution failed unexpectedly', { runId, error });
                this.Active.delete(runId);
                throw error;
            },
        );
        this.Active.set(runId, { Controller: controller, Promise: tracked });
    }

    private async Run(
        runId: string,
        ast: TTaskAst,
        variables: ReadonlyMap<string, TVariableValue>,
        config: TTaskConfig,
        controller: AbortController,
    ): Promise<TRunRecord> {
        const record = this.RunFiles.ReadMetadata(runId);
        if (record === undefined) {
            throw new AtRuntimeError(`Run "${runId}" metadata is missing`);
        }
        record.Status = this.StateMachine.Transition(record.Status, ERunStatus.Running);
        record.StartedAt = this.Clock.Now().toISOString();
        this.RunFiles.WriteMetadata(record);
        this.EventBus.Emit(EVENT_RUN_STARTED, { runId, taskId: config.taskId });
        this.Logger.Info('Task started', { taskId: config.taskId, runId });

        const packageInfo = this.PackageManager.GetPackage(config.taskId, config.packageVersion);
        const context = {
            Variables: variables,
            Workspace: this.PathService.GetRunWorkspacePath(runId),
            PackagePath: packageInfo?.Path ?? '',
            AbortSignal: controller.signal,
            RunId: runId,
        };
        let result;
        try {
            result = await this.ChainExecutor.ExecuteChain(ast.Body, context, {
                OnOutput: (stream, data) => {
                    // 输出持久化不能让守护进程崩溃：该回调在子进程 'data' 监听器内执行，异常会逃出运行层的 try/catch。
                    try {
                        if (stream === 'stdout') {
                            this.RunFiles.AppendStdout(runId, data);
                        } else {
                            this.RunFiles.AppendStderr(runId, data);
                        }
                    } catch (error) {
                        this.Logger.Error('Failed to persist run output', { runId, stream, error });
                    }
                    this.EventBus.Emit(EVENT_RUN_STEP_OUTPUT, { runId, taskId: config.taskId, stream, data });
                },
                OnStepStarted: (node, detail) => {
                    const label = describeNode(node, detail);
                    this.AppendEventSafely(runId, config.taskId, 'step.started', {
                        node: node.Kind,
                        ...stepDetailData(detail),
                    });
                    // 同一条信息也进 runtime.log：运行目录可能因磁盘/权限写不进，runtime.log 是排查时唯一一定被看的地方。
                    this.Logger.Info(`Step started: ${label}`, {
                        runId,
                        taskId: config.taskId,
                        ...stepDetailData(detail),
                    });
                    this.EventBus.Emit(EVENT_RUN_STEP_STARTED, { runId, taskId: config.taskId, step: node.Kind });
                },
                OnStepFinished: (node, stepResult, detail) => {
                    const label = describeNode(node, detail);
                    const failed = stepResult.Status !== EStepStatus.Success;
                    this.AppendEventSafely(runId, config.taskId, 'step.finished', {
                        node: node.Kind,
                        ...stepDetailData(detail),
                        status: stepResult.Status,
                        exitCode: stepResult.ExitCode,
                        durationMs: stepResult.DurationMs,
                        error: failed ? stepResult.Error : undefined,
                    });
                    const meta = {
                        runId,
                        taskId: config.taskId,
                        ...stepDetailData(detail),
                        status: stepResult.Status,
                        exitCode: stepResult.ExitCode,
                        durationMs: stepResult.DurationMs,
                        error: failed ? stepResult.Error : undefined,
                    };
                    // 失败按 Error 级别记：默认日志级别是 info，用户不改配置也能看到。
                    if (failed) {
                        this.Logger.Error(`Step failed: ${label}`, meta);
                    } else {
                        this.Logger.Info(`Step finished: ${label}`, meta);
                    }
                    this.EventBus.Emit(EVENT_RUN_STEP_FINISHED, {
                        runId,
                        taskId: config.taskId,
                        step: node.Kind,
                        status: stepResult.Status,
                    });
                },
                OnBranchSelected: (node, branch) => {
                    const data = {
                        line: node.Line,
                        column: node.Column,
                        branch: branch?.Kind ?? 'none',
                        branchLine: branch?.Line,
                    };
                    this.AppendEventSafely(runId, config.taskId, 'select.branch', data);
                    this.Logger.Info(
                        branch === undefined
                            ? '[Select] matched no branch; the task ends here'
                            : `[Select] took the [${branch.Kind}] branch`,
                        { runId, taskId: config.taskId, ...data },
                    );
                },
            });
        } catch (error) {
            result = {
                Status: EStepStatus.Failure,
                Output: '',
                DurationMs: 0,
                Error: error instanceof Error ? error.message : String(error),
            };
        }
        const status = statusToRunStatus(result.Status);
        const error =
            result.Status === EStepStatus.Success
                ? undefined
                : (result.Error ?? `Step ended with status ${result.Status}`);
        this.PersistFinalState(record, status, error);
        this.EmitFinalEvent(config.taskId, runId, status);
        this.Logger.Info('Task finished', { taskId: config.taskId, runId, status, durationMs: result.DurationMs });
        return record;
    }

    // AppendEvent 写盘失败会抛（磁盘满、目录被删等）；这些回调在链内同步调用，抛出去会
    // 变成「日志坏了 → 任务失败」，方向反了：记录失败只该记一笔然后继续。
    private AppendEventSafely(runId: string, taskId: string, type: string, data: Record<string, unknown>): void {
        try {
            this.RunFiles.AppendEvent(runId, taskId, type, data);
        } catch (error) {
            this.Logger.Error('Failed to persist run event', { runId, type, error });
        }
    }

    private PersistFinalState(record: TRunRecord, status: ERunStatus, error: string | undefined): void {
        record.Status = this.StateMachine.Transition(record.Status, status);
        record.FinishedAt = this.Clock.Now().toISOString();
        if (error !== undefined) {
            record.Error = error;
        }
        this.RunFiles.WriteMetadata(record);
    }

    private EmitFinalEvent(taskId: string, runId: string, status: ERunStatus): void {
        switch (status) {
            case ERunStatus.Success:
            case ERunStatus.Skipped:
                // Skipped 携带状态，监听方可区分。
                this.EventBus.Emit(EVENT_RUN_FINISHED, { runId, taskId, status });
                break;
            case ERunStatus.Failure:
            case ERunStatus.Timeout:
                this.EventBus.Emit(EVENT_RUN_FAILED, { runId, taskId, status });
                break;
            case ERunStatus.Cancelled:
                this.EventBus.Emit(EVENT_RUN_CANCELLED, { runId, taskId });
                break;
            default:
                break;
        }
    }

    private MarkSkipped(record: TRunRecord): void {
        this.PersistFinalState(record, ERunStatus.Skipped, 'Skipped because of the overlap policy');
        this.EventBus.Emit(EVENT_RUN_FINISHED, {
            runId: record.RunId,
            taskId: record.TaskId,
            status: ERunStatus.Skipped,
        });
        this.Logger.Info('Task skipped because overlap policy', { taskId: record.TaskId, runId: record.RunId });
    }

    private DrainQueue(taskId: string): void {
        const pending = this.Queue.get(taskId);
        if (pending === undefined || pending.length === 0) {
            return;
        }
        const next = pending.shift();
        if (next === undefined) {
            return;
        }
        try {
            const config = this.ConfigManager.GetTaskConfig(taskId);
            if (config === undefined) {
                throw new AtRuntimeError(`Task "${taskId}" no longer exists`);
            }
            const packageInfo = this.PackageManager.GetPackage(taskId, config.packageVersion);
            if (packageInfo === undefined) {
                throw new AtRuntimeError(`Package "${taskId}@${config.packageVersion}" is no longer installed`);
            }
            const ast = this.LoadAndValidateAts(taskId, config, next.Variables);
            const variables = resolveVariables(ast.Variables, config.variables, next.Variables);
            this.ExecuteRun(next.RunId, ast, variables, config);
        } catch (error) {
            // 排队运行的任务失效时不能阻塞队列，也不能留下未处理的 rejection。
            const record = this.RunFiles.ReadMetadata(next.RunId);
            if (record !== undefined && record.Status === ERunStatus.Queued) {
                this.PersistFinalState(
                    record,
                    ERunStatus.Failure,
                    error instanceof Error ? error.message : String(error),
                );
                this.EmitFinalEvent(taskId, next.RunId, ERunStatus.Failure);
            }
            this.Logger.Error('Failed to start queued run', { taskId, runId: next.RunId, error });
        }
    }

    private ReadRunMetadata(file: string): TRunRecord | undefined {
        try {
            const raw = readFileSync(file, 'utf8');
            return parseRunRecord(JSON.parse(raw));
        } catch {
            this.Logger.Warn('Skipping unreadable run metadata', { file });
            return undefined;
        }
    }
}

export { RunStateMachine };
