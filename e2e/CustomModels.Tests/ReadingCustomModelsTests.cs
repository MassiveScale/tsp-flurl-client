using System.Text.Json;
using AwesomeAssertions;
using Flurl.Http;
using MassiveScale.CustomModels.Client;

namespace CustomModels.Tests;

/// <summary>Responses are read as the model the caller asked for, by overload or by <see cref="ModelMap"/>.</summary>
[TestClass]
public sealed class ReadingCustomModelsTests
{
    private const string WidgetJson = """{"id":"1","name":"gear","sku":"S-1"}""";

    private const string PageJson =
        """{"items":[{"id":"1","name":"a","sku":"S-1"}],"featured":{"id":"2","name":"b","sku":"S-2"},"cursor":"next"}""";

    [TestMethod]
    public async Task The_declared_overload_returns_the_generated_model_and_drops_unknown_properties()
    {
        var (client, handler) = Harness.Create();
        handler.RespondJson(WidgetJson);

        var widget = await client.Widgets.ReadAsync("1");

        widget.Should().BeOfType<Widget>();
        widget.Name.Should().Be("gear");
    }

    [TestMethod]
    public async Task The_generic_overload_returns_the_custom_model()
    {
        var (client, handler) = Harness.Create();
        handler.RespondJson(WidgetJson);

        var widget = await client.Widgets.ReadAsync<MyWidget>("1");

        widget.Sku.Should().Be("S-1");
        widget.Name.Should().Be("gear");
    }

    [TestMethod]
    public async Task The_generic_overload_works_for_a_wrapper_with_nested_models()
    {
        var (client, handler) = Harness.Create();
        handler.RespondJson(PageJson);

        var page = await client.Widgets.ListAsync<MyWidgetPage>();

        page.Cursor.Should().Be("next");
        page.Items.Should().ContainSingle().Which.Name.Should().Be("a");
    }

    [TestMethod]
    public async Task The_generic_overload_works_for_a_list_response()
    {
        var (client, handler) = Harness.Create();
        handler.RespondJson($"[{WidgetJson}]");

        var widgets = await client.Widgets.CreateManyAsync<MyWidget>([]);

        widgets.Should().ContainSingle().Which.Sku.Should().Be("S-1");
    }

    [TestMethod]
    public async Task A_custom_subtype_of_a_discriminated_model_is_read_by_generic_overload()
    {
        var (client, handler) = Harness.Create();
        handler.RespondJson("""[{"kind":"dog","name":"rex","isBarker":true,"breed":"lab"}]""");

        var pets = await client.Pets.ListAsync<MyDog>();

        pets.Should().ContainSingle().Which.Breed.Should().Be("lab");
    }

    [TestMethod]
    public async Task A_mapped_model_is_returned_as_the_custom_type_everywhere_it_appears()
    {
        var (client, handler) = Harness.Create(m => m.Map<Widget, MyWidget>());
        handler.RespondJson(PageJson);

        var page = await client.Widgets.ListAsync();

        page.Items[0].Should().BeOfType<MyWidget>().Which.Sku.Should().Be("S-1");
        page.Featured.Should().BeOfType<MyWidget>().Which.Sku.Should().Be("S-2");
    }

    [TestMethod]
    public async Task A_mapped_model_is_returned_as_the_custom_type_from_the_declared_overload()
    {
        var (client, handler) = Harness.Create(m => m.Map<Widget, MyWidget>());
        handler.RespondJson(WidgetJson);

        var widget = await client.Widgets.ReadAsync("1");

        widget.Should().BeOfType<MyWidget>().Which.Sku.Should().Be("S-1");
    }

    [TestMethod]
    public async Task Raw_flurl_calls_on_the_exposed_client_get_the_mapped_model_too()
    {
        var (client, handler) = Harness.Create(m => m.Map<Widget, MyWidget>());
        handler.RespondJson(WidgetJson);

        var widget = await client.FlurlClient.Request("api/widgets/1").GetJsonAsync<Widget>();

        widget.Should().BeOfType<MyWidget>().Which.Sku.Should().Be("S-1");
    }

    [TestMethod]
    public async Task A_mapped_subtype_of_a_discriminated_model_is_returned_when_read_through_its_base()
    {
        var (client, handler) = Harness.Create(m => m.Map<Dog, MyDog>());
        handler.RespondJson(
            """[{"kind":"dog","name":"rex","isBarker":true,"breed":"lab"},{"kind":"cat","name":"tom","isPurrer":true}]""");

        var pets = await client.Pets.ListAsync();

        pets[0].Should().BeOfType<MyDog>().Which.Breed.Should().Be("lab");
        pets[1].Should().BeOfType<Cat>();
    }

    [TestMethod]
    public async Task A_mapped_model_nested_in_a_list_body_keeps_its_extra_properties_when_sent()
    {
        var (client, handler) = Harness.Create(m => m.Map<Owner, MyOwner>());

        await client.Owners.CreateManyAsync(new List<Owner> { new MyOwner { Name = "a", Nickname = "n" } });

        handler.Last.Body.Should().Contain("\"nickname\":\"n\"");
    }

    [TestMethod]
    public async Task A_plain_instance_of_a_mapped_model_is_still_sent_without_recursing()
    {
        var (client, handler) = Harness.Create(m => m.Map<Owner, MyOwner>());

        await client.Owners.CreateManyAsync(new List<Owner> { new Owner { Name = "a" } });

        handler.Last.Body.Should().Be("""[{"name":"a"}]""");
    }

    [TestMethod]
    public async Task A_non_success_response_throws_and_exposes_the_error_body()
    {
        var (client, handler) = Harness.Create();
        handler.RespondJson("""{"code":7,"message":"nope"}""", System.Net.HttpStatusCode.BadRequest);

        var act = () => client.Widgets.ReadAsync("1");

        var failure = (await act.Should().ThrowAsync<FlurlHttpException>()).Which;
        (await failure.GetResponseStringAsync()).Should().Contain("nope");
    }

    [TestMethod]
    public async Task Other_mapped_models_still_apply_inside_a_plain_instance_of_a_mapped_model()
    {
        var (client, handler) = Harness.Create(m => m.Map<Gadget, MyGadget>().Map<Owner, MyOwner>());
        handler.RespondJson("""{"id":"1","owner":{"name":"o"},"tags":{},"raw":null,"bytes":""}""");

        // The gadget itself is a plain Gadget, which the map would turn into a MyGadget when reading,
        // so writing it takes a different path. Its owner is a custom MyOwner and must keep its extras.
        await client.Gadgets.CreateAsync(new Gadget
        {
            Id = "1",
            Owner = new MyOwner { Name = "o", Nickname = "ozzy" },
            Tags = new Dictionary<string, string>(),
            Raw = JsonSerializer.SerializeToElement((string?)null),
            Bytes = [],
        });

        using var sent = JsonDocument.Parse(handler.Last.Body!);
        sent.RootElement.GetProperty("owner").GetProperty("nickname").GetString().Should().Be("ozzy");
    }
}
