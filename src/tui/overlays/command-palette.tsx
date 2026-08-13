import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { type ReactElement, useMemo, useState } from 'react';

import { fuzzyRank } from '../fuzzy';
import { overlayInnerWidth, type TOverlayBox } from '../layout';
import { RenderOverlay, RenderOverlayBlank, RenderOverlayList, RenderOverlayRow } from '../overlay';
import { clampOffset, displayWidth, padCells, palette, truncateCells } from '../theme';

export type TCommand = { Id: string; Label: string; Hint?: string; Run: () => void };

// 高亮命中的码点。Positions 指向 Array.from(text) 的下标，这正是 fuzzy.ts 用码点而非 UTF-16 单元的原因。
function RenderMatch({
    text,
    positions,
    selected,
}: {
    text: string;
    positions: number[];
    selected: boolean;
}): ReactElement {
    const chars = Array.from(text);
    const hit = new Set(positions);
    return (
        <Text wrap="truncate">
            {chars.map((char, index) => (
                <Text
                    key={`${char}-${String(index)}`}
                    bold={hit.has(index)}
                    color={hit.has(index) ? palette.Selected : selected ? palette.TitleGlow : undefined}
                >
                    {char}
                </Text>
            ))}
        </Text>
    );
}

export function RenderCommandPalette({
    box,
    commands,
    OnCancel: onCancel,
}: {
    box: TOverlayBox;
    commands: TCommand[];
    OnCancel: () => void;
}): ReactElement {
    const inner = overlayInnerWidth(box.Width);
    // 两行边框加标题行、查询行、查询行下的空行、页脚行。
    const visible = Math.max(1, box.Height - 6);
    const [query, setQuery] = useState('');
    const [index, setIndex] = useState(0);

    const results = useMemo(
        () => fuzzyRank(query, commands, (command) => `${command.Label} ${command.Id}`),
        [commands, query],
    );
    const bounded = Math.min(index, Math.max(0, results.length - 1));
    const offset = clampOffset(results.length, visible, bounded, 0);

    // TextInput 会消费可打印输入，这个处理器只能认领导航键——另外两个 overlay 没有这种分工。
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
            setIndex(Math.min(results.length - 1, bounded + 1));
            return;
        }
        if (key.return) {
            results[bounded]?.Item.Run();
        }
    });

    // 提示符占三格、光标占一格，其余补齐让查询行像卡片其他行一样不透明。
    const queryTail = Math.max(0, inner - 4 - displayWidth(query));
    const rows = results.slice(offset, offset + visible).map((result, position) => {
        const absolute = offset + position;
        const selected = absolute === bounded;
        const hint = result.Item.Hint ?? '';
        const hintWidth = Math.min(displayWidth(hint), Math.max(0, inner - 12));
        const labelWidth = Math.max(1, inner - hintWidth);
        // 标签为高亮要逐字符渲染，不能走 padCells；标签格改为定宽，hint 补齐该行剩余部分。
        const label = padCells(` ${result.Item.Label}`, labelWidth);
        return (
            <Box key={result.Item.Id} width={inner} flexShrink={0}>
                <Box width={labelWidth} flexShrink={0}>
                    <Text backgroundColor={selected ? palette.SelectionBg : undefined}>
                        <RenderMatch
                            text={label}
                            // +1 补偿上面加的前导空格。
                            positions={result.Match.Positions.map((value) => value + 1)}
                            selected={selected}
                        />
                    </Text>
                </Box>
                <Text
                    backgroundColor={selected ? palette.SelectionBg : undefined}
                    color={palette.Muted}
                    wrap="truncate"
                >
                    {padCells(truncateCells(hint, hintWidth), hintWidth)}
                </Text>
            </Box>
        );
    });

    return (
        <RenderOverlay box={box} title="命令面板">
            <Box width={inner} flexShrink={0}>
                <Text color={palette.Selected}>{' ❯ '}</Text>
                <TextInput
                    value={query}
                    onChange={(next) => {
                        setQuery(next);
                        setIndex(0);
                    }}
                />
                <Text>{padCells('', queryTail)}</Text>
            </Box>
            {/* 查询行与结果列表之间空一行，让输入区和候选项分开。空行同样要写满内宽保持不透明。 */}
            <RenderOverlayBlank width={inner} />
            <RenderOverlayList width={inner} visible={visible} rows={rows} />
            <RenderOverlayRow
                text=" ↑↓ 选择 · ↵ 执行 · Esc 取消"
                width={inner}
                selected={false}
                color={palette.Muted}
            />
        </RenderOverlay>
    );
}
