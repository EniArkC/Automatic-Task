export type TEventPayload = Record<string, unknown>;

export type TEventData = {
    Type: string;
    Timestamp: Date;
    Payload: TEventPayload;
};

export type TEventHandler = (event: TEventData) => void;

export class EventBus {
    private readonly Handlers = new Map<string, Set<TEventHandler>>();

    public On(type: string, handler: TEventHandler): () => void {
        let set = this.Handlers.get(type);
        if (set === undefined) {
            set = new Set<TEventHandler>();
            this.Handlers.set(type, set);
        }
        set.add(handler);
        return () => {
            set.delete(handler);
        };
    }

    public Emit(type: string, payload: TEventPayload = {}): void {
        const event: TEventData = { Type: type, Timestamp: new Date(), Payload: payload };
        const set = this.Handlers.get(type);
        if (set !== undefined) {
            for (const handler of set) {
                handler(event);
            }
        }
    }

    public RemoveAll(): void {
        this.Handlers.clear();
    }
}

export const EVENT_RUNTIME_STARTED = 'runtime.started';
export const EVENT_RUNTIME_STOPPING = 'runtime.stopping';

export const EVENT_TASK_INSTALLED = 'task.installed';
export const EVENT_TASK_UPDATED = 'task.updated';
export const EVENT_TASK_ENABLED = 'task.enabled';
export const EVENT_TASK_DISABLED = 'task.disabled';
export const EVENT_TASK_UNINSTALLED = 'task.uninstalled';

export const EVENT_RUN_CREATED = 'run.created';
export const EVENT_RUN_STARTED = 'run.started';
export const EVENT_RUN_STEP_STARTED = 'run.step.started';
export const EVENT_RUN_STEP_OUTPUT = 'run.step.output';
export const EVENT_RUN_STEP_FINISHED = 'run.step.finished';
export const EVENT_RUN_FINISHED = 'run.finished';
export const EVENT_RUN_FAILED = 'run.failed';
export const EVENT_RUN_CANCELLED = 'run.cancelled';

export const EVENT_SCHEDULER_TRIGGERED = 'scheduler.triggered';
