using System.Diagnostics;

namespace AutomaticTask.Tray;

// 托盘是 runtime 的轻量启动器：后台模式拉起 at.exe，
// 按需打开 TUI 并转发关闭请求。
public sealed class TrayApplicationContext : ApplicationContext
{
    // 最近一次 runtime ping 的结果。工作线程写入、UI 线程读取，
    // 字段不得被缓存到寄存器。
    private enum EPingState
    {
        Unknown,
        Connected,
        Down,
    }

    private const int StatusPollMs = 5000;

    // 状态行禁用后不可点击，但 WinForms 会把禁用项一律涂成系统灰，
    // 无视 ForeColor。用类型标记该项，让下方渲染器单独处理。
    private sealed class StatusMenuItem(string text) : ToolStripMenuItem(text);

    // 保持默认菜单外观，只接管状态行的文字绘制，否则其颜色会被禁用的灰色盖掉。
    private sealed class StatusColorRenderer : ToolStripProfessionalRenderer
    {
        protected override void OnRenderItemText(ToolStripItemTextRenderEventArgs e)
        {
            if (e.Item is StatusMenuItem)
            {
                TextRenderer.DrawText(e.Graphics, e.Text, e.TextFont, e.TextRectangle, e.Item.ForeColor, e.TextFormat);
                return;
            }
            base.OnRenderItemText(e);
        }
    }

    private readonly NotifyIcon _notifyIcon;
    private readonly RuntimeClient _runtimeClient = new();
    private readonly ToolStripMenuItem _startOnBootItem;
    private readonly StatusMenuItem _statusItem;
    private readonly System.Windows.Forms.Timer _statusTimer;
    private volatile EPingState _pingState = EPingState.Unknown;
    private int _pingPending;
    // UI 线程的 WinForms 同步上下文。让 ping 结束后立即刷新菜单，
    // 不必等下一个 tick，菜单开着时也能自我修正。
    private SynchronizationContext? _uiContext;
    // 跟踪托盘打开的 TUI 窗口，随托盘一并关闭；用户自己开的终端不受影响。
    private readonly List<Process> _tuiProcesses = [];

    public TrayApplicationContext()
    {
        var menu = new ContextMenuStrip { Renderer = new StatusColorRenderer() };
        // 仅作展示：runtime 可能自行死亡（任务管理器结束、崩溃）而托盘仍在，
        // 别无他处能显示。禁用而非仅不挂事件，让它明确是状态行而非命令。
        _statusItem = new StatusMenuItem(StatusText(EPingState.Unknown))
        {
            Enabled = false,
            ForeColor = StatusColor(EPingState.Unknown),
        };
        menu.Items.Add(_statusItem);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("打开界面", null, (_, _) => OpenTui());
        menu.Items.Add("日志", null, (_, _) => OpenLogs());
        menu.Items.Add(new ToolStripSeparator());
        _startOnBootItem = new ToolStripMenuItem("开机自启", null, (_, _) => ToggleStartOnBoot())
        {
            Checked = StartupManager.IsEnabled(),
        };
        menu.Items.Add(_startOnBootItem);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("退出", null, (_, _) => ExitApplication());

        _notifyIcon = new NotifyIcon
        {
            Text = "Automatic-Task",
            // 托盘使用与 exe 内嵌相同的图标。
            Icon = Icon.ExtractAssociatedIcon(Environment.ProcessPath) ?? SystemIcons.Application,
            ContextMenuStrip = menu,
            Visible = true,
        };
        _notifyIcon.DoubleClick += (_, _) => OpenTui();
        _notifyIcon.MouseUp += (_, e) =>
        {
            if (e.Button == MouseButtons.Right)
            {
                _startOnBootItem.Checked = StartupManager.IsEnabled();
                // 打开菜单才是真正查看状态的时刻：先刷新上次轮询结果再发起新 ping，
                // 避免几秒前已死的 runtime 仍显示为已连接。
                ApplyPingState();
                QueuePing();
            }
        };

        // 后台轮询让气泡提示（以及下次菜单打开）保持真实，即使菜单从未打开。
        // Tick 跑在 UI 线程，从这里发起 ping 无需封送。间隔刻意放宽：这是存活指示，不是心跳。
        _statusTimer = new System.Windows.Forms.Timer { Interval = StatusPollMs };
        _statusTimer.Tick += (_, _) =>
        {
            // 双保险：即使构造时上下文不可用，tick 仍应用最近一次 ping 的结果。
            _uiContext ??= SynchronizationContext.Current;
            ApplyPingState();
            QueuePing();
        };
        _statusTimer.Start();
        // 上面创建菜单与托盘图标已在本线程装上 WinForms 同步上下文；
        // 在这里捕获，连第一次 ping 都能立即刷新显示而无需等一个 tick。
        _uiContext = SynchronizationContext.Current;
        QueuePing();
    }

