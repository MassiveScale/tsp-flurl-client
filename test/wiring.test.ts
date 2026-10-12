import { ok, doesNotMatch } from "node:assert";
import { describe, it } from "node:test";
import { emit, fileContent } from "./host.js";

const TWO_INTERFACES = `
  import "@typespec/http";
  using Http;

  @service(#{ title: "Test API" })
  namespace TestApi;

  @route("/pets")
  interface Pets { @get list(): string[]; }

  @route("/stores")
  interface Stores { @get list(): string[]; }
`;

describe("aggregate client", () => {
  it("exposes the Flurl client it is built on", async () => {
    const content = fileContent(
      await emit(TWO_INTERFACES),
      "TestApiClientExtensions.g.cs",
    );

    ok(content.includes("public IFlurlClient FlurlClient { get; }"));
    ok(
      content.includes(
        "public TestApiClient(IFlurlClient flurlClient, IPets pets, IStores stores)",
      ),
    );
    ok(content.includes("FlurlClient = flurlClient ?? throw"));
  });

  it("can be created from a Flurl client or a base URL", async () => {
    const content = fileContent(
      await emit(TWO_INTERFACES),
      "TestApiClientExtensions.g.cs",
    );

    ok(
      content.includes(
        "public static TestApiClient Create(IFlurlClient flurlClient, ModelMap? models = null)",
      ),
    );
    ok(content.includes("ClientRuntime.Configure(flurlClient, models);"));
    ok(
      content.includes(
        "return new TestApiClient(flurlClient, new PetsEndpoint(flurlClient), new StoresEndpoint(flurlClient));",
      ),
    );
    ok(
      content.includes(
        "public static TestApiClient Create(string baseUrl, Action<ModelMap>? configureModels = null)",
      ),
    );
  });
});

describe("dependency injection registration", () => {
  it("registers a named HttpClient and every endpoint", async () => {
    const content = fileContent(
      await emit(TWO_INTERFACES),
      "TestApiClientExtensions.g.cs",
    );

    ok(
      content.includes(
        'private const string HttpClientName = "TestApi.Client.TestApiClient";',
      ),
    );
    ok(
      content.includes(
        "services.AddHttpClient(HttpClientName, configureHttpClient);",
      ),
    );
    ok(
      content.includes(
        "services.AddTransient<IPets>(sp => new PetsEndpoint(CreateFlurlClient(sp, models)));",
      ),
    );
    ok(
      content.includes(
        "services.AddTransient<IStores>(sp => new StoresEndpoint(CreateFlurlClient(sp, models)));",
      ),
    );
  });

  it("lets callers add handlers and register custom models", async () => {
    const content = fileContent(
      await emit(TWO_INTERFACES),
      "TestApiClientExtensions.g.cs",
    );

    ok(
      content.includes(
        "Func<IHttpClientBuilder, IHttpClientBuilder>? configureBuilder = null,",
      ),
    );
    ok(content.includes("Action<ModelMap>? configureModels = null)"));
    ok(
      !content.includes("AddSingleton"),
      "The model map must be captured, not registered by type, or one API version's map would replace another's",
    );
    ok(content.includes("configureModels?.Invoke(models);"));
  });

  it("keys the HttpClient name by client name", async () => {
    const content = fileContent(
      await emit(TWO_INTERFACES, { "client-name": "PetStore" }),
      "PetStoreExtensions.g.cs",
    );

    ok(content.includes('"TestApi.Client.PetStore"'));
  });

  it("escapes an interface whose parameter name is a C# keyword", async () => {
    const results = await emit(`
      import "@typespec/http";
      using Http;

      @service(#{ title: "Test API" })
      namespace TestApi;

      @route("/params")
      interface Params { @get list(): string[]; }
    `);

    const content = fileContent(results, "TestApiClientExtensions.g.cs");
    ok(content.includes("IParams @params"));
    ok(content.includes("Params = @params;"));
  });
});

describe("project file", () => {
  it("references Flurl.Http and the HttpClient factory, not Refit", async () => {
    const content = fileContent(await emit(TWO_INTERFACES), ".csproj");

    ok(
      content.includes(
        '<PackageReference Include="Flurl.Http" Version="4.*" />',
      ),
    );
    ok(
      content.includes('<PackageReference Include="Microsoft.Extensions.Http"'),
    );
    doesNotMatch(content, /Refit/);
  });

  it("describes the package as a Flurl client by default", async () => {
    const content = fileContent(await emit(TWO_INTERFACES), ".csproj");

    ok(
      content.includes(
        "<Description>Flurl client for the TestApi.Client API</Description>",
      ),
    );
  });
});
