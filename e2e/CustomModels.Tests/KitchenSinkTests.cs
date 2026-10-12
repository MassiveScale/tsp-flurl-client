using System.Text.Json;
using AwesomeAssertions;
using Flurl.Http;
using MassiveScale.KitchenSink.Client;

namespace CustomModels.Tests;

/// <summary>
/// The kitchen-sink example uses most of TypeSpec, so these tests check the wire formats that
/// are easiest to get silently wrong.
/// </summary>
[TestClass]
public sealed class KitchenSinkTests
{
    private static (KitchenSinkClient Client, StubHandler Handler) Create()
    {
        var handler = new StubHandler();
        var flurl = new FlurlClient(new HttpClient(handler) { BaseAddress = new Uri("https://api.test/") });
        return (KitchenSinkClient.Create(flurl), handler);
    }

    [TestMethod]
    public async Task A_discriminated_hierarchy_with_a_grouping_model_is_read_as_the_right_subtypes()
    {
        var (client, handler) = Create();
        handler.RespondJson(
            """
            [{"kind":"labrador","name":"rex","guide":true},
             {"kind":"poodle","name":"fifi"},
             {"kind":"cat","name":"tom"}]
            """);

        var animals = await client.Animals.ListAsync();

        animals[0].Should().BeOfType<Labrador>().Which.Guide.Should().BeTrue();
        animals[1].Should().BeOfType<Poodle>();
        animals[2].Should().BeOfType<Cat>();
    }

    [TestMethod]
    public async Task A_subtype_below_a_grouping_model_is_written_with_its_discriminator()
    {
        var (client, handler) = Create();
        handler.RespondJson("""{"kind":"labrador","name":"rex"}""");

        await client.Animals.CreateAsync(new Labrador { Name = "rex", Guide = true });

        using var sent = JsonDocument.Parse(handler.Last.Body!);
        sent.RootElement.GetProperty("kind").GetString().Should().Be("labrador");
        sent.RootElement.GetProperty("guide").GetBoolean().Should().BeTrue();
    }

    [TestMethod]
    public void The_grouping_model_is_abstract_because_it_has_no_wire_shape_of_its_own()
    {
        typeof(Dog).IsAbstract.Should().BeTrue();
    }

    [TestMethod]
    public async Task Numbers_declared_as_strings_round_trip_without_losing_precision()
    {
        var (client, handler) = Create();
        handler.RespondJson(
            """{"big":"9007199254740993","ratio":"1.5","took":"PT1H30M","at":"2024-01-02T03:04:05Z","blob":"AQID","whole":123}""");

        var encoded = await client.Misc.EncodedAsync();

        encoded.Big.Should().Be(9007199254740993L, "a double cannot hold this exactly");
        encoded.Ratio.Should().Be(1.5);
        encoded.Whole.Should().Be(123L);
    }

    [TestMethod]
    public async Task Durations_are_iso_8601_both_ways()
    {
        var (client, handler) = Create();
        handler.RespondJson("""{"big":"1","ratio":"1","took":"P1DT2H30M","at":"2024-01-02T03:04:05Z","blob":"","whole":1}""");

        var encoded = await client.Misc.EncodedAsync();
        encoded.Took.Should().Be(new TimeSpan(1, 2, 30, 0));

        handler.RespondJson("""{"big":"1","ratio":"1","took":"PT0S","at":"2024-01-02T03:04:05Z","blob":"","whole":1}""");
        await client.Misc.SendEncodedAsync(encoded with { Took = new TimeSpan(1, 30, 0) });

        using var sent = JsonDocument.Parse(handler.Last.Body!);
        sent.RootElement.GetProperty("took").GetString().Should().Be("PT1H30M");
    }

    [TestMethod]
    public async Task Numbers_declared_as_strings_are_written_as_strings_and_the_rest_as_numbers()
    {
        var (client, handler) = Create();
        handler.RespondJson("""{"big":"1","ratio":"1","took":"PT0S","at":"2024-01-02T03:04:05Z","blob":"","whole":1}""");

        await client.Misc.SendEncodedAsync(new Encoded
        {
            Big = 9007199254740993L,
            Ratio = 1.5,
            Took = TimeSpan.Zero,
            At = new DateTimeOffset(2024, 1, 2, 3, 4, 5, TimeSpan.Zero),
            Blob = [1, 2, 3],
            Whole = 7,
        });

        using var sent = JsonDocument.Parse(handler.Last.Body!);
        sent.RootElement.GetProperty("big").ValueKind.Should().Be(JsonValueKind.String);
        sent.RootElement.GetProperty("big").GetString().Should().Be("9007199254740993");
        sent.RootElement.GetProperty("ratio").GetString().Should().Be("1.5");
        sent.RootElement.GetProperty("whole").ValueKind.Should().Be(JsonValueKind.Number);
        sent.RootElement.GetProperty("blob").GetString().Should().Be("AQID");
    }

    [TestMethod]
    public void An_integer_is_a_long()
    {
        typeof(Encoded).GetProperty("Whole")!.PropertyType.Should().Be(typeof(long));
    }

    [TestMethod]
    public async Task Cookie_parameters_are_sent_as_cookies()
    {
        var (client, handler) = Create();
        handler.RespondJson("\"ok\"");

        await client.Misc.CookiesAsync("abc", "chocolate");

        var cookie = handler.Last.Headers["Cookie"];
        cookie.Should().Contain("session=abc");
        cookie.Should().Contain("flavour=chocolate");
    }

    [TestMethod]
    public async Task An_omitted_optional_cookie_is_not_sent()
    {
        var (client, handler) = Create();
        handler.RespondJson("\"ok\"");

        await client.Misc.CookiesAsync("abc");

        handler.Last.Headers["Cookie"].Should().NotContain("flavour");
    }

    [TestMethod]
    public async Task Array_query_parameters_follow_their_explode_setting()
    {
        var (client, handler) = Create();
        handler.RespondJson("\"ok\"");

        await client.Misc.ListsAsync(["a", "b"], ["x", "y"], ["p", "q"]);

        var query = Uri.UnescapeDataString(handler.Last.Uri.Query);
        query.Should().Contain("tags=a,b", "an array is comma-separated unless it is exploded");
        query.Should().Contain("labels=x&labels=y", "an exploded array is repeated");
        query.Should().Contain("csv=p,q");
    }

    [TestMethod]
    public async Task A_typed_error_body_can_be_read_from_the_exception()
    {
        var (client, handler) = Create();
        handler.RespondJson("""{"code":7,"message":"nope"}""", System.Net.HttpStatusCode.BadRequest);

        var act = () => client.Misc.FailAsync();

        var failure = (await act.Should().ThrowAsync<FlurlHttpException>()).Which;
        var error = await failure.GetResponseJsonAsync<ApiError>();
        error.Code.Should().Be(7);
        error.Message.Should().Be("nope");
    }
}
