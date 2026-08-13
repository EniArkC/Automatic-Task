using System.Diagnostics;

namespace AutomaticTask.Tray;

// 单可执行文件入口：双击（或脱离父控制台启动）进入托盘；
// 从终端运行时附加到父控制台并把命令行转发给内嵌 CLI，
// 一个二进制同时服务桌面与命令行。
internal static class Program
{
    [STAThread]
    private static int Main(string[] args)
    {
        EmbeddedPayload.Ensure();

        // 只要带参数就进入 CLI 模式（仅单独的 --background 自启开关除外）：
        // 脚本中无控制台运行 `autotask run ...` 也必须执行并退出，而不是开托盘。
        // 命令行中段的 --background 对 CLI 是未知选项。
        bool bareBackground = args.Length == 1 && args[0] == "--background";
        if (args.Length > 0 && !bareBackground)
        {
            return ConsoleForwarder.RunCli(args);
        }

        // 托盘每个交互会话仅一个实例；用 Local 命名空间（普通用户无需 SeCreateGlobalPrivilege）并按会话隔离。
        Mutex? mutex = null;
        bool createdNew = true;
        try
        {
            mutex = new Mutex(true, "Local\\AutomaticTask.Tray", out createdNew);
        }
        catch (UnauthorizedAccessException)
        {
            // 退化为进程内守卫：仍保证单实例，重复启动直接退出。
            createdNew = !TrayLocalGuard.Instance.Held;
            TrayLocalGuard.Instance.Held = true;
        }
        if (!createdNew)
        {
            mutex?.Dispose();
            return 0;
        }

        using (mutex)
        {
            RunTrayLoop();
            return 0;
        }
    }

    private static void RunTrayLoop()
    {
        // 进入托盘前先确保 runtime 已启动。此处尚无消息循环，异步客户端在线程池上完成，阻塞等待不会死锁。
        var client = new RuntimeClient();
        bool Ping() => client.PingAsync().GetAwaiter().GetResult();
        if (!Ping())
        {
            StartRuntime();
            for (int attempt = 0; attempt < 20 && !Ping(); attempt++)
            {
                Thread.Sleep(250);
            }
        }

        ApplicationConfiguration.Initialize();
        Application.Run(new TrayApplicationContext());
    }

    // 会话互斥体创建失败（如特殊权限环境）时的进程内单实例兜底。
    private sealed class TrayLocalGuard
    {
        public static readonly TrayLocalGuard Instance = new();
        public bool Held;
    }

    // 无窗口启动 runtime 守护进程（GUI 父进程 + CreateNoWindow 不会出现控制台窗口）。
    // runtime 缺失不能拖垮托盘；上面的 ping 循环会持续失败重试。
    private static void StartRuntime()
    {
        try
        {
            Process.Start(new ProcessStartInfo
            {
                FileName = StartupManager.ResolveRuntimeExecutable(),
                Arguments = StartupManager.ResolveRuntimeArguments(),
                UseShellExecute = false,
                CreateNoWindow = true,
            });
        }
        catch
        {
            // 忽略：托盘保持存活，下次启动时重试。
        }
    }
}
