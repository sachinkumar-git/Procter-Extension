using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json.Serialization;

namespace ExamGuard.Agent;

public sealed class Credential
{
    [JsonPropertyName("session_id")]
    public required string SessionId { get; init; }

    [JsonPropertyName("contest_id")]
    public required string ContestId { get; init; }

    [JsonPropertyName("token")]
    public required string Token { get; init; }

    [JsonPropertyName("expires_at")]
    public required DateTimeOffset ExpiresAt { get; init; }
}

public sealed class ApiException(HttpStatusCode? status, string message) : Exception(message)
{
    public HttpStatusCode? Status { get; } = status;

    public bool IsUnauthorized => Status == HttpStatusCode.Unauthorized;
}

public interface IAgentApi
{
    Task<Credential> PairAsync(string code, CancellationToken cancel);

    /// <summary>Returns whether the session is still active on the server.</summary>
    Task<bool> HeartbeatAsync(string token, CancellationToken cancel);

    Task SendEventsAsync(string token, IReadOnlyList<ExamEvent> events, CancellationToken cancel);
}

public sealed class ApiClient : IAgentApi, IDisposable
{
    private readonly HttpClient http;

    public ApiClient(string baseUrl)
    {
        http = new HttpClient { BaseAddress = new Uri(baseUrl), Timeout = TimeSpan.FromSeconds(15) };
    }

    public async Task<Credential> PairAsync(string code, CancellationToken cancel)
    {
        using var response = await PostAsync("/v1/agent/pair", new { pairing_code = code }, null, cancel);
        return await response.Content.ReadFromJsonAsync<Credential>(cancel)
            ?? throw new ApiException(response.StatusCode, "Empty pairing response.");
    }

    public async Task<bool> HeartbeatAsync(string token, CancellationToken cancel)
    {
        using var response = await PostAsync("/v1/heartbeat", new { }, token, cancel);
        var body = await response.Content.ReadFromJsonAsync<HeartbeatBody>(cancel);
        return body?.SessionActive ?? false;
    }

    public async Task SendEventsAsync(string token, IReadOnlyList<ExamEvent> events, CancellationToken cancel)
    {
        using var response = await PostAsync("/v1/events/batch", new { events }, token, cancel);
    }

    public void Dispose() => http.Dispose();

    private async Task<HttpResponseMessage> PostAsync(string path, object body, string? token, CancellationToken cancel)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, path) { Content = JsonContent.Create(body) };
        if (token is not null)
        {
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        }

        HttpResponseMessage response;
        try
        {
            response = await http.SendAsync(request, cancel);
        }
        catch (Exception error) when (error is HttpRequestException or TaskCanceledException)
        {
            throw new ApiException(null, "The exam server could not be reached.");
        }

        if (!response.IsSuccessStatusCode)
        {
            var status = response.StatusCode;
            response.Dispose();
            throw new ApiException(status, $"The exam server returned {(int)status}.");
        }

        return response;
    }

    private sealed class HeartbeatBody
    {
        [JsonPropertyName("session_active")]
        public bool SessionActive { get; init; }
    }
}
