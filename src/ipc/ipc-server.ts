import type { Server, Socket } from 'node:net';

import type { TIpcMessage } from './protocol';
import { encodeMessage, MessageFramer, openSocketServer, removeSocketFile } from './transport';

export type TIpcConnection = {
    readonly Id: number;
    Send(message: TIpcMessage): void;
    Close(): void;
};

export interface IIpcServer {
    Listen(): Promise<void>;
    Close(): void;
    Broadcast(message: TIpcMessage): void;
    OnMessage(handler: (connection: TIpcConnection, message: TIpcMessage) => void): void;
    OnConnection(handler: (connection: TIpcConnection) => void): void;
}

class ServerConnection implements TIpcConnection {
    public readonly Id: number;
    private readonly Socket: Socket;
    private readonly OnClose: () => void;

    public constructor(id: number, socket: Socket, onClose: () => void) {
        this.Id = id;
        this.Socket = socket;
        this.OnClose = onClose;
    }

    public Send(message: TIpcMessage): void {
        if (!this.Socket.destroyed) {
            this.Socket.write(encodeMessage(message));
        }
    }

    public Close(): void {
        this.Socket.end();
        this.OnClose();
    }
}

export class IpcServer implements IIpcServer {
    private readonly SocketPath: string;
    private Server: Server | undefined;
    private readonly Connections = new Map<number, ServerConnection>();
    private NextConnectionId = 1;
    private MessageHandler: ((connection: TIpcConnection, message: TIpcMessage) => void) | undefined;
    private ConnectionHandler: ((connection: TIpcConnection) => void) | undefined;

    public constructor(socketPath: string) {
        this.SocketPath = socketPath;
    }

    public async Listen(): Promise<void> {
        removeSocketFile(this.SocketPath);
        this.Server = await openSocketServer(this.SocketPath);
        this.Server.on('connection', (socket) => {
            this.Accept(socket);
        });
    }

    public Close(): void {
        for (const connection of this.Connections.values()) {
            connection.Close();
        }
        this.Connections.clear();
        if (this.Server !== undefined) {
            this.Server.close();
            removeSocketFile(this.SocketPath);
            this.Server = undefined;
        }
    }

    public Broadcast(message: TIpcMessage): void {
        for (const connection of this.Connections.values()) {
            connection.Send(message);
        }
    }

    public OnMessage(handler: (connection: TIpcConnection, message: TIpcMessage) => void): void {
        this.MessageHandler = handler;
    }

    public OnConnection(handler: (connection: TIpcConnection) => void): void {
        this.ConnectionHandler = handler;
    }

    private Accept(socket: Socket): void {
        const connection = new ServerConnection(this.NextConnectionId++, socket, () => {
            this.Connections.delete(connection.Id);
        });
        const framer = new MessageFramer((message) => {
            this.MessageHandler?.(connection, message);
        });
        this.Connections.set(connection.Id, connection);
        this.ConnectionHandler?.(connection);
        socket.on('data', (chunk: Buffer) => {
            framer.OnData(chunk);
        });
        socket.on('error', () => {
            connection.Close();
        });
        socket.on('close', () => {
            this.Connections.delete(connection.Id);
        });
    }
}
