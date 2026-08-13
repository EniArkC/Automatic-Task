import { UlidGenerator, ulidToDate } from '@at/core';
import { PathService, PlatformService } from '@at/paths';
import { describe, expect, it } from 'vitest';

function createWindowsPaths(): PathService {
    const platform = new PlatformService(
        { LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local', USERNAME: 'test' },
        'win32',
    );
    return new PathService(platform);
}

function createLinuxPaths(): PathService {
    const platform = new PlatformService(
        {
            XDG_DATA_HOME: '/home/test/.local/share',
            XDG_CONFIG_HOME: '/home/test/.config',
            XDG_STATE_HOME: '/home/test/.local/state',
            XDG_RUNTIME_DIR: '/run/user/1000',
            USER: 'test',
        },
        'linux',
    );
    return new PathService(platform);
}

function pad2(value: number): string {
    return String(value).padStart(2, '0');
}

describe('windows paths', () => {
    const paths = createWindowsPaths();

    it('lays out the app root', () => {
        expect(paths.GetAppRoot()).toBe('C:\\Users\\test\\AppData\\Local\\Automatic-Task');
        expect(paths.GetConfigRoot()).toBe('C:\\Users\\test\\AppData\\Local\\Automatic-Task\\config');
        expect(paths.GetAppConfigPath()).toBe('C:\\Users\\test\\AppData\\Local\\Automatic-Task\\config\\app.json');
        expect(paths.GetTaskConfigPath('daily-report')).toBe(
            'C:\\Users\\test\\AppData\\Local\\Automatic-Task\\config\\tasks\\daily-report.json',
        );
    });

    it('lays out packages', () => {
        expect(paths.GetPackagePath('daily-report', '1.0.0')).toBe(
            'C:\\Users\\test\\AppData\\Local\\Automatic-Task\\packages\\daily-report\\1.0.0',
        );
        expect(paths.GetTempPackagePath('tmp-1')).toBe(
            'C:\\Users\\test\\AppData\\Local\\Automatic-Task\\packages\\.tmp\\tmp-1',
        );
    });

    it('lays out runs by date from the run id', () => {
        const generator = new UlidGenerator();
        const runId = generator.Next();
        const date = ulidToDate(runId);
        const expected = `C:\\Users\\test\\AppData\\Local\\Automatic-Task\\runs\\${date.getFullYear()}\\${pad2(
            date.getMonth() + 1,
        )}\\${pad2(date.getDate())}\\${runId}`;
        expect(paths.GetRunPath(runId)).toBe(expected);
        expect(paths.GetRunWorkspacePath(runId)).toBe(`${expected}\\workspace`);
        expect(paths.GetRunMetadataPath(runId)).toBe(`${expected}\\metadata.json`);
    });

    it('uses a per-user named pipe', () => {
        expect(paths.GetRuntimeSocketPath()).toBe('\\\\.\\pipe\\automatic-task-runtime-test');
    });
});

describe('linux paths', () => {
    const paths = createLinuxPaths();

    it('follows XDG base directories', () => {
        expect(paths.GetAppRoot()).toBe('/home/test/.local/share/automatic-task');
        expect(paths.GetConfigRoot()).toBe('/home/test/.config/automatic-task');
        expect(paths.GetLogsRoot()).toBe('/home/test/.local/state/automatic-task');
        expect(paths.GetRuntimeSocketPath()).toBe('/run/user/1000/automatic-task-runtime.sock');
    });
});
