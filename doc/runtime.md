# Runtime 技术文档

Runtime 是唯一执行任务的守护进程：解析 ATS、调度任务、管理运行记录，并通过 IPC 向 CLI/TUI/托盘提供服务。单实例、常驻、无窗口。

## 进程模型

### 单实例

- 每个 Windows 用户全局只有一个 runtime，按用户隔离（IPC 管道名含用户名）。
- 双保险：启动前 ping 探测（已存在则退出）；托盘持有会话级互斥体。
- 并发拉起竞态：绑定管道失败（EADDRINUSE）的实例静默退出，不崩溃。

### 启动与拉起

- 发布形态：CLI 与 runtime 合并进同一个 pkg exe，`--runtime-daemon` 隐藏参数切换角色；`runtime-launcher.ts` 在 pkg 环境用 `process.execPath + '--runtime-daemon'` 拉起自身（需设置 `PKG_EXECPATH` 防止 pkg 子进程误判为普通 node）。
- 开发形态（esbuild bundle）：`node dist/at.js --runtime-daemon`。
- tsx 开发：`node --import tsx src/runtime/main.ts`。
- 拉起方式：`detached + stdio ignore + windowsHide`，与启动者终端无关；CLI 拉起后轮询 ping（10 秒超时）。
- 退出方式：IPC `runtime.shutdown`（100ms 后 Stop）或 SIGINT/SIGTERM（停 runtime 后延迟 2.5s 退出，等 taskkill 进程树收敛）。

## 数据目录

`%LOCALAPPDATA%\Automatic-Task\`（Linux 遵循 XDG）：

```
config/app.json          全局配置（agent/logging/cleanup）
config/tasks/<id>.json   任务配置（用户所有）
packages/<id>/<version>/ 已安装任务包（只读，可多版本共存）
runs/<年>/<月>/<日>/<runId>/   运行记录（按 ULID 时间分目录）
  metadata.json          runId/taskId/status/trigger/变量(脱敏)/错误
  stdout.log / stderr.log
  events.jsonl           步骤级事件
  workspace/             任务工作目录
logs/runtime.log         日志（10MB × 5 轮转）
runtime/runtime.lock     单例标记（记录 pid 与启动时间）
```

配置写入原子化（tmp + rename），损坏时备份为 `*.corrupt-<时间戳>`。

## IPC 协议

- 传输：Windows Named Pipe `\\.\pipe\automatic-task-runtime-<user>` / Linux Unix Socket。
- 帧：JSON Lines（一行一个消息，UTF-8 安全，1MB 上限）。
- 协议版本：`at/ipc/v1`；连接超时 2s，请求超时 30s。
- 错误响应带 `exitCode`，CLI 据此映射退出码。

### 方法

| 组 | 方法 |
|----|------|
| runtime | ping / status / shutdown |
| app | get / set（app.json 读取与 patch 保存） |
| task | list / get / schema / installInfo / install / uninstall / enable / disable / setSchedule / setConfig / run |
| run | get / list / stop / cancel / prune |
| logs | tail（支持按 runId 取指定运行） |

关键参数：

- `task.setConfig`：`{ taskId, patch: { variables, overlap } }`，增量合并（未提及的键保留）。
- `task.schema`：返回 `@var` 声明（类型/必填/默认值/选项/行尾注释给出的说明）+ 已配置值，供配置表单渲染；password 不回显明文，只给 `hasConfigured`。
- `app.set`：`{ patch: { agent, logging, cleanup } }`，全字段校验；`logging.level` 保存后实时生效。
- `logs.tail`：`{ taskId, runId?, lines? }`，无 runId 取该任务最新运行。
- 事件（服务端推送）：`run.step.output`（顶层 `data` 字段为输出片段）、`run.started/finished/failed/cancelled`、`task.installed/uninstalled/enabled/disabled`。

## 任务配置（task config）

`config/tasks/<taskId>.json`，字段：`taskId` / `packageVersion`（选择运行版本）/ `enabled`（是否允许调度）/ `schedule.cron`（系统本地时区）/ `overlap`（skip/queue/parallel）/ `variables`。

- 安装任务时若无配置则创建默认（disabled、无调度、skip、空变量）；已有配置不受影响（多版本共存，升级/回滚通过 `packageVersion`）。
- 变量解析优先级：声明默认值 → 保存的配置 → 运行覆盖；数字/布尔按声明类型强制转换（CLI `--set` 传入字符串）。
- 密码类变量在日志、事件、run 元数据、CLI 回显中一律脱敏为 `****`。

## ATS 执行

- 校验：安装时与每次运行时都做（解析 + 校验器）。
- 步骤：Script（包内脚本/命令）、Agent（可配置命令）、Docker；支持 `timeout`、`remove`。
- 分支：`[Select]` 内 `Success / Failure（含超时/取消）/ Case(条件) / Default`，按声明序第一个匹配。
- 链模型：失败/超时/取消不中断链（留给后续 Select 处理）；Select 无匹配（skipped）中断链；Abort 立即终止。
- 表达式：`== != > >= < <=`、`&& || !`（短路求值）；模板按原样传递。
- 包内脚本相对包目录解析；`.bat/.cmd` 经 `cmd /d /s /c` 执行；Docker 挂载 workspace 到 `/workspace`。

## 执行引擎

- 子进程：统一 ProcessRunner——可超时、可取消、进程树终止（Windows `taskkill /T`、POSIX 进程组）、输出上限（5MB）。
- 超时：先优雅终止，宽限 3 秒后强制；Windows 无窗口进程优雅终止无效，走强制路径。
- run 目录由 RunFiles 持久化：stdout/stderr 增量追加，事件 JSONL，metadata 原子写。
- 崩溃恢复：启动时将 running/queued 的遗留 run 标记为 interrupted。
- 清理：`runs.prune`（删整个 run 目录，按保留天数，跳过运行中的 run）。
- 自动清理：启动时执行一次，之后每小时一次。读 `app.json` 的 `cleanup`（每次重新读，`app.set` 改完立刻生效）：`keepWorkspaceDays`（默认 7）只删 run 目录下的 `workspace/`，`keepRunsDays`（默认 30）删整个 run 目录。**任一项为 0 表示关闭该项自动清理**（0 天等价于立即删光，不该是自动行为；手动全清仍走 `runs.prune days=0`）。

## 调度器

- 1 秒粒度轮询启用且有 cron 的任务，用 croner 计算下次触发（DST 安全）。
- 首次触发只排程不立即执行；cron 永不触发（如 2 月 30 日）会丢弃排程防死循环。
- 非法 timezone 导致的解析异常被隔离，不崩溃调度循环。
- 触发通过 RunManager.Start 走 overlap 策略。

## 日志

- 级别 debug/info/warn/error，默认 info，可被 app.json `logging.level` 覆盖（启动时读取，保存时实时生效）。
- 轮转 10MB × 5 份；写入失败降级到 stderr，不崩溃。
- 敏感键（password/token/secret/apiKey/authorization 等）自动脱敏。

## 安全

- `.atp` 安装走临时目录 + 原子 rename；Zip Slip 防护（拒绝绝对路径与 `..` 穿越）；解压前全量校验。
- 包 manifest 禁止 `schedule/enabled/cron/variables/userConfig` 等用户配置键。
- 密码变量不回显、日志脱敏、run 元数据脱敏。
