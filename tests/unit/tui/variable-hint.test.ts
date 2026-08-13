import { describe, expect, it } from 'vitest';

import type { TVariableSchemaRow } from '../../../src/tui/hooks';
import { variableHint } from '../../../src/tui/task-form';

function row(patch: Partial<TVariableSchemaRow>): TVariableSchemaRow {
    return { name: 'city', type: 'string', required: false, hasConfigured: false, ...patch };
}

describe('variableHint', () => {
    it('shows the description from the declaration comment when there is one', () => {
        expect(variableHint(row({ description: '要生成日报的城市', defaultValue: '北京' }))).toBe('要生成日报的城市');
    });

    // 没写说明时必须逐字保持加说明语法之前的内容，否则老任务包的提示会变样。
    it('falls back to type and required flag without a default', () => {
        expect(variableHint(row({ type: 'password', required: true }))).toBe('密码 · 必填');
        expect(variableHint(row({ type: 'number' }))).toBe('数字');
    });

    it('falls back to type and default value when a default exists', () => {
        expect(variableHint(row({ defaultValue: '北京' }))).toBe('文本 · 默认 北京');
        expect(variableHint(row({ type: 'boolean', defaultValue: true }))).toBe('开关 · 默认 true');
    });

    it('treats an empty description as absent', () => {
        expect(variableHint(row({ description: '', defaultValue: '北京' }))).toBe('文本 · 默认 北京');
    });

    it('falls back to the raw type name for an unknown type', () => {
        expect(variableHint(row({ type: 'weird' }))).toBe('weird');
    });
});
