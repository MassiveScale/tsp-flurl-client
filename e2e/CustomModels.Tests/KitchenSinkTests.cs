using System.Reflection;
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

    [TestMethod]
    public async Task A_filtered_request_for_a_discriminated_body_keeps_its_subtypes_and_discriminator()
    {
        var (client, handler) = Create();
        handler.RespondJson("""{"type":"car","id":"1","wheels":4,"vin":"V","seats":5}""");

        var created = await client.Vehicles.CreateAsync(new CarCreateRequest { Wheels = 4, Seats = 5 });

        using var sent = JsonDocument.Parse(handler.Last.Body!);
        sent.RootElement.GetProperty("type").GetString().Should().Be("car");
        sent.RootElement.GetProperty("seats").GetInt32().Should().Be(5);
        sent.RootElement.TryGetProperty("id", out _).Should().BeFalse("id is read-only");
        sent.RootElement.TryGetProperty("vin", out _).Should().BeFalse("vin is read-only");
        created.Should().BeOfType<Car>().Which.Vin.Should().Be("V");
    }

    [TestMethod]
    public async Task A_filtered_request_for_a_subtype_is_sent_with_its_discriminator()
    {
        var (client, handler) = Create();
        handler.RespondJson("""{"type":"car","id":"1","wheels":4,"vin":"V","seats":5}""");

        await client.Vehicles.CreateCarAsync(new CarCreateRequest { Wheels = 4, Seats = 5 });

        using var sent = JsonDocument.Parse(handler.Last.Body!);
        sent.RootElement.GetProperty("type").GetString().Should().Be("car");
        CountOf(handler.Last.Body!, "\"type\"").Should().Be(1);
    }

    [TestMethod]
    public async Task A_custom_subtype_of_a_filtered_request_keeps_its_extra_properties_and_discriminator()
    {
        var (client, handler) = Create();
        handler.RespondJson("""{"type":"car","id":"1","wheels":4,"vin":"V","seats":5}""");

        await client.Vehicles.CreateCarAsync(new MyCarRequest { Wheels = 4, Seats = 5, Colour = "red" });

        using var sent = JsonDocument.Parse(handler.Last.Body!);
        sent.RootElement.GetProperty("type").GetString().Should().Be("car");
        sent.RootElement.GetProperty("colour").GetString().Should().Be("red");
    }

    [TestMethod]
    public async Task Parameters_named_after_csharp_keywords_are_sent_under_their_declared_names()
    {
        var (client, handler) = Create();
        handler.RespondText("ok");

        await client.Misc.KeywordsAsync("a", @class: "b", var: "c");

        handler.Last.Uri.AbsolutePath.Should().EndWith("/keywords/a");
        handler.Last.Uri.Query.Should().Be("?class=b");
        handler.Last.Headers["var"].Should().Be("c");
    }

    [TestMethod]
    public async Task A_declared_enum_parameter_is_sent_as_its_wire_value()
    {
        var (client, handler) = Create();
        handler.RespondJson("""{"items":[]}""");

        await client.DerivedItems.ListAsync(color: Color.Dark_green);

        Uri.UnescapeDataString(handler.Last.Uri.Query).Should().Be("?color=dark-green");
    }

    [TestMethod]
    public async Task An_undeclared_enum_parameter_is_rejected_rather_than_sent_as_a_number()
    {
        var (client, handler) = Create();

        var act = () => client.DerivedItems.ListAsync(color: (Color)99);

        (await act.Should().ThrowAsync<ArgumentException>()).Which.Message.Should().Contain("99");
        handler.Requests.Should().BeEmpty("nothing is sent");
    }

    [TestMethod]
    public async Task Read_only_properties_of_nested_models_are_not_sent()
    {
        var (client, handler) = Create();
        handler.RespondJson("""{"id":"f","name":"north","vehicles":[],"depot":null}""");

        await client.Vehicles.CreateFleetAsync(new FleetCreateRequest
        {
            Name = "north",
            Vehicles = [new CarCreateRequest { Wheels = 4, Seats = 5 }, new BikeCreateRequest { Wheels = 2 }],
            Depot = new DepotCreateRequest { City = "Oslo" },
        });

        using var sent = JsonDocument.Parse(handler.Last.Body!);
        sent.RootElement.TryGetProperty("id", out _).Should().BeFalse("the fleet's id is read-only");
        var vehicles = sent.RootElement.GetProperty("vehicles");
        vehicles[0].GetProperty("type").GetString().Should().Be("car");
        vehicles[0].TryGetProperty("vin", out _).Should().BeFalse("a nested car's vin is read-only");
        vehicles[1].GetProperty("type").GetString().Should().Be("bike");
        var depot = sent.RootElement.GetProperty("depot");
        depot.GetProperty("city").GetString().Should().Be("Oslo");
        depot.TryGetProperty("id", out _).Should().BeFalse("a nested depot's id is read-only");
    }

    [TestMethod]
    public void Nested_request_records_have_no_read_only_members()
    {
        typeof(CarCreateRequest).GetProperty("Vin").Should().BeNull();
        typeof(DepotCreateRequest).GetProperty("Id").Should().BeNull();
        typeof(FleetCreateRequest).GetProperty("Depot")!.PropertyType.Should().Be<DepotCreateRequest>();
    }

    [TestMethod]
    public async Task A_nullable_body_is_filtered_and_can_be_sent_as_null()
    {
        var (client, handler) = Create();

        await client.Vehicles.CreateDepotAsync(new DepotCreateRequest { City = "Oslo" });
        using (var sent = JsonDocument.Parse(handler.Last.Body!))
        {
            sent.RootElement.GetProperty("city").GetString().Should().Be("Oslo");
            sent.RootElement.TryGetProperty("id", out _).Should().BeFalse("id is read-only");
        }

        await client.Vehicles.CreateDepotAsync(null);
        handler.Last.Body.Should().Be("null");
    }

    [TestMethod]
    public async Task An_omitted_optional_body_sends_no_content()
    {
        var (client, handler) = Create();

        await client.Vehicles.MaybeCreateAsync();
        handler.Last.Body.Should().BeNull();

        await client.Vehicles.MaybeCreateAsync(new BikeCreateRequest { Wheels = 2 });
        using var sent = JsonDocument.Parse(handler.Last.Body!);
        sent.RootElement.GetProperty("type").GetString().Should().Be("bike");
    }

    [TestMethod]
    public async Task Text_can_be_sent_in_a_windows_code_page()
    {
        var (client, handler) = Create();

        await client.Misc.Cp1252Async("café €");

        handler.Last.BodyBytes.Should().Equal(0x63, 0x61, 0x66, 0xE9, 0x20, 0x80);
        handler.Last.ContentType.Should().Be("text/plain; charset=windows-1252");
    }

    [TestMethod]
    public async Task Bytes_are_null_for_the_bodyless_success_and_an_empty_array_for_an_empty_body()
    {
        var (client, handler) = Create();

        (await client.Misc.MaybeBytesAsync()).Should().BeNull("the server sent 204");

        handler.RespondBytes([]);
        (await client.Misc.MaybeBytesAsync()).Should().NotBeNull().And.BeEmpty();

        handler.RespondBytes([1, 2]);
        (await client.Misc.MaybeBytesAsync()).Should().Equal(1, 2);
    }

    [TestMethod]
    public void A_narrowing_override_is_carried_by_the_inherited_member()
    {
        typeof(Car).GetProperty("Wheels", BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly)
            .Should().BeNull("Car inherits Wheels from Vehicle rather than hiding it");
        typeof(Car).GetProperty("Wheels").Should().NotBeNull();
    }

    [TestMethod]
    public async Task Encoded_json_names_are_used_both_ways_and_a_null_only_property_is_sent()
    {
        var (client, handler) = Create();
        handler.RespondJson("""{"display_name":"Ann","count":2,"nothing":null}""");

        var read = await client.Misc.WireNamesAsync(new WireNames { DisplayName = "Bob", Count = 1 });

        read.DisplayName.Should().Be("Ann");
        read.Count.Should().Be(2);
        using var sent = JsonDocument.Parse(handler.Last.Body!);
        sent.RootElement.GetProperty("display_name").GetString().Should().Be("Bob");
        sent.RootElement.TryGetProperty("displayName", out _).Should().BeFalse();
        sent.RootElement.GetProperty("count").GetInt32().Should().Be(1);
        sent.RootElement.GetProperty("nothing").ValueKind.Should().Be(JsonValueKind.Null);
    }

    [TestMethod]
    public async Task Empty_text_is_an_empty_string_not_null()
    {
        var (client, handler) = Create();
        handler.RespondText("");

        var label = await client.Misc.LabelAsync();

        label.Should().NotBeNull().And.BeEmpty();
    }

    private static readonly DateTimeOffset At = new(2024, 1, 2, 3, 4, 5, TimeSpan.Zero);

    [TestMethod]
    public async Task Every_encoding_is_written_in_its_wire_format()
    {
        var (client, handler) = Create();
        handler.RespondJson("""{"at":0,"httpDate":"Thu, 01 Jan 1970 00:00:00 GMT","wait":0,"precise":0,"ms":0,"token":"","tags":""}""");

        await client.Misc.TimedAsync(new Timed
        {
            At = At,
            HttpDate = At,
            Wait = TimeSpan.FromSeconds(90),
            Precise = TimeSpan.FromSeconds(1.5),
            Ms = TimeSpan.FromMilliseconds(250),
            Token = [0xFB, 0xFF],
            Tags = ["a", "b"],
            Counts = [1, 2],
        });

        using var sent = JsonDocument.Parse(handler.Last.Body!);
        var root = sent.RootElement;
        root.GetProperty("at").GetInt64().Should().Be(1704164645);
        root.TryGetProperty("maybeAt", out _).Should().BeFalse("an optional null is left out");
        root.GetProperty("httpDate").GetString().Should().Be("Tue, 02 Jan 2024 03:04:05 GMT");
        root.GetProperty("wait").GetRawText().Should().Be("90");
        root.GetProperty("precise").GetDouble().Should().Be(1.5);
        root.GetProperty("ms").GetRawText().Should().Be("250");
        root.GetProperty("token").GetString().Should().Be("-_8");
        root.GetProperty("tags").GetString().Should().Be("a|b");
        root.GetProperty("counts").GetString().Should().Be("1,2");
    }

    [TestMethod]
    public async Task Every_encoding_is_read_from_its_wire_format()
    {
        var (client, handler) = Create();
        handler.RespondJson(
            """{"at":1704164645,"maybeAt":1704164645,"httpDate":"Tue, 02 Jan 2024 03:04:05 GMT","wait":90,"precise":1.5,"ms":250,"token":"-_8","tags":"a|b","counts":"1,2"}""");

        var timed = await client.Misc.TimedAsync(new Timed { HttpDate = At, Token = [], Tags = [] });

        timed.At.Should().Be(At);
        timed.MaybeAt.Should().Be(At);
        timed.HttpDate.Should().Be(At);
        timed.Wait.Should().Be(TimeSpan.FromSeconds(90));
        timed.Precise.Should().Be(TimeSpan.FromSeconds(1.5));
        timed.Ms.Should().Be(TimeSpan.FromMilliseconds(250));
        timed.Token.Should().Equal(0xFB, 0xFF);
        timed.Tags.Should().Equal("a", "b");
        timed.Counts.Should().Equal(1, 2);
    }

    [TestMethod]
    public async Task A_value_in_the_wrong_wire_format_fails_loudly()
    {
        var (client, handler) = Create();
        handler.RespondJson("""{"at":"2024-01-02T03:04:05Z","httpDate":"x","wait":0,"precise":0,"ms":0,"token":"","tags":""}""");

        var act = () => client.Misc.TimedAsync(new Timed { HttpDate = At, Token = [], Tags = [] });

        (await act.Should().ThrowAsync<FlurlParsingException>())
            .WithInnerException<JsonException>()
            .WithMessage("Expected a Unix timestamp*");
    }

    [TestMethod]
    public async Task Encoded_parameters_use_their_wire_format()
    {
        var (client, handler) = Create();

        await client.Misc.EncodedParamsAsync(At, At, ["a", "b"], TimeSpan.FromSeconds(90), [0xFB, 0xFF]);

        handler.Last.Uri.AbsolutePath.Should().Be("/api/misc/encoded-params/1704164645");
        var query = Uri.UnescapeDataString(handler.Last.Uri.Query);
        query.Should().Contain("since=Tue, 02 Jan 2024 03:04:05 GMT");
        query.Should().Contain("tags=a|b");
        query.Should().Contain("token=-_8");
        handler.Last.Headers["X-Wait"].Should().Be("90");
    }

    [TestMethod]
    public async Task An_encoded_text_body_and_response_use_their_wire_format()
    {
        var (client, handler) = Create();

        handler.RespondText("1704164645");
        (await client.Misc.UnixAsync()).Should().Be(At);

        await client.Misc.SetUnixAsync(At);
        handler.Last.Body.Should().Be("1704164645");
    }

    [TestMethod]
    public async Task A_merge_patch_writes_each_value_in_its_propertys_format()
    {
        var (client, handler) = Create();

        await client.Misc.PatchTimedAsync(new MergePatch<Timed>()
            .Set(t => t.At, At)
            .Set(t => t.Tags, ["a", "b"])
            .Set("wait", TimeSpan.FromSeconds(90))
            .Set("extra", 5));

        using var sent = JsonDocument.Parse(handler.Last.Body!);
        sent.RootElement.GetProperty("at").GetInt64().Should().Be(1704164645, "the expression overload uses the property's converter");
        sent.RootElement.GetProperty("tags").GetString().Should().Be("a|b");
        sent.RootElement.GetProperty("wait").GetRawText().Should().Be("90", "the wire-name overload finds the property too");
        sent.RootElement.GetProperty("extra").GetInt32().Should().Be(5, "an extension property is written as it is");
    }

    [TestMethod]
    public async Task A_merge_patch_writes_a_string_encoded_number_as_a_string()
    {
        var (client, handler) = Create();

        await client.Misc.PatchEncodedAsync(new MergePatch<Encoded>().Set(e => e.Big, 9007199254740993L));

        using var sent = JsonDocument.Parse(handler.Last.Body!);
        sent.RootElement.GetProperty("big").GetString().Should().Be("9007199254740993");
    }

    private static int CountOf(string text, string value) =>
        (text.Length - text.Replace(value, string.Empty).Length) / value.Length;

    private record MyCarRequest : CarCreateRequest
    {
        [System.Text.Json.Serialization.JsonPropertyName("colour")]
        public string? Colour { get; init; }
    }
}
