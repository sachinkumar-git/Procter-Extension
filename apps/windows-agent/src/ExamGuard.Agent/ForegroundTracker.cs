namespace ExamGuard.Agent;

/// <summary>Turns foreground samples into change metadata.</summary>
public sealed class ForegroundTracker
{
    private readonly HashSet<string> approved;
    private readonly int pollMs;
    private ForegroundSample? current;

    public ForegroundTracker(IEnumerable<string> approvedBrowsers, int pollMs)
    {
        approved = new HashSet<string>(approvedBrowsers, StringComparer.OrdinalIgnoreCase);
        this.pollMs = pollMs;
    }

    /// <summary>Returns event metadata when the foreground application changed.</summary>
    public Dictionary<string, object?>? Observe(ForegroundSample? sample)
    {
        if (sample is null || IsSameApplication(sample, current))
        {
            return null;
        }

        var previous = current;
        current = sample;
        var isApproved = sample.ProcessName is not null && approved.Contains(sample.ProcessName);

        // The first sample only sets a baseline, unless the exam starts away from the browser.
        if (previous is null && isApproved)
        {
            return null;
        }

        return new Dictionary<string, object?>
        {
            ["process_name"] = sample.ProcessName,
            ["process_id"] = sample.ProcessId,
            ["previous_process"] = previous?.ProcessName,
            ["is_approved_browser"] = isApproved,
            ["lookup_failed"] = sample.ProcessName is null,
            ["detection"] = "foreground_poll",
            ["poll_ms"] = pollMs,
        };
    }

    private static bool IsSameApplication(ForegroundSample sample, ForegroundSample? other) =>
        other is not null
        && (sample.ProcessName is not null
            ? string.Equals(sample.ProcessName, other.ProcessName, StringComparison.OrdinalIgnoreCase)
            : other.ProcessName is null && sample.ProcessId == other.ProcessId);
}
