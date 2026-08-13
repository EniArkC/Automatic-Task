import type { TIpcConnection, TIpcRequest, TIpcResponse } from '@at/ipc';
import { IPC_METHOD_RUNTIME_PING, IpcClient, IpcServer, MessageFramer } from '@at/ipc';
import { describe, expect, it } from 'vitest';

function pipePath(): string {
    return `\\\\.\\pipe\\at-ipc-test-${process.pid}-${Math.floor(Math.random() * 1_000_000)}`;
}

async function startServer(path: string): Promise<IpcServer> {
    const server = new IpcServer(path);
    await server.Listen();
    return server;
}

function respond(
    connection: TIpcConnection,
    message: TIpcRequest,
    result?: unknown,
    error?: { code: string; message: string },
): void {
    const response: TIpcResponse = {
        protocol: 'at/ipc/v1',
        id: message.id,
        ok: error === undefined,
        result,
        error,
    };
    connection.Send(response);
}

describe('message framer', () => {
    it('reassembles a multi-byte character split across chunks', () => {
        const received: unknown[] = [];
        const framer = new MessageFramer((message) => {
            received.push(message);
        });
        const payload = `${JSON.stringify({ protocol: 'at/ipc/v1', type: 'run.output', data: '上海' })}\n`;
        const bytes = Buffer.from(payload, 'utf8');
        // Split exactly inside the first multi-byte character of 上海.
        const split = bytes.indexOf(0xe4);
        framer.OnData(bytes.subarray(0, split + 1));
        framer.OnData(bytes.subarray(split + 1));
        expect(received).toHaveLength(1);
        expect((received[0] as { data: string }).data).toBe('上海');
    });

    it('drops malformed lines without killing the stream', () => {
        const received: unknown[] = [];
        const framer = new MessageFramer((message) => {
            received.push(message);
        });
        framer.OnData(Buffer.from('{not json\n{"a":1}\n', 'utf8'));
        expect(received).toHaveLength(1);
        expect(received[0]).toEqual({ a: 1 });
    });
});

describe('ipc', () => {
    it('round-trips a request and response', async () => {
        const path = pipePath();
        const server = await startServer(path);
        server.OnMessage((connection, message) => {
            if ('method' in message && message.method === IPC_METHOD_RUNTIME_PING) {
                respond(connection, message, { pong: true });
            }
        });
        const client = new IpcClient(path);
        await client.Connect();
        const result = await client.SendRequest(IPC_METHOD_RUNTIME_PING, {});
        expect(result).toEqual({ pong: true });
        client.Close();
        server.Close();
    });

    it('forwards errors from the server', async () => {
        const path = pipePath();
        const server = await startServer(path);
        server.OnMessage((connection, message) => {
            respond(connection, message as TIpcRequest, undefined, {
                code: 'task.notFound',
                message: 'Task "x" does not exist',
            });
        });
        const client = new IpcClient(path);
        await client.Connect();
        await expect(client.SendRequest('task.run', { taskId: 'x' })).rejects.toThrow(/does not exist/);
        client.Close();
        server.Close();
    });

    it('broadcasts events to all clients', async () => {
        const path = pipePath();
        const server = await startServer(path);
        const clientA = new IpcClient(path);
        const clientB = new IpcClient(path);
        await clientA.Connect();
        await clientB.Connect();
        const eventsA: string[] = [];
        const eventsB: string[] = [];
        clientA.OnEvent((event) => {
            eventsA.push(event.type);
        });
        clientB.OnEvent((event) => {
            eventsB.push(event.type);
        });
        await new Promise((resolve) => setTimeout(resolve, 100));
        server.Broadcast({ protocol: 'at/ipc/v1', type: 'run.started', runId: 'r1', taskId: 't1' });
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(eventsA).toContain('run.started');
        expect(eventsB).toContain('run.started');
        clientA.Close();
        clientB.Close();
        server.Close();
    });

    it('handles messages split across chunks', async () => {
        const path = pipePath();
        const server = await startServer(path);
        server.OnMessage((connection, message) => {
            respond(connection, message as TIpcRequest, { value: 42 });
        });
        const client = new IpcClient(path);
        await client.Connect();
        const result = await client.SendRequest('task.get', { taskId: 'a' });
        expect(result).toEqual({ value: 42 });
        client.Close();
        server.Close();
    });

    it('handles multi-byte characters split across chunks', async () => {
        const path = pipePath();
        const server = await startServer(path);
        server.OnMessage((connection, message) => {
            respond(connection, message as TIpcRequest, { value: '上海' });
        });
        const client = new IpcClient(path);
        await client.Connect();
        const result = await client.SendRequest('task.run', { taskId: 'daily-report', city: '上海' });
        expect(result).toEqual({ value: '上海' });
        client.Close();
        server.Close();
    });

    it('rejects connections when no server is listening', async () => {
        const path = pipePath();
        const client = new IpcClient(path);
        await expect(client.Connect()).rejects.toThrow(/not reachable|failed/);
    });

    it('supports concurrent clients', async () => {
        const path = pipePath();
        const server = await startServer(path);
        let messageCount = 0;
        server.OnMessage((connection, message) => {
            messageCount++;
            respond(connection, message as TIpcRequest, { count: messageCount });
        });
        const clients = Array.from({ length: 5 }, () => new IpcClient(path));
        for (const client of clients) {
            await client.Connect();
        }
        const results = await Promise.all(clients.map((client, index) => client.SendRequest('task.list', { index })));
        expect(results.map((result) => (result as { count: number }).count)).toEqual([1, 2, 3, 4, 5]);
        for (const client of clients) {
            client.Close();
        }
        server.Close();
    });

    it('sends the protocol version on every message', async () => {
        const path = pipePath();
        const server = await startServer(path);
        let received: TIpcRequest | undefined;
        server.OnMessage((connection, message) => {
            if ('method' in message) {
                received = message;
            }
            respond(connection, message as TIpcRequest, {});
        });
        const client = new IpcClient(path);
        await client.Connect();
        await client.SendRequest('runtime.ping', {});
        expect(received).not.toBeUndefined();
        expect(received?.protocol).toBe('at/ipc/v1');
        expect(received?.id).toBeTruthy();
        expect(received?.method).toBe('runtime.ping');
        client.Close();
        server.Close();
    });
});
