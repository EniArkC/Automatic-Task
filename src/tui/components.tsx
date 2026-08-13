import { Box, Text, useStdout } from 'ink';
import { type ReactElement, type ReactNode, useEffect, useState } from 'react';

import { BIG_TITLE_ROWS, BIG_TITLE_WIDTH, bigTitleLetters } from './banner-font';
import { boxContentWidth, type TFrameSize } from './layout';
import { displayWidth, palette, scrollColumn, spinnerFrames } from './theme';

// 框架铺满终端，两个维度都要跟踪。
export function useTerminalSize(): TFrameSize {
    const { stdout } = useStdout();
    const [size, setSize] = useState<TFrameSize>({ Columns: stdout.columns || 100, Rows: stdout.rows || 30 });
    useEffect(() => {
        const onResize = (): void => {
            const columns = stdout.columns || 100;
            const rows = stdout.rows || 30;
            // Windows Terminal 拖拽窗口边缘会爆发式触发 resize 事件，多数尺寸没变。
            // 返回旧对象让 React 跳过重渲染。
            setSize((previous) =>
                previous.Columns === columns && previous.Rows === rows ? previous : { Columns: columns, Rows: rows },
            );
        };
        stdout.on('resize', onResize);
        return () => {
            stdout.off('resize', onResize);
        };
    }, [stdout]);
    return size;
}

// 定外尺寸的带框盒子。overflow="hidden" 拦垂直溢出（否则会穿透底边框）；水平溢出靠各叶子 Text 的 wrap="truncate"。
function RenderShell({
    width,
    rows,
    borderColor,
    children,
}: {
    width: number;
    rows: number;
    borderColor: string;
    children: ReactNode;
}): ReactElement {
    return (
        <Box
            width={width}
            height={rows + 2}
            borderStyle="round"
            borderColor={borderColor}
            paddingX={1}
            flexDirection="column"
            flexShrink={0}
            overflow="hidden"
        >
            {children}
        </Box>
    );
}

const TITLE = 'Automatic-Task';
// 纯 ASCII，按码元索引与按字符索引等价。
const titleChars = Array.from({ length: TITLE.length }, (unused, index) => TITLE.charAt(index));

// 波浪驱动每字母明暗：相邻字母相位错开，标题上同时移动两三处波峰而非一个亮点，更显灵动。
// 波约每 3 帧移动一个字母，在 110ms 动画时钟下保持平滑。
const grayLevels = [
    { Color: 'whiteBright', Bold: true },
    { Color: 'white', Bold: true },
    { Color: 'white', Bold: false },
    { Color: 'gray', Bold: false },
] as const;

function waveColor(index: number, frame: number): { Color: string; Bold: boolean } {
    const phase = Math.sin(index * 0.9 + frame * 0.35);
    const level = Math.round(((phase + 1) / 2) * (grayLevels.length - 1));
    return grayLevels[Math.max(0, Math.min(grayLevels.length - 1, level))] ?? grayLevels[0];
}

// 波浪扫过标题。每个字符是独立 Text 节点，ink 拼接兄弟节点无分隔符，标题在终端里仍读作一个词。
function RenderShimmerTitle({ frame }: { frame: number }): ReactElement {
    return (
        <Text wrap="truncate">
            {titleChars.map((char, index) => {
                const style = waveColor(index, frame);
                return (
                    <Text key={`${char}-${String(index)}`} color={style.Color} bold={style.Bold}>
                        {char}
                    </Text>
                );
            })}
        </Text>
    );
}

// 标题下方的脉冲条，宽度取框架剩余空间。
function RenderPulseBar({ frame, width }: { frame: number; width: number }): ReactElement {
    // 宽度过小时脉冲只剩噪点，看不出运动。
    if (width < 8) {
        return <Text />;
    }
    const period = width + 12;
    const head = frame % period;
    const cells = Array.from({ length: width }, (unused, index) => {
        const distance = head - index;
        if (distance === 0) {
            return '━';
        }
        if (distance > 0 && distance <= 3) {
            return '─';
        }
        return '╌';
    });
    return (
        <Text color={palette.TitleDim} dimColor wrap="truncate">
            {cells.join('')}
        </Text>
    );
}

export type TConnectionBadge = { Glyph: string; Color: string; Label: string };

