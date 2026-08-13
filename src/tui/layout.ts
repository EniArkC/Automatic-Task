// TUI 尺寸引擎。
//
// 全部是终端尺寸的纯函数，resize 只需重算：帧间不携带状态，任何维度都不会被钳制到超出终端的下限。
import { BIG_TITLE_ROWS } from './banner-font';
import { layout } from './theme';

export type TFrameSize = { Columns: number; Rows: number };

export type TFrameMetrics = {
    Width: number;
    Height: number;
    BannerRows: number;
    FooterRows: number;
    ContentRows: number;
    TwoColumn: boolean;
    BigBanner: boolean;
    TooSmall: boolean;
};

export type TDashboardMetrics = {
    TwoColumn: boolean;
    TaskWidth: number;
    RunWidth: number;
    ListRows: number;
};

export type TTaskRowColumns = { Name: number; ShowVersion: boolean; ShowSchedule: boolean };

export type TRunRowColumns = { Name: number; ShowId: boolean; ShowDuration: boolean };

// Windows 控制台最后一列一写入就换行，所以框架始终留一格余量。
export function frameWidth(columns: number): number {
    return Math.max(1, columns - 1);
}

// 行也留一格：渲染输出达到终端高度时 ink 会退化为整屏清空，表现为持续闪烁。
export function frameHeight(rows: number): number {
    return Math.max(1, rows - 1);
}

// 带框盒子内的可用宽度：每侧各一格外框加一格外边距。
export function boxContentWidth(width: number): number {
    return Math.max(1, width - 4);
}

// overlay 内的可用宽度：只有两格外框。overlay 不能用 paddingX——ink 从不写 padding 格，
// 未写的格子会露出底层内容；边距由行文本自带，保证每格都被写入。
export function overlayInnerWidth(width: number): number {
    return Math.max(1, width - 2);
}

// 含 `rows` 行内容的面板总高：两行边框加面板固定画的标题行。
export function panelOuterHeight(rows: number): number {
    return rows + 3;
}

export function frameMetrics(size: TFrameSize, hintRows: number): TFrameMetrics {
    const width = frameWidth(size.Columns);
    const height = frameHeight(size.Rows);
    // 方块字母标题占三行加上下各一空行，宽度远超拼出的词，两个维度都要够；否则退回单行标题。
    const bigBanner = size.Rows >= layout.BannerBigMinRows && size.Columns >= layout.BannerBigMinColumns;
    // 横幅：两行边框加内容行。
    const bannerRows = bigBanner ? 2 + BIG_TITLE_ROWS + 2 : 3;
    // 页脚：两行边框加提示行。通知不在这里——它是浮动 toast，页脚高度只取决于提示行数。
    const footerRows = 2 + Math.min(Math.max(1, hintRows), layout.MaxHintRows);
    return {
        Width: width,
        Height: height,
        BannerRows: bannerRows,
        FooterRows: footerRows,
        ContentRows: Math.max(1, height - bannerRows - footerRows),
        // 以终端而非框架为准：断点是关于用户所见窗口的判断。
        TwoColumn: size.Columns >= layout.TwoColumnMin,
        BigBanner: bigBanner,
        TooSmall: size.Columns < layout.MinColumns || size.Rows < layout.MinRows,
    };
}

export function dashboardMetrics(metrics: TFrameMetrics): TDashboardMetrics {
    // 整个内容区都是列表，详情面板已移除。
    const listArea = Math.max(1, metrics.ContentRows);
    if (!metrics.TwoColumn) {
        // 堆叠模式：两面板平分剩余高度。
        const each = Math.max(1, Math.floor(listArea / 2) - 3);
        return {
            TwoColumn: false,
            TaskWidth: metrics.Width,
            RunWidth: metrics.Width,
            ListRows: each,
        };
    }
    const taskWidth = Math.max(20, Math.floor((metrics.Width - layout.PanelGap) * layout.TaskPanelRatio));
    return {
        TwoColumn: true,
        TaskWidth: taskWidth,
        // 取精确余量而非再次取整，两个面板加间隔在任何列数下都正好等于框架宽度。
        RunWidth: metrics.Width - layout.PanelGap - taskWidth,
        ListRows: Math.max(1, listArea - 3),
    };
}

export function logRows(metrics: TFrameMetrics): number {
    return Math.max(1, metrics.ContentRows - 3);
}

export function formRows(metrics: TFrameMetrics): number {
    return Math.max(1, metrics.ContentRows - panelOuterHeight(2) - panelOuterHeight(1) - 3);
}

// 全局配置页的表头面板只有一行（任务表单是两行），多出来的一行归字段面板，否则底部会空一行。
export function settingsRows(metrics: TFrameMetrics): number {
    return Math.max(1, metrics.ContentRows - panelOuterHeight(1) - panelOuterHeight(1) - 3);
}

// `Frame` 是卡片浮于其上的框架宽度，不是卡片自身宽度：overlay 必须覆盖所占用行的框架内跨度。
// 见 overlay.tsx 的注释。
export type TOverlayBox = { Width: number; Height: number; Left: number; Top: number; Frame: number };

// overlay 每行必须覆盖的跨度：框架左右边框之间的全部。
export function frameInnerSpan(width: number): { Left: number; Width: number } {
    return { Left: 1, Width: Math.max(1, width - 2) };
}

