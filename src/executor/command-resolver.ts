import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

// 命令行的一个片段：`text` 是脚本写死的文本，`value` 是模板变量替换出来的值。
// 两者必须分开，切分规则完全不同——见 splitCommandParts。
export type TCommandPart = {
    Kind: 'text' | 'value';
    Text: string;
};

export function textPart(text: string): TCommandPart[] {
    return [{ Kind: 'text', Text: text }];
}

export function partsToText(parts: TCommandPart[]): string {
    return parts.map((part) => part.Text).join('');
}

// 按片段切分命令行。脚本写死的文本按空白切分、双引号成对保留空格；
// 变量值整体算一个参数片段，既不按空格切开也不参与引号配对——
// 否则值里带空格（`hello world`）会被切成两个参数，带引号会破坏后续配对。
export function splitCommandParts(parts: TCommandPart[]): string[] {
    const tokens: string[] = [];
    let current = '';
    let inQuotes = false;
    const flush = (): void => {
        if (current !== '') {
            tokens.push(current);
            current = '';
        }
    };
    for (const part of parts) {
        if (part.Kind === 'value') {
            current += part.Text;
            continue;
        }
        for (const char of part.Text) {
            if (char === '"') {
                inQuotes = !inQuotes;
                continue;
            }
            if (char === ' ' && !inQuotes) {
                flush();
                continue;
            }
            current += char;
        }
    }
    flush();
    return tokens;
}

// 纯文本命令行的切分，等价于只有一个 text 片段。
export function splitCommandLine(line: string): string[] {
    return splitCommandParts(textPart(line));
}

const scriptExtensions = ['.bat', '.cmd', '.exe', '.sh', '.ps1'];

function looksLikeFile(token: string): boolean {
    if (isAbsolute(token)) {
        return true;
    }
    if (token.includes('/') || token.includes('\\')) {
        return true;
    }
    const lower = token.toLowerCase();
    return scriptExtensions.some((extension) => lower.endsWith(extension));
}

export type TResolvedCommand = {
    // 要启动的可执行文件；必须经 cmd 运行时为 undefined。
    Command?: string;
    Args: string[];
    // 脚本位于包目录内时设置。
    ResolvedPath?: string;
};

// 相对已安装包目录解析脚本命令，不依赖当前工作目录，`at run` 可在任意目录运行。
export function resolveCommand(command: string | TCommandPart[], packagePath: string): TResolvedCommand {
    const parts = typeof command === 'string' ? textPart(command) : command;
    const tokens = splitCommandParts(parts);
    const first = tokens[0] ?? '';
    if (first === '') {
        return { Args: [] };
    }
    const lower = first.toLowerCase();
    const viaCmd = lower.endsWith('.bat') || lower.endsWith('.cmd');
    if (!isAbsolute(first) && looksLikeFile(first)) {
        const candidate = join(packagePath, first);
        if (existsSync(candidate)) {
            if (viaCmd) {
                // 批处理经 cmd 运行，参数必须原样保留。
                return { Command: undefined, Args: tokens.slice(1), ResolvedPath: candidate };
            }
            return { Command: candidate, Args: tokens.slice(1), ResolvedPath: candidate };
        }
    }
    if (viaCmd) {
        // 即使经 PATH 找到批处理，仍需 cmd 执行。
        return { Command: undefined, Args: tokens.slice(1), ResolvedPath: first };
    }
    return { Command: first, Args: tokens.slice(1) };
}

// 为 cmd.exe 转义参数。双引号内 cmd 将成对引号 ("" ) 视为字面引号，不能用反斜杠转义。
export function quoteCmdArgument(value: string): string {
    if (value === '') {
        return '""';
    }
    const needsQuotes = /[\s&|<>^()%!"]/.test(value);
    if (!needsQuotes) {
        return value;
    }
    return `"${value.replace(/"/g, '""')}"`;
}

export function buildCmdLine(script: string, args: string[]): string {
    const parts = [script, ...args];
    return parts.map((part) => quoteCmdArgument(part)).join(' ');
}
