using System.Net;
using System.Text;
using System.Text.Json.Serialization;
using Flurl.Http;
using MassiveScale.CustomModels.Client;

namespace CustomModels.Tests;

/// <summary>A request the stub handler saw, captured before the content is disposed.</summary>
public sealed record RecordedRequest(
    HttpMethod Method,
    Uri Uri,
    IReadOnlyDictionary<string, string> Headers,
    string? ContentType,
    string? Body,
    byte[]? BodyBytes);

/// <summary>
/// Stands in for the network. Queued responses are returned in order; every request is recorded.
/// </summary>
public sealed class StubHandler : HttpMessageHandler
{
    private readonly Queue<(HttpStatusCode Status, byte[] Body, string ContentType)> _responses = new();

    public List<RecordedRequest> Requests { get; } = [];

    public RecordedRequest Last => Requests[^1];

    public StubHandler RespondJson(string json, HttpStatusCode status = HttpStatusCode.OK)
    {
        _responses.Enqueue((status, Encoding.UTF8.GetBytes(json), "application/json"));
        return this;
    }

    public StubHandler RespondBytes(byte[] data)
    {
        _responses.Enqueue((HttpStatusCode.OK, data, "application/octet-stream"));
        return this;
    }

    protected override async Task<HttpResponseMessage> SendAsync(
        HttpRequestMessage request,
        CancellationToken cancellationToken)
    {
        byte[]? bytes = null;
        if (request.Content is not null)
        {
            bytes = await request.Content.ReadAsByteArrayAsync(cancellationToken);
        }

        Requests.Add(new RecordedRequest(
            request.Method,
            request.RequestUri!,
            request.Headers.ToDictionary(h => h.Key, h => string.Join(",", h.Value)),
            request.Content?.Headers.ContentType?.ToString(),
            bytes is null ? null : Encoding.UTF8.GetString(bytes),
            bytes));

        var (status, body, contentType) = _responses.Count > 0
            ? _responses.Dequeue()
            : (HttpStatusCode.NoContent, [], "application/json");
        var response = new HttpResponseMessage(status) { Content = new ByteArrayContent(body) };
        response.Content.Headers.ContentType = new(contentType);
        return response;
    }
}

/// <summary>Builds clients wired to a <see cref="StubHandler"/>.</summary>
public static class Harness
{
    public static (CustomModelsClient Client, StubHandler Handler) Create(Action<ModelMap>? configureModels = null)
    {
        var handler = new StubHandler();
        var flurl = new FlurlClient(new HttpClient(handler) { BaseAddress = new Uri("https://api.test/") });

        ModelMap? models = null;
        if (configureModels is not null)
        {
            models = new ModelMap();
            configureModels(models);
        }

        return (CustomModelsClient.Create(flurl, models), handler);
    }
}

public record MyWidget : Widget
{
    [JsonPropertyName("sku")]
    public string? Sku { get; init; }
}

public record MyCreateRequest : WidgetCreateRequest
{
    [JsonPropertyName("sku")]
    public string? Sku { get; init; }
}

public record MyWidgetPage : WidgetPage
{
    [JsonPropertyName("cursor")]
    public string? Cursor { get; init; }
}

public record MyDog : Dog
{
    [JsonPropertyName("breed")]
    public string? Breed { get; init; }
}
