import { useInput } from 'ink';
import { type ReactElement } from 'react';

import { overlayInnerWidth, type TOverlayBox } from '../layout';
import { RenderOverlay, RenderOverlayList, RenderOverlayRow, useOverlayRows } from '../overlay';
import { palette } from '../theme';

export type TOption = { Value: string; Label: string; Hint?: string };

// 从列表里选一个值。三个子窗口中最简单的一个，也是让选项较多的 select 字段可用的关键：
// 用方向键循环六个值不可行。
export function RenderOptionSelect({
    box,
    title,
    options,
    index,
    OnMove: onMove,
    OnPick: onPick,
    OnCancel: onCancel,
}: {
    box: TOverlayBox;
    title: string;
    options: TOption[];
    index: number;
    OnMove: (next: number) => void;
    OnPick: (value: string) => void;
    OnCancel: () => void;
}): ReactElement {
    const inner = overlayInnerWidth(box.Width);
    // 两行边框加标题行、页脚行。
    const visible = Math.max(1, box.Height - 4);
    const offset = useOverlayRows(options.length, visible, index);

    useInput((input, key) => {
        if (key.escape) {
            onCancel();
            return;
        }
        if (key.upArrow) {
            onMove(Math.max(0, index - 1));
            return;
        }
        if (key.downArrow) {
            onMove(Math.min(options.length - 1, index + 1));
            return;
        }
        if (key.return) {
            const picked = options[index];
            if (picked !== undefined) {
                onPick(picked.Value);
            }
            return;
        }
        // 数字快捷键直接选中前九项。
        const digit = Number.parseInt(input, 10);
        if (!Number.isNaN(digit) && digit >= 1 && digit <= 9 && digit <= options.length) {
            const picked = options[digit - 1];
            if (picked !== undefined) {
                onPick(picked.Value);
            }
        }
    });

    const rows = options.slice(offset, offset + visible).map((option, position) => {
        const absolute = offset + position;
        const number = absolute < 9 ? `${String(absolute + 1)}.` : '  ';
        const hint = option.Hint === undefined ? '' : `  ${option.Hint}`;
        return (
            <RenderOverlayRow
                key={option.Value}
                text={` ${number} ${option.Label}${hint}`}
                width={inner}
                selected={absolute === index}
            />
        );
    });

    return (
        <RenderOverlay box={box} title={title} hint={`${String(index + 1)}/${String(options.length)}`}>
            <RenderOverlayList width={inner} visible={visible} rows={rows} />
            <RenderOverlayRow
                text=" ↑↓ 选择 · 1-9 直选 · ↵ 确定 · Esc 取消"
                width={inner}
                selected={false}
                color={palette.Muted}
            />
        </RenderOverlay>
    );
}
