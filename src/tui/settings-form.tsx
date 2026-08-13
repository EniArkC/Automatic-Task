import type { IpcClient } from '@at/ipc';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { type ReactElement, useEffect, useMemo, useState } from 'react';

import { RenderPanel, RenderScrollBox, RenderSpinner, type TScrollRow } from './components';
import { type TAppConfig, useAppForm } from './hooks';
import { boxContentWidth, settingsRows, type TFrameMetrics } from './layout';
import { clampOffset, displayWidth, padCells, palette } from './theme';

// 全局配置的一个可编辑字段。草稿保存字符串；数字和日志级别在保存时解析。
//
// 分区不占独立行：Section 只在该组第一个字段上非空，渲染到行首的分区栏里。
// 独立分区行会吃掉三行且不可选中，在小终端上是纯浪费。
type TField = { Kind: 'cycle' | 'text'; Section: string; Label: string; Key: keyof TAppConfig } & (
    { Kind: 'cycle'; Options: string[]; Value: string } | { Kind: 'text'; Value: string }
);

const levelOptions = ['debug', 'info', 'warn', 'error'];

function buildFields(config: TAppConfig | undefined): TField[] {
    if (config === undefined) {
        return [];
    }
    return [
        { Kind: 'text', Section: 'Agent', Label: '命令', Key: 'AgentCommand', Value: config.AgentCommand },
        { Kind: 'text', Section: '', Label: '参数', Key: 'AgentArgs', Value: config.AgentArgs.join(',') },
        { Kind: 'text', Section: '', Label: '模型', Key: 'AgentModel', Value: config.AgentModel },
        {
            Kind: 'cycle',
            Section: '日志',
            Label: '级别',
            Key: 'LogLevel',
            Options: levelOptions,
            Value: config.LogLevel,
        },
        {
            Kind: 'text',
            Section: '',
            Label: '单文件大小（MB）',
            Key: 'MaxFileSizeMb',
            Value: String(config.MaxFileSizeMb),
        },
        { Kind: 'text', Section: '', Label: '保留文件数量', Key: 'MaxFiles', Value: String(config.MaxFiles) },
        {
            Kind: 'text',
            Section: '',
            Label: '自动清理日志（天）',
            Key: 'KeepRunsDays',
            Value: String(config.KeepRunsDays),
        },
        {
            Kind: 'text',
            Section: '',
            Label: '自动清理工作区（天）',
            Key: 'KeepWorkspaceDays',
            Value: String(config.KeepWorkspaceDays),
        },
    ];
}

// 分区栏宽度取最长分区名，让所有字段列对齐；无分区名的行留空但保留缩进。
function sectionWidth(fields: TField[]): number {
    let widest = 0;
    for (const field of fields) {
        widest = Math.max(widest, displayWidth(field.Section));
    }
    return widest;
}

// 标签列宽取最长标签，避免长标签被截断；窄终端下再按可用宽度收缩。
function labelWidth(fields: TField[]): number {
    let widest = 0;
    for (const field of fields) {
        widest = Math.max(widest, displayWidth(field.Label));
    }
    return widest;
}

function cycleOption(options: string[], current: string, direction: number): string {
    const index = options.indexOf(current);
    const next = (index < 0 ? 0 : index + direction + options.length) % options.length;
    return options[next] ?? current;
}

