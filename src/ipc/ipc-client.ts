import type { Socket } from 'node:net';

import { AtIpcError } from '@at/core';

import {
    IPC_PROTOCOL,
    IPC_REQUEST_TIMEOUT_MS,
    type TIpcEventMessage,
    type TIpcMessage,
    type TIpcResponse,
} from './protocol';
import { connectSocket, encodeMessage, MessageFramer } from './transport';

export type TIpcEventHandler = (event: TIpcEventMessage) => void;

export interface IIpcClient {
    Connect(): Promise<void>;
    IsConnected(): boolean;
    SendRequest(method: string, params: Record<string, unknown>): Promise<unknown>;
    OnEvent(handler: TIpcEventHandler): void;
    Close(): void;
}

function exitCodeForErrorKind(kind: string | undefined): number {
    switch (kind) {
        case 'package':
        case 'parse':
        case 'validation':
            return 4;
        case 'execution':
            return 6;
        case 'ipc':
            return 5;
        default:
            return 1;
    }
}

type TPendingRequest = {
    Resolve: (value: unknown) => void;
    Reject: (error: Error) => void;
    Timer: ReturnType<typeof setTimeout>;
};

export class IpcClient implements IIpcClient {
    private readonly SocketPath: string;
    private Socket: Socket | undefined;
    private Connected = false;
    private readonly Pending = new Map<string, TPendingRequest>();
    private RequestCounter = 0;
    private EventHandler: TIpcEventHandler | undefined;

    public constructor(socketPath: string) {
        this.SocketPath = socketPath;
    }

    public async Connect(): Promise<void> {
        // 断线后旧 socket 可能残留；销毁它避免监听器跨重连累积，并让在途请求直接失败。
        if (this.Socket !== undefined) {
            this.RejectAllPending(new AtIpcError('IPC connection replaced by reconnect'));
            this.Socket.removeAllListeners();
            this.Socket.destroy();
        }
        this.Socket = await connectSocket(this.SocketPath);
        this.Connected = true;
        const framer = new MessageFramer((message) => {
            this.HandleMessage(message);
        });
        this.Socket.on('data', (chunk: Buffer) => {
            framer.OnData(chunk);
        });
        this.Socket.on('error', () => {
            this.Connected = false;
        });
        this.Socket.on('close', () => {
            this.Connected = false;
            this.RejectAllPending(new AtIpcError('IPC connection closed'));
        });
    }

    public IsConnected(): boolean {
        return this.Connected;
    }

    public async SendRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
        if (!this.Connected || this.Socket === undefined) {
            throw new AtIpcError('IPC client is not connected');
        }
        const id = `req-${++this.RequestCounter}`;
        const message: TIpcMessage = { protocol: IPC_PROTOCOL, id, method, params };
        const response = await new Promise<unknown>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.Pending.delete(id);
                reject(new AtIpcError(`Request "${method}" timed out`));
            }, IPC_REQUEST_TIMEOUT_MS);
            this.Pending.set(id, { Resolve: resolve, Reject: reject, Timer: timer });
            this.Socket?.write(encodeMessage(message));
        });
        return response;
    }

    public OnEvent(handler: TIpcEventHandler): void {
        this.EventHandler = handler;
    }

    public Close(): void {
        this.RejectAllPending(new AtIpcError('IPC client closed'));
        this.Socket?.end();
        this.Socket?.destroy();
        this.Connected = false;
    }

    private HandleMessage(message: TIpcMessage): void {
        if ('id' in message && 'ok' in message) {
            this.HandleResponse(message);
            return;
        }
        if ('type' in message) {
            this.EventHandler?.(message);
        }
    }

    private HandleResponse(response: TIpcResponse): void {
        const pending = this.Pending.get(response.id);
        if (pending === undefined) {
            return;
        }
        this.Pending.delete(response.id);
        clearTimeout(pending.Timer);
        if (response.ok) {
            pending.Resolve(response.result);
        } else {
            const message = response.error?.message ?? `Request failed with ${response.error?.code ?? 'unknown error'}`;
            pending.Reject(
                new AtIpcError(message, {
                    exitCode: response.error?.exitCode ?? exitCodeForErrorKind(response.error?.code),
                }),
            );
        }
    }

    private RejectAllPending(error: Error): void {
        for (const pending of this.Pending.values()) {
            clearTimeout(pending.Timer);
            pending.Reject(error);
        }
        this.Pending.clear();
    }
}
