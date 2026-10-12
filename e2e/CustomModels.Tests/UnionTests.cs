using System.Text.Json;
using AwesomeAssertions;
using MassiveScale.CustomModels.Client;

namespace CustomModels.Tests;

/// <summary>Unions and literal types travel as what is actually on the wire.</summary>
[TestClass]
public sealed class UnionTests
{
    [TestMethod]
    public async Task A_union_of_a_string_and_a_number_reads_either()
    {
        var (client, handler) = Harness.Create();
        handler.RespondJson("""{"kind":"mixed","value":7,"note":null,"owner":null}""");
        handler.RespondJson("""{"kind":"mixed","value":"seven","note":"n","owner":{"name":"o"}}""");

        var number = await client.Mixes.ReadAsync();
        var text = await client.Mixes.ReadAsync();

        number.Value.ValueKind.Should().Be(JsonValueKind.Number);
        number.Value.GetInt32().Should().Be(7);
        text.Value.ValueKind.Should().Be(JsonValueKind.String);
        text.Value.GetString().Should().Be("seven");
    }

    [TestMethod]
    public async Task A_nullable_union_is_null_or_the_value()
    {
        var (client, handler) = Harness.Create();
        handler.RespondJson("""{"kind":"mixed","value":1,"note":null,"owner":null}""");
        handler.RespondJson("""{"kind":"mixed","value":1,"note":"n","owner":{"name":"o"}}""");

        var empty = await client.Mixes.ReadAsync();
        var full = await client.Mixes.ReadAsync();

        empty.Note.Should().BeNull();
        empty.Owner.Should().BeNull();
        full.Note.Should().Be("n");
        full.Owner!.Name.Should().Be("o");
    }

    [TestMethod]
    public async Task A_union_of_two_models_can_be_read_as_either()
    {
        var (client, handler) = Harness.Create();
        handler.RespondJson("""{"id":"1","name":"gear"}""");

        var either = await client.Mixes.EitherAsync();

        either.Deserialize<Widget>(new JsonSerializerOptions(JsonSerializerDefaults.Web))!.Name.Should().Be("gear");
    }

    [TestMethod]
    public async Task A_union_is_sent_as_the_json_it_holds()
    {
        var (client, handler) = Harness.Create();
        handler.RespondJson("""{"kind":"mixed","value":1,"note":null,"owner":null}""");

        await client.Mixes.CreateAsync(new Mixed
        {
            Value = JsonSerializer.SerializeToElement(42),
            Note = null,
            Owner = new Owner { Name = "o" },
        });

        using var sent = JsonDocument.Parse(handler.Last.Body!);
        sent.RootElement.GetProperty("value").ValueKind.Should().Be(JsonValueKind.Number);
        sent.RootElement.GetProperty("owner").GetProperty("name").GetString().Should().Be("o");
        sent.RootElement.TryGetProperty("note", out _).Should().BeFalse("a null optional-or-nullable value is left out");
    }

    [TestMethod]
    public void A_literal_type_is_its_underlying_type()
    {
        typeof(Mixed).GetProperty("Kind")!.PropertyType.Should().Be(typeof(string));
    }
}
