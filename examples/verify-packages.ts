import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { ulidToDate } from '@at/core';

// 端到端验证脚本：隔离的 LOCALAPPDATA + USERNAME 启动 runtime，
// 安装并运行 examples/task-packages/ 下全部任务包，验证各功能路径。
// 用法：pnpm tsx examples/verify-packages.ts

const ROOT = process.cwd();
const APP_ROOT = join(ROOT, '.tmp', 'verify');
const TEST_USER = `at-verify-${process.pid}`;
const ATP_DIR = join(ROOT, 'examples', 'task-packages');

type TJsonRecord = Record<string, unknown>;

let passed = 0;
let failed = 0;
const failures: string[] = [];

function asRecord(value: unknown): TJsonRecord {
    return value as TJsonRecord;
}

function asArray(value: unknown): TJsonRecord[] {
    return Array.isArray(value) ? (value as TJsonRecord[]) : [];
}

function asString(value: unknown): string {
    return typeof value === 'string' ? value : (JSON.stringify(value) ?? '');
}

function asStringArray(value: unknown): string[] {
    return Array.isArray(value) ? (value as string[]) : [];
}

function check(name: string, ok: boolean, detail: unknown = ''): void {
    if (ok) {
        passed++;
        console.log(`  PASS  ${name}`);
    } else {
        failed++;
        failures.push(name);
        console.log(`  FAIL  ${name}${detail ? ` -> ${asString(detail)}` : ''}`);
    }
}

function cli(args: string[], input?: string): { stdout: string; stderr: string; code: number } {
    const result = spawnSync(process.execPath, ['--import', 'tsx', join(ROOT, 'src', 'cli', 'main.ts'), ...args], {
        cwd: ROOT,
        encoding: 'utf8',
        timeout: 60000,
        input,
        env: { ...process.env, LOCALAPPDATA: APP_ROOT, USERNAME: TEST_USER, USER: TEST_USER },
    });
    return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', code: result.status ?? -1 };
}

function cliJson(args: string[], input?: string): TJsonRecord {
    const result = cli(args, input);
    if (result.stdout.trim() === '') {
        throw new Error(`empty stdout for ${args.join(' ')}: ${result.stderr}`);
    }
    return asRecord(JSON.parse(result.stdout));
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

async function waitForStatus(
    taskId: string,
    targetStatuses: string[],
    timeoutMs: number,
): Promise<TJsonRecord | undefined> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const run = asArray(cliJson(['runs', '--json']).runs).find((entry) => entry.taskId === taskId);
        if (run !== undefined && targetStatuses.includes(asString(run.status))) {
            return run;
        }
        await sleep(300);
    }
    return undefined;
}

async function runTask(
    taskId: string,
    vars: TJsonRecord,
    targetStatuses: string[],
    timeoutMs: number,
): Promise<TJsonRecord | undefined> {
    if (Object.keys(vars).length > 0) {
        const setArgs = ['task', 'config', taskId];
        for (const [k, v] of Object.entries(vars)) {
            setArgs.push('--set', `${k}=${String(v)}`);
        }
        cli(setArgs);
    }
    cliJson(['run', taskId, '--json']);
    return waitForStatus(taskId, targetStatuses, timeoutMs);
}

