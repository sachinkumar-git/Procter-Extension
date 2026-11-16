using System.Text.Json;
using System.Text.Json.Serialization;

namespace ExamGuard.Agent;

public sealed class AgentConfig
{
    [JsonPropertyName("api_base_url")]
    public string ApiBaseUrl { get; set; } = "http://localhost:3000";

    [JsonPropertyName("approved_browsers")]
    public string[] ApprovedBrowsers { get; set; } = ["chrome"];

    [JsonPropertyName("foreground_poll_ms")]
    public int ForegroundPollMs { get; set; } = 250;

    [JsonPropertyName("heartbeat_seconds")]
    public int HeartbeatSeconds { get; set; } = 30;

    public static string DefaultDataDirectory => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "CodeWallah",
        "ExamGuard");

    public static AgentConfig Load(string path)
    {
        var config = File.Exists(path)
            ? JsonSerializer.Deserialize<AgentConfig>(File.ReadAllText(path)) ?? new AgentConfig()
            : new AgentConfig();
        config.Validate();
        return config;
    }

    public void Validate()
    {
        var url = new Uri(ApiBaseUrl);
        if (url.Scheme != Uri.UriSchemeHttps && !url.IsLoopback)
        {
            throw new InvalidOperationException("api_base_url must use HTTPS unless it is on this computer.");
        }

        if (ForegroundPollMs < 50 || HeartbeatSeconds < 5)
        {
            throw new InvalidOperationException("Polling intervals are too small.");
        }
    }
}
