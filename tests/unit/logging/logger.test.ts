import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ELogLevel, formatEntry, Logger, RotatingFileTransport } from '@at/logging';
import { afterEach, describe, expect, it } from 'vitest';

import { createTempDir, removeDir } from '../../helpers/test-utils';

describe('logger', () => {
    it('respects log level filtering', () => {
        const lines: string[] = [];
        const transport = {
            Write: (entry: { Message: string }): void => {
                lines.push(entry.Message);
            },
        };
        const logger = new Logger([transport], ELogLevel.Info);
        logger.Debug('hidden');
        logger.Info('visible');
        expect(lines).toEqual(['visible']);
    });

    it('redacts secrets in meta', () => {
        const lines: string[] = [];
        const transport = {
            Write: (entry: Parameters<typeof formatEntry>[0]): void => {
                lines.push(formatEntry(entry));
            },
        };
        const logger = new Logger([transport], ELogLevel.Info);
        logger.Info('Task started', { token: 'abc', taskId: 'daily-report' });
        expect(lines[0]).toContain('token=****');
        expect(lines[0]).toContain('taskId=daily-report');
        expect(lines[0]).not.toContain('abc');
    });
});

describe('rotating file transport', () => {
    const dirs: string[] = [];

    afterEach(() => {
        for (const dir of dirs) {
            removeDir(dir);
        }
        dirs.length = 0;
    });

    it('rotates files when the size limit is hit', () => {
        const dir = createTempDir('at-log-');
        dirs.push(dir);
        const file = join(dir, 'runtime.log');
        const transport = new RotatingFileTransport(file, { maxSizeBytes: 200, maxFiles: 3 });
        for (let i = 0; i < 100; i++) {
            transport.Write({
                Timestamp: new Date(),
                Level: ELogLevel.Info,
                Message: `line ${i} with some padding text to grow the file quickly`,
            });
        }
        expect(existsSync(file)).toBe(true);
        expect(existsSync(`${file}.1`)).toBe(true);
        expect(existsSync(`${file}.2`)).toBe(true);
        expect(existsSync(`${file}.3`)).toBe(false);
        const files = readdirSync(dir).sort();
        expect(files).toEqual(['runtime.log', 'runtime.log.1', 'runtime.log.2']);
    });

    it('reopens at the existing size', () => {
        const dir = createTempDir('at-log-');
        dirs.push(dir);
        const file = join(dir, 'runtime.log');
        const first = new RotatingFileTransport(file, { maxSizeBytes: 1000, maxFiles: 3 });
        for (let i = 0; i < 5; i++) {
            first.Write({
                Timestamp: new Date(),
                Level: ELogLevel.Info,
                Message: 'hello world',
            });
        }
        const second = new RotatingFileTransport(file, { maxSizeBytes: 1000, maxFiles: 3 });
        second.Write({ Timestamp: new Date(), Level: ELogLevel.Info, Message: 'appended' });
        const content = readFileSync(file, 'utf8');
        expect(content).toContain('appended');
        expect(content).toContain('hello world');
    });
});
