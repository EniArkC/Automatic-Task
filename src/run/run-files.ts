import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { AtRuntimeError } from '@at/core';
import type { IPathService } from '@at/paths';

import { parseRunRecord, serializeRunRecord, type TRunRecord } from './run-record';

export type TRunEventLine = {
    type: string;
    runId: string;
    taskId: string;
    timestamp: string;
    data: Record<string, unknown>;
};

export interface IRunFiles {
    CreateRunDirectory(runId: string): void;
    WriteMetadata(record: TRunRecord): void;
    ReadMetadata(runId: string): TRunRecord | undefined;
    AppendStdout(runId: string, data: string): void;
    AppendStderr(runId: string, data: string): void;
    AppendEvent(runId: string, taskId: string, type: string, data: Record<string, unknown>): void;
}

// 运行目录结构：runs/<date>/<runId>/ 下含 metadata.json、stdout.log、stderr.log 与 events.jsonl。
export class RunFiles implements IRunFiles {
    private readonly PathService: IPathService;

    public constructor(pathService: IPathService) {
        this.PathService = pathService;
    }

    public CreateRunDirectory(runId: string): void {
        mkdirSync(this.PathService.GetRunPath(runId), { recursive: true });
        mkdirSync(this.PathService.GetRunWorkspacePath(runId), { recursive: true });
    }

    public WriteMetadata(record: TRunRecord): void {
        const file = this.PathService.GetRunMetadataPath(record.RunId);
        mkdirSync(dirname(file), { recursive: true });
        const tmp = `${file}.tmp`;
        writeFileSync(tmp, `${JSON.stringify(serializeRunRecord(record), undefined, 2)}\n`, 'utf8');
        renameSync(tmp, file);
    }

    public ReadMetadata(runId: string): TRunRecord | undefined {
        try {
            const raw = readFileSync(this.PathService.GetRunMetadataPath(runId), 'utf8');
            return parseRunRecord(JSON.parse(raw));
        } catch (error) {
            throw new AtRuntimeError(`Failed to read run metadata for "${runId}"`, { cause: error });
        }
    }

    public AppendStdout(runId: string, data: string): void {
        this.Append(this.PathService.GetRunStdoutPath(runId), data);
    }

    public AppendStderr(runId: string, data: string): void {
        this.Append(this.PathService.GetRunStderrPath(runId), data);
    }

    public AppendEvent(runId: string, taskId: string, type: string, data: Record<string, unknown>): void {
        const line: TRunEventLine = {
            type,
            runId,
            taskId,
            timestamp: new Date().toISOString(),
            data,
        };
        this.Append(this.PathService.GetRunEventsPath(runId), `${JSON.stringify(line)}\n`);
    }

    private Append(file: string, data: string): void {
        try {
            mkdirSync(dirname(file), { recursive: true });
            appendFileSync(file, data, 'utf8');
        } catch (error) {
            // 输出持久化失败不能中断运行本身。
            throw new AtRuntimeError(`Failed to write run output to "${file}"`, { cause: error });
        }
    }
}
