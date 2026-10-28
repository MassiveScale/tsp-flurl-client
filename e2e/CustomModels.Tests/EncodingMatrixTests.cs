using AwesomeAssertions;
using Flurl.Http;
using MassiveScale.KitchenSink.Client;

namespace CustomModels.Tests;

/// <summary>
/// Every <c>@encode</c> TypeSpec defines, carried in every position at once (path, query, header,
/// cookie, plain-text body, and plain-text response), so each wire format is checked end to end
/// rather than one example at a time.
/// </summary>
[TestClass]
public sealed class EncodingMatrixTests
{
    private static readonly DateTimeOffset At = new(2024, 1, 2, 3, 4, 5, TimeSpan.Zero);

    private static (KitchenSinkClient Client, StubHandler Handler) Create()
    {
        var handler = new StubHandler();
        var flurl = new FlurlClient(new HttpClient(handler) { BaseAddress = new Uri("https://api.test/") });
        return (KitchenSinkClient.Create(flurl), handler);
    }

    /// <summary>Asserts a value travelled as <paramref name="wire"/> in the query, header, and cookie.</summary>
    private static void AssertParameters(StubHandler handler, string wire)
    {
        var request = handler.Last;
        Uri.UnescapeDataString(request.Uri.Query).Should().Be($"?q={wire}", "the query value");
        request.Headers["X-V"].Should().Be(wire, "the header value");
        Uri.UnescapeDataString(request.Headers["Cookie"]).Should().Be($"c={wire}", "the cookie value");
    }

    /// <summary>Asserts a value travelled as <paramref name="wire"/> in every position.</summary>
    private static void AssertEverywhere(StubHandler handler, string wire, string mediaType = "text/plain")
    {
        AssertParameters(handler, wire);
        var request = handler.Last;
        Uri.UnescapeDataString(request.Uri.AbsolutePath.Split('/')[^1]).Should().Be(wire, "the path value");
        request.Body.Should().Be(wire, "the body");
        request.ContentType.Should().StartWith(mediaType, "the body keeps the media type the spec declares");
    }

    [TestMethod]
    public async Task UnixTimestamp_is_whole_seconds_everywhere()
    {
        var (client, handler) = Create();
        handler.RespondText("1704164645");

        (await client.Encodings(At).UnixAsync(At, At, At, At)).Should().Be(At);

        AssertEverywhere(handler, "1704164645");
    }

    [TestMethod]
    public async Task Rfc7231_is_an_http_date_everywhere()
    {
        var (client, handler) = Create();
        handler.RespondText("Tue, 02 Jan 2024 03:04:05 GMT");

        (await client.Encodings(At).Rfc7231Async(At, At, At, At)).Should().Be(At);

        AssertEverywhere(handler, "Tue, 02 Jan 2024 03:04:05 GMT");
    }

    [TestMethod]
    public async Task Whole_seconds_are_an_integer_everywhere()
    {
        var (client, handler) = Create();
        var value = TimeSpan.FromSeconds(90);
        handler.RespondText("90");

        (await client.Encodings(value).WholeSecondsAsync(value, value, value, value)).Should().Be(value);

        AssertEverywhere(handler, "90");
    }

    [TestMethod]
    public async Task Fractional_seconds_keep_their_fraction_everywhere()
    {
        var (client, handler) = Create();
        var value = TimeSpan.FromSeconds(1.5);
        handler.RespondText("1.5");

        (await client.Encodings(value).SecondsAsync(value, value, value, value)).Should().Be(value);

        AssertEverywhere(handler, "1.5");
    }

    [TestMethod]
    public async Task Whole_milliseconds_are_an_integer_everywhere()
    {
        var (client, handler) = Create();
        var value = TimeSpan.FromMilliseconds(250);
        handler.RespondText("250");

        (await client.Encodings(value).WholeMillisecondsAsync(value, value, value, value)).Should().Be(value);

        AssertEverywhere(handler, "250");
    }

    [TestMethod]
    public async Task Fractional_milliseconds_keep_their_fraction_everywhere()
    {
        var (client, handler) = Create();
        var value = TimeSpan.FromMilliseconds(1.5);
        handler.RespondText("1.5");

        (await client.Encodings(value).MillisecondsAsync(value, value, value, value)).Should().Be(value);

        AssertEverywhere(handler, "1.5");
    }

    [TestMethod]
    public async Task Base64url_is_url_safe_without_padding_everywhere()
    {
        var (client, handler) = Create();
        byte[] value = [0xFB, 0xFF];
        handler.RespondText("-_8");

        (await client.Encodings(value).Base64urlAsync(value, value, value, value)).Should().Equal(value);

        // TypeSpec declares a bytes body as application/octet-stream; the @encode makes it base64url text.
        AssertEverywhere(handler, "-_8", "application/octet-stream");
    }

    [TestMethod]
    public async Task Base64_is_standard_base64_everywhere()
    {
        var (client, handler) = Create();
        byte[] value = [0xFB, 0xFF];
        handler.RespondText("+/8=");

        (await client.Encodings(value).Base64Async(value, value, value, value)).Should().Equal(value);

        AssertEverywhere(handler, "+/8=", "application/octet-stream");
    }

    [TestMethod]
    public async Task A_pipe_delimited_list_is_one_value_in_every_parameter()
    {
        var (client, handler) = Create();

        await client.Encodings().PipeAsync(["a", "b"], ["a", "b"], ["a", "b"]);

        AssertParameters(handler, "a|b");
    }

    [TestMethod]
    public async Task A_space_delimited_list_is_one_value_in_every_parameter()
    {
        var (client, handler) = Create();

        await client.Encodings().SpaceAsync(["a", "b"], ["a", "b"], ["a", "b"]);

        AssertParameters(handler, "a b");
    }

    [TestMethod]
    public async Task A_comma_delimited_list_is_one_value_in_every_parameter()
    {
        var (client, handler) = Create();

        await client.Encodings().CommaAsync(["a", "b"], ["a", "b"], ["a", "b"]);

        AssertParameters(handler, "a,b");
    }

    [TestMethod]
    public async Task A_newline_delimited_list_is_one_value_in_a_query()
    {
        var (client, handler) = Create();

        await client.Encodings().NewlineQueryAsync(["a", "b"]);

        Uri.UnescapeDataString(handler.Last.Uri.Query).Should().Be("?q=a\nb");
    }
}
