import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

export interface IPlatformService {
    IsWindows(): boolean;
    IsLinux(): boolean;
    GetHomeDirectory(): string;
    GetDataDirectory(): string;
    GetConfigDirectory(): string;
    GetStateDirectory(): string;
    GetRuntimeDirectory(): string;
    GetTempDirectory(): string;
    GetUsername(): string;
}

export class PlatformService implements IPlatformService {
    private readonly Env: NodeJS.ProcessEnv;
    private readonly OsType: string;

    public constructor(env: NodeJS.ProcessEnv = process.env, osType: string = process.platform) {
        this.Env = env;
        this.OsType = osType;
    }

    public IsWindows(): boolean {
        return this.OsType === 'win32';
    }

    public IsLinux(): boolean {
        return this.OsType === 'linux';
    }

    public GetHomeDirectory(): string {
        return homedir();
    }

    public GetDataDirectory(): string {
        if (this.IsWindows()) {
            return this.Env.LOCALAPPDATA ?? this.GetHomeDirectory();
        }
        return this.Env.XDG_DATA_HOME ?? join(this.GetHomeDirectory(), '.local', 'share');
    }

    public GetConfigDirectory(): string {
        if (this.IsWindows()) {
            return this.Env.LOCALAPPDATA ?? this.GetHomeDirectory();
        }
        return this.Env.XDG_CONFIG_HOME ?? join(this.GetHomeDirectory(), '.config');
    }

    public GetStateDirectory(): string {
        if (this.IsWindows()) {
            return this.Env.LOCALAPPDATA ?? this.GetHomeDirectory();
        }
        return this.Env.XDG_STATE_HOME ?? join(this.GetHomeDirectory(), '.local', 'state');
    }

    public GetRuntimeDirectory(): string {
        if (this.IsWindows()) {
            return this.Env.LOCALAPPDATA ?? this.GetHomeDirectory();
        }
        return this.Env.XDG_RUNTIME_DIR ?? this.GetStateDirectory();
    }

    public GetTempDirectory(): string {
        return tmpdir();
    }

    public GetUsername(): string {
        return this.Env.USERNAME ?? this.Env.USER ?? 'user';
    }
}
