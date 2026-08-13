import { Box, Text } from 'ink';
import { type ReactElement, type ReactNode, useMemo } from 'react';

import { frameInnerSpan, overlayInnerWidth, type TOverlayBox } from './layout';
import { clampOffset, displayWidth, padCells, palette } from './theme';

// 子窗口宿主。
//
// ink 没有合成层：绝对定位盒子只覆盖它实际写到的格子，backgroundColor 也只按已写字符应用。
// 所以 overlay 必须每一行都写满内宽——padCells 和 RenderOverlayRow 由此而来，强制执行而不是信任调用方。
// 这同样排除了 paddingX：ink 保留 padding 格但从不写入，带 padding 的 overlay 两侧会露出底层内容。
//
// 只盖住卡片自己的格子还不够，因为 CJK 字形占两格。若底层框架恰有一个字形跨在卡片左缘，
// 卡片覆盖其第二格而留下第一格，这个孤字仍占两列——整行右移一格，边框对不齐。哪个字形
// 落在边缘取决于终端宽度，随终端宽度变化时隐时现。所以 overlay 覆盖所跨行的全部内部格，从第 1 列
// 到倒数第 2 列。这两条边界构造上必然安全：第 0 列和最后一列总是盒子的单格边框，且 ink 会
// 截断盒子内容，不会有字形跨边框。框架只在卡片上下方透出。

// 一连串空白但不透明的行，用来盖住卡片两侧的框架。
function RenderBackdrop({ width, height }: { width: number; height: number }): ReactElement {
    if (width <= 0) {
        return <Box width={0} flexShrink={0} />;
    }
    const rows = Array.from({ length: height }, (unused, index) => index);
    return (
        <Box flexDirection="column" width={width} height={height} flexShrink={0}>
            {rows.map((row) => (
                <Text key={`backdrop-${String(row)}`}>{padCells('', width)}</Text>
            ))}
        </Box>
    );
}

export function RenderOverlay({
    box,
    title,
    hint,
    children,
}: {
    box: TOverlayBox;
    title: string;
    hint?: string;
    children: ReactNode;
}): ReactElement {
    const inner = overlayInnerWidth(box.Width);
    const hintWidth = hint === undefined ? 0 : displayWidth(hint) + 1;
    const span = frameInnerSpan(box.Frame);
    const left = Math.max(0, box.Left - span.Left);
    const right = Math.max(0, span.Width - left - box.Width);
    // ink 只提供 `position` 没有 left/top，偏移用绝对定位盒子的 margin 表达。
    return (
        <Box
            position="absolute"
            marginLeft={span.Left}
            marginTop={box.Top}
            width={span.Width}
            height={box.Height}
            flexDirection="row"
            flexShrink={0}
            overflow="hidden"
        >
            <RenderBackdrop width={left} height={box.Height} />
            <Box
                width={box.Width}
                height={box.Height}
                borderStyle="round"
                borderColor={palette.BorderFocus}
                flexDirection="column"
                flexShrink={0}
                overflow="hidden"
            >
                <Box width={inner} flexShrink={0}>
                    {/* 不用 justifyContent="space-between"：它留出的空隙不会被写入，未写的格子是透明的。改为给标题补 padding，整行被覆盖。 */}
                    <Text bold color={palette.Selected} wrap="truncate">
                        {padCells(` ${title}`, Math.max(1, inner - hintWidth))}
                    </Text>
                    {hint === undefined ? undefined : (
                        <Text color={palette.Muted} wrap="truncate">
                            {padCells(hint, hintWidth)}
                        </Text>
                    )}
                </Box>
                {children}
            </Box>
            <RenderBackdrop width={right} height={box.Height} />
        </Box>
    );
}

// overlay 列表的一行。文本补齐到整个内宽使行不透明，选中条横跨整张卡片而不是只贴住标签。
export function RenderOverlayRow({
    text,
    width,
    selected,
    color,
    dim,
}: {
    text: string;
    width: number;
    selected: boolean;
    color?: string;
    dim?: boolean;
}): ReactElement {
    const padded = padCells(text, width);
    if (selected) {
        return (
            <Text backgroundColor={palette.SelectionBg} color={palette.TitleGlow} bold wrap="truncate">
                {padded}
            </Text>
        );
    }
    return (
        <Text color={color} dimColor={dim} wrap="truncate">
            {padded}
        </Text>
    );
}

// 空白但不透明的行，填充 overlay 拥有但没有内容的区域。
export function RenderOverlayBlank({ width }: { width: number }): ReactElement {
    return <Text>{padCells('', width)}</Text>;
}

