import type { IpcClient } from '@at/ipc';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { type ReactElement, useEffect, useMemo, useState } from 'react';

import { RenderPanel, RenderScrollBox, RenderSpinner, type TScrollRow } from './components';
import { type TTaskDetail, type TVariableSchemaRow, useTaskForm } from './hooks';
import { boxContentWidth, formRows, type TFrameMetrics } from './layout';
import type { TOption } from './overlays/option-select';
import { clampOffset, palette } from './theme';

// 表单行：先是任务级设置，然后包声明的每个 `@var` 一行。
type TFieldKind = 'schedule' | 'overlap' | 'variable';

type TField = {
    Kind: TFieldKind;
    Name: string;
    Label: string;
    Type: string;
    Required: boolean;
    Options?: string[];
    Hint: string;
};

const overlapOptions = ['skip', 'queue', 'parallel'];

const overlapHints: Record<string, string> = {
    skip: '上一次还在跑就跳过本次',
    queue: '排队等上一次结束',
    parallel: '同时运行多个实例',
};

const typeLabel: Record<string, string> = {
    string: '文本',
    text: '长文本',
    password: '密码',
    number: '数字',
    boolean: '开关',
    path: '路径',
    select: '选项',
};

// `@var` 行尾注释写的说明优先——那是作者对这个参数的解释，比类型标签更有价值。
// 没写注释时回退到类型与默认值，即加说明语法之前一直显示的内容。
export function variableHint(variable: TVariableSchemaRow): string {
    if (variable.description !== undefined && variable.description !== '') {
        return variable.description;
    }
    const label = typeLabel[variable.type] ?? variable.type;
    return variable.defaultValue === undefined
        ? `${label}${variable.required ? ' · 必填' : ''}`
        : `${label} · 默认 ${String(variable.defaultValue)}`;
}

function buildFields(detail: TTaskDetail | undefined, variables: TVariableSchemaRow[]): TField[] {
    const fields: TField[] = [
        {
            Kind: 'schedule',
            Name: 'schedule',
            Label: '定时计划 (cron)',
            Type: 'string',
            Required: false,
            Hint: '*分 *时 *日 *月 *星期，留空表示不定时',
        },
        {
            Kind: 'overlap',
            Name: 'overlap',
            Label: '并发策略',
            Type: 'select',
            Required: true,
            Options: overlapOptions,
            Hint: 'skip 跳过 / queue 排队 / parallel 并行',
        },
    ];
    if (detail === undefined) {
        return fields;
    }
    for (const variable of variables) {
        fields.push({
            Kind: 'variable',
            Name: variable.name,
            Label: variable.name,
            Type: variable.type,
            Required: variable.required,
            Options: variable.options,
            Hint: variableHint(variable),
        });
    }
    return fields;
}

// 草稿只保存用户输入过的内容；未触碰的字段不进 patch，运行时保留原值（setConfig 是增量式的）。
type TDraft = Record<string, string>;
function initialDraft(detail: TTaskDetail | undefined, variables: TVariableSchemaRow[]): TDraft {
    const draft: TDraft = {
        schedule: detail?.schedule ?? '',
        overlap: detail?.overlap ?? 'skip',
    };
    for (const variable of variables) {
        // 密码永远不会从运行时返回；空草稿加上已存标志告诉用户"已设置"而不显示内容。
        draft[`var:${variable.name}`] = variable.configured === undefined ? '' : String(variable.configured);
    }
    return draft;
}

function displayValue(field: TField, draft: TDraft, variables: TVariableSchemaRow[]): { Text: string; Dim: boolean } {
    const key = field.Kind === 'variable' ? `var:${field.Name}` : field.Name;
    const raw = draft[key] ?? '';
    if (field.Kind === 'variable' && field.Type === 'password') {
        if (raw !== '') {
            return { Text: '•'.repeat(Math.min(12, raw.length)), Dim: false };
        }
        const stored = variables.find((variable) => variable.name === field.Name)?.hasConfigured === true;
        return stored ? { Text: '•••••••• (已保存)', Dim: true } : { Text: '(未设置)', Dim: true };
    }
    if (raw === '') {
        const fallback = variables.find((variable) => variable.name === field.Name)?.defaultValue;
        if (field.Kind === 'variable' && fallback !== undefined) {
            return { Text: `${String(fallback)} (默认)`, Dim: true };
        }
        return { Text: field.Kind === 'schedule' ? '(未设置)' : '(空)', Dim: true };
    }
    return { Text: raw, Dim: false };
}

function cycleOption(options: string[], current: string, direction: number): string {
    const index = options.indexOf(current);
    const next = (index < 0 ? 0 : index + direction + options.length) % options.length;
    return options[next] ?? current;
}

// select/boolean 字段用 ←/→ 就地切换，不打开编辑器；只有自由输入字段需要文本光标。
function isCyclable(field: TField): boolean {
    return field.Type === 'select' || field.Type === 'boolean' || field.Kind === 'overlap';
}

