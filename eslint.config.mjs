import tseslint from 'typescript-eslint';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import simpleImportSort from 'eslint-plugin-simple-import-sort';
import importX from 'eslint-plugin-import-x';
import noNull from 'eslint-plugin-no-null';

export default tseslint.config(
    {
        ignores: ['dist/**', 'node_modules/**', 'coverage/**', '**/*.js', '**/*.mjs', '**/*.cjs'],
    },
    ...tseslint.configs.strictTypeChecked,
    ...tseslint.configs.stylisticTypeChecked,
    eslintPluginPrettierRecommended,
    importX.flatConfigs.recommended,
    {
        settings: {
            // 使用 node 解析器；`@at/*` 路径由 tsconfig paths 提供，类型检查交给 tsc
            'import-x/resolver': {
                node: { extensions: ['.ts', '.tsx', '.js', '.json'] },
            },
        },
        rules: {
            'import-x/no-unresolved': ['error', { ignore: ['^@at/'] }],
        },
    },
    {
        plugins: {
            'simple-import-sort': simpleImportSort,
            import: importX,
            'no-null': noNull,
        },
        languageOptions: {
            parserOptions: {
                project: './tsconfig.json',
                tsconfigRootDir: import.meta.dirname,
            },
        },
        rules: {
            // 禁止使用 console 统一使用 Log
            'no-console': 'error',
            // 禁止条件判断中常量表达式
            'no-constant-condition': ['error', { checkLoops: false }],
            // 禁止常规字符串中出现占位符
            'no-template-curly-in-string': 'error',
            // 强制访问器成对出现
            'accessor-pairs': 'error',
            // 强制数组方法必须有返回
            'array-callback-return': 'error',
            // 强制变量使用作用域
            'block-scoped-var': 'error',
            // 强制圈复杂度
            complexity: ['error', 50],
            // 强制返回值一致
            'consistent-return': 'error',
            // 强制括号风格一致
            curly: 'error',
            // 强制尽可能使用点号
            'dot-notation': 'error',
            // 强制使用全等
            eqeqeq: 'error',
            // 禁用 alert
            'no-alert': 'error',
            // 禁用 caller
            'no-caller': 'error',
            // 禁止正则表达式除法操作符
            'no-div-regex': 'error',
            // 禁止 if return 后有 else
            'no-else-return': 'error',
            // 禁止与 null 比较
            'no-eq-null': 'error',
            // 禁止扩展原生类型
            'no-extend-native': 'error',
            // 禁止不必要的绑定
            'no-extra-bind': 'error',
            // 禁止不必要的标签
            'no-extra-label': 'error',
            // 禁止数字前导和末尾小数点
            'no-floating-decimal': 'error',
            // 禁止全局变量和函数
            'no-implicit-globals': 'error',
            // 禁止不必要的嵌套块
            'no-lone-blocks': 'error',
            // 禁止多空格
            'no-multi-spaces': 'error',
            // 禁止多行字符串
            'no-multi-str': 'error',
            // 禁止 new 不存储结果
            'no-new': 'error',
            // 禁止对方法使用 new
            'no-new-func': 'error',
            // 禁止对基础类型使用 new
            'no-new-wrappers': 'error',
            // 禁止字符串中八进制转义
            'no-octal-escape': 'error',
            // 禁止对函数参数赋值
            'no-param-reassign': 'error',
            // 禁止返回中赋值
            'no-return-assign': 'error',
            // 禁止返回 await
            'no-return-await': 'error',
            // 禁止自我比较
            'no-self-compare': 'error',
            // 禁止逗号操作符
            'no-sequences': 'error',
            // 禁止抛出字面量异常
            'no-throw-literal': 'error',
            // 禁止不变循环条件
            'no-unmodified-loop-condition': 'error',
            // 禁止不必要 call apply
            'no-useless-call': 'error',
            // 禁止不必要连接
            'no-useless-concat': 'error',
            // 禁止不必要返回
            'no-useless-return': 'error',
            // 禁用 void 操作符
            'no-void': 'error',
            // 强制使用命名捕获
            'prefer-named-capture-group': 'error',
            // 强制 error 作为 promise 拒绝原因
            'prefer-promise-reject-errors': 'error',
            // 强制立即执行方法包裹
            'wrap-iife': 'error',
            // 禁止在循环内出现 await
            'no-await-in-loop': 'off',

            'no-null/no-null': 'error',

            // 强制 import export 排序
            'simple-import-sort/imports': 'warn',
            'simple-import-sort/exports': 'warn',

            '@typescript-eslint/no-non-null-assertion': 'off',
            '@typescript-eslint/no-empty-interface': 'off',
            // 关闭空方法报错
            '@typescript-eslint/no-empty-function': 'off',
            // 关闭禁止纯静态类
            '@typescript-eslint/no-extraneous-class': 'off',
            // 禁止魔法数字
            '@typescript-eslint/no-magic-numbers': 'off',
            '@typescript-eslint/no-redeclare': 'off',
            '@typescript-eslint/no-unsafe-assignment': 'off',
            // 强制函数返回类型
            '@typescript-eslint/explicit-function-return-type': [
                'error',
                {
                    allowExpressions: true,
                    allowTypedFunctionExpressions: true,
                    allowHigherOrderFunctions: true,
                },
            ],
            // 允许类中单行的成员之间没有空行（v8 已移除该扩展规则，保留空注释说明）
            '@typescript-eslint/no-shadow': 'off',
            // 关闭禁止类型别名
            '@typescript-eslint/no-type-alias': 'off',
            // 关闭禁止构造函数定义属性
            '@typescript-eslint/no-parameter-properties': 'off',
            // 关闭枚举强制初始化
            '@typescript-eslint/prefer-enum-initializers': 'off',
            // 关闭强制安全参数
            '@typescript-eslint/no-unsafe-argument': 'off',
            // 关闭禁止布尔类型自动转换
            '@typescript-eslint/strict-boolean-expressions': 'off',
            // 关闭强制参数只读
            '@typescript-eslint/prefer-readonly-parameter-types': 'off',
            // 关闭禁止加操作符
            '@typescript-eslint/restrict-plus-operands': 'off',
            // 关闭强制字符串中只能引用字符串类型
            '@typescript-eslint/restrict-template-expressions': 'off',
            // 关闭强制字段排序
            '@typescript-eslint/member-ordering': 'off',
            // 关闭?.运算符推荐
            '@typescript-eslint/prefer-optional-chain': 'off',
            // 关闭强制类型导入
            '@typescript-eslint/consistent-type-imports': 'off',
            // 数据模型统一使用 T 前缀 type alias（interface 需 I 前缀），因此关闭该规则
            '@typescript-eslint/consistent-type-definitions': 'off',
            // 关闭禁止始终一致的条件
            '@typescript-eslint/no-unnecessary-condition': 'off',
            // 禁止未使用变量除了方法参数
            '@typescript-eslint/no-unused-vars': [
                'error',
                {
                    varsIgnorePattern: '^(perfTiming)|(ignoreError)$',
                    args: 'none',
                    ignoreRestSiblings: false,
                    reportUsedIgnorePattern: false,
                },
            ],
            '@typescript-eslint/no-use-before-define': ['error', { classes: false }],
            // 强制命名规范
            '@typescript-eslint/naming-convention': [
                'error',
                // 全局变量：全大写下划线命名
                {
                    format: ['UPPER_CASE'],
                    leadingUnderscore: 'forbid',
                    trailingUnderscore: 'forbid',
                    selector: 'variable',
                    modifiers: ['global', 'const'],
                    types: ['boolean', 'string', 'number'],
                    filter: {
                        regex: '^[I][A-Za-z0-9]*$',
                        match: false,
                    },
                },
                // 类：严格大写驼峰命名
                {
                    format: ['StrictPascalCase'],
                    leadingUnderscore: 'forbid',
                    trailingUnderscore: 'forbid',
                    selector: 'class',
                },
                // 接口：带 I 前缀的严格大写驼峰命名
                {
                    format: ['StrictPascalCase'],
                    leadingUnderscore: 'forbid',
                    trailingUnderscore: 'forbid',
                    prefix: ['I'],
                    selector: 'interface',
                },
                // 类型：带 T 前缀的严格大写驼峰命名
                {
                    format: ['StrictPascalCase'],
                    leadingUnderscore: 'forbid',
                    trailingUnderscore: 'forbid',
                    prefix: ['T'],
                    selector: 'typeAlias',
                },
                // 泛型：带 T 前缀的严格大写驼峰命名
                {
                    format: ['StrictPascalCase'],
                    leadingUnderscore: 'forbid',
                    trailingUnderscore: 'forbid',
                    prefix: ['T'],
                    selector: 'typeParameter',
                },
                // 枚举：带 E 前缀的严格大写驼峰命名
                {
                    format: ['StrictPascalCase'],
                    leadingUnderscore: 'forbid',
                    trailingUnderscore: 'forbid',
                    prefix: ['E'],
                    selector: 'enum',
                },
                // 类属性：严格大写驼峰命名
                {
                    format: ['StrictPascalCase'],
                    leadingUnderscore: 'forbid',
                    trailingUnderscore: 'forbid',
                    selector: 'classProperty',
                    filter: {
                        regex: '^_ServiceBrand$',
                        match: false,
                    },
                },
                // 类方法：严格大写驼峰命名
                {
                    format: ['StrictPascalCase'],
                    leadingUnderscore: 'forbid',
                    trailingUnderscore: 'forbid',
                    selector: 'classMethod',
                    filter: {
                        regex: '^(render$|componentWillUnmount$|componentDidMount$|UNSAFE_componentWillMount$)',
                        match: false,
                    },
                },
                // 访问器：严格大写驼峰命名
                {
                    format: ['StrictPascalCase'],
                    leadingUnderscore: 'forbid',
                    trailingUnderscore: 'forbid',
                    selector: 'accessor',
                },
                // 类型属性：允许 camelCase，因为数据模型属性名会直接序列化为 JSON 键
                {
                    format: ['camelCase', 'PascalCase'],
                    leadingUnderscore: 'forbid',
                    trailingUnderscore: 'forbid',
                    filter: {
                        regex: '(^_St)|(^_ServiceBrand$)',
                        match: false,
                    },
                    selector: 'typeProperty',
                },
                // 类型方法：严格大写驼峰命名
                {
                    format: ['StrictPascalCase'],
                    leadingUnderscore: 'forbid',
                    trailingUnderscore: 'forbid',
                    selector: 'typeMethod',
                },
                // 字面量属性：允许 camelCase，因为 IPC/JSON 数据契约使用 camelCase 键（见规格 §21/§24/§64）
                {
                    format: ['camelCase', 'PascalCase', 'UPPER_CASE'],
                    leadingUnderscore: 'forbid',
                    trailingUnderscore: 'forbid',
                    selector: 'objectLiteralProperty',
                },
                // 字面量方法：允许 camelCase，理由同上
                {
                    format: ['camelCase', 'PascalCase'],
                    leadingUnderscore: 'forbid',
                    trailingUnderscore: 'forbid',
                    selector: 'objectLiteralMethod',
                },
                // 参数属性：严格大写驼峰命名
                {
                    format: ['StrictPascalCase'],
                    leadingUnderscore: 'forbid',
                    trailingUnderscore: 'forbid',
                    selector: 'parameterProperty',
                },
                // 枚举成员：大写驼峰命名
                {
                    format: ['PascalCase'],
                    leadingUnderscore: 'forbid',
                    trailingUnderscore: 'forbid',
                    selector: 'enumMember',
                },
                // 变量：严格小写驼峰命名
                {
                    format: ['strictCamelCase'],
                    leadingUnderscore: 'forbid',
                    trailingUnderscore: 'forbid',
                    selector: 'variable',
                    filter: {
                        regex: '^[I][A-Za-z0-9]*$',
                        match: false,
                    },
                },
                // 函数：严格小写驼峰命名
                {
                    format: ['strictCamelCase'],
                    leadingUnderscore: 'forbid',
                    trailingUnderscore: 'forbid',
                    selector: 'function',
                    filter: {
                        regex: '^Render',
                        match: false,
                    },
                },
                // 参数：严格小写驼峰命名
                {
                    format: ['strictCamelCase'],
                    leadingUnderscore: 'forbid',
                    trailingUnderscore: 'forbid',
                    selector: 'parameter',
                },
            ],
        },
    },
    {
        // 分层边界。单包合并后，原来由 pnpm 依赖图强制的模块边界改由这组规则承担，
        // 挡住环和层级倒置。依赖顺序（自底向上）：
        //   core → paths/logging/ipc/ats/process → config → package-manager/executor/scheduler → run → runtime → cli
        // tui 是并行的展示层，只依赖 core/ipc。
        files: ['src/**/*.ts', 'src/**/*.tsx'],
        rules: {
            'no-restricted-imports': [
                'error',
                {
                    patterns: [
                        {
                            // 相对路径跨层引用会绕开 @at/* 规则；层内用相对路径，跨层一律走 @at/* 别名。
                            group: ['../*/*'],
                            message: '跨层引用请使用 @at/* 别名，相对路径仅限本层内部。',
                        },
                    ],
                },
            ],
        },
    },
    {
        // core 是零依赖底座，不允许向上依赖任何一层。
        files: ['src/core/**'],
        rules: {
            'no-restricted-imports': [
                'error',
                {
                    patterns: [
                        { group: ['@at/*'], message: 'core 层必须保持零内部依赖。' },
                        { group: ['../*/*'], message: '跨层引用请使用 @at/* 别名，相对路径仅限本层内部。' },
                    ],
                },
            ],
        },
    },
    {
        // 基础设施层：彼此不相往来，只能向下用 core。
        files: ['src/paths/**', 'src/logging/**', 'src/ats/**', 'src/process/**', 'src/ipc/**'],
        rules: {
            'no-restricted-imports': [
                'error',
                {
                    patterns: [
                        {
                            group: ['@at/*', '!@at/core'],
                            message: '基础设施层只能依赖 @at/core。',
                        },
                        { group: ['../*/*'], message: '跨层引用请使用 @at/* 别名，相对路径仅限本层内部。' },
                    ],
                },
            ],
        },
    },
    {
        // 业务层不碰 UI：run/executor 里出现 tui 或 ink 就是层级倒置。
        files: ['src/config/**', 'src/package-manager/**', 'src/executor/**', 'src/scheduler/**', 'src/run/**'],
        rules: {
            'no-restricted-imports': [
                'error',
                {
                    patterns: [
                        { group: ['@at/tui', '@at/cli'], message: '业务层不能依赖展示层。' },
                        { group: ['ink', 'ink-*', 'react'], message: 'UI 库只允许出现在 src/tui。' },
                        { group: ['../*/*'], message: '跨层引用请使用 @at/* 别名，相对路径仅限本层内部。' },
                    ],
                },
            ],
        },
    },
    {
        // tui 是展示层，只经 ipc 与守护进程对话，不直接调用业务层。
        files: ['src/tui/**'],
        rules: {
            'no-restricted-imports': [
                'error',
                {
                    patterns: [
                        {
                            group: ['@at/*', '!@at/core', '!@at/ipc'],
                            message: 'TUI 只能依赖 @at/core 与 @at/ipc，业务数据一律走 IPC。',
                        },
                        { group: ['../*/*'], message: '跨层引用请使用 @at/* 别名，相对路径仅限本层内部。' },
                    ],
                },
            ],
        },
    },
    {
        // 测试文件中的 ATS fixture 源码本身包含 `${}` 模板语法，属于合法内容
        files: ['tests/**/*.ts'],
        rules: {
            'no-template-curly-in-string': 'off',
        },
    },
    {
        // 端到端验证脚本是独立命令行工具：直接操作 JSON 返回值和打印结果
        files: ['examples/verify-packages.ts'],
        rules: {
            'no-console': 'off',
            '@typescript-eslint/no-unsafe-member-access': 'off',
            '@typescript-eslint/no-unsafe-call': 'off',
        },
    },
    {
        // no-floating-promises 已确保 promise 被消费；`void` 是唯一合法的 fire-and-forget 写法
        rules: {
            'no-void': 'off',
        },
    },
    {
        // 第三方库的 ambient 声明需要保持库自身的命名
        files: ['tests/types/**/*.ts'],
        rules: {
            '@typescript-eslint/naming-convention': 'off',
        },
    },
);
