using System.Text.Json;
using System.Text.Json.Serialization;

namespace ExamGuard.Agent;

public sealed class ExamEvent
{
    [JsonPropertyName("event_id")]
    public required string EventId { get; init; }

    [JsonPropertyName("contest_id")]
    public required string ContestId { get; init; }

    [JsonPropertyName("session_id")]
    public required string SessionId { get; init; }

    [JsonPropertyName("type")]
    public required string Type { get; init; }

    [JsonPropertyName("occurred_at")]
    public required string OccurredAt { get; init; }

    [JsonPropertyName("source")]
    public string Source { get; init; } = AgentInfo.EventSource;

    [JsonPropertyName("metadata")]
    public Dictionary<string, object?> Metadata { get; init; } = [];
}

/// <summary>Durable local queue. Every change is written to disk before returning.</summary>
public sealed class EventQueue
{
    public const int MaxEvents = 5000;

    private readonly object gate = new();
    private readonly string path;
    private List<ExamEvent> events;

    public EventQueue(string path)
    {
        this.path = path;
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        events = Load(path);
    }

    public int Count
    {
        get
        {
            lock (gate)
            {
                return events.Count;
            }
        }
    }

    public int Dropped { get; private set; }

    public void Add(ExamEvent item)
    {
        lock (gate)
        {
            events.Add(item);
            var excess = events.Count - MaxEvents;
            if (excess > 0)
            {
                events.RemoveRange(0, excess);
                Dropped += excess;
            }

            Save();
        }
    }

    public IReadOnlyList<ExamEvent> Peek(int count)
    {
        lock (gate)
        {
            return events.Take(count).ToList();
        }
    }

    public void Remove(IEnumerable<ExamEvent> delivered)
    {
        lock (gate)
        {
            var ids = delivered.Select(item => item.EventId).ToHashSet();
            events = events.Where(item => !ids.Contains(item.EventId)).ToList();
            Save();
        }
    }

    private static List<ExamEvent> Load(string path)
    {
        if (!File.Exists(path))
        {
            return [];
        }

        try
        {
            return JsonSerializer.Deserialize<List<ExamEvent>>(File.ReadAllText(path)) ?? [];
        }
        catch (JsonException)
        {
            // Keep the unreadable file for investigation and start a new queue.
            File.Move(path, $"{path}.corrupt", overwrite: true);
            return [];
        }
    }

    private void Save()
    {
        var temporary = $"{path}.tmp";
        File.WriteAllText(temporary, JsonSerializer.Serialize(events));
        File.Move(temporary, path, overwrite: true);
    }
}