async function main(): Promise<void> {
    rmSync(APP_ROOT, { recursive: true, force: true });
    mkdirSync(join(APP_ROOT, 'Automatic-Task', 'config'), { recursive: true });
    writeFileSync(
        join(APP_ROOT, 'Automatic-Task', 'config', 'app.json'),
        JSON.stringify({
            version: 1,
            agent: { command: 'node', args: ['-e', "console.log('AGENT-OK: ' + process.argv[1])"] },
        }),
    );

    // 后台启动 runtime（不能阻塞等待，它是常驻进程）
    spawn(process.execPath, ['--import', 'tsx', join(ROOT, 'src', 'runtime', 'main.ts')], {
        cwd: ROOT,
        stdio: 'ignore',
        detached: true,
        env: { ...process.env, LOCALAPPDATA: APP_ROOT, USERNAME: TEST_USER, USER: TEST_USER },
    }).unref();

    let ready = false;
    for (let i = 0; i < 40 && !ready; i++) {
        await sleep(250);
        try {
            ready = cliJson(['status', '--json']).ok === true;
        } catch {
            ready = false;
        }
    }
    check('runtime 启动', ready);

    console.log('\n== 安装 7 个任务包 ==');
    const packages = [
        'hello-world.atp',
        'daily-report.atp',
        'data-clean.atp',
        'retry-demo.atp',
        'backup-demo.atp',
        'upgrade-demo-1.0.0.atp',
        'upgrade-demo-1.1.0.atp',
    ];
    for (const pkg of packages) {
        const result = cli(['install', join(ATP_DIR, pkg), '--yes', '--json']);
        check(`安装 ${pkg}`, asRecord(JSON.parse(result.stdout)).ok === true, result.stderr);
    }

    const taskIds = asArray(cliJson(['list', '--json']).tasks)
        .map((task) => asString(task.taskId))
        .sort();
    check('列表包含 6 个任务', taskIds.length === 6, taskIds.join(','));

    console.log('\n== 1. hello-world：变量与模板 ==');
    let run = await runTask('hello-world', {}, ['success'], 15000);
    check('运行成功', run?.status === 'success', run?.status);
    let logs = asStringArray(cliJson(['logs', 'hello-world', '--json']).lines);
    check('输出含默认变量', logs.join('\n').includes('你好'), logs.join('|'));
    cli(['task', 'config', 'hello-world', '--set', 'greeting=Hello']);
    run = await runTask('hello-world', {}, ['success'], 15000);
    check(
        '覆盖变量后输出 Hello',
        asStringArray(cliJson(['logs', 'hello-world', '--json']).lines)
            .join('\n')
            .includes('Hello'),
    );

    console.log('\n== 2. daily-report：.cmd 脚本 + Agent + Case 分支 + 密码脱敏 ==');
    cli(['task', 'config', 'daily-report', '--set', 'token=secret-x', '--set', 'city=上海', '--set', 'depth=详细']);
    run = await runTask('daily-report', {}, ['success'], 30000);
    check('运行成功', run?.status === 'success', run?.status);
    logs = asStringArray(cliJson(['logs', 'daily-report', '--json']).lines);
    check('fetch 收到城市参数', logs.join('\n').includes('fetching weather data for 上海'), logs.join('|'));
    check('Agent 步骤执行', logs.join('\n').includes('AGENT-OK'), logs.join('|'));
    check('Case(depth==详细) 分支', logs.join('\n').includes('详细日报已生成'), logs.join('|'));
    const metadata = JSON.stringify(run);
    check('元数据密码脱敏', !metadata.includes('secret-x') && metadata.includes('****'));

    console.log('\n== 3. data-clean：多步骤 + Docker + 失败兜底 ==');
    run = await runTask('data-clean', {}, ['success', 'failure'], 60000);
    logs = asStringArray(cliJson(['logs', 'data-clean', '--json']).lines);
    check(
        '步骤链执行',
        logs.join('\n').includes('数据校验通过') && logs.join('\n').includes('数据清洗完成'),
        logs.join('|'),
    );
    check('Docker 步骤有输出（成功或兜底）', logs.join('\n').toLowerCase().includes('docker'), logs.join('|'));
    check('最终状态已结束', run?.status === 'success' || run?.status === 'failure', run?.status);

    console.log('\n== 4. retry-demo：timeout + Failure 分支 ==');
    run = await runTask('retry-demo', { simulateTimeout: 'false' }, ['success'], 30000);
    check('快速路径成功', run?.status === 'success', run?.status);
    check(
        'Success 分支执行',
        asStringArray(cliJson(['logs', 'retry-demo', '--json']).lines)
            .join('\n')
            .includes('任务快速完成'),
        asStringArray(cliJson(['logs', 'retry-demo', '--json']).lines).join('|'),
    );
    cli(['task', 'config', 'retry-demo', '--set', 'simulateTimeout=true']);
    run = await runTask('retry-demo', {}, ['success'], 30000);
    check(
        '超时后 Failure 分支接管',
        run?.status === 'success' &&
            asStringArray(cliJson(['logs', 'retry-demo', '--json']).lines)
                .join('\n')
                .includes('重试逻辑'),
        run?.status,
    );

    console.log('\n== 5. backup-demo：.bat 脚本 + workspace 输出 ==');
    run = await runTask('backup-demo', {}, ['success'], 30000);
    check('运行成功', run?.status === 'success', run?.status);
    logs = asStringArray(cliJson(['logs', 'backup-demo', '--json']).lines);
    check('.bat 收到路径参数', logs.join('\n').includes('backup complete for backup'), logs.join('|'));
    const date = ulidToDate(asString(run?.runId));
    const pad = (n: number): string => String(n).padStart(2, '0');
    const workspaceMarker = join(
        APP_ROOT,
        'Automatic-Task',
        'runs',
        String(date.getFullYear()),
        pad(date.getMonth() + 1),
        pad(date.getDate()),
        asString(run?.runId),
        'workspace',
        'backup',
        'marker.txt',
    );
    const markerFound = existsSync(workspaceMarker) && readFileSync(workspaceMarker, 'utf8').includes('backup-ok');
    check('workspace 标记文件存在', markerFound, workspaceMarker);

    console.log('\n== 6. upgrade-demo：多版本共存 / 升级 / 回滚 ==');
    run = await runTask('upgrade-demo', {}, ['success'], 30000);
    check(
        'v1.0.0 运行（1 步）',
        run?.status === 'success' &&
            asStringArray(cliJson(['logs', 'upgrade-demo', '--json']).lines)
                .join('\n')
                .includes('版本 v1 运行'),
        'v1 check',
    );
    const upgradeConfigFile = join(APP_ROOT, 'Automatic-Task', 'config', 'tasks', 'upgrade-demo.json');
    check('默认使用 1.0.0', asRecord(JSON.parse(readFileSync(upgradeConfigFile, 'utf8'))).packageVersion === '1.0.0');
    cli(['task', 'config', 'upgrade-demo', '--set', 'greeting=upgraded']);
    // 升级到 1.1.0：直接改配置文件里的 packageVersion（演示升级语义）
    const config = asRecord(JSON.parse(readFileSync(upgradeConfigFile, 'utf8')));
    config.packageVersion = '1.1.0';
    writeFileSync(upgradeConfigFile, JSON.stringify(config, undefined, 2));
    run = await runTask('upgrade-demo', {}, ['success'], 30000);
    const upgradedLogs = asStringArray(cliJson(['logs', 'upgrade-demo', '--json']).lines).join('\n');
    check(
        '1.1.0 运行（2 步）',
        upgradedLogs.includes('版本 upgraded 运行') && upgradedLogs.includes('v2 新增的第二步执行'),
        upgradedLogs,
    );
    // 回滚到 1.0.0
    config.packageVersion = '1.0.0';
    writeFileSync(upgradeConfigFile, JSON.stringify(config, undefined, 2));
    run = await runTask('upgrade-demo', {}, ['success'], 30000);
    const rollbackLogs = asStringArray(cliJson(['logs', 'upgrade-demo', '--json']).lines).join('\n');
    check(
        '回滚到 1.0.0（1 步）',
        rollbackLogs.includes('版本 upgraded 运行') && !rollbackLogs.includes('v2 新增'),
        rollbackLogs,
    );

    console.log('\n== 7. 停止运行中的任务 ==');
    cli(['task', 'config', 'backup-demo', '--set', 'slow=true']);
    const stopRun = cliJson(['run', 'backup-demo', '--json']);
    await sleep(1500);
    const stopped = cliJson(['stop', asString(stopRun.runId), '--json']);
    check('stop 返回 ok', stopped.ok === true);
    const stoppedRun = await waitForStatus('backup-demo', ['cancelled'], 30000);
    check('任务被取消', stoppedRun?.status === 'cancelled', stoppedRun?.status);
    cli(['task', 'config', 'backup-demo', '--set', 'slow=false']);

    console.log('\n== 8. overlap=queue：排队执行 ==');
    cli(['task', 'config', 'backup-demo', '--set', 'slow=true']);
    const backupConfigFile = join(APP_ROOT, 'Automatic-Task', 'config', 'tasks', 'backup-demo.json');
    const backupConfig = asRecord(JSON.parse(readFileSync(backupConfigFile, 'utf8')));
    backupConfig.overlap = 'queue';
    writeFileSync(backupConfigFile, JSON.stringify(backupConfig, undefined, 2));
    const queueRun1Id = asString(cliJson(['run', 'backup-demo', '--json']).runId);
    const queueRun2Id = asString(cliJson(['run', 'backup-demo', '--json']).runId);
    const queueRunIds = new Set([queueRun1Id, queueRun2Id]);
    const queuedRuns = (): TJsonRecord[] =>
        asArray(cliJson(['runs', '--json']).runs).filter((entry) => queueRunIds.has(asString(entry.runId)));
    await sleep(800);
    check(
        '第二个 run 为 queued',
        queuedRuns().find((entry) => entry.runId === queueRun2Id)?.status === 'queued',
        asString(queuedRuns().find((entry) => entry.runId === queueRun2Id)?.status),
    );
    cli(['stop', queueRun1Id]);
    await sleep(1000);
    const queueRun2Done = await waitForStatus('backup-demo', ['cancelled', 'success'], 30000);
    check(
        '第一个取消后第二个出队执行',
        queueRun2Done !== undefined && asString(queueRun2Done.runId) === queueRun2Id,
        'timeout',
    );
    cli(['task', 'config', 'backup-demo', '--set', 'slow=false']);

    console.log('\n== 9. 调度器：cron 自动触发 ==');
    cli(['task', 'schedule', 'hello-world', '* * * * *']);
    cli(['task', 'enable', 'hello-world']);
    let scheduled = false;
    const deadline = Date.now() + 75000;
    while (Date.now() < deadline && !scheduled) {
        scheduled = asArray(cliJson(['runs', '--json']).runs).some(
            (entry) => entry.taskId === 'hello-world' && entry.trigger === 'schedule' && entry.status === 'success',
        );
        await sleep(1000);
    }
    check('调度器自动触发（约 60 秒内）', scheduled);
    cli(['task', 'disable', 'hello-world']);
    cli(['task', 'schedule', 'hello-world']);

    console.log('\n== 10. 错误路径 ==');
    check('未知任务退出码 3', cli(['run', 'no-such-task', '--json']).code === 3);
    check('非法命令退出码 2', cli(['definitely-not-a-command']).code === 2);
    check(
        '损坏包退出码 4',
        (() => {
            const bad = join(APP_ROOT, 'bad.atp');
            writeFileSync(bad, 'not a zip');
            return cli(['install', bad, '--yes', '--json']).code === 4;
        })(),
    );
    check('JSON 模式错误时 stdout 为空', cli(['run', 'no-such-task', '--json']).stdout.trim() === '');

    console.log('\n== 清理 ==');
    const stopScript = `
import { IpcClient } from '@at/ipc';
import { PathService, PlatformService } from '@at/paths';
const paths = new PathService(new PlatformService());
const client = new IpcClient(paths.GetRuntimeSocketPath());
await client.Connect();
await client.SendRequest('runtime.shutdown', {});
client.Close();
`;
    writeFileSync(join(ROOT, '.tmp', 'verify-shutdown.mts'), stopScript);
    spawnSync(process.execPath, ['--import', 'tsx', join(ROOT, '.tmp', 'verify-shutdown.mts')], {
        cwd: ROOT,
        encoding: 'utf8',
        env: { ...process.env, LOCALAPPDATA: APP_ROOT, USERNAME: TEST_USER, USER: TEST_USER },
    });
    rmSync(join(ROOT, '.tmp', 'verify-shutdown.mts'), { force: true });
    await sleep(1000);
    rmSync(APP_ROOT, { recursive: true, force: true });

    console.log(`\n===== 结果：${passed} 通过 / ${failed} 失败 =====`);
    if (failed > 0) {
        console.log('失败项：');
        for (const name of failures) {
            console.log(`  - ${name}`);
        }
        process.exit(1);
    }
    process.exit(0);
}

void main();
