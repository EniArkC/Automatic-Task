# Automatic-Task

本地自动化任务运行器：用 `.atp` 任务包（ZIP）安装任务，用 `.ats`（Automatic-Task Script）描述任务流程，支持脚本、AI Agent、Docker 三种执行方式，带 CLI、TUI 与 Windows 托盘三种界面。

```bash
autotask install daily-report.atp
autotask task enable daily-report
autotask task schedule daily-report "*/30 * * * *"
autotask run daily-report
```

## 构建

```bash
pnpm install
pnpm build && pnpm package
```

- 前置：Node ≥20.11、pnpm、.NET 9 SDK。
- `pnpm build`：esbuild → `dist/at.js`。
- `pnpm package`：pkg 打包 → 内嵌进 C# 外壳 → `dist/autotask.exe`（**唯一发布物**，自包含，目标机无需 Node/.NET）。
- 技术细节见 `doc/`（runtime / tui / tray）。

## 使用

### 发布版

单个 `dist/autotask.exe`：

- **双击 / 无参数**：托盘 + 自动拉起 runtime。
- **终端带参数**：CLI（如 `autotask list`）；交互终端下 TUI 完整可用。
- 首次运行自动释放内部组件到 `%LOCALAPPDATA%\Automatic-Task\bin\`（只一次）。
- 数据与配置在 `%LOCALAPPDATA%\Automatic-Task\`：卸载 = 删除该目录。
- 建议把 exe 所在目录加入 PATH。

### 开发模式

```bash
pnpm dev:cli -- status       # 运行 CLI（自动拉起 runtime）
pnpm run dev:runtime         # 单独启动 runtime（前台）
pnpm dev:cli tui             # TUI
```

### CLI 命令

```bash
autotask                              # 发布版：托盘；开发模式：TUI
autotask tui                          # 打开 TUI
autotask list [--json]                # 已安装任务
autotask run <taskId> [--json]        # 手动运行（立即返回 runId）
autotask install <file.atp> [--yes] [--json]
autotask uninstall <taskId> [--yes] [--json]
autotask task enable <taskId>
autotask task disable <taskId>
autotask task schedule <taskId> [cron]    # 省略 cron 清除调度
autotask task config <taskId> [--set k=v]...
autotask status / ps / runs [--limit N]
autotask runs-prune [--days N]
autotask stop <runId>
autotask logs <taskId> [--lines N]
```

- `--json` 时 stdout 只有 JSON，提示与错误走 stderr。
- 退出码：0 成功 · 2 参数错误 · 3 任务不存在 · 4 包无效 · 5 runtime 不可用 · 6 执行失败 · 7/8 运行结果状态（超时/取消）。

### TUI

仪表盘（任务/运行记录双栏）→ 配置页（任务参数）→ 设置页（全局配置）→ 日志页，外加命令面板（`^P`）、文件选择器、确认框。

快捷键：`Tab` 切栏 · `↵` 打开（任务栏=配置，运行栏=日志）· `e` 运行 · `空格` 启停 · `x` 停止 · `r` 刷新 · `^P` 命令面板 · `q` 退出；配置页 `s` 保存。安装/卸载任务包在命令面板里。

### 托盘

双击进入；菜单：打开界面 / 日志 / 开机自启 / 退出。托盘轮询显示 runtime 连接状态（未连接时保留托盘，仅菜单标注）。

## ATS 语法

任务逻辑写在 `task.ats`，固定结构：

```text
@var city: string = "北京"          # 要生成日报的城市
@var token: password!               # 抓取接口的访问令牌
@var depth: select("简版", "详细") = "简版"

[Start]

-> [Script(`scripts/fetch.bat ${city}`)]

-> [Agent(`为 ${city} 生成日报`, timeout: 600)]

-> [Select]

    -> [Failure]
        -> [Script(`echo 失败`)]

    -> [Case(${depth} == "详细")]
        -> [Script(`echo 详细`)]

    -> [Default]
        -> [Script(`echo 兜底`)]

