// TUI 终端配色；贴近常见 16 色终端，无 truecolor 支持时界面也正常。
export const palette = {
    Title: 'cyan',
    TitleDim: 'blue',
    TitleGlow: 'whiteBright',
    Accent: 'magenta',
    Success: 'green',
    Danger: 'red',
    Warning: 'yellow',
    Muted: 'gray',
    Selected: 'cyanBright',
    Border: 'gray',
    BorderFocus: 'cyan',
    SelectionBg: 'blue',
} as const;

// 断点与比例。这里没有绝对格数：框架填满终端给出的空间，这些只决定哪种尺寸显示什么。具体尺寸在 layout.ts。
export const layout = {
    // 低于此值时界面被"窗口过小"提示替代。
    MinColumns: 40,
    MinRows: 12,
    // 达到或超过此值仪表盘分成两列。
    TwoColumnMin: 76,
    TaskPanelRatio: 0.42,
    PanelGap: 1,
    // 完整/精简详情面板所需的内容行数。
    DetailFullMin: 18,
    DetailCompactMin: 14,
    // 三行方块字母横幅所需的终端尺寸。放不下的终端改用单行标题。
    BannerBigMinRows: 24,
    BannerBigMinColumns: 80,
    MaxHintRows: 2,
    // 通知 toast：允许的最大宽高，以及自动消失前的停留时间。
    ToastMaxWidth: 46,
    ToastMaxLines: 3,
    ToastMs: 4000,
    // 确认卡：文本允许的最大宽度与行数，卡片高度由实际行数决定。
    ConfirmMaxWidth: 52,
    ConfirmMaxLines: 4,
} as const;

function isWideCodePoint(code: number): boolean {
    return (
        (code >= 0x1100 && code <= 0x115f) ||
        (code >= 0x2e80 && code <= 0x303e) ||
        (code >= 0x3041 && code <= 0x33ff) ||
        (code >= 0x3400 && code <= 0x4dbf) ||
        (code >= 0x4e00 && code <= 0x9fff) ||
        (code >= 0xa000 && code <= 0xa4cf) ||
        (code >= 0xac00 && code <= 0xd7a3) ||
        (code >= 0xf900 && code <= 0xfaff) ||
        (code >= 0xfe30 && code <= 0xfe4f) ||
        (code >= 0xff00 && code <= 0xff60) ||
        (code >= 0xffe0 && code <= 0xffe6) ||
        (code >= 0x1f300 && code <= 0x1f64f) ||
        (code >= 0x20000 && code <= 0x3fffd)
    );
}

// 字符串的终端格宽：CJK 与全角码点占两列。本地实现而非用 string-width：
// 该包 v7 起调用 Intl.Segmenter，打包进可执行文件的小型 icu Node 构建在这里会抛错。
export function displayWidth(text: string): number {
    let width = 0;
    for (const char of text) {
        width += isWideCodePoint(char.codePointAt(0) ?? 0) ? 2 : 1;
    }
    return width;
}

export function truncateCells(text: string, width: number): string {
    if (width <= 0) {
        return '';
    }
    if (displayWidth(text) <= width) {
        return text;
    }
    let result = '';
    let used = 0;
    for (const char of text) {
        const size = isWideCodePoint(char.codePointAt(0) ?? 0) ? 2 : 1;
        if (used + size > width - 1) {
            break;
        }
        result += char;
        used += size;
    }
    return `${result}…`;
}

// 把字符串补到恰好 `width` 格。只有 overlay 需要：绝对定位盒子没写到的地方是透明的，
// 每一行都必须覆盖它占据的格子。基础布局写短行也无妨——ink 会用空格预填网格。
export function padCells(text: string, width: number): string {
    const clipped = truncateCells(text, width);
    return clipped + ' '.repeat(Math.max(0, width - displayWidth(clipped)));
}

// 把 `text` 拆成最多 `maxLines` 行、每行最多 `width` 格，按字符而不是按词断行：
// 通知大多是路径和运行时错误串，常常没有词可断。
export function wrapCells(text: string, width: number, maxLines: number): string[] {
    if (width <= 0 || maxLines <= 0) {
        return [];
    }
    const lines: string[] = [];
    let current = '';
    let used = 0;
    for (const char of text) {
        const size = isWideCodePoint(char.codePointAt(0) ?? 0) ? 2 : 1;
        if (used + size > width) {
            if (lines.length + 1 === maxLines) {
                // 没有空间再开一行，最后一行把剩余内容截成省略号而不是静默丢弃。
                lines.push(truncateCells(`${current}${char}`, width));
                return lines;
            }
            lines.push(current);
            current = '';
            used = 0;
        }
        current += char;
        used += size;
    }
    if (current !== '' || lines.length === 0) {
        lines.push(current);
    }
    return lines;
}

// 列表滚动条列每可见行一个字符；全部放得下时留空。
export function scrollColumn(total: number, visible: number, offset: number): string[] {
    if (total <= visible || visible <= 0) {
        return new Array<string>(Math.max(0, visible)).fill(' ');
    }
    const thumb = Math.max(1, Math.round((visible / total) * visible));
    const start = Math.round((offset / (total - visible)) * (visible - thumb));
    return Array.from({ length: visible }, (unused, index) => (index >= start && index < start + thumb ? '█' : '│'));
}

// 让光标停留在 `visible` 行的视口内且尽量少移动，列表不会在选中项下跳动。
export function clampOffset(total: number, visible: number, index: number, offset: number): number {
    if (total <= visible) {
        return 0;
    }
    const maxOffset = total - visible;
    if (index < offset) {
        return Math.max(0, Math.min(index, maxOffset));
    }
    if (index >= offset + visible) {
        return Math.max(0, Math.min(index - visible + 1, maxOffset));
    }
    return Math.max(0, Math.min(offset, maxOffset));
}

export const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;

export type TStatusMeta = { Glyph: string; Color: string; Label: string };

export function statusMeta(status: string): TStatusMeta {
    switch (status) {
        case 'success':
            return { Glyph: '✓', Color: palette.Success, Label: '成功' };
        case 'failure':
            return { Glyph: '✗', Color: palette.Danger, Label: '失败' };
        case 'timeout':
            return { Glyph: '◷', Color: palette.Warning, Label: '超时' };
        case 'cancelled':
            return { Glyph: '⊘', Color: palette.Muted, Label: '已取消' };
        case 'skipped':
            return { Glyph: '◇', Color: palette.Warning, Label: '已跳过' };
        case 'interrupted':
            return { Glyph: '!', Color: palette.Warning, Label: '被中断' };
        case 'running':
            return { Glyph: '●', Color: palette.Accent, Label: '运行中' };
        case 'queued':
            return { Glyph: '◌', Color: palette.Warning, Label: '排队中' };
        default:
            return { Glyph: '·', Color: palette.Muted, Label: status === '' ? '-' : status };
    }
}

export function formatDuration(ms: number): string {
    if (ms < 0) {
        return '0s';
    }
    if (ms < 1000) {
        return `${ms}ms`;
    }
    if (ms < 60_000) {
        return `${Math.round(ms / 1000)}s`;
    }
    if (ms < 3_600_000) {
        return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
    }
    return `${Math.floor(ms / 3_600_000)}h ${Math.floor((ms % 3_600_000) / 60_000)}m`;
}

export function formatClock(now: number): string {
    const date = new Date(now);
    const pad = (value: number): string => String(value).padStart(2, '0');
    return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function shortId(runId: string): string {
    return runId.length > 8 ? runId.slice(0, 8) : runId;
}
