using System.Security.Principal;
using System.Text.Json;
using System.IO.Pipes;

namespace AutomaticTask.Tray;

// Automatic-Task runtime 命名管道的 JSONL 客户端。托盘只允许
// ping 与请求关闭；全部业务逻辑在 TypeScript runtime 中。
public sealed class RuntimeClient
{
    private const string PipePrefix = @"\\.\pipe\automatic-task-runtime-";
    private const int ConnectTimeoutMs = 1000;

    public static string PipeName()
    {
        // TS 侧用 USERNAME 环境变量推导管道名；这里用同一来源，
        // 即使 USERNAME 被覆盖（测试、服务）托盘与 CLI/runtime 也连同一管道。
        // Windows 身份仅作兜底。
        string? user = Environment.GetEnvironmentVariable("USERNAME");
        if (string.IsNullOrEmpty(user))
        {
            user = WindowsIdentity.GetCurrent().Name.Split('\\')[^1];
        }
        string safe = System.Text.RegularExpressions.Regex.Replace(user, "[^a-zA-Z0-9]+", "-");
        return PipePrefix + safe;
    }

    public async Task<bool> PingAsync()
    {
        using var pipe = new NamedPipeClientStream(".", PipeName().Replace(@"\\.\pipe\", string.Empty), PipeDirection.InOut);
        try
        {
            await pipe.ConnectAsync(ConnectTimeoutMs);
            string request = JsonSerializer.Serialize(new RequestEnvelope("tray-ping", "runtime.ping"));
            await WriteLineAsync(pipe, request);
            string? response = await ReadLineAsync(pipe, 1000);
            return response?.Contains("\"ok\":true") == true;
        }
        catch
        {
            return false;
        }
    }

    // 故意同步：退出时在 UI 线程调用，若 await 会死锁 WinForms 消息循环。
    // runtime 已不存在时最多阻塞 ConnectTimeoutMs。
    public void RequestShutdown()
    {
        using var pipe = new NamedPipeClientStream(".", PipeName().Replace(@"\\.\pipe\", string.Empty), PipeDirection.InOut);
        try
        {
            pipe.Connect(ConnectTimeoutMs);
            string request = JsonSerializer.Serialize(new RequestEnvelope("tray-shutdown", "runtime.shutdown"));
            byte[] bytes = System.Text.Encoding.UTF8.GetBytes(request + "\n");
            pipe.Write(bytes, 0, bytes.Length);
            pipe.Flush();
        }
        catch
        {
            // runtime 可能已退出。
        }
    }

    // 协议约定 params 键的拼写；C# 属性名不得泄漏到线上格式。
    private sealed class RequestEnvelope
    {
        public RequestEnvelope(string id, string method)
        {
            this.Id = id;
            this.Method = method;
        }

        [System.Text.Json.Serialization.JsonPropertyName("protocol")]
        public string Protocol { get; } = "at/ipc/v1";

        [System.Text.Json.Serialization.JsonPropertyName("id")]
        public string Id { get; }

        [System.Text.Json.Serialization.JsonPropertyName("method")]
        public string Method { get; }

        [System.Text.Json.Serialization.JsonPropertyName("params")]
        public object Params { get; } = new { };
    }

    private static async Task WriteLineAsync(NamedPipeClientStream pipe, string line)
    {
        byte[] bytes = System.Text.Encoding.UTF8.GetBytes(line + "\n");
        await pipe.WriteAsync(bytes);
        await pipe.FlushAsync();
    }

    private static async Task<string?> ReadLineAsync(NamedPipeClientStream pipe, int timeoutMs)
    {
        using var cts = new CancellationTokenSource(timeoutMs);
        var buffer = new List<byte>();
        var single = new byte[1];
        while (await pipe.ReadAsync(single, cts.Token) == 1)
        {
            if (single[0] == (byte)'\n')
            {
                return System.Text.Encoding.UTF8.GetString(buffer.ToArray());
            }
            buffer.Add(single[0]);
        }
        return null;
    }
}
