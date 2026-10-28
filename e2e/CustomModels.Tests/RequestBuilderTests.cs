using AwesomeAssertions;
using Flurl.Http;
using MassiveScale.KitchenSink.Client;
using Microsoft.Extensions.DependencyInjection;
using CustomModelsClient = MassiveScale.CustomModels.Client.CustomModelsClient;
using CustomModelsClientExtensions = MassiveScale.CustomModels.Client.CustomModelsClientExtensions;

namespace CustomModels.Tests;

/// <summary>
/// The request builders a client hands out: path parameters given to the client method reach the
/// route, and the headers, query parameters, cookies, and request callbacks added to a builder reach
/// the wire on every request that builder sends, and on no other.
/// </summary>
[TestClass]
public sealed class RequestBuilderTests
{
    private static readonly DateTimeOffset At = new(2024, 1, 2, 3, 4, 5, TimeSpan.Zero);

    private static (KitchenSinkClient Client, StubHandler Handler) Create()
    {
        var handler = new StubHandler();
        var flurl = new FlurlClient(new HttpClient(handler) { BaseAddress = new Uri("https://api.test/") });
        return (KitchenSinkClient.Create(flurl), handler);
    }

    [TestMethod]
    public async Task An_appended_header_is_sent()
    {
        var (client, handler) = Create();
        handler.RespondText("pong");

        await client.Pings().AppendHeader("X-Extra", "value").PingAsync();

        handler.Last.Headers["X-Extra"].Should().Be("value");
    }

    [TestMethod]
    public async Task An_appended_header_replaces_a_declared_header_of_the_same_name()
    {
        var (client, handler) = Create();
        handler.RespondJson("""{"items":[]}""");

        await client.DerivedItems().AppendHeader("X-Trace", "appended").ListAsync(trace: "declared");

        handler.Last.Headers["X-Trace"].Should().Be("appended");
    }

    [TestMethod]
    public async Task The_last_appended_header_of_a_name_wins()
    {
        var (client, handler) = Create();
        handler.RespondJson("""{"items":[]}""");

        await client.DerivedItems().AppendHeader("X-Extra", "a").AppendHeader("X-Extra", "b").ListAsync();

        handler.Last.Headers["X-Extra"].Should().Be("b");
    }

    [TestMethod]
    public async Task An_appended_null_header_removes_a_declared_header_of_the_same_name()
    {
        var (client, handler) = Create();
        handler.RespondJson("""{"items":[]}""");

        await client.DerivedItems().AppendHeader("X-Trace", null).ListAsync(trace: "declared");

        handler.Last.Headers.Should().NotContainKey("X-Trace");
    }

    [TestMethod]
    public async Task An_appended_header_value_is_converted_like_a_declared_one()
    {
        var (client, handler) = Create();
        handler.RespondText("pong");

        await client.Pings()
            .AppendHeader("X-Color", Color.Dark_green)
            .AppendHeader("X-On", true)
            .AppendHeader("X-At", At)
            .PingAsync();

        handler.Last.Headers["X-Color"].Should().Be("dark-green");
        handler.Last.Headers["X-On"].Should().Be("true");
        handler.Last.Headers["X-At"].Should().StartWith("2024-01-02T03:04:05", "an ISO 8601 date");
        DateTimeOffset.Parse(handler.Last.Headers["X-At"]).Should().Be(At);
    }

    [TestMethod]
    public async Task An_appended_query_parameter_is_sent()
    {
        var (client, handler) = Create();
        handler.RespondText("pong");

        await client.Pings().AppendQueryParameter("debug", true).PingAsync();

        handler.Last.Uri.Query.Should().Be("?debug=true");
    }

    [TestMethod]
    public async Task An_appended_query_parameter_is_added_beside_a_declared_one_of_the_same_name()
    {
        var (client, handler) = Create();
        handler.RespondJson("""{"items":[]}""");

        await client.DerivedItems().AppendQueryParameter("limit", 5).ListAsync(limit: 10);

        handler.Last.Uri.Query.Should().Be("?limit=10&limit=5");
    }

    [TestMethod]
    public async Task An_appended_list_query_parameter_is_repeated_once_per_item_with_wire_values()
    {
        var (client, handler) = Create();
        handler.RespondText("pong");

        await client.Pings()
            .AppendQueryParameter("tag", new[] { "a", "b" })
            .AppendQueryParameter("color", new[] { Color.Red, Color.Dark_green })
            .PingAsync();

        handler.Last.Uri.Query.Should().Be("?tag=a&tag=b&color=red&color=dark-green");
    }

    [TestMethod]
    public async Task An_appended_cookie_is_sent()
    {
        var (client, handler) = Create();
        handler.RespondText("pong");

        await client.Pings().AppendCookie("session", "abc").AppendCookie("color", Color.Dark_green).PingAsync();

        var cookie = handler.Last.Headers["Cookie"];
        cookie.Should().Contain("session=abc");
        cookie.Should().Contain("color=dark-green");
    }