    private static string StatusText(EPingState state) => state switch
    {
        EPingState.Connected => "● 已连接",
        EPingState.Down => "○ 未连接",
        _ => "◌ 检测中…",
    };

    // 比纯色更深，保证浅色菜单背景上文字可读；灰色本就是禁用项的观感。
    private static Color StatusColor(EPingState state) => state switch
    {
        EPingState.Connected => Color.FromArgb(0x1E, 0x8E, 0x3E),
        EPingState.Down => Color.FromArgb(0xC5, 0x22, 0x1F),
        _ => Color.FromArgb(0x80, 0x80, 0x80),
    };

    // 在 UI 线程之外 ping，结果一落地立即折回。重叠轮询直接丢弃：
    // ping 可能阻塞到连接超时，排队只会让显示越发滞后。
    private void QueuePing()
    {
        if (Interlocked.CompareExchange(ref _pingPending, 1, 0) != 0)
        {
            return;
        }
        _ = Task.Run(async () =>
        {
            try
            {
                _pingState = await _runtimeClient.PingAsync() ? EPingState.Connected : EPingState.Down;
            }
            catch
            {
                _pingState = EPingState.Down;
            }
            finally
            {
                Volatile.Write(ref _pingPending, 0);
            }
            // 封送回 UI 线程：WinForms 控件只能由创建它的线程操作。
            _uiContext?.Post(_ => ApplyPingState(), null);
        });
    }

    private void ApplyPingState()
    {
        EPingState state = _pingState;
        _statusItem.Text = StatusText(state);
        _statusItem.ForeColor = StatusColor(state);
        // shell 将 NotifyIcon.Text 限制在 63 字符内；两种文案都远低于上限。
        _notifyIcon.Text = state == EPingState.Down ? "Automatic-Task（未连接）" : "Automatic-Task";
    }

    private void OpenTui()
    {
        // TUI 需要控制台二进制；at.exe 缺失或错位不能拖垮整个托盘。
        try
        {
            Process? process = Process.Start(new ProcessStartInfo
            {
                FileName = StartupManager.ResolveCliExecutable(),
                Arguments = "tui",
                UseShellExecute = false,
                CreateNoWindow = false,
            });
            if (process != null)
            {
                _tuiProcesses.Add(process);
            }
        }
        catch (Exception error)
        {
            MessageBox.Show($"无法打开 Automatic-Task 终端界面：{error.Message}", "Automatic-Task", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
    }

    private void OpenLogs()
    {
        Process.Start(new ProcessStartInfo
        {
            FileName = "explorer.exe",
            Arguments = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Automatic-Task", "logs"),
            UseShellExecute = true,
        });
    }

    private void ToggleStartOnBoot()
    {
        if (_startOnBootItem.Checked)
        {
            StartupManager.Disable();
            _startOnBootItem.Checked = false;
        }
        else
        {
            StartupManager.Enable();
            _startOnBootItem.Checked = true;
        }
    }

    private void ExitApplication()
    {
        _statusTimer.Stop();
        _statusTimer.Dispose();
        _notifyIcon.Visible = false;
        // 先关闭托盘打开的 TUI 窗口，再停 runtime。关闭请求会阻塞到写入完成
        // （或 runtime 不可达）；随后 runtime 自行停止并结束其子进程。
        foreach (Process process in _tuiProcesses)
        {
            try
            {
                if (!process.HasExited)
                {
                    process.Kill();
                }
            }
            catch
            {
                // TUI 可能已被用户自行关闭。
            }
        }
        _runtimeClient.RequestShutdown();
        Application.Exit();
    }
}
