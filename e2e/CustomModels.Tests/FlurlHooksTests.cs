using System.Net;
using AwesomeAssertions;
using Flurl.Http;
using MassiveScale.KitchenSink.Client;
using Microsoft.Extensions.DependencyInjection;

namespace CustomModels.Tests;

/// <summary>
/// What callers can attach to the client without touching the generated code: Flurl's call
/// events, their own message handlers, and authentication handlers that fetch and refresh tokens,
/// both through dependency injection and without it.
/// </summary>
[TestClass]
public sealed class FlurlHooksTests
{
    [TestMethod]
    public async Task Dependency_injection_runs_before_and_after_call_handlers_on_every_call()
    {
        var handler = new StubHandler().RespondText("one").RespondText("two");
        var before = 0;
        var statuses = new List<int>();
        await using var provider = Container(
            handler,
            flurl => flurl
                .BeforeCall(call =>
                {
                    before++;
                    call.Request.WithHeader("X-Before", "yes");
                })
                .AfterCall(call => statuses.Add(call.Response!.StatusCode)));

        await provider.GetRequiredService<KitchenSinkClient>().Pings().PingAsync();
        await provider.GetRequiredService<KitchenSinkClient>().Pings().PingAsync();

        before.Should().Be(2, "each resolved client gets its own Flurl client, configured the same way");
        statuses.Should().Equal(200, 200);
        handler.Requests.Should().AllSatisfy(r => r.Headers["X-Before"].Should().Be("yes"));
    }

    [TestMethod]
    public async Task Dependency_injection_runs_an_error_handler_on_a_failed_call()
    {
        var handler = new StubHandler().RespondJson("{}", HttpStatusCode.InternalServerError);
        int? failed = null;
        await using var provider = Container(handler, flurl => flurl.OnError(call => failed = call.Response?.StatusCode));

        var act = () => provider.GetRequiredService<KitchenSinkClient>().Pings().PingAsync();

        await act.Should().ThrowAsync<FlurlHttpException>();
        failed.Should().Be(500);
    }

    [TestMethod]
    public async Task An_event_handler_added_to_one_builder_runs_on_its_calls_only()
    {
        var handler = new StubHandler().RespondText("one").RespondText("two");
        await using var provider = Container(handler);
        var client = provider.GetRequiredService<KitchenSinkClient>();
        var before = 0;

        await client.Pings().ConfigureRequest(r => r.BeforeCall(_ => before++)).PingAsync();
        await client.Pings().PingAsync();

        before.Should().Be(1);
    }

    [TestMethod]
    public async Task A_delegating_handler_fetches_a_token_and_refreshes_it_when_the_server_rejects_it()
    {
        var handler = new StubHandler()
            .RespondJson("{}", HttpStatusCode.Unauthorized)
            .RespondText("one")
            .RespondText("two");
        var tokens = new FakeTokenSource();
        var services = new ServiceCollection();
        services.AddKitchenSinkClient(
            http => http.BaseAddress = new Uri("https://api.test/"),
            builder => builder
                .ConfigurePrimaryHttpMessageHandler(() => handler)
                .AddHttpMessageHandler(() => new RefreshingTokenHandler(tokens)));
        await using var provider = services.BuildServiceProvider();
        var client = provider.GetRequiredService<KitchenSinkClient>();

        (await client.Pings().PingAsync()).Should().Be("one");
        (await client.Pings().PingAsync()).Should().Be("two");

        handler.Requests.Select(r => r.Headers["Authorization"]).Should().Equal(
            "Bearer token-1",
            "Bearer token-2",
            "Bearer token-2");
    }

    [TestMethod]
    public async Task An_async_before_call_handler_can_attach_a_token()
    {
        var handler = new StubHandler().RespondText("pong");
        var tokens = new FakeTokenSource();
        await using var provider = Container(
            handler,
            flurl => flurl.BeforeCall(async call => call.Request.WithOAuthBearerToken(await tokens.GetAsync())));

        await provider.GetRequiredService<KitchenSinkClient>().Pings().PingAsync();

        handler.Last.Headers["Authorization"].Should().Be("Bearer token-1");
    }

    [TestMethod]
    public async Task Without_dependency_injection_the_flurl_client_brings_its_own_handlers_and_events()
    {
        var handler = new StubHandler().RespondJson("{}", HttpStatusCode.Unauthorized).RespondText("pong");
        var tokens = new FakeTokenSource();
        var after = 0;
        var flurl = new FlurlClient(new HttpClient(new RefreshingTokenHandler(tokens) { InnerHandler = handler }))
        {
            BaseUrl = "https://api.test",
        }.AfterCall(_ => after++);

        var result = await KitchenSinkClient.Create(flurl).Pings().PingAsync();

        result.Should().Be("pong");
        after.Should().Be(1, "the retry happens inside the handler, below Flurl");
        handler.Requests.Select(r => r.Headers["Authorization"]).Should().Equal("Bearer token-1", "Bearer token-2");
    }

    /// <summary>
    /// Registers the kitchen-sink client with the stub as its primary handler.
    /// </summary>
    private static ServiceProvider Container(StubHandler handler, Action<IFlurlClient>? configureFlurlClient = null)
    {
        var services = new ServiceCollection();
        services.AddKitchenSinkClient(
            http => http.BaseAddress = new Uri("https://api.test/"),
            builder => builder.ConfigurePrimaryHttpMessageHandler(() => handler),
            configureFlurlClient: configureFlurlClient);
        return services.BuildServiceProvider();
    }

    /// <summary>Hands out a cached token, and a new one on refresh.</summary>
    private sealed class FakeTokenSource
    {
        private int _issued;
        private string? _current;

        public Task<string> GetAsync() => Task.FromResult(_current ??= Issue());

        public Task<string> RefreshAsync() => Task.FromResult(_current = Issue());

        private string Issue() => $"token-{++_issued}";
    }

    /// <summary>
    /// Sends the current token, and on a 401 refreshes it and sends the request once more.
    /// </summary>
    private sealed class RefreshingTokenHandler(FakeTokenSource tokens) : DelegatingHandler
    {
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            request.Headers.Authorization = new("Bearer", await tokens.GetAsync());
            var response = await base.SendAsync(request, cancellationToken);
            if (response.StatusCode != HttpStatusCode.Unauthorized) return response;

            response.Dispose();
            request.Headers.Authorization = new("Bearer", await tokens.RefreshAsync());
            return await base.SendAsync(request, cancellationToken);
        }
    }
}
