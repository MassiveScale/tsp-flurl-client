using System.Net;
using System.Text;
using AwesomeAssertions;
using Flurl.Http;
using MassiveScale.CustomModels.Client;
using Microsoft.Extensions.DependencyInjection;

namespace CustomModels.Tests;

/// <summary>Routes, parameters, headers, raw bodies, and dependency injection.</summary>
[TestClass]
public sealed class WireFormatTests
{
    [TestMethod]
    public async Task Query_parameters_use_wire_names_and_repeat_for_lists()
    {
        var (client, handler) = Harness.Create();
        handler.RespondJson("""{"items":[]}""");

        await client.Widgets.ListAsync(Color.Blue, ["a", "b"], "trace-1");

        handler.Last.Method.Should().Be(HttpMethod.Get);
        handler.Last.Uri.PathAndQuery.Should().Be("/api/widgets?color=blue&tags=a&tags=b");
        handler.Last.Headers["X-Trace"].Should().Be("trace-1");
    }

    [TestMethod]
    public async Task Omitted_optional_parameters_add_nothing()
    {
        var (client, handler) = Harness.Create();
        handler.RespondJson("""{"items":[]}""");

        await client.Widgets.ListAsync();

        handler.Last.Uri.PathAndQuery.Should().Be("/api/widgets");
        handler.Last.Headers.Should().NotContainKey("X-Trace");
    }

    [TestMethod]
    public async Task Additional_query_parameters_are_appended()
    {
        var (client, handler) = Harness.Create();
        handler.RespondJson("""{"items":[]}""");

        await client.Widgets.ListAsync(additionalQueryParameters: new() { ["debug"] = true, ["when"] = Color.Red });

        handler.Last.Uri.Query.Should().Be("?debug=true&when=red");
    }

    [TestMethod]
    public async Task Path_values_are_fully_percent_encoded()
    {
        var (client, handler) = Harness.Create();
        handler.RespondJson("""{"id":"x","name":"n"}""");

        await client.Widgets.ReadAsync("a/b c?d");

        handler.Last.Uri.AbsolutePath.Should().Be("/api/widgets/a%2Fb%20c%3Fd");
    }

    [TestMethod]
    public async Task A_delete_with_no_response_body_completes()
    {
        var (client, handler) = Harness.Create();

        await client.Widgets.DeleteAsync("1");

        handler.Last.Method.Should().Be(HttpMethod.Delete);
    }

    [TestMethod]
    public async Task A_byte_body_is_sent_raw_with_its_media_type()
    {
        var (client, handler) = Harness.Create();
        byte[] payload = [1, 2, 3, 255];

        await client.Files.UploadAsync(payload);

        handler.Last.BodyBytes.Should().Equal(payload);
        handler.Last.ContentType.Should().Be("application/octet-stream");
    }

    [TestMethod]
    public async Task A_byte_response_is_returned_raw()
    {
        var (client, handler) = Harness.Create();
        byte[] payload = [9, 8, 7, 0, 255];
        handler.RespondBytes(payload);

        var data = await client.Files.DownloadAsync("f1");

        data.Should().Equal(payload);
        handler.Last.Uri.AbsolutePath.Should().Be("/api/files/f1");
    }

    [TestMethod]
    public async Task Calls_made_through_dependency_injection_apply_the_model_map()
    {
        var handler = new StubHandler().RespondJson("""{"id":"1","name":"gear","sku":"S-1"}""");
        var services = new ServiceCollection();
        services.AddCustomModelsClient(
            http => http.BaseAddress = new Uri("https://api.test/"),
            builder => builder.ConfigurePrimaryHttpMessageHandler(() => handler),
            models => models.Map<Widget, MyWidget>());
        await using var provider = services.BuildServiceProvider();

        var widget = await provider.GetRequiredService<IWidgets>().ReadAsync("1");
        var aggregate = provider.GetRequiredService<CustomModelsClient>();

        widget.Should().BeOfType<MyWidget>();
        aggregate.Widgets.Should().NotBeNull();
        aggregate.Pets.Should().NotBeNull();
        aggregate.Files.Should().NotBeNull();
        aggregate.FlurlClient.Should().NotBeNull();
        handler.Last.Uri.Host.Should().Be("api.test");
    }

    [TestMethod]
    public void A_client_can_be_created_from_a_base_url()
    {
        var client = CustomModelsClient.Create("https://api.test", m => m.Map<Widget, MyWidget>());

        client.FlurlClient.BaseUrl.Should().Be("https://api.test");
        client.Widgets.Should().NotBeNull();
    }

    [TestMethod]
    public void Registration_requires_its_arguments()
    {
        new ServiceCollection().Invoking(s => s.AddCustomModelsClient(null!)).Should().Throw<ArgumentNullException>();

        var act = () => CustomModelsClientExtensions.AddCustomModelsClient(null!, _ => { });
        act.Should().Throw<ArgumentNullException>();
    }
}
