# 托盘技术文档

托盘是 C#（net9.0-windows）GUI 外壳，唯一发布物 `autotask.exe` 的宿主：内嵌并释放唯一内部 exe、以双模式运行（托盘/CLI 转发）、watchdog 监控 runtime 共存亡。

## 单 exe 架构

- 发布物：`autotask.exe`（自包含 .NET 单文件，GUI 子系统）。
- 内部 exe：一个 `at.exe`（pkg 打包，宿主 CLI + runtime，`--runtime-daemon` 参数切换角色）。
- 首次运行释放到 `%LOCALAPPDATA%\Automatic-Task\bin\at.exe`：
  - SHA-256 内容哈希缓存（`.hash` 文件），相同则不重复释放；
  - 并发安全：唯一临时文件名 + 原子移动；
  - 占用降级：内部 exe 正在运行导致覆盖失败时保留旧版，下次启动再替换；
  - 自动清理历史遗留（旧版 at-cli.exe / at-runtime.exe 及其 hash）。
- 打包（scripts/package.mjs）：esbuild → `dist/at.js` → pkg → `apps/tray/embedded/at.exe`（EmbeddedResource）→ `dotnet publish`（`RequireEmbeddedPayload` 强制资源存在）→ `dist/autotask.exe`。

## 双模式入口（Program.cs）

- 有参数且非恰好 `--background`：CLI 模式——`ConsoleForwarder.RunCli` 转发到内部 `at.exe`，退出码透传。
- 无参数或 `--background`：托盘模式——先确保 runtime 就绪（ping 失败则启动 runtime 并轮询 5 秒，仍失败则进入托盘显示未连接）。
- 单实例：会话级互斥体（`Local\AutomaticTask.Tray`），创建失败降级为进程内标志。

## CLI 转发（ConsoleForwarder.cs）

GUI 进程无控制台，需把终端上下文交给内部 CLI：

- 三种宿主分别处理：
  - 交互终端：`AttachConsole(父进程)`，内部 CLI（控制台子系统）自动继承该控制台，TUI 完整可用且不弹新窗口；
  - 重定向/管道：`GetStdHandle` 有效管道/文件句柄经 `STARTF_USESTDHANDLES` 透传，`CREATE_NO_WINDOW` 隐藏子进程；
  - 无控制台也无重定向（GUI 宿主/计划任务）：`CREATE_NO_WINDOW` 防止弹出控制台窗口。
- 命令行拼接按 MSVCRT 规则转义（引号、尾部反斜杠翻倍）。
- 已知限制：`cmd /c "autotask ..."` 的重定向输出不可达（cmd 不向 GUI 子进程传递 std 句柄）；PowerShell/Node 直调与真实终端正常。

## Runtime 协作（RuntimeClient.cs）

- 管道名与 TS 侧同源（优先 `USERNAME` 环境变量，回退 Windows 身份），保证托盘与 CLI/runtime 连同一个管道。
- 请求体为协议契约（`protocol/id/method/params`），`params` 键显式映射，避免 C# 属性名泄漏。
- `PingAsync`：启动就绪探测与 watchdog 心跳。
- `RequestShutdown`：同步发送 shutdown（UI 线程退出时不得异步等待导致死锁），runtime 收到后停止自身与所有任务子进程。

## Watchdog（TrayApplicationContext.cs）

- 5 秒定时器轮询 runtime：成功→菜单状态"已连接"，失败→"未连接"，恢复自动刷新。
- 托盘不随 runtime 退出：runtime 停止（命令行 shutdown、直接杀进程）后托盘保留并显示"未连接"，退出只经菜单。
- 退出链路：先关掉托盘打开的 TUI 窗口（记录启动的进程并 Kill）→ 同步发 shutdown → 退出。

## 托盘 UI

- 菜单（中文）：打开界面（启动内部 CLI 的 TUI，新建控制台窗口）/ 日志（资源管理器打开日志目录）/ 开机自启 / 退出。
- 图标：内嵌 exe 图标（`Icon.ExtractAssociatedIcon`）。
- 开机自启：HKCU `Run` 写入 `autotask.exe --background`。
- runtime 启动：内部 `at.exe --runtime-daemon`（bin 目录优先，回退 AT_EXE_PATH / 同目录）。

## 构建

```bash
pnpm build          # esbuild → dist/at.js
pnpm package        # pkg → embedded → dotnet publish → dist/autotask.exe
```

需要 Node ≥20.11、pnpm、.NET 9 SDK。产物自包含（目标机无需 Node/.NET）。