// 标题行右侧：脉冲、连接徽标、时钟。两种横幅模式共用；大字模式下位于方块字母中间行，与标题读作一行。
function RenderBannerTail({
    frame,
    barWidth,
    badge,
    clock,
}: {
    frame: number;
    barWidth: number;
    badge: TConnectionBadge;
    clock: string;
}): ReactElement {
    return (
        <>
            <Text color={palette.Muted}>{'  '}</Text>
            <RenderPulseBar frame={frame} width={barWidth} />
            <Box flexGrow={1} />
            <Text color={palette.Muted}>{'  '}</Text>
            <Text color={badge.Color} wrap="truncate">
                {`${badge.Glyph} ${badge.Label}`}
            </Text>
            <Text color={palette.Muted} wrap="truncate">
                {`  ${clock}`}
            </Text>
        </>
    );
}

// 方块字母标题的一行，按字母而非按格波动：波逐字母前进，这种尺寸下比逐列扫过更耐看，节点数也更少。
function RenderBigTitleRow({ frame, row }: { frame: number; row: number }): ReactElement {
    return (
        <Text wrap="truncate">
            {bigTitleLetters.map((letter, index) => {
                const style = waveColor(index, frame);
                return (
                    <Text key={`big-${String(row)}-${String(index)}`} color={style.Color} bold={style.Bold}>
                        {letter.Rows[row]}
                    </Text>
                );
            })}
        </Text>
    );
}

export function RenderBanner({
    frame,
    width,
    badge,
    clock,
    big,
}: {
    frame: number;
    width: number;
    badge: TConnectionBadge;
    clock: string;
    big: boolean;
}): ReactElement {
    const inner = boxContentWidth(width);
    const tailWidth = 2 + 2 + displayWidth(`${badge.Glyph} ${badge.Label}`) + displayWidth(`  ${clock}`);
    if (!big) {
        const barWidth = Math.max(0, inner - displayWidth(TITLE) - tailWidth);
        return (
            <RenderShell width={width} rows={1} borderColor={palette.Border}>
                <Box width={inner} flexShrink={0}>
                    <RenderShimmerTitle frame={frame} />
                    <RenderBannerTail frame={frame} barWidth={barWidth} badge={badge} clock={clock} />
                </Box>
            </RenderShell>
        );
    }
    const barWidth = Math.max(0, inner - BIG_TITLE_WIDTH - tailWidth);
    // 上下各留一行空白，方块在框内居中。
    return (
        <RenderShell width={width} rows={BIG_TITLE_ROWS + 2} borderColor={palette.Border}>
            <Box width={inner} flexShrink={0}>
                <Text> </Text>
            </Box>
            {[0, 1, 2].map((row) => (
                <Box key={`big-row-${String(row)}`} width={inner} flexShrink={0}>
                    <RenderBigTitleRow frame={frame} row={row} />
                    {/* 尾部搭在中行，相对标题垂直居中，如同大字字体旁的位置。 */}
                    {row === 1 ? (
                        <RenderBannerTail frame={frame} barWidth={barWidth} badge={badge} clock={clock} />
                    ) : undefined}
                </Box>
            ))}
            <Box width={inner} flexShrink={0}>
                <Text> </Text>
            </Box>
        </RenderShell>
    );
}

// 定内容尺寸的带框盒子。内部不得增长：宽高由调用方决定，面板照办。
export function RenderPanel({
    title,
    hint,
    width,
    rows,
    focused,
    children,
}: {
    title: string;
    hint?: string;
    width: number;
    rows: number;
    focused?: boolean;
    children: ReactNode;
}): ReactElement {
    const inner = boxContentWidth(width);
    return (
        <RenderShell
            width={width}
            rows={rows + 1}
            borderColor={focused === true ? palette.BorderFocus : palette.Border}
        >
            <Box width={inner} flexShrink={0} justifyContent="space-between">
                <Text bold color={focused === true ? palette.Selected : palette.Muted} wrap="truncate">
                    {title}
                </Text>
                {hint === undefined ? undefined : (
                    <Text color={palette.Muted} wrap="truncate">
                        {hint}
                    </Text>
                )}
            </Box>
            {children}
        </RenderShell>
    );
}

export type TScrollRow = { Key: string; Node: ReactElement };

// 恰好渲染 `rows` 行加一列滚动条，空白补齐使盒子高度不随数据变化。
export function RenderScrollBox({
    rows,
    width,
    total,
    offset,
    items,
    empty,
}: {
    rows: number;
    width: number;
    total: number;
    offset: number;
    items: TScrollRow[];
    empty: string;
}): ReactElement {
    const bar = scrollColumn(total, rows, offset);
    const lineWidth = Math.max(1, width - 1);
    const lines: TScrollRow[] = [...items];
    while (lines.length < rows) {
        lines.push({ Key: `blank-${String(lines.length)}`, Node: <Text> </Text> });
    }
    return (
        <Box flexDirection="column" width={width} height={rows} flexShrink={0}>
            {lines.slice(0, rows).map((row, index) => (
                <Box key={row.Key} width={width} flexShrink={0}>
                    <Box width={lineWidth} flexShrink={0}>
                        {total === 0 && index === 0 ? (
                            <Text color={palette.Muted} wrap="truncate">
                                {empty}
                            </Text>
                        ) : (
                            row.Node
                        )}
                    </Box>
                    <Text color={palette.Muted}>{bar[index] ?? ' '}</Text>
                </Box>
            ))}
        </Box>
    );
}

