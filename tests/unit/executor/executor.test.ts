import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseAts, type TChainNode, type TStepNode } from '@at/ats';
import { EStepStatus, type TExecutionContext, type TVariableValue } from '@at/core';
import {
    ChainExecutor,
    createChainExecutor,
    DockerExecutor,
    PiAgentAdapter,
    quoteCmdArgument,
    resolveCommand,
    ScriptExecutor,
    splitCommandLine,
    splitCommandParts,
    StepExecutor,
    type TStepDetail,
} from '@at/executor';
import { ProcessRunner } from '@at/process';
import { afterEach, describe, expect, it } from 'vitest';

import { createTempDir, removeDir } from '../../helpers/test-utils';

const runner = new ProcessRunner();

function createHarness(): { Chain: ChainExecutor } {
    const stepExecutor = new StepExecutor(
        new ScriptExecutor(runner),
        new PiAgentAdapter(runner, { command: process.execPath, args: ['-e', "console.log('agent-done')"] }),
        new DockerExecutor(runner),
    );
    return createChainExecutor(stepExecutor);
}

function createContext(
    variables: Record<string, TVariableValue> = {},
    workspace: string,
    packagePath: string,
): TExecutionContext {
    return {
        Variables: new Map(Object.entries(variables)),
        Workspace: workspace,
        PackagePath: packagePath,
        AbortSignal: new AbortController().signal,
    };
}

function chainOf(source: string): TChainNode[] {
    const ast = parseAts(source, 'task.ats');
    return ast.Body;
}

describe('command resolver', () => {
    it('splits command lines honoring quotes', () => {
        expect(splitCommandLine('node -e "console.log(1)"')).toEqual(['node', '-e', 'console.log(1)']);
        expect(splitCommandLine('echo hello world')).toEqual(['echo', 'hello', 'world']);
    });

    it('keeps a variable value with spaces as one argument', () => {
        const parts = splitCommandParts([
            { Kind: 'text', Text: 'echo ' },
            { Kind: 'value', Text: 'hello world' },
        ]);
        expect(parts).toEqual(['echo', 'hello world']);
    });

    it('does not let quotes inside a variable value open a quoted section', () => {
        const parts = splitCommandParts([
            { Kind: 'text', Text: 'echo ' },
            { Kind: 'value', Text: 'a"b' },
            { Kind: 'text', Text: ' tail' },
        ]);
        expect(parts).toEqual(['echo', 'a"b', 'tail']);
    });

    it('resolves package-relative scripts against the package path', () => {
        const dir = createTempDir('at-resolver-');
        const scriptsDir = join(dir, 'scripts');
        mkdirSync(scriptsDir, { recursive: true });
        writeFileSync(join(scriptsDir, 'fetch.bat'), '@echo off\r\n');
        try {
            const resolved = resolveCommand('scripts/fetch.bat', dir);
            expect(resolved.ResolvedPath).toBe(join(dir, 'scripts', 'fetch.bat'));
        } finally {
            removeDir(dir);
        }
    });

    it('keeps arguments for package-local batch scripts', () => {
        const dir = createTempDir('at-resolver-');
        const scriptsDir = join(dir, 'scripts');
        mkdirSync(scriptsDir, { recursive: true });
        writeFileSync(join(scriptsDir, 'fetch.cmd'), '@echo off\r\n');
        try {
            const resolved = resolveCommand('scripts/fetch.cmd 北京 token', dir);
            expect(resolved.ResolvedPath).toBe(join(dir, 'scripts', 'fetch.cmd'));
            expect(resolved.Args).toEqual(['北京', 'token']);
        } finally {
            removeDir(dir);
        }
    });

    it('keeps a missing package script as-is', () => {
        const resolved = resolveCommand('scripts/nope.bat', 'C:\\pkg');
        expect(resolved.ResolvedPath).toBe('scripts/nope.bat');
    });

    it('keeps bare commands on the PATH', () => {
        const resolved = resolveCommand('node --version', 'C:\\pkg');
        expect(resolved.Command).toBe('node');
        expect(resolved.Args).toEqual(['--version']);
    });

    it('quotes cmd arguments with doubled quotes, not backslashes', () => {
        expect(quoteCmdArgument('a"b')).toBe('"a""b"');
        expect(quoteCmdArgument('plain')).toBe('plain');
        expect(quoteCmdArgument('a b')).toBe('"a b"');
        expect(quoteCmdArgument('')).toBe('""');
    });
});

