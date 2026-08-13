import { rmSync } from 'node:fs';
import { connect, createServer, type Server, type Socket } from 'node:net';

import { AtIpcError } from '@at/core';

import type { TIpcMessage } from './protocol';

const SOCKET_CONNECT_TIMEOUT_MS = 2000;

export function openSocketServer(path: string): Promise<Server> {
    return new Promise((resolve, reject) => {
        const server = createServer();
        const onError = (error: Error): void => {
            server.close();
            reject(new AtIpcError(`Failed to listen on IPC socket "${path}": ${error.message}`, { cause: error }));
        };
        server.once('error', onError);
        server.listen(path, () => {
            server.removeListener('error', onError);
            resolve(server);
        });
    });
}

export function connectSocket(path: string, timeoutMs = SOCKET_CONNECT_TIMEOUT_MS): Promise<Socket> {
    return new Promise((resolve, reject) => {
        const socket = connect(path);
        const timer = setTimeout(() => {
            socket.destroy();
            reject(new AtIpcError(`IPC runtime is not reachable at "${path}"`));
        }, timeoutMs);
        socket.once('connect', () => {
            clearTimeout(timer);
            resolve(socket);
        });
        socket.once('error', (error) => {
            clearTimeout(timer);
            reject(new AtIpcError(`IPC connection to "${path}" failed: ${error.message}`, { cause: error }));
        });
    });
}

export function removeSocketFile(path: string): void {
    // Unix 域套接字会遗留陈旧文件；命名管道不会。
    if (!path.startsWith('\\')) {
        rmSync(path, { force: true });
    }
}

// JSON Lines 帧协议：socket 上每行一个 JSON 对象。按整行解码，跨 TCP 分片的多字节 UTF-8 不会破坏消息。
export class MessageFramer {
    private readonly OnMessage: (message: TIpcMessage) => void;
    private Buffer: Buffer = Buffer.alloc(0);

    public constructor(onMessage: (message: TIpcMessage) => void) {
        this.OnMessage = onMessage;
    }

    public OnData(chunk: Buffer): void {
        const combined = Buffer.concat([this.Buffer, chunk]);
        let start = 0;
        while (true) {
            const newline = combined.indexOf(0x0a, start);
            if (newline < 0) {
                break;
            }
            const line = combined.subarray(start, newline).toString('utf8').trim();
            start = newline + 1;
            if (line === '') {
                continue;
            }
            try {
                this.OnMessage(JSON.parse(line) as TIpcMessage);
            } catch {
                // 丢弃畸形行，连接保持可用。
            }
        }
        this.Buffer = combined.subarray(start);
        if (this.Buffer.length > 1024 * 1024) {
            this.Buffer = Buffer.alloc(0);
        }
    }
}

export function encodeMessage(message: TIpcMessage): string {
    return `${JSON.stringify(message)}\n`;
}