[End]
```

### 变量

`@var 名称: 类型 [!] [= 默认值] [# 说明]`

| 类型             | 说明                                |
| ---------------- | ----------------------------------- |
| string / text    | 字符串 / 长文本                     |
| password         | 密码（日志与元数据中脱敏为 `****`） |
| number / boolean | 数字 / 布尔                         |
| path             | 路径字符串                          |
| select("A","B")  | 选项枚举（默认值必须在选项内）      |

变量名 `[a-zA-Z_][a-zA-Z0-9_]*`，不能与关键字（Start/End/Select/Success/Failure/Default/Case）重名。必填变量无值时校验失败。

声明行尾的 `#` 注释即该参数的说明，配置界面选中该参数时显示；没写时回退为类型与默认值。只有与 `@var` 同一行的注释算说明，独立成行的注释仍然只是注释。

### 步骤

| 步骤                                                  | 说明                                                                                                 |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `[Script(`命令`)]`                                    | 命令相对包目录解析；`.bat/.cmd` 经 `cmd /d /s /c` 执行（参数原样传递）；其余命令直接以参数数组 spawn |
| `[Agent(`提示词`, timeout: 秒)]`                      | 调用 Agent 命令（默认 `pi`，可在 app.json 配置 command/args/model）                                  |
| `[Docker(`镜像`, `命令`, timeout: 秒, remove: true)]` | `docker run`；默认 `--rm`；宿主 workspace 挂载到容器 `/workspace`                                    |

公共参数：`timeout`（秒，正数字面量或单个 `number` 变量引用，如 `timeout: ${secs}`）；Docker 另有 `remove`（默认 true）。

### 分支与表达式

- `[Select]` 按声明序匹配：`Success`（上一步成功或还没有步骤）→ `Failure`（失败/超时/取消）→ `Case(条件)` → `Default`，只执行第一个匹配。
- 无分支匹配且无 Default：run 以 `skipped` 结束并中断链。
- 失败/超时/取消不中断链（留给后续 Select 处理）；`autotask stop` 立即终止。
- 表达式：`== != > >= < <=`、`&& || !`；比较在声明类型一致时进行。
- 模板：反引号内 `${变量}` 替换为运行时值；`Case(${x} == "a")` 中可直接用 `${...}`。
- 行注释 `#`；缩进用空格（Tab 报错）；空行不影响缩进。

### 校验

安装与运行时都会校验：Start/End 必须存在且唯一；变量不重名、默认值类型匹配、select 默认值在选项内；步骤参数合法、timeout 为正数或 `number` 变量；Select 分支不重复、Case 表达式合法；模板引用的变量必须已声明。

## 包结构（.atp）

ZIP 包，固定包含 `manifest.json` 与 `task.ats`，可选 `scripts/`、`assets/`、`README.md`：

```json
{
    "spec": "atp/v1",
    "id": "daily-report",
    "name": "Daily Report",
    "version": "1.0.0"
}
```

- `id` 匹配 `^[a-z0-9-]{3,64}$`，`version` 为 SemVer。
- 禁止 `schedule/enabled/cron/variables/userConfig` 等用户配置字段。
- 安装安全：Zip Slip 防护、解压前全量校验、临时目录 + 原子 rename、同版本重复安装报错；不同版本可共存，切换运行版本（升级/回滚）编辑 `config/tasks/<id>.json` 的 `packageVersion` 即可。

## 示例

`examples/task-packages/` 下 8 个示例（源码 + 构建产物）：

```bash
node examples/build-packages.mjs        # 重建 .atp
autotask install examples/task-packages/hello-world.atp --yes
autotask run hello-world
pnpm tsx examples/verify-packages.ts    # 端到端验证全部示例
```

## 安全

- `.atp` 可执行任意脚本，安装前确认来源（CLI 默认 y/N 确认）。
- 程序不修改 PATH / shell 配置 / 全局包；不自装 Node/Python/Docker。
- 密码类变量在日志、事件、run 元数据、CLI 回显中一律脱敏。
- 卸载 = 删除 `%LOCALAPPDATA%\Automatic-Task\`。