    [TestMethod]
    public async Task An_appended_cookie_replaces_a_declared_cookie_of_the_same_name()
    {
        var (client, handler) = Create();
        handler.RespondJson("\"ok\"");

        await client.Misc().AppendCookie("flavour", "vanilla").CookiesAsync("abc", "chocolate");

        var cookie = handler.Last.Headers["Cookie"];
        cookie.Should().Contain("session=abc");
        cookie.Should().Contain("flavour=vanilla");
        cookie.Should().NotContain("chocolate");
    }

    [TestMethod]
    public async Task A_request_callback_runs_after_the_declared_parameters_are_set()
    {
        var (client, handler) = Create();
        handler.RespondJson("""{"items":[]}""");
        var calls = 0;
        object? limitSeen = null;

        await client.DerivedItems()
            .ConfigureRequest(request =>
            {
                calls++;
                limitSeen = request.Url.QueryParams.FirstOrDefault("limit");
                request.WithHeader("X-Configured", "yes");
            })
            .ListAsync(limit: 3);

        calls.Should().Be(1);
        limitSeen.Should().Be("3", "the operation's own parameters are set before the callback runs");
        handler.Last.Headers["X-Configured"].Should().Be("yes");
    }

    [TestMethod]
    public async Task Modifiers_are_applied_in_the_order_they_were_added()
    {
        var (client, handler) = Create();
        handler.RespondText("pong");
        string? querySeen = null;

        await client.Pings()
            .AppendQueryParameter("o", "1")
            .ConfigureRequest(request => querySeen = request.Url.Query)
            .AppendQueryParameter("o", "2")
            .AppendCookie("k", "first")
            .AppendCookie("k", "second")
            .PingAsync();

        querySeen.Should().Be("o=1", "the callback runs after the modifiers before it and before the ones after it");
        handler.Last.Uri.Query.Should().Be("?o=1&o=2");
        handler.Last.Headers["Cookie"].Should().Be("k=second");
    }

    [TestMethod]
    public void Every_modifier_returns_the_same_builder()
    {
        var (client, _) = Create();
        var builder = client.Pings();

        builder.AppendHeader("X-A", "1").Should().BeSameAs(builder);
        builder.AppendQueryParameter("a", "1").Should().BeSameAs(builder);
        builder.AppendCookie("a", "1").Should().BeSameAs(builder);
        builder.ConfigureRequest(_ => { }).Should().BeSameAs(builder);
    }

    [TestMethod]
    public async Task A_builder_kept_in_a_variable_applies_its_modifiers_to_each_later_call()
    {
        var (client, handler) = Create();
        handler.RespondJson("""{"id":"1","name":"n"}""");
        var item = client.DerivedItems("1").AppendHeader("X-A", "1").AppendQueryParameter("q", "1");

        await item.ReadAsync();
        await item.RemoveAsync();

        handler.Requests.Should().HaveCount(2);
        handler.Requests[0].Method.Should().Be(HttpMethod.Get);
        handler.Requests[1].Method.Should().Be(HttpMethod.Delete);
        handler.Requests.Should().AllSatisfy(r =>
        {
            r.Uri.PathAndQuery.Should().Be("/api/derived/1?q=1");
            r.Headers["X-A"].Should().Be("1");
        });
    }

    [TestMethod]
    public async Task A_modifier_added_to_a_builder_after_a_call_applies_to_the_next_one()
    {
        var (client, handler) = Create();
        handler.RespondText("one").RespondText("two");
        var pings = client.Pings();

        await pings.PingAsync();
        await pings.AppendHeader("X-A", "1").PingAsync();

        handler.Requests[0].Headers.Should().NotContainKey("X-A");
        handler.Requests[1].Headers["X-A"].Should().Be("1");
    }

    [TestMethod]
    public async Task A_fresh_builder_does_not_see_modifiers_added_to_an_earlier_one()
    {
        var (client, handler) = Create();
        handler.RespondText("one").RespondText("two");
        var calls = 0;

        await client.Pings()
            .AppendHeader("X-A", "1")
            .AppendQueryParameter("q", "1")
            .AppendCookie("c", "1")
            .ConfigureRequest(_ => calls++)
            .PingAsync();
        await client.Pings().PingAsync();

        calls.Should().Be(1);
        var fresh = handler.Requests[1];
        fresh.Headers.Should().NotContainKey("X-A");
        fresh.Headers.Should().NotContainKey("Cookie");
        fresh.Uri.Query.Should().BeEmpty();
    }

    [TestMethod]
    public async Task Path_parameters_given_to_the_client_method_are_percent_encoded()
    {
        var (client, handler) = Create();
        handler.RespondJson("""{"id":"1","name":"n"}""").RespondText("ok");

        await client.DerivedItems("a/b c?d#e").ReadAsync();
        await client.Misc("k/1", "i d").LookupAsync();

        handler.Requests[0].Uri.AbsolutePath.Should().Be("/api/derived/a%2Fb%20c%3Fd%23e");
        handler.Requests[0].Uri.Query.Should().BeEmpty("a ? in the value must not start a query string");
        handler.Requests[1].Uri.AbsolutePath.Should().Be("/api/misc/lookup/k%2F1/i%20d");
    }

