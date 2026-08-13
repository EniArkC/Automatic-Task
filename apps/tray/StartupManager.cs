using Microsoft.Win32;

namespace AutomaticTask.Tray;

// 注册/移除每用户自启动项；绝不触碰 HKLM 或要求提权。
public static class StartupManager
{
    private const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
    private const string ValueName = "Automatic-Task";

    // 单 exe 释放一个 at.exe 到每用户 bin 目录；该二进制既是 CLI
    // 也是 runtime 守护进程（后者经由隐藏的 --runtime-daemon 开关）。
    public static string ResolveCliExecutable()
    {
        string? configured = Environment.GetEnvironmentVariable("AT_EXE_PATH");
        if (!string.IsNullOrEmpty(configured) && File.Exists(configured))
        {
            return configured;
        }
        string bin = Path.Combine(EmbeddedPayload.BinDir(), "at.exe");
        if (File.Exists(bin))
        {
            return bin;
        }
        string local = Path.Combine(AppContext.BaseDirectory, "at.exe");
        if (File.Exists(local))
        {
            return local;
        }
        // 绝不回退到裸 "at"：CreateProcess 会解析到 System32 的 AT.EXE
        // （计划任务）。宁可报一个清晰可诊断的错误，也不静默跑错工具。
        throw new InvalidOperationException(
            "The Automatic-Task CLI is missing. Reinstall the package or restore %LOCALAPPDATA%\\Automatic-Task\\bin.");
    }

    // 与 CLI 同一二进制，附加守护进程开关启动。
    public static string ResolveRuntimeExecutable()
    {
        return ResolveCliExecutable();
    }

    public static string ResolveRuntimeArguments()
    {
        return "--runtime-daemon";
    }

    public static bool IsEnabled()
    {
        using RegistryKey key = Registry.CurrentUser.OpenSubKey(RunKey) ?? Registry.CurrentUser.CreateSubKey(RunKey);
        return key.GetValue(ValueName) is string;
    }

    public static void Enable()
    {
        using RegistryKey key = Registry.CurrentUser.OpenSubKey(RunKey, true) ?? Registry.CurrentUser.CreateSubKey(RunKey);
        // exe 是 GUI 子系统二进制，自启动保持无窗口；它会自行拉起 runtime。
        string self = Environment.ProcessPath ?? "Autotask.exe";
        key.SetValue(ValueName, $"\"{self}\" --background");
    }

    public static void Disable()
    {
        using RegistryKey key = Registry.CurrentUser.OpenSubKey(RunKey, true);
        key?.DeleteValue(ValueName, false);
    }
}
