using System.Net;
using ExamGuard.Agent;
using Xunit;

namespace ExamGuard.Agent.Tests;

public sealed class FakeReader : IForegroundReader
{
    public ForegroundSample? Next { get; set; }

    public ForegroundSample? Read() => Next;
}

public sealed class FakeApi : IAgentApi
{
    public List<ExamEvent> Delivered { get; } = [];

    public Exception? SendFailure { get; set; }

    public Exception? HeartbeatFailure { get; set; }

    public bool SessionActive { get; set; } = true;

    public int SendCalls { get; private set; }

    public Task<Credential> PairAsync(string code, CancellationToken cancel) =>
        Task.FromResult(new Credential
        {
            SessionId = "session",
            ContestId = "contest",
            Token = "token",
            ExpiresAt = DateTimeOffset.UtcNow.AddHours(1),
        });

    public Task<bool> HeartbeatAsync(string token, CancellationToken cancel) =>
        HeartbeatFailure is null ? Task.FromResult(SessionActive) : Task.FromException<bool>(HeartbeatFailure);

    public Task SendEventsAsync(string token, IReadOnlyList<ExamEvent> events, CancellationToken cancel)
    {
        SendCalls++;
        if (SendFailure is not null)
        {
            return Task.FromException(SendFailure);
        }

        Delivered.AddRange(events);
        return Task.CompletedTask;
    }
}

public class ForegroundTrackerTests
{
    private static ForegroundSample App(string name) => new(name, 100);

    private readonly ForegroundTracker tracker = new(["chrome"], 250);

    [Fact]
    public void BrowserAtStartIsOnlyABaseline() => Assert.Null(tracker.Observe(App("chrome")));

    [Fact]
    public void StartingAwayFromTheBrowserIsReported()
    {
        var metadata = tracker.Observe(App("notepad"));
        Assert.Equal(false, metadata!["is_approved_browser"]);
    }

    [Fact]
    public void LeavingAndReturningProducesBothEvents()
    {
        tracker.Observe(App("chrome"));

        var away = tracker.Observe(App("notepad"))!;
        Assert.Equal("notepad", away["process_name"]);
        Assert.Equal("chrome", away["previous_process"]);
        Assert.Equal(false, away["is_approved_browser"]);

        var back = tracker.Observe(App("Chrome"))!;
        Assert.Equal(true, back["is_approved_browser"]);
        Assert.Equal("notepad", back["previous_process"]);
    }

    [Fact]
    public void RepeatedSamplesAndWindowlessMomentsAreIgnored()
    {
        tracker.Observe(App("chrome"));
        Assert.Null(tracker.Observe(App("chrome")));
        Assert.Null(tracker.Observe(null));
        Assert.Null(tracker.Observe(App("chrome")));
    }

    [Fact]
    public void FailedLookupIsReportedNotHidden()
    {
        tracker.Observe(App("chrome"));
        var metadata = tracker.Observe(new ForegroundSample(null, 42))!;
        Assert.Equal(true, metadata["lookup_failed"]);
        Assert.Equal(false, metadata["is_approved_browser"]);
    }

    [Fact]
    public void WindowTitlesAreNeverPartOfTheEvent()
    {
        var metadata = tracker.Observe(App("notepad"))!;
        Assert.DoesNotContain(metadata.Keys, key => key.Contains("title", StringComparison.OrdinalIgnoreCase));
    }
}

public sealed class AgentCoreTests : IDisposable
{
    private readonly string directory = Directory.CreateTempSubdirectory("examguard").FullName;
    private readonly FakeApi api = new();
    private readonly FakeReader reader = new();

    public void Dispose() => Directory.Delete(directory, recursive: true);

    private string QueuePath => Path.Combine(directory, "queue.json");

    private AgentCore NewCore(EventQueue queue) => new(
        new AgentConfig { ForegroundPollMs = 100_000, HeartbeatSeconds = 100_000 },
        api,
        reader,
        queue,
        new CredentialStore(Path.Combine(directory, "credential.bin")),
        TimeProvider.System,
        _ => { });