// 全局配置在运行期可改（TUI 的 `app.set` 会写回 app.json）。适配器如果在构造时
// 把配置快照下来，用户改完命令/参数立刻跑任务仍然会走旧的那一套，只有重启守护
// 进程才生效——这正是曾经出现过的问题。
describe('agent adapter config', () => {
    const dirs: string[] = [];

    afterEach(() => {
        for (const dir of dirs) {
            removeDir(dir);
        }
        dirs.length = 0;
    });

    function contextIn(): TExecutionContext {
        const workspace = createTempDir('at-agent-');
        dirs.push(workspace);
        return createContext({}, workspace, workspace);
    }

    it('re-reads the config on every call instead of snapshotting it', async () => {
        let args = ['-e', "console.log('before')"];
        const adapter = new PiAgentAdapter(runner, () => ({ command: process.execPath, args }));

        const first = await adapter.Execute({ Prompt: '' }, contextIn());
        expect(first.Output).toContain('before');

        // 换成新配置后不重建适配器，模拟用户在 TUI 里改完全局配置立刻跑任务。
        args = ['-e', "console.log('after')"];
        const second = await adapter.Execute({ Prompt: '' }, contextIn());
        expect(second.Output).toContain('after');
    });

    it('treats an empty model as unset rather than passing -m ""', async () => {
        // 表单清空模型字段留下的是 ""。若原样下发就变成 `-m ""`，多数 CLI 会把它
        // 当成非法模型名。这里让子进程把收到的 argv 打印出来自证。
        const adapter = new PiAgentAdapter(runner, {
            command: process.execPath,
            args: ['-e', 'console.log(JSON.stringify(process.argv.slice(1)))'],
            model: '',
        });
        const result = await adapter.Execute({ Prompt: 'hello' }, contextIn());
        expect(JSON.parse(result.Output.trim())).toEqual(['hello']);
    });
});

