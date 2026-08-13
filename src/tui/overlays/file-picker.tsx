import { existsSync, readdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

import { useInput } from 'ink';
import { type ReactElement, useMemo, useState } from 'react';

import { fuzzyRank } from '../fuzzy';
import { overlayInnerWidth, type TOverlayBox } from '../layout';
import { RenderOverlay, RenderOverlayList, RenderOverlayRow } from '../overlay';
import { clampOffset, palette, truncateCells } from '../theme';

type TEntry = { Name: string; Path: string; Directory: boolean; Parent: boolean };

// 读大目录开销小，渲染和滚动开销大。
const MAX_ENTRIES = 500;

// Windows 没有单一文件系统根：`dirname('C:\\')` 还是 `'C:\\'`，从盘符根向上没有父目录，
// 选择器无法离开起始盘。此哨兵代替所有盘符的上一层，列出盘符本身。
const DRIVE_ROOT = '\u0000drives';
function isWindows(): boolean {
    return process.platform === 'win32';
}

function readDrives(): TEntry[] {
    const drives: TEntry[] = [];
    for (let code = 'A'.charCodeAt(0); code <= 'Z'.charCodeAt(0); code += 1) {
        const path = `${String.fromCharCode(code)}:\\`;
        if (existsSync(path)) {
            drives.push({ Name: path, Path: path, Directory: true, Parent: false });
        }
    }
    return drives;
}

// `dir` 的上一级，没有则为 undefined。Windows 上盘符根的上一级是盘符列表，不是盘符根本身。
function parentOf(dir: string): string | undefined {
    if (dir === DRIVE_ROOT) {
        return undefined;
    }
    const parent = dirname(dir);
    if (parent !== dir) {
        return parent;
    }
    return isWindows() ? DRIVE_ROOT : undefined;
}

function readEntries(dir: string, extension: string): { Entries: TEntry[]; Error: string | undefined } {
    if (dir === DRIVE_ROOT) {
        return { Entries: readDrives(), Error: undefined };
    }
    let raw;
    try {
        raw = readdirSync(dir, { withFileTypes: true });
    } catch (error) {
        // Windows 上无权限目录很常见；选择器就地报告而不是导致整个 TUI 崩溃。
        return { Entries: [], Error: error instanceof Error ? error.message : String(error) };
    }
    const directories: TEntry[] = [];
    const files: TEntry[] = [];
    for (const item of raw) {
        if (item.isDirectory()) {
            directories.push({ Name: item.name, Path: join(dir, item.name), Directory: true, Parent: false });
        } else if (item.name.toLowerCase().endsWith(extension)) {
            files.push({ Name: item.name, Path: join(dir, item.name), Directory: false, Parent: false });
        }
    }
    directories.sort((left, right) => left.Name.localeCompare(right.Name));
    files.sort((left, right) => left.Name.localeCompare(right.Name));
    const parent = parentOf(dir);
    const entries: TEntry[] = parent === undefined ? [] : [{ Name: '..', Path: parent, Directory: true, Parent: true }];
    entries.push(...directories, ...files);
    return { Entries: entries.slice(0, MAX_ENTRIES), Error: undefined };
}

function displayDir(dir: string): string {
    return dir === DRIVE_ROOT ? '此电脑' : dir;
}

function shortDir(dir: string): string {
    if (dir === DRIVE_ROOT) {
        return '此电脑';
    }
    return basename(dir) === '' ? dir : basename(dir);
}

export function RenderFilePicker({
    box,
    title,
    root,
    extension,
    OnPick: onPick,
    OnCancel: onCancel,
}: {
    box: TOverlayBox;
    title: string;
    root: string;
    extension: string;
    OnPick: (path: string) => void;
    OnCancel: () => void;
}): ReactElement {
    const inner = overlayInnerWidth(box.Width);
    // 两行边框加标题行、路径行、页脚行。
    const visible = Math.max(1, box.Height - 5);
    const [dir, setDir] = useState(() => resolve(root));
    const [query, setQuery] = useState('');
    const [index, setIndex] = useState(0);

    const listing = useMemo(() => readEntries(dir, extension), [dir, extension]);
    const entries = useMemo(
        () =>
            query === ''
                ? listing.Entries
                : fuzzyRank(query, listing.Entries, (entry) => entry.Name).map((result) => result.Item),
        [listing.Entries, query],
    );

    const bounded = Math.min(index, Math.max(0, entries.length - 1));
    const offset = clampOffset(entries.length, visible, bounded, 0);

    const enter = (entry: TEntry): void => {
        if (entry.Directory) {
            setDir(entry.Path);
            setQuery('');
            setIndex(0);
            return;
        }
        onPick(entry.Path);
    };

    const goUp = (): void => {
        const parent = parentOf(dir);
        if (parent !== undefined) {
            setDir(parent);
            setQuery('');
            setIndex(0);
        }
    };

    useInput((input, key) => {
        if (key.escape) {
            onCancel();
            return;
        }
        if (key.upArrow) {
            setIndex(Math.max(0, bounded - 1));
            return;
        }
        if (key.downArrow) {
            setIndex(Math.min(entries.length - 1, bounded + 1));
            return;
        }
        if (key.return) {
            const entry = entries[bounded];
            if (entry !== undefined) {
                enter(entry);
            }
            return;
        }
        if (key.leftArrow) {
            goUp();
            return;
        }
        if (key.backspace || key.delete) {
            // 有筛选时退格编辑筛选，筛选为空才向上级目录。
            if (query === '') {
                goUp();
            } else {
                setQuery(query.slice(0, -1));
                setIndex(0);
            }
            return;
        }
        // 其余输入都是筛选。j/k 在这里不是导航：它们是文件名里的普通字符。
        if (input !== '' && !key.ctrl && !key.meta) {
            setQuery(query + input);
            setIndex(0);
        }
    });

    const rows = entries.slice(offset, offset + visible).map((entry, position) => {
        const absolute = offset + position;
        const glyph = entry.Parent ? '↰' : entry.Directory ? '▸' : '·';
        // 盘符条目已以分隔符结尾，不能再加一个。
        const slash = entry.Directory && !entry.Parent && !entry.Name.endsWith('\\') ? '/' : '';
        return (
            <RenderOverlayRow
                key={entry.Path}
                text={` ${glyph} ${entry.Name}${slash}`}
                width={inner}
                selected={absolute === bounded}
                color={entry.Directory ? palette.Title : undefined}
            />
        );
    });

    const status =
        listing.Error !== undefined
            ? `无法读取：${listing.Error}`
            : entries.length === 0
              ? `没有 ${extension} 文件`
              : query === ''
                ? truncateCells(displayDir(dir), inner - 1)
                : `筛选 ${query} · ${String(entries.length)} 项`;

    return (
        <RenderOverlay box={box} title={title} hint={shortDir(dir)}>
            <RenderOverlayRow
                text={` ${status}`}
                width={inner}
                selected={false}
                color={listing.Error === undefined ? palette.Muted : palette.Danger}
            />
            <RenderOverlayList width={inner} visible={visible} rows={rows} />
            <RenderOverlayRow
                text=" ↑↓ 选择 · ↵ 进入/选定 · ← 上级 · 输入筛选 · Esc 取消"
                width={inner}
                selected={false}
                color={palette.Muted}
            />
        </RenderOverlay>
    );
}
