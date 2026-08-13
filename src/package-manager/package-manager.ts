import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { parseAts, validateTaskAst } from '@at/ats';
import type { IConfigManager } from '@at/config';
import {
    AtPackageError,
    AtValidationError,
    compareSemver,
    isValidPackageId,
    isValidSemver,
    UlidGenerator,
} from '@at/core';
import type { ILogger } from '@at/logging';
import type { IPathService } from '@at/paths';

import { extractZipTo, readZip, readZipEntryText, sanitizeZipEntryPath } from './atp-reader';
import { parseManifest, type TManifest } from './manifest';

export type TInstalledPackage = {
    TaskId: string;
    Version: string;
    Manifest: TManifest;
    Path: string;
};

export type TPackagePreview = {
    Manifest: TManifest;
    Files: string[];
    ScriptCount: number;
    UsesDocker: boolean;
};

export interface IPackageManager {
    Inspect(atpFile: string): Promise<TPackagePreview>;
    Install(atpFile: string): Promise<TInstalledPackage>;
    Uninstall(taskId: string): void;
    GetInstalledPackages(): TInstalledPackage[];
    GetPackage(taskId: string, version?: string): TInstalledPackage | undefined;
    ReadTaskAts(taskId: string, version: string): string;
    CleanupTemp(): void;
}

