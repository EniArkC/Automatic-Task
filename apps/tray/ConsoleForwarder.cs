using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

namespace AutomaticTask.Tray;

// 在父终端中运行内嵌 CLI，两种模式：
//  - 交互终端（AttachConsole 成功）：CLI 是控制台子系统进程，
//    自动继承本 GUI 进程附加到的控制台，无需转发标准句柄——
//    Windows 直接接线到继承的控制台，TUI 与全部输出正常，且不创建窗口。
//  - 重定向/无头（管道、文件、无父控制台）：AttachConsole 失败，
//    通过 STARTF_USESTDHANDLES 把继承的管道/文件句柄转发给子进程，
//    保持 shell 组合（autotask x > file、管道）可用；此情形下
//    CREATE_NO_WINDOW 防止为子进程拉起隐藏控制台。
internal static class ConsoleForwarder
{
    private const uint AttachParentProcess = 0xFFFFFFFF;
    private const uint CreateNoWindow = 0x08000000;
    private const uint StartfUseStdHandles = 0x00000100;
    private const int StdInputHandle = -10;
    private const int StdOutputHandle = -11;
    private const int StdErrorHandle = -12;
    private static readonly IntPtr InvalidHandle = new(-1);

    [StructLayout(LayoutKind.Sequential)]
    private struct StartupInfo
    {
        public uint Size;
        public IntPtr Reserved;
        public string? Desktop;
        public IntPtr Title;
        public uint X;
        public uint Y;
        public uint XSize;
        public uint YSize;
        public uint XCountChars;
        public uint YCountChars;
        public uint FillAttribute;
        public uint Flags;
        public ushort ShowWindow;
        public ushort Reserved2;
        public IntPtr Reserved3;
        public IntPtr StdInput;
        public IntPtr StdOutput;
        public IntPtr StdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInformation
    {
        public IntPtr Process;
        public IntPtr Thread;
        public uint ProcessId;
        public uint ThreadId;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AttachConsole(uint processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool CreateProcessW(
        string? application,
        StringBuilder commandLine,
        IntPtr processAttributes,
        IntPtr threadAttributes,
        bool inheritHandles,
        uint flags,
        IntPtr environment,
        string? currentDirectory,
        ref StartupInfo startupInfo,
        out ProcessInformation processInfo);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetConsoleWindow();

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetStdHandle(int handle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint GetFileType(IntPtr handle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

    private const uint FileTypeDisk = 1;
    private const uint FileTypePipe = 3;

    public static bool AttachToParent()
    {
        return AttachConsole(AttachParentProcess);
    }

    public static int RunCli(string[] args)
    {
        // 附加到父终端（交互场景）。重定向/无头场景会失败，
        // 此时子进程不应闪出新的控制台窗口。
        bool attached = AttachToParent();
        string cli = StartupManager.ResolveCliExecutable();

        var commandLine = new StringBuilder();
        commandLine.Append('"').Append(cli).Append('"');
        foreach (string argument in args)
        {
            commandLine.Append(' ').Append(Quote(argument));
        }

        StartupInfo startup = new() { Size = (uint)Marshal.SizeOf<StartupInfo>() };
        uint flags = 0;

        // 重定向句柄（父 shell 的管道/文件）必须转发给子进程以保证 shell 组合可用，
        // 子进程保持隐藏。交互终端则附加父控制台，子进程自动继承且无新窗口。
        // 两者都不满足时（无控制台也无重定向，如 GUI 宿主或计划任务），
        // 同样隐藏子进程，避免控制台窗口闪现。
        IntPtr stdIn = GetStdHandle(StdInputHandle);
        IntPtr stdOut = GetStdHandle(StdOutputHandle);
        IntPtr stdErr = GetStdHandle(StdErrorHandle);
        if (IsPipeOrFile(stdIn) || IsPipeOrFile(stdOut) || IsPipeOrFile(stdErr))
        {
            startup.Flags = StartfUseStdHandles;
            startup.StdInput = stdIn;
            startup.StdOutput = stdOut;
            startup.StdError = stdErr;
            flags = CreateNoWindow;
        }
        else if (!attached)
        {
            flags = CreateNoWindow;
        }

        if (!CreateProcessW(
                cli,
                commandLine,
                IntPtr.Zero,
                IntPtr.Zero,
                true,
                flags,
                IntPtr.Zero,
                Environment.CurrentDirectory,
                ref startup,
                out ProcessInformation process))
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(), $"Failed to start {cli}");
        }

        CloseHandle(process.Thread);
        _ = WaitForSingleObject(process.Process, uint.MaxValue);
        _ = GetExitCodeProcess(process.Process, out uint exitCode);
        CloseHandle(process.Process);
        return (int)exitCode;
    }

    private static bool IsPipeOrFile(IntPtr handle)
    {
        if (handle == IntPtr.Zero || handle == InvalidHandle)
        {
            return false;
        }
        uint type = GetFileType(handle);
        return type is 1 /* DISK */ or 3 /* PIPE */;
    }

    private static string Quote(string value)
    {
        if (value.Length == 0)
        {
            return "\"\"";
        }
        if (!value.Contains(' ') && !value.Contains('"') && !value.EndsWith('\\'))
        {
            return value;
        }
        // MSVCRT 规则：紧邻结束引号的反斜杠必须加倍，否则引号会被视为已转义。
        string escaped = value.Replace("\"", "\\\"");
        if (escaped.EndsWith('\\'))
        {
            escaped += "\\";
        }
        return "\"" + escaped + "\"";
    }
}