function optionsOf(field: TField): string[] {
    if (field.Type === 'boolean') {
        return ['true', 'false'];
    }
    return field.Options ?? [];
}

function fieldKey(field: TField): string {
    return field.Kind === 'variable' ? `var:${field.Name}` : field.Name;
}

function RenderFieldRow({
    field,
    value,
    dim,
    selected,
    editing,
    editValue,
    width,
    OnEditChange: onEditChange,
    OnEditSubmit: onEditSubmit,
}: {
    field: TField;
    value: string;
    dim: boolean;
    selected: boolean;
    editing: boolean;
    editValue: string;
    width: number;
    OnEditChange: (next: string) => void;
    OnEditSubmit: () => void;
}): ReactElement {
    const labelWidth = Math.min(22, Math.max(12, Math.floor(width * 0.32)));
    const valueWidth = Math.max(4, width - labelWidth - 3);
    const marker = selected ? '›' : ' ';
    const required = field.Required ? '*' : ' ';
    return (
        <Box width={width} flexShrink={0}>
            <Text color={selected ? palette.Selected : palette.Muted}>{`${marker} `}</Text>
            <Text color={field.Required ? palette.Warning : palette.Muted}>{required}</Text>
            <Box width={labelWidth} flexShrink={0}>
                <Text bold={selected} color={selected ? palette.Selected : undefined} wrap="truncate">
                    {field.Label}
                </Text>
            </Box>
            <Box width={valueWidth} flexShrink={0}>
                {editing ? (
                    <TextInput
                        value={editValue}
                        onChange={onEditChange}
                        onSubmit={onEditSubmit}
                        mask={field.Type === 'password' ? '•' : undefined}
                    />
                ) : (
                    <Text
                        color={dim ? palette.Muted : selected ? palette.Selected : undefined}
                        dimColor={dim}
                        wrap="truncate"
                    >
                        {isCyclable(field) ? `‹ ${value} ›` : value}
                    </Text>
                )}
            </Box>
        </Box>
    );
}

