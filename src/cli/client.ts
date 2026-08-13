import type { TIpcEventHandler } from '@at/ipc';
import { IpcClient } from '@at/ipc';
import { PathService, PlatformService } from '@at/paths';

import { RuntimeLauncher } from './runtime-launcher';

// 保证运行时在跑并封装 IPC 连接。
export class AtClient {
    private readonly SocketPath: string;
    private Client: IpcClient | undefined;

    public constructor(socketPath: string) {
        this.SocketPath = socketPath;
    }

    public static Create(): AtClient {
        const pathService = new PathService(new PlatformService());
        return new AtClient(pathService.GetRuntimeSocketPath());
    }

    public async Connect(): Promise<void> {
        const launcher = new RuntimeLauncher(this.SocketPath);
        await launcher.EnsureRunning(() => this.NewClient());
        this.Client = this.NewClient();
        await this.Client.Connect();
    }

    public Close(): void {
        this.Client?.Close();
        this.Client = undefined;
    }

    public OnEvent(handler: TIpcEventHandler): void {
        this.Client?.OnEvent(handler);
    }

    public async Request(method: string, params: Record<string, unknown>): Promise<unknown> {
        if (this.Client === undefined) {
            throw new Error('client is not connected');
        }
        return this.Client.SendRequest(method, params);
    }

    private NewClient(): IpcClient {
        return new IpcClient(this.SocketPath);
    }
}
