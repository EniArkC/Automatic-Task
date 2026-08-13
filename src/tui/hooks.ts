import type { IpcClient, TIpcEventHandler } from '@at/ipc';
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function asString(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
}

export type TConnectionState = 'connecting' | 'connected' | 'disconnected';

export type TTaskRow = {
    taskId: string;
    packageVersion?: string;
    enabled?: boolean;
    schedule?: string;
    overlap?: string;
};

export type TRunRow = {
    runId: string;
    taskId?: string;
    status?: string;
    startedAt?: string;
    finishedAt?: string;
};

export type TTaskDetail = {
    taskId: string;
    name?: string;
    description?: string;
    author?: string;
    version?: string;
    enabled: boolean;
    schedule?: string;
    overlap: string;
    packagePath?: string;
};

// 已安装任务脚本的一条 `@var` 声明，与任务当前配置的值合并展示。
export type TVariableSchemaRow = {
    name: string;
    type: string;
    required: boolean;
    defaultValue?: string | number | boolean;
    options?: string[];
    // 声明行尾注释给出的说明，配置界面优先显示它；作者没写注释时缺省。
    description?: string;
    configured?: string | number | boolean;
    hasConfigured: boolean;
};

export type TTuiState = {
    Connection: TConnectionState;
    Tasks: TTaskRow[];
    Runs: TRunRow[];
    LogLines: string[];
    SelectedRun: string | undefined;
    Notice: string | undefined;
    NoticeKind: 'info' | 'error';
    // 每次通知都递增（含重复的）。toast 由定时器自动消失，没有它，相同消息连续到达时定时器不会重新计时。
    NoticeSeq: number;
    Now: number;
    Frame: number;
};

export type TTuiAction =
    | { Type: 'connection'; State: TConnectionState }
    | { Type: 'tasks'; Tasks: TTaskRow[] }
    | { Type: 'runs'; Runs: TRunRow[] }
    | { Type: 'logs'; Lines: string[] }
    | { Type: 'appendLog'; Line: string }
    | { Type: 'selectRun'; RunId: string | undefined }
    | { Type: 'notice'; Message: string | undefined; Kind?: 'info' | 'error' }
    | { Type: 'tick'; Now: number }
    | { Type: 'frame' };

const INITIAL: TTuiState = {
    Connection: 'connecting',
    Tasks: [],
    Runs: [],
    LogLines: [],
    SelectedRun: undefined,
    Notice: undefined,
    NoticeKind: 'info',
    NoticeSeq: 0,
    Now: Date.now(),
    Frame: 0,
};

export function tuiReducer(state: TTuiState, action: TTuiAction): TTuiState {
    switch (action.Type) {
        case 'connection':
            return { ...state, Connection: action.State };
        case 'tasks':
            return { ...state, Tasks: action.Tasks };
        case 'runs':
            return { ...state, Runs: action.Runs };
        case 'logs':
            return { ...state, LogLines: action.Lines };
        case 'appendLog':
            return { ...state, LogLines: [...state.LogLines, action.Line].slice(-500) };
        case 'selectRun':
            return { ...state, SelectedRun: action.RunId };
        case 'notice':
            return {
                ...state,
                Notice: action.Message,
                NoticeKind: action.Kind ?? 'info',
                NoticeSeq: state.NoticeSeq + 1,
            };
        case 'tick':
            return { ...state, Now: action.Now };
        case 'frame':
            // 远在 Number.MAX_SAFE_INTEGER 之前就会回绕；动画只取它对自身帧数的模。
            return { ...state, Frame: (state.Frame + 1) % 100_000 };
        default:
            return state;
    }
}

export function asTasks(value: unknown): TTaskRow[] {
    if (!Array.isArray(value)) {
        return [];
    }
    return value.map((item) => {
        const row = item as Record<string, unknown>;
        return {
            taskId: asString(row.taskId) ?? '',
            packageVersion: asString(row.packageVersion) ?? '',
            enabled: row.enabled === true,
            schedule: asString(row.schedule),
            overlap: asString(row.overlap),
        };
    });
}

export function asRuns(value: unknown): TRunRow[] {
    if (!Array.isArray(value)) {
        return [];
    }
    return value.map((item) => {
        const row = item as Record<string, unknown>;
        return {
            runId: asString(row.runId) ?? '',
            taskId: asString(row.taskId) ?? '',
            status: asString(row.status) ?? '',
            startedAt: asString(row.startedAt),
            finishedAt: asString(row.finishedAt),
        };
    });
}