    [TestMethod]
    public async Task A_builder_shared_by_operations_with_the_same_path_parameter_types_fills_each_route()
    {
        var (client, handler) = Create();
        handler.RespondText("one").RespondText("two");
        var shared = client.Misc("docs/a b", "x/y").AppendHeader("X-A", "1");

        await shared.LookupAsync();
        await shared.ReservedAsync();

        handler.Requests[0].Uri.AbsolutePath.Should().Be("/api/misc/lookup/docs%2Fa%20b/x%2Fy");
        handler.Requests[1].Uri.AbsolutePath.Should().Be(
            "/api/misc/reserved/docs/a%20b/items/x%2Fy",
            "the first argument fills the reserved path parameter, keeping its slash");
        handler.Requests.Should().AllSatisfy(r => r.Headers["X-A"].Should().Be("1"));
    }

    [TestMethod]
    public async Task Modifiers_reach_only_the_first_page_when_following_next_links()
    {
        var (client, handler) = Create();
        handler
            .RespondJson("""{"kind":"signed","items":[{"title":"a","signedBy":"x"}],"next":"/catalogs?cursor=2"}""")
            .RespondJson("""{"kind":"signed","items":[{"title":"b","signedBy":"y"}]}""");
        var calls = 0;

        var books = new List<Book>();
        await foreach (var book in client.Catalogs()
            .AppendHeader("X-A", "1")
            .AppendQueryParameter("q", "1")
            .AppendCookie("c", "1")
            .ConfigureRequest(_ => calls++)
            .SignedAllAsync(tenant: "acme"))
        {
            books.Add(book);
        }

        books.Select(b => b.Title).Should().Equal("a", "b");
        handler.Requests.Should().HaveCount(2);
        calls.Should().Be(1, "the callback runs on the first page request only");

        var first = handler.Requests[0];
        first.Uri.Query.Should().Be("?q=1");
        first.Headers["X-A"].Should().Be("1");
        first.Headers["Cookie"].Should().Be("c=1");
        first.Headers["X-Tenant"].Should().Be("acme");

        var next = handler.Requests[1];
        next.Uri.Should().Be(new Uri("https://api.test/catalogs?cursor=2"), "the link is followed as given");
        next.Headers.Should().NotContainKey("X-A");
        next.Headers.Should().NotContainKey("Cookie");
        next.Headers["X-Tenant"].Should().Be("acme", "the operation's declared header is still sent");
    }

    [TestMethod]
    public async Task Modifiers_apply_to_a_generic_overload_that_reads_a_custom_model()
    {
        var (client, handler) = Harness.Create();
        handler.RespondJson("""{"id":"1","name":"gear","sku":"S-1"}""");

        var widget = await client.Widgets("1").AppendHeader("X-A", "1").ReadAsync<MyWidget>();

        widget.Sku.Should().Be("S-1");
        handler.Last.Uri.AbsolutePath.Should().Be("/api/widgets/1");
        handler.Last.Headers["X-A"].Should().Be("1");
    }

    [TestMethod]
    public void Modifiers_require_a_name_or_callback()
    {
        var (client, _) = Create();
        var builder = client.Pings();

        builder.Invoking(b => b.AppendHeader(null!, "v")).Should().Throw<ArgumentNullException>().WithParameterName("name");
        builder.Invoking(b => b.AppendQueryParameter(null!, "v")).Should().Throw<ArgumentNullException>().WithParameterName("name");
        builder.Invoking(b => b.AppendCookie(null!, "v")).Should().Throw<ArgumentNullException>().WithParameterName("name");
        builder.Invoking(b => b.ConfigureRequest(null!)).Should().Throw<ArgumentNullException>().WithParameterName("configure");
    }

    [TestMethod]
    public void The_client_requires_a_flurl_client()
    {
        var act = () => new KitchenSinkClient(null!);

        act.Should().Throw<ArgumentNullException>().WithParameterName("flurlClient");
    }

    [TestMethod]
    public async Task Dependency_injection_registers_only_the_client_as_transient()
    {
        var handler = new StubHandler();
        var services = new ServiceCollection();
        CustomModelsClientExtensions.AddCustomModelsClient(
            services,
            http => http.BaseAddress = new Uri("https://api.test/"),
            builder => builder.ConfigurePrimaryHttpMessageHandler(() => handler));

        services.Where(d => d.ServiceType.Assembly == typeof(CustomModelsClient).Assembly)
            .Should().ContainSingle()
            .Which.Should().Match<ServiceDescriptor>(d =>
                d.ServiceType == typeof(CustomModelsClient) && d.Lifetime == ServiceLifetime.Transient);

        await using var provider = services.BuildServiceProvider();
        var first = provider.GetRequiredService<CustomModelsClient>();
        var second = provider.GetRequiredService<CustomModelsClient>();
        first.Should().NotBeSameAs(second);
    }
}