describe('chain executor', () => {
    const dirs: string[] = [];

    afterEach(() => {
        for (const dir of dirs) {
            removeDir(dir);
        }
        dirs.length = 0;
    });

    it('resolves variables into script commands', async () => {
        const { Chain: chain } = createHarness();
        const dir = createTempDir('at-exec-');
        dirs.push(dir);
        const source = '[Start]\n-> [Script(`node -e "console.log(process.argv[1])" ${city}`)]\n[End]\n';
        const result = await chain.ExecuteChain(chainOf(source), createContext({ city: '上海' }, dir, dir));
        expect(result.Status).toBe(EStepStatus.Success);
        expect(result.Output).toContain('上海');
    });

    it('passes a variable value with spaces as a single argument', async () => {
        const { Chain: chain } = createHarness();
        const dir = createTempDir('at-exec-');
        dirs.push(dir);
        const source = '[Start]\n-> [Script(`node -e "console.log(process.argv[1])" ${greeting}`)]\n[End]\n';
        const result = await chain.ExecuteChain(chainOf(source), createContext({ greeting: 'hello world' }, dir, dir));
        expect(result.Status).toBe(EStepStatus.Success);
        expect(result.Output).toContain('hello world');
    });

    it('resolves a number variable used as timeout', async () => {
        const { Chain: chain } = createHarness();
        const dir = createTempDir('at-exec-');
        dirs.push(dir);
        const source =
            '@var secs: number = 1\n[Start]\n-> [Script(`node -e "setInterval(() => {}, 100)"`, timeout: ${secs})]\n[End]\n';
        const result = await chain.ExecuteChain(chainOf(source), createContext({ secs: 1 }, dir, dir));
        expect(result.Status).toBe(EStepStatus.Timeout);
    });

    it('keeps running after a failure so a Select can react to it', async () => {
        const { Chain: chain } = createHarness();
        const dir = createTempDir('at-exec-');
        dirs.push(dir);
        const marker = join(dir, 'recovered.txt');
        const source = `[Start]
-> [Script(\`node -e "process.exit(1)"\`)]
-> [Select]
    -> [Failure]
        -> [Script(\`node -e "require('fs').writeFileSync('${marker.replace(/\\/g, '/')}', 'x'); console.log('RECOVERED')"\`)]
    -> [Default]
        -> [Script(\`node -e "console.log('DEFAULT')"\`)]
[End]
`;
        const result = await chain.ExecuteChain(chainOf(source), createContext({}, dir, dir));
        expect(result.Status).toBe(EStepStatus.Success);
        expect(result.Output).toContain('RECOVERED');
        expect(existsSync(marker)).toBe(true);
    });

    it('ends with failure when no Select handles it', async () => {
        const { Chain: chain } = createHarness();
        const dir = createTempDir('at-exec-');
        dirs.push(dir);
        const source = '[Start]\n-> [Script(`node -e "process.exit(1)"`)]\n[End]\n';
        const result = await chain.ExecuteChain(chainOf(source), createContext({}, dir, dir));
        expect(result.Status).toBe(EStepStatus.Failure);
    });

    it('takes the failure branch after a failed step', async () => {
        const { Chain: chain } = createHarness();
        const dir = createTempDir('at-exec-');
        dirs.push(dir);
        const source = `[Start]
-> [Script(\`node -e "process.exit(2)"\`)]
-> [Select]
    -> [Failure]
        -> [Script(\`node -e "console.log('FAILURE_BRANCH')"\`)]
    -> [Default]
        -> [Script(\`node -e "console.log('DEFAULT')"\`)]
[End]
`;
        const result = await chain.ExecuteChain(chainOf(source), createContext({}, dir, dir));
        expect(result.Status).toBe(EStepStatus.Success);
        expect(result.Output).toContain('FAILURE_BRANCH');
        expect(result.Output).not.toContain('DEFAULT');
    });

    it('evaluates case branches against variables', async () => {
        const { Chain: chain } = createHarness();
        const dir = createTempDir('at-exec-');
        dirs.push(dir);
        const source = `@var depth: select("简版", "详细") = "简版"
[Start]
-> [Select]
    -> [Case(\${depth} == "详细")]
        -> [Script(\`node -e "console.log('DETAILED')"\`)]
    -> [Default]
        -> [Script(\`node -e "console.log('DEFAULT')"\`)]
[End]
`;
        const detailed = await chain.ExecuteChain(chainOf(source), createContext({ depth: '详细' }, dir, dir));
        expect(detailed.Output).toContain('DETAILED');
        const brief = await chain.ExecuteChain(chainOf(source), createContext({ depth: '简版' }, dir, dir));
        expect(brief.Output).toContain('DEFAULT');
    });

    it('returns skipped when no branch matches', async () => {
        const { Chain: chain } = createHarness();
        const dir = createTempDir('at-exec-');
        dirs.push(dir);
        const source = `[Start]
-> [Select]
    -> [Case(\${n} == 1)]
        -> [Script(\`node -e "console.log('NOPE')"\`)]
[End]
`;
        const result = await chain.ExecuteChain(chainOf(source), createContext({ n: 2 }, dir, dir));
        expect(result.Status).toBe(EStepStatus.Skipped);
    });

    it('runs agent steps through the configured adapter', async () => {
        const { Chain: chain } = createHarness();
        const dir = createTempDir('at-exec-');
        dirs.push(dir);
        const source = '[Start]\n-> [Agent(`do something`)]\n[End]\n';
        const result = await chain.ExecuteChain(chainOf(source), createContext({}, dir, dir));
        expect(result.Status).toBe(EStepStatus.Success);
        expect(result.Output).toContain('agent-done');
    });

    it('runs a package-local batch script from any cwd', async () => {
        const { Chain: chain } = createHarness();
        const dir = createTempDir('at-exec-');
        dirs.push(dir);
        const packageDir = join(dir, 'pkg');
        const scriptsDir = join(packageDir, 'scripts');
        mkdirSync(scriptsDir, { recursive: true });
        writeFileSync(join(scriptsDir, 'hello.bat'), '@echo off\r\necho hello from script\r\n');
        const workspace = join(dir, 'work');
        mkdirSync(workspace, { recursive: true });
        const source = '[Start]\n-> [Script(`scripts/hello.bat`)]\n[End]\n';
        const result = await chain.ExecuteChain(chainOf(source), createContext({}, workspace, packageDir));
        expect(result.Status).toBe(EStepStatus.Success);
        expect(result.Output).toContain('hello from script');
    });

    it('emits step lifecycle events', async () => {
        const { Chain: chain } = createHarness();
        const dir = createTempDir('at-exec-');
        dirs.push(dir);
        const source = '[Start]\n-> [Script(`node -e "console.log(\'out\')"`)]\n[End]\n';
        const started: string[] = [];
        const output: string[] = [];
        await chain.ExecuteChain(chainOf(source), createContext({}, dir, dir), {
            OnStepStarted: (node) => {
                started.push((node as TStepNode).StepType);
            },
            OnOutput: (stream, data) => {
                output.push(`${stream}:${data}`);
            },
        });
        expect(started).toEqual(['Script']);
        expect(output.join('')).toContain('stdout:out');
    });
});