// overlay 列表的滚动偏移，派生而非存储：选择下标是子窗口唯一需要保存的状态。
export function useOverlayRows(total: number, visible: number, index: number): number {
    return useMemo(() => clampOffset(total, visible, index, 0), [total, visible, index]);
}

// 从 `offset` 起渲染 `visible` 行，尾部补齐保持卡片尺寸和不透明性。
export function RenderOverlayList({
    width,
    visible,
    rows,
}: {
    width: number;
    visible: number;
    rows: ReactElement[];
}): ReactElement {
    const filled: ReactNode[] = [...rows.slice(0, visible)];
    for (let index = filled.length; index < visible; index += 1) {
        filled.push(<RenderOverlayBlank key={`overlay-blank-${String(index)}`} width={width} />);
    }
    return (
        <Box flexDirection="column" width={width} height={visible} flexShrink={0}>
            {filled}
        </Box>
    );
}

// 通知 toast：右下角的小卡片，位于页脚上方。
//
// 它遵守与子窗口相同的不透明契约，也面临同样的跨字形风险——所以尽管卡片贴右缘，
// 它仍横跨框架整个内宽。第 1 列和倒数第 2 列是卡片唯一能起止而不劈开 CJK 字形的边界。
export function RenderToast({
    box,
    lines,
    color,
    glyph,
}: {
    box: TOverlayBox;
    lines: string[];
    color: string;
    glyph: string;
}): ReactElement {
    const inner = overlayInnerWidth(box.Width);
    const span = frameInnerSpan(box.Frame);
    const left = Math.max(0, box.Left - span.Left);
    return (
        <Box
            position="absolute"
            marginLeft={span.Left}
            marginTop={box.Top}
            width={span.Width}
            height={box.Height}
            flexDirection="row"
            flexShrink={0}
            overflow="hidden"
        >
            <RenderBackdrop width={left} height={box.Height} />
            <Box
                width={box.Width}
                height={box.Height}
                borderStyle="round"
                borderColor={color}
                flexDirection="column"
                flexShrink={0}
                overflow="hidden"
            >
                {lines.map((line, index) => (
                    <Text key={`toast-${String(index)}`} color={color} wrap="truncate">
                        {padCells(index === 0 ? ` ${glyph} ${line}` : `   ${line}`, inner)}
                    </Text>
                ))}
            </Box>
            <RenderBackdrop width={Math.max(0, span.Width - left - box.Width)} height={box.Height} />
        </Box>
    );
}

// 小型模态确认卡。卡片高度由调用方按行数算出（见 layout.confirmBox），这里把每一行都写满：
// 卡片内任何没写到的格子都会露出底层框架——这正是 overlay 不透明契约的要求。
// 按键由 app.tsx 的确认处理器独占，卡片本身不接管键盘。
export function RenderConfirm({
    box,
    title,
    lines,
    footer,
}: {
    box: TOverlayBox;
    title: string;
    lines: string[];
    footer: string;
}): ReactElement {
    const inner = overlayInnerWidth(box.Width);
    const span = frameInnerSpan(box.Frame);
    const left = Math.max(0, box.Left - span.Left);
    // 边框各占一行，其余全部由下面的行填满。
    const bodyRows = Math.max(1, box.Height - 2);
    const rows: ReactElement[] = [
        <Text key="confirm-title" bold color={palette.Warning} wrap="truncate">
            {padCells(` ${title}`, inner)}
        </Text>,
        ...lines.map((line, index) => (
            <Text key={`confirm-line-${String(index)}`} color={palette.Muted} wrap="truncate">
                {padCells(` ${line}`, inner)}
            </Text>
        )),
        <Text key="confirm-footer" wrap="truncate">
            {padCells(` ${footer}`, inner)}
        </Text>,
    ];
    // 少于卡片高度时补白，多于时截断：两种情况下写入的行数都恰好等于卡片内高。
    for (let index = rows.length; index < bodyRows; index += 1) {
        rows.push(<RenderOverlayBlank key={`confirm-blank-${String(index)}`} width={inner} />);
    }
    return (
        <Box
            position="absolute"
            marginLeft={span.Left}
            marginTop={box.Top}
            width={span.Width}
            height={box.Height}
            flexDirection="row"
            flexShrink={0}
            overflow="hidden"
        >
            <RenderBackdrop width={left} height={box.Height} />
            <Box
                width={box.Width}
                height={box.Height}
                borderStyle="round"
                borderColor={palette.Warning}
                flexDirection="column"
                flexShrink={0}
                overflow="hidden"
            >
                {rows.slice(0, bodyRows)}
            </Box>
            <RenderBackdrop width={Math.max(0, span.Width - left - box.Width)} height={box.Height} />
        </Box>
    );
}
