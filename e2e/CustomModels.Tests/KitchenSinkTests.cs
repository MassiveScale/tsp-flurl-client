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

    [TestMethod]
    public async Task Bytes_in_a_query_or_header_are_base64_not_a_list_of_numbers()
    {
        var (client, handler) = Create();
        handler.RespondJson("\"ok\"");

        await client.Misc.BlobAsync([1, 2, 3, 255], [4, 5, 6]);

        Uri.UnescapeDataString(handler.Last.Uri.Query).Should().Be("?data=AQID/w==");
        handler.Last.Headers["X-Blob"].Should().Be("BAUG");
    }

    [TestMethod]
    public async Task A_numeric_enum_with_a_value_beyond_long_still_reads_and_writes_by_value()
    {
        var (client, handler) = Create();
        handler.RespondJson("100000000000000000000");

        var magnitude = await client.Misc.MagnitudeAsync();

        magnitude.Should().Be(Magnitude.Huge);
    }

    [TestMethod]
    public async Task A_vendor_json_body_is_sent_with_its_declared_media_type()
    {
        var (client, handler) = Create();
        handler.RespondJson("""{"id":"1","name":"n"}""");

        await client.Misc.VendorAsync(new Derived { Id = "1", Name = "n" });

        handler.Last.ContentType.Should().StartWith("application/vnd.acme+json");
        using var sent = JsonDocument.Parse(handler.Last.Body!);
        sent.RootElement.GetProperty("name").GetString().Should().Be("n");
    }

    [TestMethod]
    public async Task An_optional_response_body_is_null_when_the_server_sends_no_content()
    {
        var (client, _) = Create();

        var result = await client.Misc.OptionalAsync();

        result.Should().BeNull();
    }

    [TestMethod]
    public async Task A_renamed_generic_model_is_read()
    {
        var (client, handler) = Create();
        handler.RespondJson("""{"content":{"id":"1","name":"n"}}""");

        Bundle<Derived> box = await client.Misc.BoxAsync();

        box.Content.Name.Should().Be("n");
    }

    [TestMethod]
    public async Task Text_scalars_are_parsed_from_their_wire_text()
    {
        var (client, handler) = Create();

        handler.RespondText("2024-01-02T03:04:05Z");
        (await client.Text.WhenAsync()).Should().Be(new DateTimeOffset(2024, 1, 2, 3, 4, 5, TimeSpan.Zero));

        handler.RespondText("42");
        (await client.Text.CountAsync()).Should().Be(42);

        handler.RespondText("P1DT2H");
        (await client.Text.TookAsync()).Should().Be(new TimeSpan(1, 2, 0, 0));

        handler.RespondText("2024-02-29");
        (await client.Text.DayAsync()).Should().Be(new DateOnly(2024, 2, 29));

        handler.RespondText("12.50");
        (await client.Text.PriceAsync()).Should().Be(12.50m);

        handler.RespondText("true");
        (await client.Text.OnAsync()).Should().BeTrue();
    }

    [TestMethod]
    public async Task A_union_of_scalars_read_as_text_keeps_numbers_and_strings_apart()
    {
        var (client, handler) = Create();

        handler.RespondText("42");
        (await client.Text.EitherAsync()).GetInt32().Should().Be(42);

        handler.RespondText("hello");
        (await client.Text.EitherAsync()).GetString().Should().Be("hello");
    }

    [TestMethod]
    public async Task An_optional_text_scalar_is_null_when_the_server_sends_no_content()
    {
        var (client, handler) = Create();

        (await client.Text.MaybeAsync()).Should().BeNull();

        handler.RespondText("7");
        (await client.Text.MaybeAsync()).Should().Be(7);
    }

    [TestMethod]
    public async Task A_malformed_text_scalar_fails_loudly()
    {
        var (client, handler) = Create();
        handler.RespondText("not a number");

        var act = () => client.Text.CountAsync();

        await act.Should().ThrowAsync<FormatException>();
    }

    [TestMethod]
    public async Task Text_scalar_bodies_are_sent_as_their_wire_text_with_text_plain()
    {
        var (client, handler) = Create();

        await client.Text.SetCountAsync(42);
        handler.Last.Body.Should().Be("42");
        handler.Last.ContentType.Should().StartWith("text/plain");

        await client.Text.SetWhenAsync(new DateTimeOffset(2024, 1, 2, 3, 4, 5, TimeSpan.Zero));
        handler.Last.Body.Should().Be("2024-01-02T03:04:05.0000000+00:00");
        handler.Last.ContentType.Should().StartWith("text/plain");
    }

    [TestMethod]
    public async Task Different_bodies_per_success_status_are_returned_as_whichever_arrived()
    {
        var (client, handler) = Create();

        handler.RespondJson("""{"id":"1","name":"updated"}""");
        var updated = await client.Misc.UpsertAsync();
        updated.Deserialize<Derived>(new JsonSerializerOptions(JsonSerializerDefaults.Web))!.Name.Should().Be("updated");

        handler.RespondJson("""{"id":"2","extra":"created"}""", System.Net.HttpStatusCode.Created);
        var created = await client.Misc.UpsertAsync();
        created.Deserialize<Spread>(new JsonSerializerOptions(JsonSerializerDefaults.Web))!.Extra.Should().Be("created");
    }

    [TestMethod]
    public async Task A_value_declared_as_json_or_text_is_read_by_the_content_type_that_arrives()
    {
        var (client, handler) = Create();

        handler.RespondText("plain words");
        (await client.Misc.LabelAsync()).Should().Be("plain words");

        handler.RespondJson("\"quoted\"");
        (await client.Misc.LabelAsync()).Should().Be("quoted");
    }

    [TestMethod]
    public async Task Text_is_encoded_with_the_charset_its_media_type_declares()
    {
        var (client, handler) = Create();

        await client.Misc.LatinAsync("café");

        handler.Last.BodyBytes.Should().Equal(0x63, 0x61, 0x66, 0xE9);
        handler.Last.ContentType.Should().Be("text/plain; charset=iso-8859-1");
    }

    [TestMethod]
    public async Task A_uuid_body_is_a_guid_both_ways()
    {
        var (client, handler) = Create();
        var id = Guid.Parse("0f8fad5b-d9cb-469f-a165-70867728950e");

        handler.RespondText("0f8fad5b-d9cb-469f-a165-70867728950e");
        (await client.Text.IdAsync()).Should().Be(id);

        await client.Text.SetIdAsync(id);
        handler.Last.Body.Should().Be("0f8fad5b-d9cb-469f-a165-70867728950e");
    }
}
