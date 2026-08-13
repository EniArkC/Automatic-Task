export const IPC_PROTOCOL = 'at/ipc/v1';
export const IPC_REQUEST_TIMEOUT_MS = 30_000;

export type TIpcRequest = {
    protocol: string;
    id: string;
    method: string;
    params: Record<string, unknown>;
};

export type TIpcError = {
    code: string;
    message: string;
    // 原始错误对应的 CLI 退出码（已知时）。
    exitCode?: number;
};

export type TIpcResponse = {
    protocol: string;
    id: string;
    ok: boolean;
    result?: unknown;
    error?: TIpcError;
};

export type TIpcEventMessage = {
    protocol: string;
    type: string;
    runId?: string;
    taskId?: string;
    stream?: string;
    status?: string;
    step?: string;
    data?: Record<string, unknown>;
};

export type TIpcMessage = TIpcRequest | TIpcResponse | TIpcEventMessage;

export const IPC_METHOD_RUNTIME_PING = 'runtime.ping';
export const IPC_METHOD_RUNTIME_STATUS = 'runtime.status';
export const IPC_METHOD_RUNTIME_SHUTDOWN = 'runtime.shutdown';

export const IPC_METHOD_APP_GET = 'app.get';
export const IPC_METHOD_APP_SET = 'app.set';

export const IPC_METHOD_TASK_LIST = 'task.list';
export const IPC_METHOD_TASK_GET = 'task.get';
// 返回已安装任务脚本的 `@var` 声明；task.get 只报告配置值，编辑器需要 schema（类型、必填、默认值、选项）来渲染输入框。
export const IPC_METHOD_TASK_SCHEMA = 'task.schema';
export const IPC_METHOD_TASK_INSTALL_INFO = 'task.installInfo';
export const IPC_METHOD_TASK_INSTALL = 'task.install';
export const IPC_METHOD_TASK_UNINSTALL = 'task.uninstall';
export const IPC_METHOD_TASK_ENABLE = 'task.enable';
export const IPC_METHOD_TASK_DISABLE = 'task.disable';
export const IPC_METHOD_TASK_SET_SCHEDULE = 'task.setSchedule';
export const IPC_METHOD_TASK_SET_CONFIG = 'task.setConfig';
export const IPC_METHOD_TASK_RUN = 'task.run';

export const IPC_METHOD_RUN_GET = 'run.get';
export const IPC_METHOD_RUN_LIST = 'run.list';
export const IPC_METHOD_RUN_STOP = 'run.stop';
export const IPC_METHOD_RUN_CANCEL = 'run.cancel';
export const IPC_METHOD_RUNS_PRUNE = 'runs.prune';

export const IPC_METHOD_LOGS_TAIL = 'logs.tail';