export function RenderTaskForm({
    client,
    taskId,
    metrics,
    frame,
    overlayOpen,
    OnClose: onClose,
    OnNotice: onNotice,
    OnReload: onReload,
    OnOpenOptions: onOpenOptions,
}: {
    client: IpcClient;
    taskId: string;
    metrics: TFrameMetrics;
    frame: number;
    overlayOpen: boolean;
    OnClose: () => void;
    OnNotice: (message: string, kind: 'info' | 'error') => void;
    OnReload: () => void;
    OnOpenOptions: (title: string, options: TOption[], index: number, OnPick: (value: string) => void) => void;
}): ReactElement {
    const width = metrics.Width;
    const form = useTaskForm(client, taskId);
    const fields = useMemo(() => buildFields(form.Detail, form.Variables), [form.Detail, form.Variables]);
    const [draft, setDraft] = useState<TDraft>({});
    const [index, setIndex] = useState(0);
    const [offset, setOffset] = useState(0);
    const [editing, setEditing] = useState(false);
    const [editValue, setEditValue] = useState('');
    const [dirty, setDirty] = useState(false);
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        if (!form.Loading) {
            setDraft(initialDraft(form.Detail, form.Variables));
            setDirty(false);
        }
    }, [form.Loading, form.Detail, form.Variables]);

    // 参数面板总是填满布局预留的空间，无论字段多少页脚都与其他页面同位置；
    // 空行由 RenderScrollBox 补白，窗口随终端伸缩。
    const rows = Math.max(1, formRows(metrics));
    const boundedIndex = Math.min(index, Math.max(0, fields.length - 1));
    // 派生而非存储：clampOffset 是纯函数，每帧重算让窗口在 resize 后仍正确，且无需渲染阶段 setState。
    const visibleOffset = clampOffset(fields.length, rows, boundedIndex, offset);
    const current = fields[boundedIndex];

    const move = (next: number): void => {
        setIndex(next);
        setOffset(clampOffset(fields.length, rows, next, visibleOffset));
    };

    const setValue = (field: TField, value: string): void => {
        setDraft((previous) => ({ ...previous, [fieldKey(field)]: value }));
        setDirty(true);
    };

    const save = async (): Promise<void> => {
        setSaving(true);
        try {
            const variables: Record<string, string | number | boolean> = {};
            for (const field of fields) {
                if (field.Kind !== 'variable') {
                    continue;
                }
                const raw = draft[`var:${field.Name}`] ?? '';
                if (raw === '') {
                    // 未触碰的密码（或任何留空字段）不得覆盖运行时已存的值。
                    continue;
                }
                if (field.Type === 'number') {
                    const parsed = Number(raw);
                    if (Number.isNaN(parsed)) {
                        throw new Error(`变量 "${field.Name}" 需要数字，收到 "${raw}"`);
                    }
                    variables[field.Name] = parsed;
                } else if (field.Type === 'boolean') {
                    variables[field.Name] = raw === 'true';
                } else {
                    variables[field.Name] = raw;
                }
            }
            // 运行时从 `patch` 对象读取变更字段，而不是请求顶层（见 runtime.ts 的 TaskSetConfig）。
            await client.SendRequest('task.setConfig', {
                taskId,
                patch: { variables, overlap: draft.overlap ?? 'skip' },
            });
            const schedule = (draft.schedule ?? '').trim();
            await client.SendRequest('task.setSchedule', schedule === '' ? { taskId } : { taskId, cron: schedule });
            setDirty(false);
            form.Reload();
            onReload();
            onNotice(`已保存 ${taskId} 的配置`, 'info');
        } catch (error) {
            onNotice(error instanceof Error ? error.message : String(error), 'error');
        } finally {
            setSaving(false);
        }
    };

    // 两个选项就地循环；更多选项用方向键没法操作，回车把字段交给选项子窗口。
    const pick = (field: TField, options: string[]): void => {
        const key = fieldKey(field);
        const value = draft[key] ?? options[0] ?? '';
        onOpenOptions(
            `选择 ${field.Label}`,
            options.map((option) => ({
                Value: option,
                Label: option,
                Hint: field.Kind === 'overlap' ? overlapHints[option] : undefined,
            })),
            Math.max(0, options.indexOf(value)),
            (next) => {
                setValue(field, next);
            },
        );
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
                move(Math.max(0, boundedIndex - 1));
                return;
            }
            if (key.downArrow) {
                move(Math.min(fields.length - 1, boundedIndex + 1));
                return;
            }
            if (current === undefined) {
                return;
            }
            if (key.leftArrow || key.rightArrow) {
                const options = optionsOf(current);
                if (options.length > 0) {
                    const key0 = fieldKey(current);
                    setValue(current, cycleOption(options, draft[key0] ?? options[0] ?? '', key.rightArrow ? 1 : -1));
                }
                return;
            }
            if (key.return) {
                if (isCyclable(current)) {
                    const options = optionsOf(current);
                    if (options.length > 2) {
                        pick(current, options);
                        return;
                    }
                    const key0 = fieldKey(current);
                    setValue(current, cycleOption(options, draft[key0] ?? options[0] ?? '', 1));
                    return;
                }
                setEditValue(draft[fieldKey(current)] ?? '');
                setEditing(true);
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
    const items: TScrollRow[] = fields.slice(visibleOffset, visibleOffset + rows).map((field, position) => {
        const absolute = visibleOffset + position;
        const shown = displayValue(field, draft, form.Variables);
        return {
            Key: `${field.Kind}-${field.Name}`,
            Node: (
                <RenderFieldRow
                    field={field}
                    value={shown.Text}
                    dim={shown.Dim}
                    selected={absolute === boundedIndex}
                    editing={editing && absolute === boundedIndex}
                    editValue={editValue}
                    width={inner - 1}
                    OnEditChange={setEditValue}
                    OnEditSubmit={() => {
                        setValue(field, editValue);
                        setEditing(false);
                    }}
                />
            ),
        };
    });

    const detail = form.Detail;
    const header = detail === undefined ? taskId : `${detail.name ?? taskId} v${detail.version ?? '?'}`;
    const state = form.Loading ? '加载中…' : saving ? '保存中…' : dirty ? '● 未保存' : '已同步';
    const busy = form.Loading || saving;

    return (
        <Box flexDirection="column" width={width} flexShrink={0}>
            <RenderPanel title={`配置 · ${header}`} hint={state} width={width} rows={2} focused={!overlayOpen}>
                <Box width={inner} flexShrink={0}>
                    <Text color={palette.Muted} wrap="truncate">
                        {detail?.description ?? '（无描述）'}
                    </Text>
                </Box>
                <Box width={inner} flexShrink={0}>
                    <Text color={palette.Muted} wrap="truncate">
                        {`任务 ${taskId} · ${detail?.enabled === true ? '已启用' : '已停用'} · 作者 ${detail?.author ?? '-'}`}
                    </Text>
                </Box>
            </RenderPanel>
            <RenderPanel
                title="参数"
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
                    empty={form.Error ?? '该任务没有可配置参数'}
                />
            </RenderPanel>
            <RenderPanel title="说明" width={width} rows={1}>
                <Box width={inner} flexShrink={0}>
                    {busy ? <RenderSpinner frame={frame} /> : <Text color={palette.Muted}>·</Text>}
                    <Box width={Math.max(1, inner - 1)} flexShrink={0}>
                        <Text color={palette.Muted} wrap="truncate">
                            {editing ? ' 回车确认输入 · Esc 取消编辑' : ` ${current?.Hint ?? ''}`}
                        </Text>
                    </Box>
                </Box>
            </RenderPanel>
        </Box>
    );
}
