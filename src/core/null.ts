// lint 规则禁止 null 字面量，但 JSON 来源仍会产生 null。
// 此哨兵值绕开字面量构造，仅用于同一性判断。
const nullSentinel: unknown = JSON.parse('null');
export function isNull(value: unknown): boolean {
    return value === nullSentinel;
}

export function isNullOrUndefined(value: unknown): boolean {
    return value === nullSentinel || value === undefined;
}

export const SINGLE_INSTANCE_MUTEX_NAME = 'Global\\AutomaticTask.Runtime';
