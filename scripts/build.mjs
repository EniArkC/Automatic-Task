import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');

// ink（及其 widest-line/cli-truncate 依赖）使用 string-width v7，
// 其宽度测量调用 Intl.Segmenter；pkg 内嵌的 small-icu Node 构建中
// Segmenter.segment() 会抛异常，拖垮 TUI。别名到 string-width v4，
// 它是纯正则实现，API 面一致。
const stringWidthV4 = join(
    root,
    'node_modules',
    '.pnpm',
    'string-width@4.2.3',
    'node_modules',
    'string-width',
    'index.js',
);

async function main() {
    mkdirSync(dist, { recursive: true });

    const common = {
        bundle: true,
        platform: 'node',
        target: 'node20',
        format: 'esm',
        sourcemap: false,
        minify: false,
        logLevel: 'info',
        alias: { 'string-width': stringWidthV4 },
    };

    await build({
        ...common,
        entryPoints: [join(root, 'src', 'cli', 'main.ts')],
        outfile: join(dist, 'at.js'),
        // 打包进来的 CJS 依赖偶尔会动态调用 require()（yauzl 以这种方式
        // 解析 node 内建模块）；该 shim 让它们在 ESM 输出中继续可用。
        banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
    });

    console.log('Build complete: dist/at.js');
}

void main();
