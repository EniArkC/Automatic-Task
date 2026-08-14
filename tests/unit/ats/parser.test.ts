import { parseAts, Parser, type TSelectNode, type TStepNode } from '@at/ats';
import { AtParseError } from '@at/core';
import { describe, expect, it } from 'vitest';

const FULL_EXAMPLE = `@var city: string = "北京"
@var depth: select("简版", "详细") = "简版"
@var token: password!

[Start]

-> [Script(\`scripts/fetch.bat \${city}\`)]

-> [Agent(\`为 \${city} 生成\${depth}日报，写入 report.md\`, timeout: 1800)]

-> [Select]

    -> [Failure]
        -> [Agent(\`总结本次失败原因写入 error-note.txt\`)]

    -> [Case(\${depth} == "详细")]
        -> [Agent(\`补充深度数据分析\`)]

    -> [Default]
        -> [Script(\`scripts/archive.bat \${city}\`)]

[End]
`;

function parse(source: string): ReturnType<Parser['Parse']> {
    return parseAts(source, 'task.ats');
}

describe('parser', () => {
    it('parses the full example', () => {
        const ast = parse(FULL_EXAMPLE);
        expect(ast.Variables).toHaveLength(3);
        expect(ast.Variables[0]).toMatchObject({ Name: 'city', Type: 'string', Required: false, DefaultValue: '北京' });
        expect(ast.Variables[1]?.Options).toEqual(['简版', '详细']);
        expect(ast.Variables[2]).toMatchObject({ Name: 'token', Type: 'password', Required: true });
        expect(ast.Body).toHaveLength(3);

        const script = ast.Body[0] as TStepNode;
        expect(script.StepType).toBe('Script');
        expect(script.Arguments[0]).toMatchObject({ Kind: 'positional' });

        const agent = ast.Body[1] as TStepNode;
        expect(agent.Arguments[1]).toMatchObject({ Kind: 'named', Name: 'timeout' });

        const select = ast.Body[2] as TSelectNode;
        expect(select.Kind).toBe('select');
        expect(select.Branches.map((branch) => branch.Kind)).toEqual(['failure', 'case', 'default']);
        expect(select.Branches[1]?.Condition).not.toBeUndefined();
    });

    it('parses an empty task', () => {
        const ast = parse('[Start]\n\n[End]\n');
        expect(ast.Body).toHaveLength(0);
    });

    it('parses a nested select', () => {
        const source = `[Start]

-> [Select]

    -> [Case(\${a} == "1")]
        -> [Select]

            -> [Success]
                -> [Script(\`x\`)]

            -> [Default]
                -> [Script(\`y\`)]

    -> [Default]
        -> [Script(\`z\`)]

[End]
`;
        const ast = parse(source);
        const outer = ast.Body[0] as TSelectNode;
        const inner = outer.Branches[0]?.Body[0] as TSelectNode;
        expect(inner.Kind).toBe('select');
        expect(inner.Branches).toHaveLength(2);
        expect(inner.Branches[0]?.Kind).toBe('success');
    });

    it('parses expression operators', () => {
        const source = `[Start]

-> [Select]

    -> [Case(\${a} >= 3 && \${b} != "x")]
        -> [Script(\`x\`)]

    -> [Default]
        -> [Script(\`y\`)]

[End]
`;
        const ast = parse(source);
        const select = ast.Body[0] as TSelectNode;
        expect(select.Branches[0]?.Condition).toBeDefined();
    });

    it('rejects missing [Start]', () => {
        expect(() => parse('-> [Script(`x`)]\n[End]\n')).toThrow(/Expected \[Start\]/);
    });

    it('rejects missing [End]', () => {
        expect(() => parse('[Start]\n-> [Script(`x`)]\n')).toThrow(/Expected \[End\]/);
    });

    it('rejects duplicate [Start]', () => {
        expect(() => parse('[Start]\n[Start]\n[End]\n')).toThrow(/Duplicate \[Start\]/);
    });

    it('rejects a second [End]', () => {
        expect(() => parse('[Start]\n[End]\n[End]\n')).toThrow(/after \[End\]/);
    });

    it('rejects missing parentheses', () => {
        expect(() => parse('[Start]\n-> [Agent(`x`\n[End]\n')).toThrow(AtParseError);
    });

    it('rejects steps inside select without indentation', () => {
        const source = `[Start]

-> [Select]
-> [Failure]
    -> [Script(\`x\`)]

-> [Default]
    -> [Script(\`y\`)]

[End]
`;
        expect(() => parse(source)).toThrow(/Expected indented branches/);
    });

    it('rejects a branch with an empty body', () => {
        const source = `[Start]

-> [Select]

    -> [Failure]

    -> [Default]
        -> [Script(\`y\`)]

[End]
`;
        expect(() => parse(source)).toThrow(/Expected indented steps/);
    });

    it('rejects unknown step types', () => {
        expect(() => parse('[Start]\n-> [Frobnicate(`x`)]\n[End]\n')).toThrow(/Unknown step type/);
    });

    it('rejects branch markers outside select', () => {
        expect(() => parse('[Start]\n-> [Failure]\n[End]\n')).toThrow(/only allowed inside/);
    });

    it('rejects a missing colon in variable declarations', () => {
        expect(() => parse('@var city string = "x"\n[Start]\n[End]\n')).toThrow(/Expected ':'/);
    });

    it('rejects invalid variable types', () => {
        expect(() => parse('@var city: integer = 3\n[Start]\n[End]\n')).toThrow(/Unknown variable type/);
    });

    it('takes the trailing comment of a declaration as its description', () => {
        const ast = parse(
            [
                '// 独立成行的注释不是说明',
                '@var city: string = "北京"   # 要生成日报的城市',
                '@var token: password!  #  抓取接口的访问令牌  ',
                '@var lines: number = 5',
                '@var quiet: boolean = true #',
                '[Start]',
                '[End]',
                '',
            ].join('\n'),
        );
        expect(ast.Variables[0]?.Description).toBe('要生成日报的城市');
        expect(ast.Variables[1]?.Description).toBe('抓取接口的访问令牌');
        // 没写注释的参数没有说明，配置界面据此回退到类型与默认值。
        expect(ast.Variables[2]?.Description).toBeUndefined();
        // `#` 后面什么都没有算不上说明。
        expect(ast.Variables[3]?.Description).toBeUndefined();
    });

    it('does not take a comment on the previous line as a description', () => {
        const ast = parse('// 这行只是注释\n@var city: string\n[Start]\n[End]\n');
        expect(ast.Variables[0]?.Description).toBeUndefined();
    });

    it('includes line and column in errors', () => {
        try {
            parse('[Start]\n-> [Agent(`x`, timeout: )]\n[End]\n');
            expect.unreachable();
        } catch (error) {
            const parseError = error as AtParseError;
            expect(parseError.Detail.Line).toBe(2);
            expect(parseError.Detail.Snippet).toContain('timeout');
            expect(parseError.Detail.Column).toBeGreaterThan(0);
        }
    });
});
