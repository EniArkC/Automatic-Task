import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { ConfigManager } from '@at/config';
import { AtValidationError, EOverlapPolicy } from '@at/core';
import { afterEach, describe, expect, it } from 'vitest';

import { createTempDir, createTempPathService, createTestLogger, removeDir } from '../../helpers/test-utils';

describe('config manager', () => {
    const dirs: string[] = [];

    afterEach(() => {
        for (const dir of dirs) {
            removeDir(dir);
        }
        dirs.length = 0;
    });

    function createManager(): { config: ConfigManager; root: string } {
        const root = createTempDir('at-config-');
        dirs.push(root);
        const paths = createTempPathService(root);
        const { Logger: logger } = createTestLogger();
        return { config: new ConfigManager(paths, logger), root };
    }

    it('creates a default app config', () => {
        const { config } = createManager();
        expect(config.LoadAppConfig().version).toBe(1);
    });

    it('round-trips app config', () => {
        const { config } = createManager();
        config.SaveAppConfig({ version: 1, logging: { level: 'debug' } });
        expect(config.LoadAppConfig().logging?.level).toBe('debug');
    });

    it('creates a default task config with disabled and no schedule', () => {
        const { config } = createManager();
        const taskConfig = config.CreateDefaultTaskConfig('daily-report', '1.0.0');
        expect(taskConfig.enabled).toBe(false);
        expect(taskConfig.schedule).toBeUndefined();
        expect(taskConfig.overlap).toBe(EOverlapPolicy.Skip);
        expect(taskConfig.variables).toEqual({});
    });

    it('round-trips task config including schedule', () => {
        const { config } = createManager();
        const taskConfig = config.CreateDefaultTaskConfig('daily-report', '1.0.0');
        taskConfig.enabled = true;
        taskConfig.schedule = { cron: '*/30 * * * *' };
        taskConfig.variables = { city: '上海' };
        config.SaveTaskConfig(taskConfig);
        const loaded = config.GetTaskConfig('daily-report');
        expect(loaded).not.toBeUndefined();
        expect(loaded?.enabled).toBe(true);
        expect(loaded?.schedule?.cron).toBe('*/30 * * * *');
        expect(loaded?.variables.city).toBe('上海');
    });

    it('accepts a null schedule on disk as no schedule', () => {
        const { config, root } = createManager();
        const tasksDir = join(root, 'config', 'tasks');
        mkdirSync(tasksDir, { recursive: true });
        writeFileSync(
            join(tasksDir, 'daily-report.json'),
            '{"taskId":"daily-report","packageVersion":"1.0.0","enabled":false,"overlap":"skip","schedule":null,"variables":{}}',
            'utf8',
        );
        const loaded = config.GetTaskConfig('daily-report');
        expect(loaded?.schedule).toBeUndefined();
    });

    it('lists task configs', () => {
        const { config } = createManager();
        config.SaveTaskConfig(config.CreateDefaultTaskConfig('alpha', '1.0.0'));
        config.SaveTaskConfig(config.CreateDefaultTaskConfig('bravo', '1.0.0'));
        const ids = config
            .ListTaskConfigs()
            .map((config) => config.taskId)
            .sort();
        expect(ids).toEqual(['alpha', 'bravo']);
    });

    it('rejects invalid task configs', () => {
        const { config } = createManager();
        const taskConfig = config.CreateDefaultTaskConfig('daily-report', '1.0.0');
        taskConfig.packageVersion = 'not-a-version';
        expect(() => {
            config.SaveTaskConfig(taskConfig);
        }).toThrow(AtValidationError);
    });

    it('deletes task configs', () => {
        const { config } = createManager();
        config.SaveTaskConfig(config.CreateDefaultTaskConfig('alpha', '1.0.0'));
        config.DeleteTaskConfig('alpha');
        expect(config.GetTaskConfig('alpha')).toBeUndefined();
    });

    it('recovers from corrupt app config', () => {
        const { config, root } = createManager();
        const configDir = join(root, 'config');
        mkdirSync(configDir, { recursive: true });
        writeFileSync(join(configDir, 'app.json'), '{not json', 'utf8');
        const loaded = config.LoadAppConfig();
        expect(loaded.version).toBe(1);
    });

    it('recovers from corrupt task config', () => {
        const { config, root } = createManager();
        const tasksDir = join(root, 'config', 'tasks');
        mkdirSync(tasksDir, { recursive: true });
        writeFileSync(join(tasksDir, 'daily-report.json'), 'garbage', 'utf8');
        expect(config.GetTaskConfig('daily-report')).toBeUndefined();
    });
});