    private static ForegroundTracker Tracker() => new(["chrome"], 250);

    [Fact]
    public async Task PairingRecordsStartAndDeliversUniqueEvents()
    {
        var core = NewCore(new EventQueue(QueuePath));
        await core.PairAsync(" CODE ", TestContext.Current.CancellationToken);
        Assert.Equal(AgentState.Monitoring, core.State);

        var tracker = Tracker();
        reader.Next = new ForegroundSample("notepad", 5);
        core.PollOnce(tracker);
        await core.FlushAsync(TestContext.Current.CancellationToken);

        Assert.Equal(["AGENT_HEARTBEAT", "FOREGROUND_APP_CHANGED"], api.Delivered.Select(e => e.Type));
        Assert.All(api.Delivered, e => Assert.Equal("windows-agent", e.Source));
        Assert.All(api.Delivered, e => Assert.EndsWith("Z", e.OccurredAt));
        Assert.Equal(2, api.Delivered.Select(e => e.EventId).Distinct().Count());
        Assert.Equal(0, core.QueuedEvents);
        await core.StopAsync();
    }

    [Fact]
    public async Task FailedDeliveryKeepsEventsAndBacksOff()
    {
        var core = NewCore(new EventQueue(QueuePath));
        await core.PairAsync("CODE", TestContext.Current.CancellationToken);
        api.SendFailure = new ApiException(null, "offline");

        await core.FlushAsync(TestContext.Current.CancellationToken);
        await core.FlushAsync(TestContext.Current.CancellationToken);

        Assert.Equal(1, api.SendCalls);
        Assert.Equal(1, core.QueuedEvents);
        api.SendFailure = null;
        await core.StopAsync();
    }

    [Fact]
    public async Task QueueSurvivesARestart()
    {
        var core = NewCore(new EventQueue(QueuePath));
        api.SendFailure = new ApiException(null, "offline");
        await core.PairAsync("CODE", TestContext.Current.CancellationToken);
        await core.StopAsync();

        var reloaded = new EventQueue(QueuePath);
        Assert.Equal(2, reloaded.Count);
    }

    [Fact]
    public async Task OutageIsVisibleAndReconnectionRecordedOnce()
    {
        var core = NewCore(new EventQueue(QueuePath));
        await core.PairAsync("CODE", TestContext.Current.CancellationToken);
        await core.FlushAsync(TestContext.Current.CancellationToken);

        api.HeartbeatFailure = new ApiException(null, "offline");
        await core.HeartbeatOnceAsync(TestContext.Current.CancellationToken);
        Assert.Equal(AgentState.Offline, core.State);

        api.HeartbeatFailure = null;
        await core.HeartbeatOnceAsync(TestContext.Current.CancellationToken);
        await core.HeartbeatOnceAsync(TestContext.Current.CancellationToken);
        await core.FlushAsync(TestContext.Current.CancellationToken);

        Assert.Equal(AgentState.Monitoring, core.State);
        Assert.Single(api.Delivered, e => e.Type == "NETWORK_RECONNECTED");
        await core.StopAsync();
    }

    [Fact]
    public async Task RejectedCredentialEndsMonitoring()
    {
        var core = NewCore(new EventQueue(QueuePath));
        await core.PairAsync("CODE", TestContext.Current.CancellationToken);
        api.HeartbeatFailure = new ApiException(HttpStatusCode.Unauthorized, "401");

        await core.HeartbeatOnceAsync(TestContext.Current.CancellationToken);

        Assert.Equal(AgentState.Expired, core.State);
        Assert.Null(core.SessionId);
    }

    [Fact]
    public async Task ServerClosedSessionStopsTheAgent()
    {
        var core = NewCore(new EventQueue(QueuePath));
        await core.PairAsync("CODE", TestContext.Current.CancellationToken);
        api.SessionActive = false;

        await core.HeartbeatOnceAsync(TestContext.Current.CancellationToken);

        Assert.Equal(AgentState.NotPaired, core.State);
    }

