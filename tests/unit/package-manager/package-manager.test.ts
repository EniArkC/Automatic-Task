import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { ConfigManager } from '@at/config';
import { AtPackageError } from '@at/core';
import { PackageManager, parseManifest, validateManifest } from '@at/package-manager';
import { afterEach, describe, expect, it } from 'vitest';

import { basicAtpEntries, buildAtp, buildRawZipBytes, manifestEntry, taskAtsEntry } from '../../helpers/atp-fixtures';
import { createTempDir, createTempPathService, createTestLogger, removeDir } from '../../helpers/test-utils';

describe('manifest validation', () => {
    it('accepts a valid manifest', () => {
        expect(validateManifest(JSON.parse(manifestEntry().content))).toHaveLength(0);
    });

    it('rejects a wrong spec', () => {
        expect(validateManifest(JSON.parse(manifestEntry({ spec: 'atp/v2' }).content))).toHaveLength(1);
    });

    it('rejects a bad id', () => {
        expect(validateManifest(JSON.parse(manifestEntry({ id: 'Daily Report' }).content)).length).toBeGreaterThan(0);
        expect(validateManifest(JSON.parse(manifestEntry({ id: '../foo' }).content)).length).toBeGreaterThan(0);
    });

    it('rejects a bad version', () => {
        expect(validateManifest(JSON.parse(manifestEntry({ version: '1.0' }).content))).toHaveLength(1);
    });

    it('rejects forbidden keys', () => {
        for (const key of ['schedule', 'enabled', 'cron', 'variables', 'userConfig']) {
            expect(validateManifest(JSON.parse(manifestEntry({ [key]: true }).content)).length).toBeGreaterThan(0);
        }
    });

    it('parses a valid manifest', () => {
        const manifest = parseManifest(manifestEntry().content);
        expect(manifest).toMatchObject({ spec: 'atp/v1', id: 'daily-report', version: '1.0.0', author: 'Example' });
    });
});