function RenderSettingsRow({
    field,
    value,
    selected,
    editing,
    editValue,
    width,
    sectionCells,
    labelCells,
    OnEditChange: onEditChange,
    OnEditSubmit: onEditSubmit,
}: {
    field: TField;
    // 草稿值：编辑或循环后立刻生效，不等保存回写 app.json。
    value: string;
    selected: boolean;
    editing: boolean;
    editValue: string;
    width: number;
    // 行首分区栏宽度（0 表示配置里没有任何分区名）。补齐使各组字段列对齐。
    sectionCells: number;
    // 标签列宽度：取所有标签中最长的一个，各行的值列因此对齐。
    labelCells: number;
    OnEditChange: (next: string) => void;
    OnEditSubmit: () => void;
}): ReactElement {
    const sectionSpan = sectionCells === 0 ? 0 : sectionCells + 1;
    // 值至少留 4 格，否则宁可截断标签——没有值的行看不出配置成什么样。
    const labelWidth = Math.max(6, Math.min(labelCells, width - sectionSpan - 7));
    const valueWidth = Math.max(4, width - sectionSpan - labelWidth - 3);
    return (
        <Box width={width} flexShrink={0}>
            {sectionSpan === 0 ? undefined : (
                <Box width={sectionSpan} flexShrink={0}>
                    <Text bold color={palette.Accent} wrap="truncate">
                        {padCells(field.Section, sectionSpan)}
                    </Text>
                </Box>
            )}
            <Text color={selected ? palette.Selected : palette.Muted}>{selected ? '› ' : '  '}</Text>
            <Box width={labelWidth} flexShrink={0}>
                <Text bold={selected} color={selected ? palette.Selected : undefined} wrap="truncate">
                    {field.Label}
                </Text>
            </Box>
            <Box width={valueWidth} flexShrink={0}>
                {editing ? (
                    <TextInput value={editValue} onChange={onEditChange} onSubmit={onEditSubmit} />
                ) : (
                    <Text color={selected ? palette.Selected : palette.Muted} wrap="truncate">
                        {field.Kind === 'cycle' ? `‹ ${value} ›` : value === '' ? '（空）' : value}
                    </Text>
                )}
            </Box>
        </Box>
    );
}

