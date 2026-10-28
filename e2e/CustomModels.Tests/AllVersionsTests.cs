using System.Reflection;
using System.Text.Json;
using AwesomeAssertions;
using Flurl.Http;
using Microsoft.Extensions.DependencyInjection;
using V1 = MassiveScale.AllVersions.Client.V1_0;
using V2 = MassiveScale.AllVersions.Client.V2_0;

namespace CustomModels.Tests;

/// <summary>
/// With all versions emitted, each version's types have exactly that version's shape, and the
/// clients for different versions can live side by side.
/// </summary>
[TestClass]
public sealed class AllVersionsTests
{
    private const string Root = "MassiveScale.AllVersions.Client";

    private static (TClient Client, StubHandler Handler) Create<TClient>(Func<IFlurlClient, TClient> create)
    {
        var handler = new StubHandler();
        var flurl = new FlurlClient(new HttpClient(handler) { BaseAddress = new Uri("https://api.test/") });
        return (create(flurl), handler);
    }

    private static string[] ParameterNames(Type endpoint, string method) =>
        endpoint.GetMethods()
            .Single(m => m.Name == method && !m.IsGenericMethod)
            .GetParameters()
            .Select(p => p.Name!)
            .ToArray();

    [TestMethod]
    public void Model_properties_are_projected_onto_each_version()
    {
        typeof(V1.Widget).GetProperty("LegacyCode").Should().NotBeNull();
        typeof(V1.Widget).GetProperty("Color").Should().BeNull();

        typeof(V2.Widget).GetProperty("Color").Should().NotBeNull();
        typeof(V2.Widget).GetProperty("LegacyCode").Should().BeNull();
    }

    [TestMethod]
    public void Request_records_are_projected_onto_each_version()
    {
        typeof(V1.WidgetCreateRequest).GetProperty("LegacyCode").Should().NotBeNull();
        typeof(V1.WidgetCreateRequest).GetProperty("Color").Should().BeNull();
        typeof(V2.WidgetCreateRequest).GetProperty("Color").Should().NotBeNull();
    }

    [TestMethod]
    public void Enum_members_are_projected_onto_each_version()
    {
        Enum.GetNames(typeof(V1.Status)).Should().Equal("Active", "Legacy");
        Enum.GetNames(typeof(V2.Status)).Should().Equal("Active", "Archived");
    }

    [TestMethod]
    public void A_model_that_only_exists_in_a_later_version_is_only_generated_there()
    {
        typeof(V1.Widget).Assembly.GetType($"{Root}.V1_0.Label").Should().BeNull();
        typeof(V2.Widget).Assembly.GetType($"{Root}.V2_0.Label").Should().NotBeNull();
        typeof(V1.Widget).Assembly.GetType($"{Root}.V1_0.Cat").Should().BeNull();
        typeof(V2.Widget).Assembly.GetType($"{Root}.V2_0.Cat").Should().NotBeNull();
    }

    [TestMethod]
    public void Operations_and_parameters_are_projected_onto_each_version()
    {
        ParameterNames(typeof(V1.WidgetsItemRequestBuilder), "ReadAsync").Should().NotContain("expand");
        ParameterNames(typeof(V2.WidgetsItemRequestBuilder), "ReadAsync").Should().Contain("expand");

        typeof(V1.WidgetsRequestBuilder).GetMethods().Should().NotContain(m => m.Name == "LabelsAsync");
        typeof(V1.WidgetsItemRequestBuilder).GetMethods().Should().NotContain(m => m.Name == "LabelsAsync");
        typeof(V2.WidgetsRequestBuilder).GetMethods().Should().Contain(m => m.Name == "LabelsAsync");
    }

    [TestMethod]
    public async Task Each_version_calls_its_own_route_with_its_own_shape()
    {
        var (v1, v1Handler) = Create(f => V1.AllVersionsClient.Create(f));
        v1Handler.RespondJson("""{"id":"1","name":"gear","legacyCode":"L-1"}""");
        var v1Widget = await v1.Widgets("1").ReadAsync();

        v1Handler.Last.Uri.PathAndQuery.Should().Be("/api/v1.0/widgets/1");
        v1Widget.LegacyCode.Should().Be("L-1");

        var (v2, v2Handler) = Create(f => V2.AllVersionsClient.Create(f));
        v2Handler.RespondJson("""{"id":"1","name":"gear","color":"red"}""");
        var v2Widget = await v2.Widgets("1").ReadAsync(expand: true);

        v2Handler.Last.Uri.PathAndQuery.Should().Be("/api/v2.0/widgets/1?expand=true");
        v2Widget.Color.Should().Be("red");
    }

