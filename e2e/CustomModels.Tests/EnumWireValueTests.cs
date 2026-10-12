using System.Text.Json;
using AwesomeAssertions;
using MassiveScale.CustomModels.Client;

namespace CustomModels.Tests;

/// <summary>Enums travel on the wire as their declared values, not their C# member names.</summary>
[TestClass]
public sealed class EnumWireValueTests
{
    [TestMethod]
    public async Task An_enum_in_a_request_body_is_sent_as_its_declared_value()
    {
        var (client, handler) = Harness.Create();
        handler.RespondJson("""{"id":"1","name":"gear"}""");

        await client.Widgets.CreateAsync(new WidgetCreateRequest { Name = "gear", Color = Color.Blue });

        using var sent = JsonDocument.Parse(handler.Last.Body!);
        sent.RootElement.GetProperty("color").GetString().Should().Be("blue");
    }

    [TestMethod]
    public async Task An_enum_in_a_response_is_read_from_its_declared_value()
    {
        var (client, handler) = Harness.Create();
        handler.RespondJson("""{"id":"1","name":"gear","color":"red"}""");

        var widget = await client.Widgets.ReadAsync("1");

        widget.Color.Should().Be(Color.Red);
    }

    [TestMethod]
    public async Task An_unknown_enum_value_is_rejected_rather_than_guessed()
    {
        var (client, handler) = Harness.Create();
        handler.RespondJson("""{"id":"1","name":"gear","color":"purple"}""");

        var act = () => client.Widgets.ReadAsync("1");

        (await act.Should().ThrowAsync<Exception>()).Which.ToString().Should().Contain("purple");
    }

    [TestMethod]
    public async Task A_non_string_enum_value_is_rejected()
    {
        var (client, handler) = Harness.Create();
        handler.RespondJson("""{"id":"1","name":"gear","color":3}""");

        var act = () => client.Widgets.ReadAsync("1");

        await act.Should().ThrowAsync<Exception>();
    }

    [TestMethod]
    public async Task An_omitted_optional_enum_is_left_out_and_reads_back_as_null()
    {
        var (client, handler) = Harness.Create();
        handler.RespondJson("""{"id":"1","name":"gear"}""").RespondJson("""{"id":"1","name":"gear"}""");

        await client.Widgets.CreateAsync(new WidgetCreateRequest { Name = "gear" });
        var widget = await client.Widgets.ReadAsync("1");

        handler.Requests[0].Body.Should().Be("""{"name":"gear"}""");
        widget.Color.Should().BeNull();
    }

    [TestMethod]
    public async Task A_numeric_enum_is_sent_as_a_json_number()
    {
        var (client, handler) = Harness.Create();
        handler.RespondJson("""{"id":"1","name":"gear"}""");

        await client.Widgets.CreateAsync(new WidgetCreateRequest { Name = "gear", Priority = Priority.High });

        using var sent = JsonDocument.Parse(handler.Last.Body!);
        sent.RootElement.GetProperty("priority").ValueKind.Should().Be(JsonValueKind.Number);
        sent.RootElement.GetProperty("priority").GetInt32().Should().Be(2);
    }

    [TestMethod]
    public async Task A_numeric_enum_is_read_from_a_json_number()
    {
        var (client, handler) = Harness.Create();
        handler.RespondJson("""{"id":"1","name":"gear","priority":1}""");

        var widget = await client.Widgets.ReadAsync("1");

        widget.Priority.Should().Be(Priority.Low);
    }

    [TestMethod]
    public async Task An_unknown_number_is_rejected_for_a_numeric_enum()
    {
        var (client, handler) = Harness.Create();
        handler.RespondJson("""{"id":"1","name":"gear","priority":7}""");

        var act = () => client.Widgets.ReadAsync("1");

        (await act.Should().ThrowAsync<Exception>()).Which.ToString().Should().Contain("7");
    }

    [TestMethod]
    public async Task A_string_is_rejected_for_a_numeric_only_enum()
    {
        var (client, handler) = Harness.Create();
        handler.RespondJson("""{"id":"1","name":"gear","priority":"low"}""");

        var act = () => client.Widgets.ReadAsync("1");

        (await act.Should().ThrowAsync<Exception>()).Which.ToString().Should().Contain("a number");
    }
}
