using System.Net;
using System.Reflection;
using AwesomeAssertions;
using MassiveScale.KitchenSink.Client;
using Microsoft.Extensions.DependencyInjection;

namespace CustomModels.Tests;

/// <summary>
/// Redirects for a client from the container: the registered handler leaves them to Flurl, as
/// Flurl's own client factory does, so a raw call is still redirected and a next-page request's
/// redirects reach the paging wrapper's origin check.
/// </summary>
[TestClass]
public sealed class RedirectsThroughDependencyInjectionTests
{
    [TestMethod]
    public async Task The_registered_primary_handler_does_not_follow_redirects_itself()
    {
        var services = new ServiceCollection();
        services.AddKitchenSinkClient(http => http.BaseAddress = new Uri("https://api.test/"));
        await using var provider = services.BuildServiceProvider();
        var name = (string)typeof(KitchenSinkClientExtensions)
            .GetField("HttpClientName", BindingFlags.NonPublic | BindingFlags.Static)!
            .GetRawConstantValue()!;

        HttpMessageHandler handler = provider.GetRequiredService<IHttpMessageHandlerFactory>().CreateHandler(name);
        while (handler is DelegatingHandler delegating)
        {
            handler = delegating.InnerHandler!;
        }

        handler.Should().BeOfType<HttpClientHandler>().Which.AllowAutoRedirect.Should().BeFalse();
    }

    [TestMethod]
    public async Task A_raw_call_that_is_redirected_is_still_followed()
    {
        var (provider, handler) = Container();
        await using var lifetime = provider;
        handler
            .RespondRedirect("/catalogs/moved")
            .RespondJson("""{"kind":"signed","items":[{"title":"a","signedBy":"x"}]}""");

        var page = await provider.GetRequiredService<KitchenSinkClient>().Catalogs.SignedAsync();

        page.Items.Select(b => b.Title).Should().Equal("a");
        handler.Requests.Should().HaveCount(2);
        handler.Requests[1].Uri.Should().Be(new Uri("https://api.test/catalogs/moved"));
    }

    [TestMethod]
    public async Task A_same_origin_redirect_of_a_next_page_request_is_followed_with_the_operation_headers()
    {
        var (provider, handler) = Container();
        await using var lifetime = provider;
        handler
            .RespondJson("""{"kind":"signed","items":[{"title":"a","signedBy":"x"}],"next":"?cursor=2"}""")
            .RespondRedirect("/catalogs/moved?cursor=2", HttpStatusCode.PermanentRedirect)
            .RespondJson("""{"kind":"signed","items":[{"title":"b","signedBy":"y"}]}""");

        var books = new List<Book>();
        await foreach (var book in provider.GetRequiredService<KitchenSinkClient>().Catalogs.SignedAllAsync(tenant: "acme"))
        {
            books.Add(book);
        }

        books.Select(b => b.Title).Should().Equal("a", "b");
        handler.Requests.Should().HaveCount(3);
        handler.Requests[2].Uri.Should().Be(new Uri("https://api.test/catalogs/moved?cursor=2"));
        handler.Requests[2].Headers["X-Tenant"].Should().Be("acme");
    }

    [TestMethod]
    public async Task A_redirect_of_a_next_page_request_to_another_origin_throws_before_anything_is_sent_there()
    {
        var (provider, handler) = Container();
        await using var lifetime = provider;
        handler
            .RespondJson("""{"kind":"signed","items":[{"title":"a","signedBy":"x"}],"next":"?cursor=2"}""")
            .RespondRedirect("https://elsewhere.test/steal");

        var act = async () =>
        {
            await foreach (var _ in provider.GetRequiredService<KitchenSinkClient>().Catalogs.SignedAllAsync(tenant: "acme"))
            {
            }
        };

        await act.Should().ThrowAsync<InvalidOperationException>()
            .WithMessage("Refusing to send a next-page request to https://elsewhere.test*");
        handler.Requests.Should().HaveCount(2);
        handler.Requests.Should().NotContain(r => r.Uri.Host == "elsewhere.test");
    }

    /// <summary>
    /// Registers the kitchen-sink client with the stub as the primary handler, which, like the
    /// registered one, returns a redirect rather than following it.
    /// </summary>
    private static (ServiceProvider Provider, StubHandler Handler) Container()
    {
        var handler = new StubHandler();
        var services = new ServiceCollection();
        services.AddKitchenSinkClient(
            http => http.BaseAddress = new Uri("https://api.test/"),
            builder => builder.ConfigurePrimaryHttpMessageHandler(() => handler));
        return (services.BuildServiceProvider(), handler);
    }
}