    [TestMethod]
    public async Task Each_version_sends_its_own_request_shape()
    {
        var (v1, v1Handler) = Create(f => V1.AllVersionsClient.Create(f));
        v1Handler.RespondJson("""{"id":"1","name":"gear"}""");
        await v1.Widgets().CreateAsync(new V1.WidgetCreateRequest { Name = "gear", LegacyCode = "L-1" });

        v1Handler.Last.Body.Should().Be("""{"name":"gear","legacyCode":"L-1"}""");

        var (v2, v2Handler) = Create(f => V2.AllVersionsClient.Create(f));
        v2Handler.RespondJson("""{"id":"1","name":"gear"}""");
        await v2.Widgets().CreateAsync(new V2.WidgetCreateRequest { Name = "gear", Color = "red" });

        v2Handler.Last.Body.Should().Be("""{"name":"gear","color":"red"}""");
    }

    [TestMethod]
    public async Task Each_version_accepts_only_its_own_enum_values()
    {
        var (v1, v1Handler) = Create(f => V1.AllVersionsClient.Create(f));
        v1Handler.RespondJson("""{"id":"1","name":"a","status":"legacy"}""");
        (await v1.Widgets("1").ReadAsync()).Status.Should().Be(V1.Status.Legacy);

        v1Handler.RespondJson("""{"id":"1","name":"a","status":"archived"}""");
        var archivedInV1 = () => v1.Widgets("1").ReadAsync();
        await archivedInV1.Should().ThrowAsync<Exception>();

        var (v2, v2Handler) = Create(f => V2.AllVersionsClient.Create(f));
        v2Handler.RespondJson("""{"id":"1","name":"a","status":"archived"}""");
        (await v2.Widgets("1").ReadAsync()).Status.Should().Be(V2.Status.Archived);

        v2Handler.RespondJson("""{"id":"1","name":"a","status":"legacy"}""");
        var legacyInV2 = () => v2.Widgets("1").ReadAsync();
        await legacyInV2.Should().ThrowAsync<Exception>();
    }

    [TestMethod]
    public async Task Each_version_reads_only_its_own_subtypes()
    {
        const string dog = """{"kind":"dog","name":"rex"}""";
        const string cat = """{"kind":"cat","name":"tom"}""";

        var (v1, v1Handler) = Create(f => V1.AllVersionsClient.Create(f));
        v1Handler.RespondJson($"[{dog}]");
        (await v1.Pets().ListAsync()).Should().ContainSingle().Which.Should().BeOfType<V1.Dog>();

        v1Handler.RespondJson($"[{cat}]");
        var catInV1 = () => v1.Pets().ListAsync();
        await catInV1.Should().ThrowAsync<Exception>();

        var (v2, v2Handler) = Create(f => V2.AllVersionsClient.Create(f));
        v2Handler.RespondJson($"[{dog},{cat}]");
        var pets = await v2.Pets().ListAsync();
        pets[0].Should().BeOfType<V2.Dog>();
        pets[1].Should().BeOfType<V2.Cat>();
    }

    [TestMethod]
    public async Task Custom_models_are_registered_per_version()
    {
        var (v1, v1Handler) = Create(f => V1.AllVersionsClient.Create(f, new MassiveScale.AllVersions.Client.ModelMap().Map<V1.Widget, V1Widget>()));
        v1Handler.RespondJson("""{"id":"1","name":"gear","sku":"S-1"}""");

        var v1Widget = await v1.Widgets("1").ReadAsync();

        v1Widget.Should().BeOfType<V1Widget>().Which.Sku.Should().Be("S-1");

        var (v2, v2Handler) = Create(f => V2.AllVersionsClient.Create(f));
        v2Handler.RespondJson("""{"id":"1","name":"gear","sku":"S-1"}""");

        (await v2.Widgets("1").ReadAsync()).Should().BeOfType<V2.Widget>("version 2 has no map of its own");
    }

