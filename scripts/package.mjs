import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { rcedit } from 'rcedit';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const tmp = join(dist, 'tmp');
const embedded = join(root, 'apps', 'tray', 'embedded');
const pkgBin = join(
    root,
    'node_modules',
    '.pnpm',
    '@yao-pkg+pkg@6.22.0_supports-color@7.2.0',
    'node_modules',
    '@yao-pkg',
    'pkg',
    'lib-es5',
    'bin.js',
);

// 构建单一发布二进制：打包后的 CLI（同时承载隐藏 --runtime-daemon
// 开关后的 runtime 守护进程）作为资源嵌入托盘外壳，
// 后者自包含发布，产物为 dist/autotask.exe。

// 在 pkg 缓存目录里找 base binary（文件名形如 fetched-v{node}-win-x64）。
function findFetchedBase() {
    const cacheRoot = process.env.PKG_CACHE_PATH || join(os.homedir(), '.pkg-cache');
    if (!existsSync(cacheRoot)) {
        return undefined;
    }
    for (const dir of readdirSync(cacheRoot)) {
        const abs = join(cacheRoot, dir);
        if (!statSync(abs).isDirectory()) {
            continue;
        }
        for (const name of readdirSync(abs)) {
            if (name.startsWith('fetched-v') && name.endsWith('-win-x64')) {
                return join(abs, name);
            }
        }
    }
    return undefined;
}

// pkg 不支持 --icon，且直接改打包产物会破坏追加的 payload（运行时报 Error reading from file）。
// 改为复制一份 base binary 换成应用图标，再经 PKG_NODE_PATH 交给 pkg——该变量让 pkg
// 用指定文件作 base，同时跳过 base 的 hash 校验。缓存缺失时提示先联网跑一次。
async function iconBasePath() {
    const fetched = findFetchedBase();
    if (fetched === undefined) {
        throw new Error('找不到 pkg base binary 缓存，请先联网执行一次 pnpm package 再重试');
    }
    const iconBase = join(tmp, 'base-icon.exe');
    const icon = join(root, 'icons', 'autotask.ico');
    // rcedit 偶发 "Unable to commit changes"（文件被短暂锁定），失败则重拷重试。
    for (let attempt = 1; ; attempt += 1) {
        copyFileSync(fetched, iconBase);
        try {
            await rcedit(iconBase, { icon });
            return iconBase;
        } catch (error) {
            if (attempt >= 3) {
                throw error;
            }
        }
    }
}

async function main() {
    mkdirSync(tmp, { recursive: true });
    mkdirSync(embedded, { recursive: true });

    // pkg 需要 .mjs 入口来打包 ESM 产物。
    const cliEntry = join(dist, 'at.mjs');
    copyFileSync(join(dist, 'at.js'), cliEntry);

    const iconBase = await iconBasePath();
    execFileSync(
        process.execPath,
        [pkgBin, cliEntry, '--targets', 'node22-win-x64', '--output', join(tmp, 'at.exe')],
        { stdio: 'inherit', env: { ...process.env, PKG_NODE_PATH: iconBase } },
    );

    copyFileSync(join(tmp, 'at.exe'), join(embedded, 'at.exe'));

    // 发布单文件外壳（GUI 子系统）：双击打开托盘，从终端运行则转发给内嵌 CLI。
    // RequireEmbeddedPayload 把本可选的 at.exe 资源变成硬性要求，
    // 缺失或过期时在此失败，而不是产出空壳。
    const trayProject = join(root, 'apps', 'tray', 'AutomaticTask.Tray.csproj');
    const trayOut = join(dist, 'tray-publish');
    rmSync(trayOut, { recursive: true, force: true });
    execFileSync(
        'dotnet',
        ['publish', trayProject, '-c', 'Release', '-o', trayOut, '--nologo', '-p:RequireEmbeddedPayload=true'],
        { stdio: 'inherit' },
    );
    copyFileSync(join(trayOut, 'Autotask.exe'), join(dist, 'autotask.exe'));

    // 中间 payload 副本只是构建产物，不是交付物。
    rmSync(embedded, { recursive: true, force: true });
    rmSync(tmp, { recursive: true, force: true });

    console.log('Packaging complete: dist/autotask.exe');
}

void main();