export function RenderSettingsForm({
    client,
    metrics,
    frame,
    overlayOpen,
    OnClose: onClose,
    OnNotice: onNotice,
}: {
    client: IpcClient;
    metrics: TFrameMetrics;
    frame: number;
    overlayOpen: boolean;
    OnClose: () => void;
    OnNotice: (message: string, kind: 'info' | 'error') => void;
}): ReactElement {
    const width = metrics.Width;
    const form = useAppForm(client);
    const fields = useMemo(() => buildFields(form.Config), [form.Config]);
    const [draft, setDraft] = useState<Record<string, string>>({});
    const [index, setIndex] = useState(0);
    const [offset, setOffset] = useState(0);
    const [editing, setEditing] = useState(false);
    const [editValue, setEditValue] = useState('');
    const [dirty, setDirty] = useState(false);
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        if (!form.Loading && form.Config !== undefined) {
            const next: Record<string, string> = {};
            for (const field of buildFields(form.Config)) {
                next[field.Key] = field.Value;
            }
            setDraft(next);
            setDirty(false);
        }
    }, [form.Loading, form.Config]);

    // 字段面板与任务表单一样总是填满预留空间，页脚保持对齐、窗口随终端伸缩；
    // 字段溢出时由滚动盒补白并滚动。
    const rows = Math.max(1, settingsRows(metrics));
    const boundedIndex = Math.min(index, Math.max(0, fields.length - 1));
    const visibleOffset = clampOffset(fields.length, rows, boundedIndex, offset);
    const current = fields[boundedIndex];

    const save = async (): Promise<void> => {
        setSaving(true);
        try {
            const intOf = (
                key: 'MaxFileSizeMb' | 'MaxFiles' | 'KeepRunsDays' | 'KeepWorkspaceDays',
                fallback: number,
            ): number => {
                const parsed = Number.parseInt(draft[key] ?? '', 10);
                return Number.isNaN(parsed) ? fallback : parsed;
            };
            const args = (draft.AgentArgs ?? '')
                .split(',')
                .map((item) => item.trim())
                .filter((item) => item !== '');
            await client.SendRequest('app.set', {
                patch: {
                    agent: {
                        command: draft.AgentCommand ?? 'pi',
                        args,
                        model: draft.AgentModel ?? '',
                    },
                    logging: {
                        level: draft.LogLevel ?? 'info',
                        maxFileSizeMb: intOf('MaxFileSizeMb', 10),
                        maxFiles: intOf('MaxFiles', 5),
                    },
                    cleanup: {
                        keepRunsDays: intOf('KeepRunsDays', 30),
                        keepWorkspaceDays: intOf('KeepWorkspaceDays', 7),
                    },
                },
            });
            setDirty(false);
            form.Reload();
            onNotice('已保存全局配置', 'info');
        } catch (error) {
            onNotice(error instanceof Error ? error.message : String(error), 'error');
        } finally {
            setSaving(false);
        }
    };

    useInput(
        (input, key) => {
            if (editing) {
                if (key.escape) {
                    setEditing(false);
                }
                return;
            }
            if (key.escape || input === 'q') {
                onClose();
                return;
            }
            if (key.upArrow) {
                setIndex((value) => {
                    const next = Math.max(0, value - 1);
                    setOffset(clampOffset(fields.length, rows, next, visibleOffset));
                    return next;
                });
                return;
            }
            if (key.downArrow) {
                setIndex((value) => {
                    const next = Math.min(fields.length - 1, value + 1);
                    setOffset(clampOffset(fields.length, rows, next, visibleOffset));
                    return next;
                });
                return;
            }
            if (current === undefined) {
                return;
            }
            if (key.leftArrow || key.rightArrow) {
                if (current.Kind === 'cycle') {
                    const next = cycleOption(
                        current.Options,
                        draft[current.Key] ?? current.Value,
                        key.rightArrow ? 1 : -1,
                    );
                    setDraft((previous) => ({ ...previous, [current.Key]: next }));
                    setDirty(true);
                }
                return;
            }
            if (key.return) {
                if (current.Kind === 'cycle') {
                    const next = cycleOption(current.Options, draft[current.Key] ?? current.Value, 1);
                    setDraft((previous) => ({ ...previous, [current.Key]: next }));
                    setDirty(true);
                } else {
                    setEditValue(draft[current.Key] ?? '');
                    setEditing(true);
                }
                return;
            }
            if (input === 's') {
                void save();
                return;
            }
            if (input === 'r') {
                form.Reload();
            }
        },
        // 子窗口打开时独占键盘；没有这道闸门，表单会在它背后继续消费同样的按键。
        { isActive: !overlayOpen },
    );

    const inner = boxContentWidth(width);
    const sectionCells = sectionWidth(fields);
    const labelCells = labelWidth(fields);
    const items: TScrollRow[] = fields.slice(visibleOffset, visibleOffset + rows).map((field, position) => {
        const absolute = visibleOffset + position;
        return {
            Key: field.Key,
            Node: (
                <RenderSettingsRow
                    field={field}
                    value={draft[field.Key] ?? field.Value}
                    selected={absolute === boundedIndex}
                    editing={editing && absolute === boundedIndex}
                    editValue={editValue}
                    width={inner - 1}
                    sectionCells={sectionCells}
                    labelCells={labelCells}
                    OnEditChange={setEditValue}
                    OnEditSubmit={() => {
                        const key = field.Key;
                        setDraft((previous) => ({ ...previous, [key]: editValue }));
                        setDirty(true);
                        setEditing(false);
                    }}
                />
            ),
        };
    });

    const state = form.Loading ? '加载中…' : saving ? '保存中…' : dirty ? '● 未保存' : '已同步';

    return (
        <Box flexDirection="column" width={width} flexShrink={0}>
            <RenderPanel title="全局配置" hint={state} width={width} rows={1} focused={!overlayOpen}>
                <Box width={inner} flexShrink={0}>
                    {saving || form.Loading ? <RenderSpinner frame={frame} /> : <Text color={palette.Muted}>·</Text>}
                    <Box width={Math.max(1, inner - 1)} flexShrink={0}>
                        <Text color={palette.Muted} wrap="truncate">
                            {`app.json · ${current?.Label ?? ''}${editing ? ' · 回车确认 · Esc 取消' : ''}`}
                        </Text>
                    </Box>
                </Box>
            </RenderPanel>
            <RenderPanel
                title="配置项"
                hint={`${String(boundedIndex + 1)}/${String(fields.length)}`}
                width={width}
                rows={rows}
                focused={!overlayOpen}
            >
                <RenderScrollBox
                    rows={rows}
                    width={inner}
                    total={fields.length}
                    offset={visibleOffset}
                    items={items}
                    empty={form.Error ?? '没有可配置项'}
                />
            </RenderPanel>
            <RenderPanel title="说明" width={width} rows={1}>
                <Box width={inner} flexShrink={0}>
                    <Text color={palette.Muted} wrap="truncate">
                        {' ↑↓ 选择 · ↵ 编辑/循环 · ←→ 切换选项 · s 保存 · r 刷新 · Esc 返回'}
                    </Text>
                </Box>
            </RenderPanel>
        </Box>
    );
}