export function asTaskDetail(value: unknown): TTaskDetail | undefined {
    if (typeof value !== 'object' || value === undefined) {
        return undefined;
    }
    const row = value as Record<string, unknown>;
    const taskId = asString(row.taskId);
    if (taskId === undefined) {
        return undefined;
    }
    return {
        taskId,
        name: asString(row.name),
        description: asString(row.description),
        author: asString(row.author),
        version: asString(row.version),
        enabled: row.enabled === true,
        schedule: asString(row.schedule),
        overlap: asString(row.overlap) ?? 'skip',
    };
}

function asScalar(value: unknown): string | number | boolean | undefined {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        return value;
    }
    return undefined;
}

export function asVariableSchema(value: unknown): TVariableSchemaRow[] {
    if (!Array.isArray(value)) {
        return [];
    }
    return value.map((item) => {
        const row = item as Record<string, unknown>;
        const options = row.options;
        return {
            name: asString(row.name) ?? '',
            type: asString(row.type) ?? 'string',
            required: row.required === true,
            defaultValue: asScalar(row.defaultValue),
            options: Array.isArray(options)
                ? options.filter((option): option is string => typeof option === 'string')
                : undefined,
            description: asString(row.description),
            configured: asScalar(row.configured),
            hasConfigured: row.hasConfigured === true,
        };
    });
}

// 连接 TUI 与运行时并保持快照新鲜；连接断开自动重试而不是崩溃。
export function useTui(client: IpcClient): {
    State: TTuiState;
    Dispatch: (action: TTuiAction) => void;
    Reload: () => void;
} {
    const [state, dispatch] = useReducer(tuiReducer, INITIAL);
    const selectedRunRef = useRef<string | undefined>(undefined);
    selectedRunRef.current = state.SelectedRun;
    const reloadingRef = useRef<Promise<void> | undefined>(undefined);

    const reload = async (): Promise<void> => {
        if (reloadingRef.current !== undefined) {
            return reloadingRef.current;
        }
        const pending = (async (): Promise<void> => {
            try {
                const tasksResult = (await client.SendRequest('task.list', {})) as { tasks?: unknown };
                dispatch({ Type: 'tasks', Tasks: asTasks(tasksResult.tasks) });
            } catch (error) {
                dispatch({ Type: 'notice', Message: messageOf(error), Kind: 'error' });
            }
            try {
                const runsResult = (await client.SendRequest('run.list', { limit: 50 })) as { runs?: unknown };
                dispatch({ Type: 'runs', Runs: asRuns(runsResult.runs) });
            } catch (error) {
                dispatch({ Type: 'notice', Message: messageOf(error), Kind: 'error' });
            }
        })();
        reloadingRef.current = pending;
        void pending.finally(() => {
            reloadingRef.current = undefined;
        });
        return pending;
    };

    useEffect(() => {
        let disposed = false;
        let retryTimer: ReturnType<typeof setTimeout> | undefined;

        const connect = async (): Promise<void> => {
            dispatch({ Type: 'connection', State: 'connecting' });
            try {
                await client.Connect();
                if (disposed) {
                    client.Close();
                    return;
                }
                dispatch({ Type: 'connection', State: 'connected' });
                await reload();
            } catch {
                dispatch({ Type: 'connection', State: 'disconnected' });
                if (!disposed) {
                    retryTimer = setTimeout(() => {
                        void connect();
                    }, 2000);
                }
            }
        };

        const onEvent: TIpcEventHandler = (event) => {
            // 运行时广播 run.step.output 时负载平铺在顶层，chunk 就是 event.data 本身。
            if (event.type === 'run.step.output' && event.runId === selectedRunRef.current) {
                const data = event.data;
                dispatch({ Type: 'appendLog', Line: typeof data === 'string' ? data : JSON.stringify(data) });
            }
            if (
                event.type === 'run.started' ||
                event.type === 'run.finished' ||
                event.type === 'run.failed' ||
                event.type === 'run.cancelled'
            ) {
                void reload();
            }
        };
        client.OnEvent(onEvent);

        const tick = setInterval(() => {
            dispatch({ Type: 'tick', Now: Date.now() });
        }, 1000);
        // 动画时钟：足够快到闪烁平滑，足够慢到远程终端不被重绘淹没。
        const frames = setInterval(() => {
            dispatch({ Type: 'frame' });
        }, 110);

        void connect();
        return () => {
            disposed = true;
            clearInterval(tick);
            clearInterval(frames);
            if (retryTimer !== undefined) {
                clearTimeout(retryTimer);
            }
        };
    }, [client]);

    return { State: state, Dispatch: dispatch, Reload: () => void reload() };
}