export function RenderSpinner({ frame, color }: { frame: number; color?: string }): ReactElement {
    return <Text color={color ?? palette.Accent}>{spinnerFrames[frame % spinnerFrames.length]}</Text>;
}

export type TKeyHint = { Key: string; Label: string };

const HINT_SEPARATOR = ' · ';

function hintWidth(hint: TKeyHint): number {
    return displayWidth(hint.Key) + 1 + displayWidth(hint.Label);
}

// 贪心把按键提示装进能容纳的行，避免终端折行把标签折到下一行。`maxRows` 内放不下的丢弃并标注，
// 这让页脚高度可预测，渲染前就能从框架扣除。
function packHints(hints: TKeyHint[], width: number, maxRows: number): TKeyHint[][] {
    const rows: TKeyHint[][] = [];
    let current: TKeyHint[] = [];
    let used = 0;
    for (const hint of hints) {
        const size = hintWidth(hint) + (current.length === 0 ? 0 : displayWidth(HINT_SEPARATOR));
        if (current.length > 0 && used + size > width) {
            rows.push(current);
            if (rows.length >= Math.max(1, maxRows)) {
                rows[rows.length - 1]?.push({ Key: '…', Label: '' });
                return rows;
            }
            current = [];
            used = 0;
        }
        current.push(hint);
        used += current.length === 1 ? hintWidth(hint) : size;
    }
    if (current.length > 0) {
        rows.push(current);
    }
    return rows.length === 0 ? [[]] : rows;
}

export function countHintRows(hints: TKeyHint[], width: number, maxRows: number): number {
    return packHints(hints, width, maxRows).length;
}

// 每行独立居中。packHints 已保证行宽不超过 width，所以 justifyContent 不会把内容挤出左边界。
function RenderHintRow({ hints, width }: { hints: TKeyHint[]; width: number }): ReactElement {
    return (
        <Box width={width} flexShrink={0} justifyContent="center">
            <Text wrap="truncate">
                {hints.map((hint, index) => (
                    <Text key={hint.Key}>
                        {index === 0 ? '' : <Text color={palette.Muted}>{HINT_SEPARATOR}</Text>}
                        <Text bold color={palette.Selected}>
                            {hint.Key}
                        </Text>
                        <Text color={palette.Muted}>{hint.Label === '' ? '' : ` ${hint.Label}`}</Text>
                    </Text>
                ))}
            </Text>
        </Box>
    );
}

// 只放按键提示。通知改为自动消失的 toast（见 RenderToast），不再永久占一行。
export function RenderFooter({
    width,
    hints,
    maxRows,
}: {
    width: number;
    hints: TKeyHint[];
    maxRows: number;
}): ReactElement {
    const inner = boxContentWidth(width);
    const rows = packHints(hints, inner, maxRows);
    return (
        <RenderShell width={width} rows={rows.length} borderColor={palette.Border}>
            {rows.map((row, index) => (
                <RenderHintRow key={`hints-${String(index)}`} hints={row} width={inner} />
            ))}
        </RenderShell>
    );
}

// 终端放不下界面时以此替代。无边框：放不下的框架本身就是错乱布局的来源，不能再给它加边框。
export function RenderTooSmall({ columns, rows }: { columns: number; rows: number }): ReactElement {
    return (
        <Box flexDirection="column" width={Math.max(1, columns - 1)}>
            <Text color={palette.Warning} wrap="truncate">
                窗口过小
            </Text>
            <Text color={palette.Muted} wrap="truncate">
                {`需要至少 40×12，当前 ${String(columns)}×${String(rows)}`}
            </Text>
            <Text color={palette.Muted} wrap="truncate">
                q 退出
            </Text>
        </Box>
    );
}

// 所有视图共用外壳。overlay 最后渲染，盖在下方内容之上。
export function RenderFrame({
    width,
    height,
    overlay,
    children,
}: {
    width: number;
    height: number;
    overlay?: ReactNode;
    children: ReactNode;
}): ReactElement {
    return (
        <Box flexDirection="column" width={width} height={height} overflow="hidden">
            {children}
            {overlay}
        </Box>
    );
}