// 事件里此前只有 node.Kind（恒为 'step'），出错时完全看不出跑的是哪一步、执行的是什么。
// detail 由 StepExecutor 产出，是唯一同时知道节点类型和「变量替换之后的目标」的地方。
describe('step detail reported with lifecycle events', () => {
    const dirs: string[] = [];

    afterEach(() => {
        for (const dir of dirs) {
            removeDir(dir);
        }
        dirs.length = 0;
    });

    function tempDir(): string {
        const dir = createTempDir('at-detail-');
        dirs.push(dir);
        return dir;
    }

    it('reports type, source position and the resolved target', async () => {
        const { Chain: chain } = createHarness();
        const dir = tempDir();
        const source = '[Start]\n-> [Script(`node -e "console.log(1)" ${city}`)]\n[End]\n';
        const details: TStepDetail[] = [];
        await chain.ExecuteChain(chainOf(source), createContext({ city: '上海' }, dir, dir), {
            OnStepStarted: (node, detail) => {
                if (detail !== undefined) {
                    details.push(detail);
                }
            },
        });
        expect(details).toHaveLength(1);
        expect(details[0]?.StepType).toBe('Script');
        expect(details[0]?.Line).toBe(2);
        expect(details[0]?.Column).toBeGreaterThan(0);
        // 记的是替换后的实际命令，不是模板原文。
        expect(details[0]?.Target).toContain('上海');
        expect(details[0]?.Target).not.toContain('${city}');
    });

    it('reports the same detail on start and finish', async () => {
        const { Chain: chain } = createHarness();
        const dir = tempDir();
        const source = '[Start]\n-> [Agent(`你是谁？`)]\n[End]\n';
        let startDetail: TStepDetail | undefined;
        let finishDetail: TStepDetail | undefined;
        await chain.ExecuteChain(chainOf(source), createContext({}, dir, dir), {
            OnStepStarted: (node, detail) => {
                startDetail = detail;
            },
            OnStepFinished: (node, result, detail) => {
                finishDetail = detail;
            },
        });
        expect(startDetail?.StepType).toBe('Agent');
        expect(startDetail?.Target).toBe('你是谁？');
        expect(finishDetail).toEqual(startDetail);
    });

    it('reports the timeout so a hung step can be explained', async () => {
        const { Chain: chain } = createHarness();
        const dir = tempDir();
        const source = '[Start]\n-> [Script(`node -e "setInterval(() => {}, 100)"`, timeout: 1)]\n[End]\n';
        let detail: TStepDetail | undefined;
        const result = await chain.ExecuteChain(chainOf(source), createContext({}, dir, dir), {
            OnStepStarted: (node, value) => {
                detail = value;
            },
        });
        expect(result.Status).toBe(EStepStatus.Timeout);
        expect(detail?.TimeoutSeconds).toBe(1);
        // 超时被杀的进程什么都不吐，错误文本必须由 describeFailure 兜出来。
        expect(result.Error).toBeTruthy();
    });

    it('leaves detail undefined for a Select node', async () => {
        const { Chain: chain } = createHarness();
        const dir = tempDir();
        const source = '[Start]\n-> [Select]\n    -> [Default]\n        -> [Script(`node -e ""`)]\n[End]\n';
        const kinds: string[] = [];
        await chain.ExecuteChain(chainOf(source), createContext({}, dir, dir), {
            OnStepStarted: (node, detail) => {
                kinds.push(`${node.Kind}:${detail === undefined ? 'none' : detail.StepType}`);
            },
        });
        expect(kinds).toContain('select:none');
        expect(kinds).toContain('step:Script');
    });
});

// [Failure] 分支会把一次失败的运行改写成 success。不记下命中的是哪条分支，
// 事后只能看到 "status": "success"，真正的失败被完全掩盖。
describe('branch selection events', () => {
    const dirs: string[] = [];

    afterEach(() => {
        for (const dir of dirs) {
            removeDir(dir);
        }
        dirs.length = 0;
    });

    function tempDir(): string {
        const dir = createTempDir('at-branch-');
        dirs.push(dir);
        return dir;
    }

    it('names the branch that rewrote a failure into success', async () => {
        const { Chain: chain } = createHarness();
        const dir = tempDir();
        const source = `[Start]
-> [Script(\`node -e "process.exit(2)"\`)]
-> [Select]
    -> [Failure]
        -> [Script(\`node -e "console.log('RECOVERED')"\`)]
    -> [Default]
        -> [Script(\`node -e "console.log('DEFAULT')"\`)]
[End]
`;
        const branches: string[] = [];
        const result = await chain.ExecuteChain(chainOf(source), createContext({}, dir, dir), {
            OnBranchSelected: (node, branch) => {
                branches.push(branch?.Kind ?? 'none');
            },
        });
        expect(result.Status).toBe(EStepStatus.Success);
        expect(branches).toEqual(['failure']);
    });

    it('reports undefined when nothing matched', async () => {
        const { Chain: chain } = createHarness();
        const dir = tempDir();
        const source = `[Start]
-> [Select]
    -> [Case(\${n} == 1)]
        -> [Script(\`node -e "console.log('NOPE')"\`)]
[End]
`;
        const branches: (string | undefined)[] = [];
        const result = await chain.ExecuteChain(chainOf(source), createContext({ n: 2 }, dir, dir), {
            OnBranchSelected: (node, branch) => {
                branches.push(branch?.Kind);
            },
        });
        expect(result.Status).toBe(EStepStatus.Skipped);
        expect(branches).toEqual([undefined]);
    });
});
