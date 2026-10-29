using AwesomeAssertions;
using Flurl.Http;
using MassiveScale.PathTree.Client;

namespace CustomModels.Tests;

/// <summary>
/// The <c>path</c> client shape: each URL segment is a step of the chain, every step passes the path
/// parameters so far on to the next, and a builder starts with what was added to the one it was
/// created from, without anything added to it later reaching that one.
/// </summary>
[TestClass]
public sealed class PathTreeTests
{
    private static (PathTreeClient Client, StubHandler Handler) Create()
    {
        var handler = new StubHandler();
        var flurl = new FlurlClient(new HttpClient(handler) { BaseAddress = new Uri("https://api.test/") });
        return (PathTreeClient.Create(flurl), handler);
    }

    [TestMethod]
    public async Task A_chain_sends_to_the_route_its_steps_spell()
    {
        var (client, handler) = Create();
        handler.RespondJson("""{"id":"p1","name":"Rex"}""");

        var pet = await client.Stores("s 1").Pets("p/1").GetAsync();

        handler.Last.Method.Should().Be(HttpMethod.Get);
        handler.Last.Uri.AbsolutePath.Should().Be("/api/stores/s%201/pets/p%2F1");
        pet.Name.Should().Be("Rex");
    }

    [TestMethod]
    public async Task Each_builder_sends_its_own_operations_named_by_verb()
    {
        var (client, handler) = Create();

        await client.Stores().PostAsync(new Store { Id = "s1", Name = "Main" });
        await client.Stores("s1").DeleteAsync();
        await client.Stores("s1").Pets("p1").PatchAsync(new MergePatch<Pet>().Set(p => p.Name, "Rex"));

        handler.Requests.Select(r => $"{r.Method} {r.Uri.AbsolutePath}").Should().Equal(
            "POST /api/stores",
            "DELETE /api/stores/s1",
            "PATCH /api/stores/s1/pets/p1");
    }

    [TestMethod]
    public async Task Operations_that_share_a_verb_on_one_builder_keep_their_names()
    {
        var (client, handler) = Create();
        handler.RespondJson("[]").RespondJson("[]");

        await client.Stores("s1").Pets("p1").Toys().ListAsync();
        await client.Stores("s1").Pets("p1").Toys().SearchAsync("ball");

        handler.Requests.Select(r => r.Uri.PathAndQuery).Should().Equal(
            "/api/stores/s1/pets/p1/toys",
            "/api/stores/s1/pets/p1/toys?q=ball");
    }

    [TestMethod]
    public async Task A_route_that_starts_with_a_parameter_is_reached_through_the_client_indexer()
    {
        var (client, handler) = Create();
        handler.RespondJson("""{"theme":"dark"}""");

        var settings = await client["acme"].Settings().GetAsync();

        handler.Last.Uri.AbsolutePath.Should().Be("/api/acme/settings");
        settings.Theme.Should().Be("dark");
    }

    [TestMethod]
    public async Task The_parameters_of_a_mixed_segment_are_method_arguments()
    {
        var (client, handler) = Create();
        handler.RespondJson("""{"total":3}""");

        var report = await client.Reports().GetAsync("2024", "2025");

        handler.Last.Uri.AbsolutePath.Should().Be("/api/reports/2024-2025");
        report.Total.Should().Be(3);
    }

    [TestMethod]
    public async Task A_route_of_slash_is_reached_by_its_interface_name()
    {
        var (client, handler) = Create();

        await client.Health().GetAsync();

        handler.Last.Uri.AbsolutePath.Should().Be("/api");
    }

    [TestMethod]
    public async Task What_was_added_to_a_builder_reaches_the_requests_of_the_builders_created_from_it()
    {
        var (client, handler) = Create();
        handler.RespondJson("""{"items":[]}""");

        await client.Stores("s1")
            .AppendHeader("X-Trace", "parent")
            .AppendQueryParameter("debug", true)
            .Pets()
            .AppendHeader("X-Child", "child")
            .GetAsync();

        handler.Last.Headers["X-Trace"].Should().Be("parent");
        handler.Last.Headers["X-Child"].Should().Be("child");
        handler.Last.Uri.Query.Should().Be("?debug=true");
    }

    [TestMethod]
    public async Task What_is_added_to_a_builder_never_reaches_the_one_it_was_created_from()
    {
        var (client, handler) = Create();
        handler.RespondJson("""{"id":"s1","name":"Main"}""");
        var store = client.Stores("s1");

        store.Pets().AppendHeader("X-Child", "child");
        await store.GetAsync();

        handler.Last.Headers.Should().NotContainKey("X-Child");
    }

    [TestMethod]
    public async Task What_is_added_to_a_builder_afterwards_never_reaches_one_already_created_from_it()
    {
        var (client, handler) = Create();
        handler.RespondJson("""{"items":[]}""");
        var store = client.Stores("s1").AppendHeader("X-Before", "yes");
        var pets = store.Pets();

        store.AppendHeader("X-After", "no");
        await pets.GetAsync();

        handler.Last.Headers["X-Before"].Should().Be("yes");
        handler.Last.Headers.Should().NotContainKey("X-After");
    }

    [TestMethod]
    public async Task The_paging_wrapper_is_named_after_the_verb_and_follows_the_next_link()
    {
        var (client, handler) = Create();
        handler
            .RespondJson("""{"items":[{"id":"1","name":"a"}],"next":"https://api.test/api/stores/s1/pets?page=2"}""")
            .RespondJson("""{"items":[{"id":"2","name":"b"}]}""");

        var names = new List<string>();
        await foreach (var pet in client.Stores("s1").Pets().GetAllAsync())
        {
            names.Add(pet.Name);
        }

        names.Should().Equal("a", "b");
        handler.Requests.Select(r => r.Uri.PathAndQuery).Should().Equal(
            "/api/stores/s1/pets",
            "/api/stores/s1/pets?page=2");
    }
}
