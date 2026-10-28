import { ok, doesNotMatch, strictEqual } from "node:assert";
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
    ok(content.includes("public TestApiClient(IFlurlClient flurlClient)"));
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
    ok(content.includes("return new TestApiClient(flurlClient);"));
    ok(
      content.includes(
        "public static TestApiClient Create(string baseUrl, Action<ModelMap>? configureModels = null)",
      ),
    );
  });
});

describe("dependency injection registration", () => {
  it("registers a named HttpClient and only the client", async () => {
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
        ".ConfigurePrimaryHttpMessageHandler(() => new HttpClientHandler { AllowAutoRedirect = false });",
      ),
      "Expected the handler to leave redirects to Flurl, as Flurl's own client factory does",
    );
    ok(
      content.indexOf("ConfigurePrimaryHttpMessageHandler") <
        content.indexOf("configureBuilder?.Invoke(builder);"),
      "Expected a caller's own primary handler, set through configureBuilder, to win",
    );
    ok(
      content.includes(
        "services.AddTransient<TestApiClient>(sp => new TestApiClient(CreateFlurlClient(sp, models, configureFlurlClient)));",
      ),
    );
    strictEqual(
      (content.match(/services\.AddTransient</g) ?? []).length,
      1,
      "Expected the request builders, which the client creates, not to be registered",
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
    ok(content.includes("Action<ModelMap>? configureModels = null,"));
    ok(
      !content.includes("AddSingleton"),
      "The model map must be captured, not registered by type, or one API version's map would replace another's",
    );
    ok(content.includes("configureModels?.Invoke(models);"));
  });

  it("lets callers configure every Flurl client it creates, after its serializer is set", async () => {
    const content = fileContent(
      await emit(TWO_INTERFACES),
      "TestApiClientExtensions.g.cs",
    );

    ok(
      content.includes(
        "Action<IFlurlClient>? configureFlurlClient = null)\n    {",
      ),
      "Expected an optional last parameter, so existing calls keep compiling",
    );
    const configured = content.indexOf(
      "var flurlClient = ClientRuntime.Configure(new FlurlClient(httpClient), models);",
    );
    const invoked = content.indexOf(
      "configureFlurlClient?.Invoke(flurlClient);",
    );
    ok(
      configured >= 0 && invoked > configured,
      "Expected the caller's callback to run after the serializer is set, so the caller has the last word",
    );
    ok(content.includes("return flurlClient;"));
  });

  it("keys the HttpClient name by client name", async () => {
    const content = fileContent(
      await emit(TWO_INTERFACES, { "client-name": "PetStore" }),
      "PetStoreExtensions.g.cs",
    );

    ok(content.includes('"TestApi.Client.PetStore"'));
  });

  it("escapes a builder path parameter whose name is a C# keyword", async () => {
    const results = await emit(`
      import "@typespec/http";
      using Http;

      @service(#{ title: "Test API" })
      namespace TestApi;

      @route("/params")
      interface Params { @get read(@path params: string): string; }
    `);

    const content = fileContent(results, "TestApiClientExtensions.g.cs");
    ok(
      content.includes(
        "public ParamsItemRequestBuilder Params(string @params) =>",
      ),
    );
    ok(
      content.includes(
        "new ParamsItemRequestBuilder(this.FlurlClient, @params);",
      ),
    );
    const builders = fileContent(results, "ParamsRequestBuilders.g.cs");
    ok(
      builders.includes(
        "internal ParamsItemRequestBuilder(IFlurlClient flurlClient, string @params)",
      ),
    );
    ok(builders.includes("this._params = @params;"));
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
