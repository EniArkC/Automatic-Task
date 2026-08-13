using System.Reflection;
using System.Security.Cryptography;

namespace AutomaticTask.Tray;

// 把内嵌 payload 释放到每用户 bin 目录。单个 at.exe 同时承载
// CLI 与 runtime 守护进程，因此只写一个可执行文件。
// payload 按内容哈希缓存，每次发布构建只释放一次；写入经临时文件 + 原子移动。
internal static class EmbeddedPayload
{
    private static readonly (string Resource, string FileName)[] Payloads =
    [
        ("at.exe", "at.exe"),
    ];

    public static string BinDir()
    {
        return Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "Automatic-Task",
            "bin");
    }

    public static void Ensure()
    {
        string binDir = BinDir();
        Directory.CreateDirectory(binDir);
        // 上次硬崩溃可能遗留孤儿 .tmp 文件，清掉。
        foreach (string stale in Directory.EnumerateFiles(binDir, "*.tmp"))
        {
            try
            {
                File.Delete(stale);
            }
            catch
            {
                // 尽力而为。
            }
        }
        Assembly assembly = Assembly.GetExecutingAssembly();
        foreach ((string resource, string fileName) in Payloads)
        {
            using Stream stream = assembly.GetManifestResourceStream(resource)
                ?? throw new InvalidOperationException($"Missing embedded resource {resource}");
            string hash = Sha256Hex(stream);
            string target = Path.Combine(binDir, fileName);
            string hashFile = target + ".hash";
            if (File.Exists(target)
                && File.Exists(hashFile)
                && File.ReadAllText(hashFile) == hash
                && new FileInfo(target).Length == stream.Length)
            {
                continue;
            }
            stream.Position = 0;
            // 唯一临时名：两个实例可能并发释放。
            string temp = $"{target}.{Guid.NewGuid():N}.tmp";
            using (FileStream output = File.Create(temp))
            {
                stream.CopyTo(output);
            }
            try
            {
                File.Move(temp, target, true);
            }
            catch (UnauthorizedAccessException)
            {
                // 旧 payload 可能仍在运行（runtime 守护进程就跑在这个文件上）。
                // 此时保留旧版本，下次启动再替换。
                if (!File.Exists(target))
                {
                    throw;
                }
                File.Delete(temp);
                continue;
            }
            File.WriteAllText(hashFile, hash);
        }

        RemoveLegacyPayloads(binDir);
    }

    // CLI/runtime 合并前的构建发布过两个可执行文件；
    // 残留会让磁盘上躺着无人再启动的过期守护进程。
    private static void RemoveLegacyPayloads(string binDir)
    {
        foreach (string name in new[] { "at-cli.exe", "at-cli.exe.hash", "at-runtime.exe", "at-runtime.exe.hash" })
        {
            try
            {
                File.Delete(Path.Combine(binDir, name));
            }
            catch
            {
                // 尽力而为；被锁定的残留无害。
            }
        }
    }

    private static string Sha256Hex(Stream stream)
    {
        using var sha = SHA256.Create();
        return Convert.ToHexString(sha.ComputeHash(stream));
    }
}
