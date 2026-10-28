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

        await client.Widgets().CreateAsync(new MyCreateRequest { Name = "gear", Sku = "G-1" });

        using var sent = JsonDocument.Parse(handler.Last.Body!);
        sent.RootElement.GetProperty("name").GetString().Should().Be("gear");
        sent.RootElement.GetProperty("sku").GetString().Should().Be("G-1");
    }

    [TestMethod]
    public async Task Null_optional_properties_are_left_out_of_the_body()
    {
        var (client, handler) = Harness.Create();
        handler.RespondJson("""{"id":"1","name":"gear"}""");

        await client.Widgets().CreateAsync(new WidgetCreateRequest { Name = "gear" });

        handler.Last.Body.Should().Be("""{"name":"gear"}""");
    }

    [TestMethod]
    public async Task A_list_of_derived_models_keeps_each_items_extra_properties()
    {
        var (client, handler) = Harness.Create();
        handler.RespondJson("[]");

        await client.Widgets().CreateManyAsync(new List<MyCreateRequest> { new() { Name = "a", Sku = "S-1" } });

        using var sent = JsonDocument.Parse(handler.Last.Body!);
        sent.RootElement[0].GetProperty("sku").GetString().Should().Be("S-1");
        sent.RootElement[0].TryGetProperty("id", out _).Should().BeFalse("id is read-only, so a bulk create does not send it");
    }

    [TestMethod]
    public async Task A_dictionary_body_of_a_derived_request_type_is_accepted_and_sent()
    {
        var (client, handler) = Harness.Create();
        handler.RespondJson("""{"a":{"id":"1","name":"a"}}""");

        var created = await client.Widgets().CreateKeyedAsync(
            new Dictionary<string, MyCreateRequest> { ["a"] = new() { Name = "a", Sku = "S-1" } });

        using var sent = JsonDocument.Parse(handler.Last.Body!);
        sent.RootElement.GetProperty("a").GetProperty("sku").GetString().Should().Be("S-1");
        sent.RootElement.GetProperty("a").TryGetProperty("id", out _).Should().BeFalse("id is read-only");
        created["a"].Should().BeOfType<Widget>();
    }

    [TestMethod]
    public async Task A_dictionary_body_and_its_response_can_both_be_custom_types()
    {
        var (client, handler) = Harness.Create();
        handler.RespondJson("""{"a":{"id":"1","name":"a","sku":"S-9"}}""");

        var created = await client.Widgets().CreateKeyedAsync<MyWidget, MyCreateRequest>(
            new Dictionary<string, MyCreateRequest> { ["a"] = new() { Name = "a", Sku = "S-1" } });

        created["a"].Sku.Should().Be("S-9");
        using var sent = JsonDocument.Parse(handler.Last.Body!);
        sent.RootElement.GetProperty("a").GetProperty("sku").GetString().Should().Be("S-1");
    }

    [TestMethod]
    public async Task A_dictionary_body_of_the_declared_type_still_uses_the_declared_overloads()
    {
        var (client, handler) = Harness.Create();
        handler.RespondJson("""{"a":{"id":"1","name":"a","sku":"S-9"}}""")
            .RespondJson("""{"a":{"id":"1","name":"a","sku":"S-9"}}""");
        var body = new Dictionary<string, WidgetCreateRequest> { ["a"] = new() { Name = "a" } };

        (await client.Widgets().CreateKeyedAsync(body))["a"].Should().BeOfType<Widget>();
        (await client.Widgets().CreateKeyedAsync<MyWidget>(body))["a"].Sku.Should().Be("S-9");
    }

    [TestMethod]
    public async Task A_merge_patch_against_a_derived_model_is_accepted_and_sent()
    {
        var (client, handler) = Harness.Create();
        handler.RespondJson("""{"id":"1","name":"gear"}""");

        var patch = new MergePatch<MyWidget>().Set(w => w.Sku, "S-2").Clear(w => w.Color);
        await client.Widgets("1").UpdateAsync(patch);

        handler.Last.Method.Should().Be(HttpMethod.Patch);
        handler.Last.Body.Should().Be("""{"sku":"S-2","color":null}""");
    }

    [TestMethod]
    public async Task A_derived_subtype_of_a_discriminated_model_is_sent_with_its_discriminator()
    {
        var (client, handler) = Harness.Create();
        handler.RespondJson("""{"kind":"dog","name":"rex","isBarker":true}""");

        await client.Pets().CreateAsync(new MyDog { Name = "rex", IsBarker = true, Breed = "lab" });

        using var sent = JsonDocument.Parse(handler.Last.Body!);
        sent.RootElement.GetProperty("kind").GetString().Should().Be("dog");
        sent.RootElement.GetProperty("breed").GetString().Should().Be("lab");
    }

    [TestMethod]
    public async Task A_plain_generated_subtype_is_still_sent_with_its_discriminator()
    {
        var (client, handler) = Harness.Create();
        handler.RespondJson("""{"kind":"dog","name":"rex","isBarker":true}""");

        await client.Pets().CreateAsync(new Dog { Name = "rex", IsBarker = true });

        using var sent = JsonDocument.Parse(handler.Last.Body!);
        sent.RootElement.GetProperty("kind").GetString().Should().Be("dog");
    }

    [TestMethod]
    public async Task A_derived_model_set_on_a_merge_patch_keeps_its_extra_properties()
    {
        var (client, handler) = Harness.Create();
        handler.RespondJson("""{"id":"1","owner":{"name":"ann"},"tags":{},"raw":null,"bytes":""}""");

        var patch = new MergePatch<Gadget>().Set(g => g.Owner, new MyOwner { Name = "ann", Nickname = "annie" });
        await client.Gadgets("1").UpdateAsync(patch);

        using var sent = JsonDocument.Parse(handler.Last.Body!);
        var owner = sent.RootElement.GetProperty("owner");
        owner.GetProperty("name").GetString().Should().Be("ann");
        owner.GetProperty("nickname").GetString().Should().Be("annie", "the value is written as its runtime type");
    }

    [TestMethod]
    public async Task A_null_set_on_a_merge_patch_is_sent_as_json_null()
    {
        var (client, handler) = Harness.Create();
        handler.RespondJson("""{"id":"1","owner":{"name":"ann"},"tags":{},"raw":null,"bytes":""}""");

        await client.Gadgets("1").UpdateAsync(new MergePatch<Gadget>().Set("raw", (object?)null));

        handler.Last.Body.Should().Be("""{"raw":null}""");
    }

    [TestMethod]
    public async Task A_mapped_subtype_of_a_discriminated_model_is_sent_with_its_discriminator()
    {
        var (client, handler) = Harness.Create(m => m.Map<Dog, MyDog>());
        handler.RespondJson("""{"kind":"dog","name":"rex","isBarker":true}""");

        await client.Pets().CreateAsync(new MyDog { Name = "rex", IsBarker = true, Breed = "lab" });

        handler.Last.Body.Should().Contain("\"breed\":\"lab\"");
        CountOf(handler.Last.Body!, "\"kind\":\"dog\"").Should().Be(1, "the discriminator is written exactly once");
    }

    [TestMethod]
    public async Task A_mapped_subtype_in_a_list_of_its_base_is_sent_with_its_discriminator_once()
    {
        var (client, handler) = Harness.Create(m => m.Map<Dog, MyDog>());
        handler.RespondJson("[]");

        await client.Pets().CreateManyAsync(
            [new MyDog { Name = "rex", IsBarker = true, Breed = "lab" }, new Cat { Name = "tom", IsPurrer = true }]);

        using var sent = JsonDocument.Parse(handler.Last.Body!);
        sent.RootElement[0].GetProperty("kind").GetString().Should().Be("dog");
        sent.RootElement[0].GetProperty("breed").GetString().Should().Be("lab");
        sent.RootElement[1].GetProperty("kind").GetString().Should().Be("cat");
        CountOf(handler.Last.Body!, "\"kind\":\"dog\"").Should().Be(1);
    }

    [TestMethod]
    public async Task A_mapped_subtype_is_still_read_through_its_base_after_being_sent()
    {
        var (client, handler) = Harness.Create(m => m.Map<Dog, MyDog>());
        handler.RespondJson("""{"kind":"dog","name":"rex","isBarker":true}""");
        await client.Pets().CreateAsync(new MyDog { Name = "rex", IsBarker = true, Breed = "lab" });

        handler.RespondJson("""[{"kind":"dog","name":"rex","isBarker":true,"breed":"lab"}]""");
        var pets = await client.Pets().ListAsync();

        pets[0].Should().BeOfType<MyDog>().Which.Breed.Should().Be("lab");
    }

    private static int CountOf(string text, string value) =>
        (text.Length - text.Replace(value, string.Empty).Length) / value.Length;
}