export type TAppConfig = {
    AgentCommand: string;
    AgentArgs: string[];
    AgentModel: string;
    LogLevel: string;
    MaxFileSizeMb: number;
    MaxFiles: number;
    KeepRunsDays: number;
    KeepWorkspaceDays: number;
};

export function asAppConfig(value: unknown): TAppConfig {
    const raw = value as {
        agent?: { command?: string; args?: unknown; model?: string };
        logging?: { level?: string; maxFileSizeMb?: number; maxFiles?: number };
        cleanup?: { keepRunsDays?: number; keepWorkspaceDays?: number };
    };
    const args = Array.isArray(raw.agent?.args) ? (raw.agent.args as unknown[]).map(String) : [];
    return {
        AgentCommand: typeof raw.agent?.command === 'string' ? raw.agent.command : 'pi',
        AgentArgs: args,
        AgentModel: typeof raw.agent?.model === 'string' ? raw.agent.model : '',
        LogLevel: typeof raw.logging?.level === 'string' ? raw.logging.level : 'info',
        MaxFileSizeMb: typeof raw.logging?.maxFileSizeMb === 'number' ? raw.logging.maxFileSizeMb : 10,
        MaxFiles: typeof raw.logging?.maxFiles === 'number' ? raw.logging.maxFiles : 5,
        KeepRunsDays: typeof raw.cleanup?.keepRunsDays === 'number' ? raw.cleanup.keepRunsDays : 30,
        KeepWorkspaceDays: typeof raw.cleanup?.keepWorkspaceDays === 'number' ? raw.cleanup.keepWorkspaceDays : 7,
    };
}

export type TAppFormData = {
    Config: TAppConfig | undefined;
    Error: string | undefined;
    Loading: boolean;
};

// 为全局配置视图加载 app.json。
export function useAppForm(client: IpcClient): TAppFormData & { Reload: () => void } {
    const [data, setData] = useState<TAppFormData>({ Config: undefined, Error: undefined, Loading: true });
    const [nonce, setNonce] = useState(0);

    useEffect(() => {
        let disposed = false;
        setData((previous) => ({ ...previous, Loading: true }));
        void client
            .SendRequest('app.get', {})
            .then((result) => {
                if (!disposed) {
                    setData({ Config: asAppConfig(result), Error: undefined, Loading: false });
                }
            })
            .catch((error: unknown) => {
                if (!disposed) {
                    setData({ Config: undefined, Error: messageOf(error), Loading: false });
                }
            });
        return () => {
            disposed = true;
        };
    }, [client, nonce]);

    const reload = useCallback((): void => {
        setNonce((value) => value + 1);
    }, []);

    return { ...data, Reload: reload };
}

export type TTaskFormData = {
    Detail: TTaskDetail | undefined;
    Variables: TVariableSchemaRow[];
    Error: string | undefined;
    Loading: boolean;
};

// 加载配置表单所需的一切：task.get 取任务级设置，task.schema 取包暴露的 `@var` 声明。
export function useTaskForm(client: IpcClient, taskId: string | undefined): TTaskFormData & { Reload: () => void } {
    const [data, setData] = useState<TTaskFormData>({
        Detail: undefined,
        Variables: [],
        Error: undefined,
        Loading: true,
    });
    const [nonce, setNonce] = useState(0);

    useEffect(() => {
        let disposed = false;
        if (taskId === undefined) {
            setData({ Detail: undefined, Variables: [], Error: undefined, Loading: false });
        } else {
            setData((previous) => ({ ...previous, Loading: true }));
            void (async (): Promise<void> => {
                try {
                    const detail = await client.SendRequest('task.get', { taskId });
                    const schema = (await client.SendRequest('task.schema', { taskId })) as { variables?: unknown };
                    if (disposed) {
                        return;
                    }
                    setData({
                        Detail: asTaskDetail(detail),
                        Variables: asVariableSchema(schema.variables),
                        Error: undefined,
                        Loading: false,
                    });
                } catch (error) {
                    if (!disposed) {
                        setData({ Detail: undefined, Variables: [], Error: messageOf(error), Loading: false });
                    }
                }
            })();
        }
        return () => {
            disposed = true;
        };
    }, [client, taskId, nonce]);

    const reload = useCallback((): void => {
        setNonce((value) => value + 1);
    }, []);

    return { ...data, Reload: reload };
}
