using System.Globalization;

namespace ExamGuard.Agent;

public enum AgentState
{
    NotPaired,
    Monitoring,
    Offline,
    Expired,
}

/// <summary>Runs monitoring, delivery, and heartbeats. Contains no user interface.</summary>
public sealed class AgentCore(
    AgentConfig config,
    IAgentApi api,
    IForegroundReader reader,
    EventQueue queue,
    CredentialStore credentials,
    TimeProvider time,
    Action<string> log)
{
    private const int BatchSize = 100;
    private static readonly TimeSpan SendInterval = TimeSpan.FromSeconds(5);
    private static readonly TimeSpan RetryBase = TimeSpan.FromSeconds(5);
    private static readonly TimeSpan RetryMax = TimeSpan.FromMinutes(5);

    private readonly SemaphoreSlim sendLock = new(1, 1);
    private CancellationTokenSource? running;
    private Task loops = Task.CompletedTask;
    private Credential? credential;
    private DateTimeOffset nextSendAt = DateTimeOffset.MinValue;
    private DateTimeOffset? offlineSince;
    private int sendFailures;

    public event Action<AgentState>? StateChanged;

    public AgentState State { get; private set; } = AgentState.NotPaired;

    public string? SessionId => credential?.SessionId;

    public int QueuedEvents => queue.Count;

    /// <summary>Continues a paired session after the agent restarts.</summary>
    public void Resume()
    {
        var saved = credentials.Load();
        if (saved is null)
        {
            return;
        }

        if (saved.ExpiresAt <= time.GetUtcNow())
        {
            credentials.Clear();
            return;
        }

        Begin(saved);
    }

    public async Task PairAsync(string code, CancellationToken cancel)
    {
        var issued = await api.PairAsync(code.Trim(), cancel);
        await StopLoopsAsync();
        credentials.Save(issued);
        Begin(issued);
    }

    /// <summary>Reports the shutdown and makes one bounded attempt to deliver it.</summary>
    public async Task StopAsync()
    {
        if (credential is null)
        {
            return;
        }

        RecordLifecycle("stopping");
        await StopLoopsAsync();
        using var limit = new CancellationTokenSource(TimeSpan.FromSeconds(3));
        nextSendAt = DateTimeOffset.MinValue;
        await FlushAsync(limit.Token);
    }

    internal void PollOnce(ForegroundTracker tracker)
    {
        var metadata = tracker.Observe(reader.Read());
        if (metadata is not null)
        {
            Record("FOREGROUND_APP_CHANGED", metadata);
        }
    }

    internal async Task FlushAsync(CancellationToken cancel)
    {
        var current = credential;
        if (current is null || time.GetUtcNow() < nextSendAt)
        {
            return;
        }

        await sendLock.WaitAsync(cancel);
        try
        {
            while (queue.Peek(BatchSize) is { Count: > 0 } batch)
            {
                await api.SendEventsAsync(current.Token, batch, cancel);
                queue.Remove(batch);
                sendFailures = 0;
            }
        }
        catch (ApiException error)
        {
            sendFailures++;
            var ceiling = Math.Min(RetryMax.TotalMilliseconds, RetryBase.TotalMilliseconds * Math.Pow(2, sendFailures - 1));

            // Jitter stops a whole lab retrying at the same moment after an outage.
            nextSendAt = time.GetUtcNow().AddMilliseconds(ceiling * (0.5 + (Random.Shared.NextDouble() * 0.5)));
            log($"Delivery failed; will retry: {error.Message}");
        }
        finally
        {
            sendLock.Release();
        }
    }

    internal async Task HeartbeatOnceAsync(CancellationToken cancel)
    {
        var current = credential;
        if (current is null)
        {
            return;
        }

        try
        {
            var active = await api.HeartbeatAsync(current.Token, cancel);
            if (offlineSince is { } since)
            {
                offlineSince = null;
                nextSendAt = DateTimeOffset.MinValue;
                Record("NETWORK_RECONNECTED", new Dictionary<string, object?> { ["offline_since"] = Iso(since) });
            }

            SetState(AgentState.Monitoring);
            if (!active)
            {
                log("The session has ended on the server.");
                End(AgentState.NotPaired);
            }
        }
        catch (ApiException error) when (error.IsUnauthorized)
        {
            log("The session credential was rejected.");
            End(AgentState.Expired);
        }
        catch (ApiException error)
        {
            offlineSince ??= time.GetUtcNow();
            SetState(AgentState.Offline);
            log($"Heartbeat failed: {error.Message}");
        }
    }

    /// <summary>Stops the current session without waiting for the running loops.</summary>
    private void End(AgentState state)
    {
        running?.Cancel();
        credentials.Clear();
        credential = null;
        SetState(state);
    }

    private void Begin(Credential issued)
    {
        credential = issued;
        offlineSince = null;
        sendFailures = 0;
        nextSendAt = DateTimeOffset.MinValue;
        running = new CancellationTokenSource();
        SetState(AgentState.Monitoring);
        RecordLifecycle("started");
        var cancel = running.Token;
        loops = Task.WhenAll(
            Loop(TimeSpan.FromMilliseconds(config.ForegroundPollMs), CreatePoll(), cancel),
            Loop(SendInterval, () => FlushAsync(cancel), cancel),
            Loop(TimeSpan.FromSeconds(config.HeartbeatSeconds), () => HeartbeatOnceAsync(cancel), cancel, runFirst: true));
    }

    private Func<Task> CreatePoll()
    {
        var tracker = new ForegroundTracker(config.ApprovedBrowsers, config.ForegroundPollMs);
        return () =>
        {
            PollOnce(tracker);
            return Task.CompletedTask;
        };
    }

    private async Task Loop(TimeSpan interval, Func<Task> action, CancellationToken cancel, bool runFirst = false)
    {
        await Task.Yield();
        using var timer = new PeriodicTimer(interval, time);
        var first = runFirst;
        while (!cancel.IsCancellationRequested)
        {
            try
            {
                if (first || await timer.WaitForNextTickAsync(cancel))
                {
                    first = false;
                    await action();
                }
            }
            catch (OperationCanceledException)
            {
                return;
            }
            catch (Exception error)
            {
                // One failed cycle must never end monitoring.
                log($"Monitoring cycle failed: {error.Message}");
            }
        }
    }

    private async Task StopLoopsAsync()
    {
        running?.Cancel();
        await loops;
        running?.Dispose();
        running = null;
    }

    private void RecordLifecycle(string lifecycle) =>
        Record("AGENT_HEARTBEAT", new Dictionary<string, object?> { ["lifecycle"] = lifecycle });

    private void Record(string type, Dictionary<string, object?> metadata)
    {
        var current = credential;
        if (current is null)
        {
            return;
        }

        queue.Add(new ExamEvent
        {
            EventId = Guid.NewGuid().ToString(),
            ContestId = current.ContestId,
            SessionId = current.SessionId,
            Type = type,
            OccurredAt = Iso(time.GetUtcNow()),
            Metadata = metadata,
        });
    }

    private void SetState(AgentState state)
    {
        if (State != state)
        {
            State = state;
            StateChanged?.Invoke(state);
        }
    }

    private static string Iso(DateTimeOffset value) =>
        value.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture);
}
