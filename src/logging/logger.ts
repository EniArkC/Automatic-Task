import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { redactSecrets } from './redact';

export enum ELogLevel {
    Debug = 'debug',
    Info = 'info',
    Warn = 'warn',
    Error = 'error',
}

export type TLogEntry = {
    Timestamp: Date;
    Level: ELogLevel;
    Message: string;
    Meta?: Record<string, unknown>;
};

export interface ILogger {
    Debug(message: string, meta?: Record<string, unknown>): void;
    Info(message: string, meta?: Record<string, unknown>): void;
    Warn(message: string, meta?: Record<string, unknown>): void;
    Error(message: string, meta?: Record<string, unknown>): void;
    SetLevel(level: ELogLevel): void;
}

export interface ILogTransport {
    Write(entry: TLogEntry): void;
}

const levelRanks: Record<ELogLevel, number> = {
    [ELogLevel.Debug]: 0,
    [ELogLevel.Info]: 1,
    [ELogLevel.Warn]: 2,
    [ELogLevel.Error]: 3,
};

function levelRank(level: ELogLevel): number {
    return levelRanks[level];
}

function formatMetaValue(value: unknown): string {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        return String(value);
    }
    if (typeof value === 'object') {
        return JSON.stringify(value);
    }
    return typeof value;
}

function formatMeta(meta: Record<string, unknown>): string {
    const parts: string[] = [];
    for (const [key, value] of Object.entries(meta)) {
        parts.push(`${key}=${formatMetaValue(value)}`);
    }
    return parts.length > 0 ? ` ${parts.join(' ')}` : '';
}

export function formatEntry(entry: TLogEntry): string {
    const level = entry.Level.toUpperCase().padEnd(5);
    return `[${entry.Timestamp.toISOString()}] ${level} ${entry.Message}${formatMeta(entry.Meta ?? {})}`;
}

export class ConsoleTransport implements ILogTransport {
    private readonly Stream: NodeJS.WritableStream;

    public constructor(stream: NodeJS.WritableStream = process.stderr) {
        this.Stream = stream;
    }

    public Write(entry: TLogEntry): void {
        this.Stream.write(`${formatEntry(entry)}\n`);
    }
}

export type TRotationOptions = {
    maxSizeBytes?: number;
    maxFiles?: number;
};

const DEFAULT_MAX_SIZE_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_FILES = 5;

export class RotatingFileTransport implements ILogTransport {
    private readonly FilePath: string;
    private readonly MaxSizeBytes: number;
    private readonly MaxFiles: number;
    private CurrentSize: number;

    public constructor(filePath: string, options: TRotationOptions = {}) {
        this.FilePath = filePath;
        this.MaxSizeBytes = options.maxSizeBytes ?? DEFAULT_MAX_SIZE_BYTES;
        this.MaxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
        this.CurrentSize = this.ReadCurrentSize();
    }

    public Write(entry: TLogEntry): void {
        const line = `${formatEntry(entry)}\n`;
        const bytes = Buffer.byteLength(line, 'utf8');
        if (this.CurrentSize + bytes > this.MaxSizeBytes) {
            this.Rotate();
        }
        try {
            mkdirSync(dirname(this.FilePath), { recursive: true });
            appendFileSync(this.FilePath, line, 'utf8');
            this.CurrentSize += bytes;
        } catch (error) {
            // 日志绝不能使运行时崩溃；降级到 stderr。
            try {
                process.stderr.write(
                    `[logger] write failed: ${error instanceof Error ? error.message : String(error)}\n`,
                );
            } catch {
                /* 无可用降级。 */
            }
        }
    }

    private ReadCurrentSize(): number {
        try {
            return statSync(this.FilePath).size;
        } catch {
            return 0;
        }
    }

    private Rotate(): void {
        try {
            const oldest = `${this.FilePath}.${this.MaxFiles - 1}`;
            rmSync(oldest, { force: true });
            for (let i = this.MaxFiles - 2; i >= 1; i--) {
                const from = `${this.FilePath}.${i}`;
                if (existsSync(from)) {
                    renameSync(from, `${this.FilePath}.${i + 1}`);
                }
            }
            if (existsSync(this.FilePath)) {
                renameSync(this.FilePath, `${this.FilePath}.1`);
            }
            this.CurrentSize = 0;
        } catch (error) {
            // 轮转失败不致命；继续追加到当前文件。
            try {
                process.stderr.write(
                    `[logger] rotate failed: ${error instanceof Error ? error.message : String(error)}\n`,
                );
            } catch {
                /* 无可用降级。 */
            }
        }
    }
}

export class Logger implements ILogger {
    private readonly Transports: ILogTransport[];
    private Level: ELogLevel;

    public constructor(transports: ILogTransport[], level: ELogLevel = ELogLevel.Info) {
        this.Transports = transports;
        this.Level = level;
    }

    public SetLevel(level: ELogLevel): void {
        this.Level = level;
    }

    public Debug(message: string, meta?: Record<string, unknown>): void {
        this.Log(ELogLevel.Debug, message, meta);
    }

    public Info(message: string, meta?: Record<string, unknown>): void {
        this.Log(ELogLevel.Info, message, meta);
    }

    public Warn(message: string, meta?: Record<string, unknown>): void {
        this.Log(ELogLevel.Warn, message, meta);
    }

    public Error(message: string, meta?: Record<string, unknown>): void {
        this.Log(ELogLevel.Error, message, meta);
    }

    private Log(level: ELogLevel, message: string, meta?: Record<string, unknown>): void {
        if (levelRank(level) < levelRank(this.Level)) {
            return;
        }
        // 先脱敏再交给 transport，确保任何 transport 都不会泄漏密钥。
        const safeMeta = (meta === undefined ? undefined : redactSecrets(meta)) as Record<string, unknown> | undefined;
        const entry: TLogEntry = { Timestamp: new Date(), Level: level, Message: message, Meta: safeMeta };
        for (const transport of this.Transports) {
            transport.Write(entry);
        }
    }
}

export function createRuntimeLogger(logsRoot: string, level: ELogLevel = ELogLevel.Info): Logger {
    const runtimeLog = join(logsRoot, 'runtime.log');
    return new Logger([new RotatingFileTransport(runtimeLog), new ConsoleTransport()], level);
}