describe('package manager', () => {
    const dirs: string[] = [];

    afterEach(() => {
        for (const dir of dirs) {
            removeDir(dir);
        }
        dirs.length = 0;
    });

    function createManager(): { Manager: PackageManager; Root: string } {
        const root = createTempDir('at-pkg-');
        dirs.push(root);
        const paths = createTempPathService(root);
        const { Logger: logger } = createTestLogger();
        return { Manager: new PackageManager(paths, new ConfigManager(paths, logger), logger), Root: root };
    }

    async function createAtpFile(entries: { name: string; content: string }[], name = 'test.atp'): Promise<string> {
        const dir = createTempDir('at-atp-');
        dirs.push(dir);
        const file = join(dir, name);
        await buildAtp(file, entries);
        return file;
    }

    it('installs a valid package and creates a default task config', async () => {
        const { Manager: manager } = createManager();
        const atp = await createAtpFile(basicAtpEntries());
        const installed = await manager.Install(atp);
        expect(installed.TaskId).toBe('daily-report');
        expect(installed.Version).toBe('1.0.0');
        expect(existsSync(join(installed.Path, 'manifest.json'))).toBe(true);
        expect(existsSync(join(installed.Path, 'task.ats'))).toBe(true);
        expect(existsSync(join(installed.Path, 'scripts', 'fetch.bat'))).toBe(true);
        expect(
            installed.Path.endsWith('packages\\daily-report\\1.0.0') ||
                installed.Path.endsWith('packages/daily-report/1.0.0'),
        ).toBe(true);
    });

    it('rejects a reinstall of the same version', async () => {
        const { Manager: manager } = createManager();
        const atp = await createAtpFile(basicAtpEntries());
        await manager.Install(atp);
        await expect(manager.Install(atp)).rejects.toThrow(/already installed/);
    });

    it('rejects a package with an invalid manifest', async () => {
        const { Manager: manager } = createManager();
        const atp = await createAtpFile([manifestEntry({ id: 'bad id' }), taskAtsEntry()]);
        await expect(manager.Install(atp)).rejects.toThrow(AtPackageError);
    });

    it('rejects a package without task.ats', async () => {
        const { Manager: manager } = createManager();
        const atp = await createAtpFile([manifestEntry(), { name: 'README.md', content: 'x' }]);
        await expect(manager.Install(atp)).rejects.toThrow(/task.ats/);
    });

    it('rejects a package with an invalid task script', async () => {
        const { Manager: manager } = createManager();
        const atp = await createAtpFile([
            manifestEntry(),
            taskAtsEntry('[Start]\n-> [Script(`echo ${missing}`)]\n[End]\n'),
        ]);
        await expect(manager.Install(atp)).rejects.toThrow(/invalid task script|missing/);
    });

    it('leaves no temp directories after a failed install', async () => {
        const { Manager: manager, Root: root } = createManager();
        const atp = await createAtpFile([manifestEntry(), taskAtsEntry('garbage')]);
        await expect(manager.Install(atp)).rejects.toThrow();
        expect(existsSync(join(root, 'packages', '.tmp'))).toBe(false);
    });

    it('rejects a corrupt zip', async () => {
        const { Manager: manager } = createManager();
        const dir = createTempDir('at-atp-');
        dirs.push(dir);
        const file = join(dir, 'corrupt.atp');
        writeFileSync(file, 'this is not a zip');
        await expect(manager.Install(file)).rejects.toThrow();
    });

    it('rejects zip slip packages', async () => {
        const { Manager: manager } = createManager();
        const dir = createTempDir('at-atp-');
        dirs.push(dir);
        const file = join(dir, 'slip.atp');
        writeFileSync(file, buildRawZipBytes([manifestEntry(), taskAtsEntry(), { name: '../evil.exe', content: 'x' }]));
        // yauzl itself rejects traversal names; our sanitizer is the second line of defense.
        await expect(manager.Install(file)).rejects.toThrow(/unsafe path|invalid relative path/);
    });

    it('keeps multiple versions and resolves the latest', async () => {
        const { Manager: manager } = createManager();
        const atp1 = await createAtpFile([manifestEntry(), taskAtsEntry()], 'v1.atp');
        const atp2 = await createAtpFile([manifestEntry({ version: '1.1.0' }), taskAtsEntry()], 'v2.atp');
        await manager.Install(atp1);
        await manager.Install(atp2);
        const latest = manager.GetPackage('daily-report');
        expect(latest?.Version).toBe('1.1.0');
        expect(manager.GetPackage('daily-report', '1.0.0')?.Version).toBe('1.0.0');
        expect(manager.GetInstalledPackages()).toHaveLength(2);
    });

    it('uninstalls the task config and all package versions', async () => {
        const { Manager: manager } = createManager();
        const atp1 = await createAtpFile([manifestEntry(), taskAtsEntry()], 'v1.atp');
        await manager.Install(atp1);
        manager.Uninstall('daily-report');
        expect(manager.GetPackage('daily-report')).toBeUndefined();
    });

    it('inspects a package without installing it', async () => {
        const { Manager: manager } = createManager();
        const atp = await createAtpFile(basicAtpEntries());
        const preview = await manager.Inspect(atp);
        expect(preview.Manifest.id).toBe('daily-report');
        expect(preview.ScriptCount).toBe(1);
        expect(preview.UsesDocker).toBe(false);
        expect(manager.GetPackage('daily-report')).toBeUndefined();
    });

    it('detects docker usage in preview', async () => {
        const { Manager: manager } = createManager();
        const source = '[Start]\n-> [Docker(`alpine`, `echo hi`)]\n[End]\n';
        const atp = await createAtpFile([manifestEntry(), taskAtsEntry(source)]);
        const preview = await manager.Inspect(atp);
        expect(preview.UsesDocker).toBe(true);
    });
});
