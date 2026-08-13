import { createWriteStream, mkdirSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';

import { AtPackageError } from '@at/core';
import yauzl from 'yauzl';

export type TZipEntryInfo = {
    Path: string;
    IsDirectory: boolean;
    Size: number;
};

function openZipFile(file: string, options: yauzl.Options): Promise<yauzl.ZipFile> {
    return new Promise((resolve, reject) => {
        yauzl.open(file, options, (error, zip) => {
            // yauzl 以 error 为 null 表示成功。
            if (error instanceof Error) {
                reject(error);
            } else {
                resolve(zip);
            }
        });
    });
}

function waitForEnd(zip: yauzl.ZipFile): Promise<void> {
    return new Promise((resolve, reject) => {
        zip.on('error', reject);
        zip.on('end', resolve);
    });
}

export async function readZip(file: string): Promise<TZipEntryInfo[]> {
    let zip: yauzl.ZipFile;
    try {
        zip = await openZipFile(file, { lazyEntries: true });
    } catch (error) {
        throw new AtPackageError(
            `Failed to open package "${file}": ${error instanceof Error ? error.message : String(error)}`,
        );
    }
    const entries: TZipEntryInfo[] = [];
    const readPromise = waitForEnd(zip);
    zip.on('entry', (entry: yauzl.Entry) => {
        entries.push({
            Path: entry.fileName,
            IsDirectory: entry.fileName.endsWith('/'),
            Size: entry.uncompressedSize,
        });
        zip.readEntry();
    });
    zip.readEntry();
    try {
        await readPromise;
    } finally {
        zip.close();
    }
    return entries;
}

// Zip Slip 防护：规范化条目名，拒绝绝对路径及任何可逃出解压目录的路径。
export function sanitizeZipEntryPath(name: string): string | undefined {
    const normalized = name.replace(/\\/g, '/');
    if (normalized === '' || normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) {
        return undefined;
    }
    const parts = normalized.split('/').filter((part) => part !== '' && part !== '.');
    if (parts.length === 0 || parts.some((part) => part === '..')) {
        return undefined;
    }
    return parts.join('/');
}

export function readZipEntryText(file: string, name: string): Promise<string> {
    return new Promise((resolve, reject) => {
        let settled = false;
        openZipFile(file, { lazyEntries: true })
            .then((zip) => {
                zip.on('error', (error) => {
                    if (!settled) {
                        settled = true;
                        reject(
                            new AtPackageError(
                                `Failed to read "${name}" from package: ${error instanceof Error ? error.message : String(error)}`,
                            ),
                        );
                    }
                });
                zip.on('entry', (entry: yauzl.Entry) => {
                    if (entry.fileName !== name) {
                        zip.readEntry();
                        return;
                    }
                    zip.openReadStream(entry, (error, stream) => {
                        if (error instanceof Error) {
                            if (!settled) {
                                settled = true;
                                reject(error);
                            }
                            zip.close();
                            return;
                        }
                        const chunks: Buffer[] = [];
                        stream.on('data', (chunk: Buffer) => {
                            chunks.push(chunk);
                        });
                        stream.on('error', (streamError) => {
                            if (!settled) {
                                settled = true;
                                reject(streamError);
                            }
                            zip.close();
                        });
                        stream.on('end', () => {
                            if (!settled) {
                                settled = true;
                                resolve(Buffer.concat(chunks).toString('utf8'));
                            }
                            zip.close();
                        });
                    });
                });
                zip.on('end', () => {
                    if (!settled) {
                        settled = true;
                        reject(new AtPackageError(`Package is missing required file "${name}"`));
                    }
                    zip.close();
                });
                zip.readEntry();
            })
            .catch(reject);
    });
}

export async function extractZipTo(file: string, entries: TZipEntryInfo[], destDir: string): Promise<string[]> {
    // 写入前先校验全部条目，恶意压缩包不会留下不完整的解压结果。
    const safeTargets = new Map<string, string>();
    for (const info of entries) {
        const safePath = sanitizeZipEntryPath(info.Path);
        if (safePath === undefined) {
            throw new AtPackageError(`Package contains an unsafe path "${info.Path}"`);
        }
        const target = join(destDir, safePath);
        if (target !== destDir && !target.startsWith(destDir + sep)) {
            throw new AtPackageError(`Package entry "${info.Path}" escapes the package directory`);
        }
        safeTargets.set(info.Path, target);
    }
    const zip = await openZipFile(file, { lazyEntries: true });
    const extracted: string[] = [];
    const readPromise = waitForEnd(zip);
    zip.on('entry', (entry: yauzl.Entry) => {
        if (entry.fileName.endsWith('/')) {
            const target = safeTargets.get(entry.fileName);
            if (target !== undefined) {
                mkdirSync(target, { recursive: true });
            }
            zip.readEntry();
            return;
        }
        const target = safeTargets.get(entry.fileName);
        if (target === undefined) {
            zip.readEntry();
            return;
        }
        zip.openReadStream(entry, (error, stream) => {
            if (error instanceof Error) {
                zip.emit('error', error);
                return;
            }
            mkdirSync(dirname(target), { recursive: true });
            const writer = createWriteStream(target);
            stream.on('error', (streamError) => {
                zip.emit('error', streamError);
            });
            writer.on('error', (writeError) => {
                zip.emit('error', writeError);
            });
            writer.on('close', () => {
                extracted.push(entry.fileName);
                zip.readEntry();
            });
            stream.pipe(writer);
        });
    });
    zip.readEntry();
    try {
        await readPromise;
    } finally {
        zip.close();
    }
    return extracted;
}