function clamp(value: number, low: number, high: number): number {
    return Math.max(low, Math.min(high, value));
}

export function overlayBox(metrics: TFrameMetrics): TOverlayBox {
    const width = clamp(Math.round(metrics.Width * 0.7), 24, Math.max(24, Math.min(metrics.Width - 4, 72)));
    const height = clamp(Math.round(metrics.Height * 0.6), 7, Math.max(7, metrics.Height - 4));
    return {
        Width: width,
        Height: height,
        Left: Math.max(0, Math.floor((metrics.Width - width) / 2)),
        Top: Math.max(0, Math.floor((metrics.Height - height) / 2)),
        Frame: metrics.Width,
    };
}

// toast 文本可用的格数：卡片两格边框、三格前导图标边距、一格尾边距。
const TOAST_CHROME = 6;

export function toastContentWidth(metrics: TFrameMetrics): number {
    return Math.max(1, Math.min(layout.ToastMaxWidth, frameInnerSpan(metrics.Width).Width - TOAST_CHROME));
}

// toast 位于内容区右下角、页脚正上方，宽度只容得下文本。
export function toastBox(metrics: TFrameMetrics, contentWidth: number, lines: number): TOverlayBox {
    const span = frameInnerSpan(metrics.Width);
    const width = Math.min(span.Width, contentWidth + TOAST_CHROME);
    const height = Math.min(Math.max(3, metrics.Height), lines + 2);
    return {
        Width: width,
        Height: height,
        Left: Math.max(span.Left, span.Left + span.Width - width),
        Top: Math.max(0, metrics.Height - metrics.FooterRows - height),
        Frame: metrics.Width,
    };
}

// 确认卡两格边框、一格前导边距、一格尾边距。
const CONFIRM_CHROME = 4;

export function confirmContentWidth(metrics: TFrameMetrics): number {
    return Math.max(1, Math.min(layout.ConfirmMaxWidth, frameInnerSpan(metrics.Width).Width - CONFIRM_CHROME));
}

// 确认卡按内容定高：卡片每一行都必须由组件写满，多余的高度会露出底层框架（见 overlay.tsx 的不透明契约）。
export function confirmBox(metrics: TFrameMetrics, contentWidth: number, lines: number): TOverlayBox {
    const span = frameInnerSpan(metrics.Width);
    const width = Math.min(span.Width, contentWidth + CONFIRM_CHROME);
    const height = Math.min(Math.max(3, metrics.Height), lines + 2);
    return {
        Width: width,
        Height: height,
        Left: Math.max(span.Left, span.Left + Math.floor((span.Width - width) / 2)),
        Top: Math.max(0, Math.floor((metrics.Height - height) / 2)),
        Frame: metrics.Width,
    };
}

const MARKER_WIDTH = 1;
const STATUS_WIDTH = 3;
const VERSION_WIDTH = 9;
const SCHEDULE_WIDTH = 12;
const ID_WIDTH = 17;
const DURATION_WIDTH = 8;
// 再往下名称列就短到无法辨认，此时丢弃尾列而不是继续挤压名称。
const NAME_FLOOR = 12;

// 任务行各列宽度，行恰好拥有 `width` 格。宽度缩小时尾列逐个丢弃，名称拿剩余部分：
// 各段总和恒等于 `width`，保证行不溢出面板。
export function taskRowColumns(width: number): TTaskRowColumns {
    const fixed = MARKER_WIDTH + STATUS_WIDTH;
    if (width >= fixed + NAME_FLOOR + VERSION_WIDTH + SCHEDULE_WIDTH) {
        return { Name: width - fixed - VERSION_WIDTH - SCHEDULE_WIDTH, ShowVersion: true, ShowSchedule: true };
    }
    if (width >= fixed + NAME_FLOOR + SCHEDULE_WIDTH) {
        return { Name: width - fixed - SCHEDULE_WIDTH, ShowVersion: false, ShowSchedule: true };
    }
    if (width >= fixed + NAME_FLOOR) {
        return { Name: width - fixed, ShowVersion: false, ShowSchedule: false };
    }
    return { Name: Math.max(1, width - fixed), ShowVersion: false, ShowSchedule: false };
}

// 运行行同理：id 和时长是可丢弃的尾列。
export function runRowColumns(width: number): TRunRowColumns {
    const fixed = MARKER_WIDTH + STATUS_WIDTH;
    if (width >= fixed + NAME_FLOOR + ID_WIDTH + DURATION_WIDTH) {
        return { Name: width - fixed - ID_WIDTH - DURATION_WIDTH, ShowId: true, ShowDuration: true };
    }
    if (width >= fixed + NAME_FLOOR + ID_WIDTH) {
        return { Name: width - fixed - ID_WIDTH, ShowId: true, ShowDuration: false };
    }
    if (width >= fixed + NAME_FLOOR) {
        return { Name: width - fixed, ShowId: false, ShowDuration: false };
    }
    return { Name: Math.max(1, width - fixed), ShowId: false, ShowDuration: false };
}

export const rowColumnWidths = {
    Marker: MARKER_WIDTH,
    Status: STATUS_WIDTH,
    Version: VERSION_WIDTH,
    Schedule: SCHEDULE_WIDTH,
    Id: ID_WIDTH,
    Duration: DURATION_WIDTH,
} as const;