function missingFileError(error: unknown): boolean {
    return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

// 包是不可变产物；安装不修改已装包，只新增版本目录。
export class PackageManager implements IPackageManager {
    private readonly PathService: IPathService;
    private readonly ConfigManager: IConfigManager;
    private readonly Logger: ILogger;
    private readonly IdGenerator = new UlidGenerator();

    public constructor(pathService: IPathService, configManager: IConfigManager, logger: ILogger) {
        this.PathService = pathService;
        this.ConfigManager = configManager;
        this.Logger = logger;
    }

    public async Inspect(atpFile: string): Promise<TPackagePreview> {
        const entries = await readZip(atpFile);
        const manifest = parseManifest(await readZipEntryText(atpFile, 'manifest.json'));
        const taskAts = await readZipEntryText(atpFile, 'task.ats');
        const files = entries
            .filter((entry) => !entry.IsDirectory)
            .map((entry) => sanitizeZipEntryPath(entry.Path) ?? entry.Path);
        return {
            Manifest: manifest,
            Files: files,
            ScriptCount: files.filter((file) => file.startsWith('scripts/')).length,
            UsesDocker: taskAts.includes('[Docker'),
        };
    }

    public async Install(atpFile: string): Promise<TInstalledPackage> {
        const entries = await readZip(atpFile);
        const manifestJson = await readZipEntryText(atpFile, 'manifest.json');
        const manifest = parseManifest(manifestJson);
        if (!isValidPackageId(manifest.id)) {
            throw new AtPackageError(`Invalid package id "${manifest.id}"`);
        }
        const taskAtsSource = await readZipEntryText(atpFile, 'task.ats');
        // 解压前先校验 ATS，坏包被拒绝时不留下任何临时状态。
        const ast = parseAts(taskAtsSource, 'task.ats');
        const issues = validateTaskAst(ast);
        if (issues.length > 0) {
            throw new AtValidationError(
                `Package "${manifest.id}@${manifest.version}" contains an invalid task script`,
                issues.map((issue) => `task.ats:${issue.Line}:${issue.Column} ${issue.Message}`),
            );
        }
        const target = this.PathService.GetPackagePath(manifest.id, manifest.version);
        if (this.DirectoryExists(target)) {
            throw new AtPackageError(`Package "${manifest.id}@${manifest.version}" is already installed`, {
                exitCode: 4,
            });
        }
        const tempPath = this.PathService.GetTempPackagePath(this.IdGenerator.Next());
        try {
            await extractZipTo(atpFile, entries, tempPath);
            // 原子移动：包完整后才对外可见。
            mkdirSync(dirname(target), { recursive: true });
            renameSync(tempPath, target);
        } catch (error) {
            rmSync(tempPath, { recursive: true, force: true });
            throw new AtPackageError(
                `Failed to install package "${manifest.id}@${manifest.version}": ${error instanceof Error ? error.message : String(error)}`,
                { cause: error },
            );
        }
        const existingConfig = this.ConfigManager.GetTaskConfig(manifest.id);
        if (existingConfig === undefined) {
            this.ConfigManager.SaveTaskConfig(
                this.ConfigManager.CreateDefaultTaskConfig(manifest.id, manifest.version),
            );
        }
        this.Logger.Info('Task package installed', { taskId: manifest.id, version: manifest.version });
        return {
            TaskId: manifest.id,
            Version: manifest.version,
            Manifest: manifest,
            Path: target,
        };
    }

    public Uninstall(taskId: string): void {
        this.ConfigManager.DeleteTaskConfig(taskId);
        const packageRoot = join(this.PathService.GetPackagesRoot(), taskId);
        rmSync(packageRoot, { recursive: true, force: true });
        this.Logger.Info('Task uninstalled', { taskId });
    }

    public GetInstalledPackages(): TInstalledPackage[] {
        const packages: TInstalledPackage[] = [];
        const root = this.PathService.GetPackagesRoot();
        let taskDirs: string[] = [];
        try {
            taskDirs = readdirSync(root, { withFileTypes: true })
                .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
                .map((entry) => entry.name);
        } catch (error) {
            if (!missingFileError(error)) {
                this.Logger.Warn('Failed to list package directories', { root, error });
            }
        }
        for (const taskId of taskDirs) {
            const versionDirs = this.ListVersions(taskId);
            for (const version of versionDirs) {
                const manifestPath = join(this.PathService.GetPackagePath(taskId, version), 'manifest.json');
                try {
                    const manifest = parseManifest(readFileSync(manifestPath, 'utf8'));
                    packages.push({
                        TaskId: taskId,
                        Version: version,
                        Manifest: manifest,
                        Path: join(this.PathService.GetPackagePath(taskId, version)),
                    });
                } catch (error) {
                    this.Logger.Warn('Skipping unreadable package manifest', { manifestPath, error });
                }
            }
        }
        return packages;
    }

    public GetPackage(taskId: string, version?: string): TInstalledPackage | undefined {
        const installed = this.GetInstalledPackages().filter((entry) => entry.TaskId === taskId);
        if (installed.length === 0) {
            return undefined;
        }
        if (version !== undefined) {
            return installed.find((entry) => entry.Version === version);
        }
        installed.sort((left, right) => compareSemver(left.Version, right.Version));
        return installed[installed.length - 1];
    }

    public ReadTaskAts(taskId: string, version: string): string {
        const file = join(this.PathService.GetPackagePath(taskId, version), 'task.ats');
        try {
            return readFileSync(file, 'utf8');
        } catch (error) {
            throw new AtPackageError(`Failed to read task script of "${taskId}@${version}"`, { cause: error });
        }
    }

    public CleanupTemp(): void {
        const tempRoot = this.PathService.GetTempPackageRoot();
        try {
            rmSync(tempRoot, { recursive: true, force: true });
        } catch (error) {
            this.Logger.Warn('Failed to clean temp packages', { tempRoot, error });
        }
    }

    private ListVersions(taskId: string): string[] {
        const taskRoot = join(this.PathService.GetPackagesRoot(), taskId);
        try {
            return readdirSync(taskRoot, { withFileTypes: true })
                .filter((entry) => entry.isDirectory() && isValidSemver(entry.name))
                .map((entry) => entry.name);
        } catch (error) {
            if (!missingFileError(error)) {
                this.Logger.Warn('Failed to list package versions', { taskRoot, error });
            }
            return [];
        }
    }

    private DirectoryExists(dir: string): boolean {
        try {
            return statSync(dir).isDirectory();
        } catch {
            return false;
        }
    }
}
