using ExamGuard.Agent;

using var instance = new Mutex(true, @"Local\CodeWallahExamGuardAgent", out var isFirstInstance);
if (!isFirstInstance)
{
    return;
}

ApplicationConfiguration.Initialize();

var dataDirectory = AgentConfig.DefaultDataDirectory;
Directory.CreateDirectory(dataDirectory);
var logPath = Path.Combine(dataDirectory, "agent.log");
void Log(string message)
{
    try
    {
        File.AppendAllText(logPath, $"{DateTimeOffset.UtcNow:O} {message}{Environment.NewLine}");
    }
    catch (IOException)
    {
        // Logging must never stop monitoring.
    }
}

AgentConfig config;
try
{
    config = AgentConfig.Load(Path.Combine(AppContext.BaseDirectory, "agent.json"));
}
catch (Exception error) when (error is InvalidOperationException or UriFormatException or System.Text.Json.JsonException)
{
    MessageBox.Show($"Exam Guard configuration is invalid: {error.Message}", "CodeWallah Exam Guard");
    return;
}

using var api = new ApiClient(config.ApiBaseUrl);
var core = new AgentCore(
    config,
    api,
    new Win32ForegroundReader(),
    new EventQueue(Path.Combine(dataDirectory, "queue.json")),
    new CredentialStore(Path.Combine(dataDirectory, "credential.bin")),
    TimeProvider.System,
    Log);

Application.Run(new TrayApp(core));