    [TestMethod]
    public async Task Two_versions_can_be_registered_together_without_sharing_a_model_map()
    {
        var v1Handler = new StubHandler().RespondJson("""{"id":"1","name":"gear","sku":"S-1"}""");
        var v2Handler = new StubHandler().RespondJson("""{"id":"1","name":"gear","sku":"S-1"}""");
        var services = new ServiceCollection();
        V1.AllVersionsClientExtensions.AddAllVersionsClient(
            services,
            http => http.BaseAddress = new Uri("https://api.test/"),
            builder => builder.ConfigurePrimaryHttpMessageHandler(() => v1Handler),
            models => models.Map<V1.Widget, V1Widget>());
        V2.AllVersionsClientExtensions.AddAllVersionsClient(
            services,
            http => http.BaseAddress = new Uri("https://api.test/"),
            builder => builder.ConfigurePrimaryHttpMessageHandler(() => v2Handler));
        await using var provider = services.BuildServiceProvider();

        var v1Widget = await provider.GetRequiredService<V1.AllVersionsClient>().Widgets("1").ReadAsync();
        var v2Widget = await provider.GetRequiredService<V2.AllVersionsClient>().Widgets("1").ReadAsync();

        v1Widget.Should().BeOfType<V1Widget>("the version 1 registration maps its widget");
        v2Widget.Should().BeOfType<V2.Widget>("registering version 2 must not replace version 1's map, nor inherit it");
        v1Handler.Last.Uri.AbsolutePath.Should().Be("/api/v1.0/widgets/1");
        v2Handler.Last.Uri.AbsolutePath.Should().Be("/api/v2.0/widgets/1");
    }

    public record V1Widget : V1.Widget
    {
        [System.Text.Json.Serialization.JsonPropertyName("sku")]
        public string? Sku { get; init; }
    }

    [TestMethod]
    public void A_renamed_retyped_or_made_optional_model_keeps_each_versions_shape()
    {
        typeof(V1.Gadget).GetProperty("Title")!.PropertyType.Should().Be(typeof(string));
        typeof(V1.Gadget).GetProperty("Size")!.PropertyType.Should().Be(typeof(int));
        typeof(V1.Gadget).GetProperty("Name").Should().BeNull();
        typeof(V1.Gadget).Assembly.GetType($"{Root}.V1_0.Gizmo").Should().BeNull();

        typeof(V2.Gizmo).GetProperty("Name")!.PropertyType.Should().Be(typeof(string));
        typeof(V2.Gizmo).GetProperty("Size")!.PropertyType.Should().Be(typeof(string));
        typeof(V2.Gizmo).Assembly.GetType($"{Root}.V2_0.Gadget").Should().BeNull();

        var nullability = new NullabilityInfoContext();
        nullability.Create(typeof(V1.Gadget).GetProperty("Note")!).ReadState
            .Should().Be(NullabilityState.NotNull, "note is required in v1");
        nullability.Create(typeof(V2.Gizmo).GetProperty("Note")!).ReadState
            .Should().Be(NullabilityState.Nullable, "note was made optional in v2");
    }

    [TestMethod]
    public async Task Renamed_parameters_and_changed_return_types_follow_each_version()
    {
        var (v1, v1Handler) = Create(f => V1.AllVersionsClient.Create(f));
        v1Handler.RespondJson("""{"title":"t","size":3,"note":"n"}""");
        var gadget = await v1.Gizmos().ReadAsync("x");
        v1Handler.Last.Uri.Query.Should().Be("?q=x");
        gadget.Title.Should().Be("t");
        gadget.Size.Should().Be(3);

        var (v2, v2Handler) = Create(f => V2.AllVersionsClient.Create(f));
        v2Handler.RespondJson("""{"name":"n","size":"large"}""");
        var gizmo = await v2.Gizmos().ReadAsync("x");
        v2Handler.Last.Uri.Query.Should().Be("?search=x");
        gizmo.Size.Should().Be("large");

        v1Handler.RespondText("42");
        int v1Count = await v1.Gizmos().CountAsync();
        v1Count.Should().Be(42);

        v2Handler.RespondText("about forty");
        string v2Count = await v2.Gizmos().CountAsync();
        v2Count.Should().Be("about forty");
    }
}