    [Fact]
    public async Task ResumesAPairedSessionAfterRestart()
    {
        var first = NewCore(new EventQueue(QueuePath));
        await first.PairAsync("CODE", TestContext.Current.CancellationToken);
        await first.StopAsync();

        var second = NewCore(new EventQueue(QueuePath));
        second.Resume();

        Assert.Equal(AgentState.Monitoring, second.State);
        await second.StopAsync();
    }

    [Fact]
    public void QueueDiscardsOldestAtTheLimitAndCounts()
    {
        var seeded = Enumerable.Range(0, EventQueue.MaxEvents).Select(NewEvent).ToList();
        File.WriteAllText(QueuePath, System.Text.Json.JsonSerializer.Serialize(seeded));
        var queue = new EventQueue(QueuePath);

        queue.Add(NewEvent(EventQueue.MaxEvents));

        Assert.Equal(EventQueue.MaxEvents, queue.Count);
        Assert.Equal(1, queue.Dropped);
        Assert.Equal("1", queue.Peek(1)[0].EventId);
    }

    [Fact]
    public void CorruptQueueFileIsSetAsideNotFatal()
    {
        File.WriteAllText(QueuePath, "{not json");
        var queue = new EventQueue(QueuePath);
        Assert.Equal(0, queue.Count);
        Assert.True(File.Exists($"{QueuePath}.corrupt"));
    }

    [Fact]
    public void CredentialFileIsEncrypted()
    {
        var path = Path.Combine(directory, "c.bin");
        var store = new CredentialStore(path);
        store.Save(new Credential
        {
            SessionId = "s",
            ContestId = "c",
            Token = "very-secret-token",
            ExpiresAt = DateTimeOffset.UtcNow.AddHours(1),
        });

        Assert.DoesNotContain("very-secret-token", File.ReadAllText(path));
        Assert.Equal("very-secret-token", store.Load()!.Token);
    }

    private static ExamEvent NewEvent(int index) => new()
    {
        EventId = index.ToString(System.Globalization.CultureInfo.InvariantCulture),
        ContestId = "c",
        SessionId = "s",
        Type = "AGENT_HEARTBEAT",
        OccurredAt = "2026-01-01T00:00:00.000Z",
    };
}

public class AgentConfigTests
{
    [Theory]
    [InlineData("https://exam.example.edu", true)]
    [InlineData("http://localhost:3000", true)]
    [InlineData("http://exam.example.edu", false)]
    public void RequiresHttpsExceptOnThisComputer(string url, bool valid)
    {
        var config = new AgentConfig { ApiBaseUrl = url };
        if (valid)
        {
            config.Validate();
        }
        else
        {
            Assert.Throws<InvalidOperationException>(config.Validate);
        }
    }
}

/// <summary>Runs against a live API when EXAM_GUARD_E2E_URL and EXAM_GUARD_E2E_CODE are set.</summary>
public class LiveApiTests
{
    [Fact]
    public async Task PairsReadsTheRealForegroundAndDelivers()
    {
        var url = Environment.GetEnvironmentVariable("EXAM_GUARD_E2E_URL");
        var code = Environment.GetEnvironmentVariable("EXAM_GUARD_E2E_CODE");
        Assert.SkipWhen(url is null || code is null, "Live API not configured.");

        var directory = Directory.CreateTempSubdirectory("examguard-e2e").FullName;
        using var api = new ApiClient(url!);
        var queue = new EventQueue(Path.Combine(directory, "queue.json"));
        var core = new AgentCore(
            new AgentConfig { ApiBaseUrl = url!, ApprovedBrowsers = ["no-such-browser"], ForegroundPollMs = 100, HeartbeatSeconds = 5 },
            api,
            new Win32ForegroundReader(),
            queue,
            new CredentialStore(Path.Combine(directory, "credential.bin")),
            TimeProvider.System,
            _ => { });

        await core.PairAsync(code!, TestContext.Current.CancellationToken);
        await Task.Delay(TimeSpan.FromSeconds(7), TestContext.Current.CancellationToken);

        Assert.Equal(AgentState.Monitoring, core.State);
        await core.StopAsync();
        Assert.Equal(0, queue.Count);
    }
}
