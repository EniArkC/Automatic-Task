import type { TVariableType } from './ast';

// 运行时自动提供的变量，任务脚本无需 @var 声明即可引用。
// 值在运行开始时由运行层注入，整个运行期间恒定不变。
const builtinVariables: ReadonlyMap<string, TVariableType> = new Map<string, TVariableType>([
    // 本次运行的工作目录，也是各步骤子进程的 cwd。
    ['Workspace_Dir', 'path'],
    // 任务包的解压目录；脚本读取包内自带的文件时需要它，因为 cwd 是工作区而非包目录。
    ['Package_Dir', 'path'],
    ['Run_Id', 'string'],
    ['Task_Id', 'string'],
    // "manual" 或 "schedule"，见 ERunTrigger。
    ['Trigger_Type', 'string'],
]);

export function isBuiltinVariable(name: string): boolean {
    return builtinVariables.has(name);
}

export function builtinVariableType(name: string): TVariableType | undefined {
    return builtinVariables.get(name);
}

export function builtinVariableNames(): string[] {
    return [...builtinVariables.keys()];
}
