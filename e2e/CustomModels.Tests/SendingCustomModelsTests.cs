using System.Text.Json;
using AwesomeAssertions;
using MassiveScale.CustomModels.Client;

namespace CustomModels.Tests;

/// <summary>A derived model passed to a method reaches the API with its extra properties.</summary>
[TestClass]
public sealed class SendingCustomModelsTests
{
    [TestMethod]
    public async Task A_derived_request_body_is_sent_with_its_extra_properties()
    {
        var (client, handler) = Harness.Create();
        handler.RespondJson("""{"id":"1","name":"gear"}""");

        await client.Widgets.CreateAsync(new MyCreateRequest { Name = "gear", Sku = "G-1" });

        using var sent = JsonDocument.Parse(handler.Last.Body!);
        sent.RootElement.GetProperty("name").GetString().Should().Be("gear");
        sent.RootElement.GetProperty("sku").GetString().Should().Be("G-1");
    }

    [TestMethod]
    public async Task Null_optional_properties_are_left_out_of_the_body()
    {
        var (client, handler) = Harness.Create();
        handler.RespondJson("""{"id":"1","name":"gear"}""");

        await client.Widgets.CreateAsync(new WidgetCreateRequest { Name = "gear" });

        handler.Last.Body.Should().Be("""{"name":"gear"}""");
    }

    [TestMethod]
    public async Task A_list_of_derived_models_keeps_each_items_extra_properties()
    {
        var (client, handler) = Harness.Create();
        handler.RespondJson("[]");

        await client.Widgets.CreateManyAsync(new List<MyWidget> { new() { Id = "1", Name = "a", Sku = "S-1" } });

        using var sent = JsonDocument.Parse(handler.Last.Body!);
        sent.RootElement[0].GetProperty("sku").GetString().Should().Be("S-1");
    }

    [TestMethod]
    public async Task A_merge_patch_against_a_derived_model_is_accepted_and_sent()
    {
        var (client, handler) = Harness.Create();
        handler.RespondJson("""{"id":"1","name":"gear"}""");

        var patch = new MergePatch<MyWidget>().Set(w => w.Sku, "S-2").Clear(w => w.Color);
        await client.Widgets.UpdateAsync("1", patch);

        handler.Last.Method.Should().Be(HttpMethod.Patch);
        handler.Last.Body.Should().Be("""{"sku":"S-2","color":null}""");
    }

    [TestMethod]
    public async Task A_derived_subtype_of_a_discriminated_model_is_sent_with_its_discriminator()
    {
        var (client, handler) = Harness.Create();
        handler.RespondJson("""{"kind":"dog","name":"rex","isBarker":true}""");

        await client.Pets.CreateAsync(new MyDog { Name = "rex", IsBarker = true, Breed = "lab" });

        using var sent = JsonDocument.Parse(handler.Last.Body!);
        sent.RootElement.GetProperty("kind").GetString().Should().Be("dog");
        sent.RootElement.GetProperty("breed").GetString().Should().Be("lab");
    }

    [TestMethod]
    public async Task A_plain_generated_subtype_is_still_sent_with_its_discriminator()
    {
        var (client, handler) = Harness.Create();
        handler.RespondJson("""{"kind":"dog","name":"rex","isBarker":true}""");

        await client.Pets.CreateAsync(new Dog { Name = "rex", IsBarker = true });

        using var sent = JsonDocument.Parse(handler.Last.Body!);
        sent.RootElement.GetProperty("kind").GetString().Should().Be("dog");
    }
}
