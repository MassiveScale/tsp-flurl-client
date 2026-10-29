import { deepStrictEqual, doesNotMatch, ok, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import { builderClassName } from "../src/endpoints.js";
import {
  emit,
  emitWithDiagnostics,
  fileContent,
  has,
  messagesFor,
} from "./host.js";

const PREAMBLE = `
  import "@typespec/http";
  using Http;

  @service(#{ title: "Test API" })
  namespace TestApi;
`;

/**
 * The declaration of one class in a generated file, from its `class` line to the
 * closing brace at the start of a line.
 *
 * @param source - The generated file.
 * @param className - The class to find.
 * @returns The class text.
 */
function classBody(source: string, className: string): string {
  const start = source.search(new RegExp(`class ${className}\\b`));
  ok(start >= 0, `Expected class ${className} in:\n${source}`);
  const end = source.indexOf("\n}\n", start);
  return source.slice(start, end < 0 ? undefined : end + 2);
}

/**
 * The names of the classes a generated file declares, in order.
 *
 * @param source - The generated file.
 * @returns The class names.
 */
function classNames(source: string): string[] {
  return [...source.matchAll(/sealed class (\w+)/g)].map((m) => m[1]);
}

describe("builderClassName", () => {
  it("names the builder without path parameters after the group alone", () =>
    strictEqual(builderClassName("Pets", 0), "PetsRequestBuilder"));

  it("names the first builder with path parameters Item", () =>
    strictEqual(builderClassName("Pets", 1), "PetsItemRequestBuilder"));

  it("numbers every further builder from 2", () => {
    strictEqual(builderClassName("Pets", 2), "PetsItem2RequestBuilder");
    strictEqual(builderClassName("Pets", 10), "PetsItem10RequestBuilder");
  });
});

describe("grouping operations into request builders", () => {
  it("puts operations that take no path parameters on the builder named after the group", async () => {
    const source = fileContent(
      await emit(`${PREAMBLE}
        @route("/pets") interface Pets {
          @get list(): string[];
          @post create(@body body: string): void;
        }
      `),
      "Endpoints/PetsRequestBuilders.g.cs",
    );

    deepStrictEqual(classNames(source), ["PetsRequestBuilder"]);
    const builder = classBody(source, "PetsRequestBuilder");
    ok(builder.includes("ListAsync(CancellationToken cancellationToken"));
    ok(builder.includes("CreateAsync(string body, CancellationToken"));
  });

  it("orders the builders by how many path parameters they take, then by declaration", async () => {
    const source = fileContent(
      await emit(`${PREAMBLE}
        @route("/stores") interface Stores {
          @route("{storeId}/pets/{petId}") @get pet(@path storeId: string, @path petId: string): void;
          @route("{storeId}") @get read(@path storeId: string): void;
          @get list(): void;
          @route("{storeId}/counts/{n}") @get count(@path storeId: string, @path n: int32): void;
        }
      `),
      "Endpoints/StoresRequestBuilders.g.cs",
    );

    deepStrictEqual(classNames(source), [
      "StoresRequestBuilder",
      "StoresItemRequestBuilder",
      "StoresItem2RequestBuilder",
      "StoresItem3RequestBuilder",
    ]);
    ok(classBody(source, "StoresRequestBuilder").includes("ListAsync("));
    ok(classBody(source, "StoresItemRequestBuilder").includes("ReadAsync("));
    ok(classBody(source, "StoresItem2RequestBuilder").includes("PetAsync("));
    ok(classBody(source, "StoresItem3RequestBuilder").includes("CountAsync("));
  });

  it("starts at Item when no operation is without path parameters", async () => {
    const source = fileContent(
      await emit(`${PREAMBLE}
        @route("/{storeId}/pets") interface Pets {
          @get list(@path storeId: string): void;
          @route("{petId}") @delete remove(@path storeId: string, @path petId: string): void;
        }
      `),
      "Endpoints/PetsRequestBuilders.g.cs",
    );

    deepStrictEqual(classNames(source), [
      "PetsItemRequestBuilder",
      "PetsItem2RequestBuilder",
    ]);
  });

  it("shares one builder between operations whose path parameters have the same types", async () => {
    const source = fileContent(
      await emit(`${PREAMBLE}
        @route("/misc") interface Misc {
          @route("lookup/{kind}/{id}") @get lookup(@path kind: string, @path id: string): void;
          @route("reserved/{+path}/items/{id}") @get reserved(@path path: string, @path id: string): void;
        }
      `),
      "Endpoints/MiscRequestBuilders.g.cs",
    );

    deepStrictEqual(classNames(source), ["MiscItemRequestBuilder"]);
    const builder = classBody(source, "MiscItemRequestBuilder");
    // Named after the first operation that takes them.
    ok(builder.includes("private readonly string _kind;"), builder);
    ok(builder.includes("private readonly string _id;"), builder);
    ok(
      builder.includes(
        '$"api/misc/lookup/{ClientRuntime.EscapePathSegment(this._kind)}/{ClientRuntime.EscapePathSegment(this._id)}"',
      ),
      builder,
    );
    // The second operation fills its own route by position, keeping its own escaping.
    ok(
      builder.includes(
        '$"api/misc/reserved/{ClientRuntime.EscapeReservedPath(this._kind)}/items/{ClientRuntime.EscapePathSegment(this._id)}"',
      ),
      builder,
    );
  });

  it("makes a shared field nullable when one operation's path parameter is optional", async () => {
    const results = await emit(`${PREAMBLE}
      @route("/items") interface Items {
        @route("{/id}") @get find(@path id?: string): void;
        @route("{id}/raw") @get raw(@path id: string): void;
      }
    `);
    const source = fileContent(results, "Endpoints/ItemsRequestBuilders.g.cs");

    deepStrictEqual(classNames(source), ["ItemsItemRequestBuilder"]);
    ok(source.includes("private readonly string? _id;"), source);
    ok(
      fileContent(results, "TestApiClientExtensions.g.cs").includes(
        "public ItemsItemRequestBuilder Items(string? id) =>",
      ),
    );
  });

  it("shares one builder when the types differ only in nested reference nullability (CS0111)", async () => {
    const results = await emit(`${PREAMBLE}
      model Item { id: string; }
      @route("/p") interface Positions {
        @route("a/{v}") @get items(@path v: Item[]): void;
        @route("b/{v}") @get nullableItems(@path v: (Item | null)[]): void;
      }
    `);
    const source = fileContent(
      results,
      "Endpoints/PositionsRequestBuilders.g.cs",
    );

    deepStrictEqual(classNames(source), ["PositionsItemRequestBuilder"]);
    ok(source.includes("private readonly List<Item?> _v;"), source);
    strictEqual(
      fileContent(results, "TestApiClientExtensions.g.cs").match(
        / Positions\(/g,
      )?.length,
      1,
    );
  });

  it("keeps a nullable value type apart, since it is a different type", async () => {
    const results = await emit(`${PREAMBLE}
      enum Color { red, blue }
      @route("/p") interface Positions {
        @route("a/{v}") @get count(@path v: int32): void;
        @route("b/{v}") @get maybe(@path v: int32 | null): void;
        @route("c/{v}") @get color(@path v: Color): void;
        @route("d/{v}") @get maybeColor(@path v: Color | null): void;
      }
    `);
    const client = fileContent(results, "TestApiClientExtensions.g.cs");

    ok(client.includes("Positions(int v)"), client);
    ok(client.includes("Positions(int? v)"), client);
    ok(client.includes("Positions(Color v)"), client);
    ok(client.includes("Positions(Color? v)"), client);
  });

  it("keeps builders apart when the types of their path parameters differ", async () => {
    const results = await emit(`${PREAMBLE}
      @route("/values") interface Values {
        @route("text/{p}") @get text(@path p: string): void;
        @route("number/{p}") @get number(@path p: int32): void;
      }
    `);
    const source = fileContent(results, "Endpoints/ValuesRequestBuilders.g.cs");
    const client = fileContent(results, "TestApiClientExtensions.g.cs");

    deepStrictEqual(classNames(source), [
      "ValuesItemRequestBuilder",
      "ValuesItem2RequestBuilder",
    ]);
    ok(client.includes("public ValuesItemRequestBuilder Values(string p) =>"));
    ok(client.includes("public ValuesItem2RequestBuilder Values(int p) =>"));
  });

  it("leaves the path parameters out of the method signature", async () => {
    const source = fileContent(
      await emit(`${PREAMBLE}
        @route("/items") interface Items {
          @get read(@path id: string, @query expand?: string, @header("X-Tenant") tenant: string): void;
        }
      `),
      "Endpoints/ItemsRequestBuilders.g.cs",
    );

    ok(
      source.includes(
        "public async Task ReadAsync(string tenant, string? expand = null, CancellationToken cancellationToken = default)",
      ),
      source,
    );
    doesNotMatch(source, /ReadAsync\(string id/);
    doesNotMatch(source, /additionalQueryParameters/);
  });

  it("applies a path parameter's encoding to the field", async () => {
    const source = fileContent(
      await emit(`${PREAMBLE}
        @route("/at/{when}") interface Times {
          @get read(@path @encode(DateTimeKnownEncoding.unixTimestamp, int64) when: utcDateTime): void;
        }
      `),
      "Endpoints/TimesRequestBuilders.g.cs",
    );

    ok(source.includes("private readonly DateTimeOffset _when;"), source);
    ok(
      source.includes(
        "ClientRuntime.EscapePathSegment(ClientRuntime.Encode(this._when, ClientRuntime.WireEncoding.UnixSeconds))",
      ),
      source,
    );
  });

  it("documents a field's constructor parameter from the path parameter's doc", async () => {
    const results = await emit(`${PREAMBLE}
      @route("/items") interface Items {
        @get read(
          /** The item's
           * identifier. */
          @path id: string,
        ): void;
      }
    `);

    const client = fileContent(results, "TestApiClientExtensions.g.cs");
    ok(
      client.includes('/// <param name="id">The item\'s identifier.</param>'),
      client,
    );
  });

  it("gives a parameter without documentation a generated summary", async () => {
    const client = fileContent(
      await emit(`${PREAMBLE}
        @route("/items") interface Items { @get read(@path id: string): void; }
      `),
      "TestApiClientExtensions.g.cs",
    );

    ok(
      client.includes(
        '/// <param name="id">The <c>id</c> path parameter.</param>',
      ),
      client,
    );
  });
});

describe("the request a builder sends", () => {
  it("starts from the base class's client and applies the caller's modifiers after the declared parameters", async () => {
    const source = fileContent(
      await emit(`${PREAMBLE}
        @route("/items") interface Items {
          @get list(@query q?: string, @header("X-Tenant") tenant?: string, @cookie session?: string): void;
        }
      `),
      "Endpoints/ItemsRequestBuilders.g.cs",
    );

    const build = source.indexOf("Client.Request().AppendPathSegment");
    const query = source.indexOf('flurlRequest.SetQueryParam("q"');
    const header = source.indexOf('flurlRequest.WithHeader("X-Tenant"');
    const cookie = source.indexOf('flurlRequest.WithCookie("session"');
    const modifiers = source.indexOf("ApplyModifiers(flurlRequest);");
    ok(build >= 0 && query > build && header > query && cookie > header);
    ok(modifiers > cookie, source);
  });

  it("documents each member, since no interface supplies inherited docs", async () => {
    const source = fileContent(
      await emit(`${PREAMBLE}
        model Widget { id: string; }
        @route("/w") interface Widgets {
          /** Reads a widget. */
          @get read(@path id: string): Widget;
        }
      `),
      "Endpoints/WidgetsRequestBuilders.g.cs",
    );

    doesNotMatch(source, /inheritdoc/);
    strictEqual(source.match(/\/\/\/ Reads a widget\./g)?.length, 2);
    ok(source.includes('/// <typeparam name="TResult">'));
  });

  it("pages an operation named configure without declaring a member beside ConfigureRequest", async () => {
    const source = fileContent(
      await emit(`${PREAMBLE}
        model Page { @pageItems items: string[]; @nextLink next?: url; }
        @route("/c") interface Things { @list @get configure(): Page; }
      `),
      "Endpoints/ThingsRequestBuilders.g.cs",
    );

    ok(source.includes("var page = await ConfigureAsync(cancellationToken)"));
    doesNotMatch(source, /IFlurlRequest \w+\(/);
  });

  it("applies the caller's modifiers to the first nextLink page only", async () => {
    const source = fileContent(
      await emit(`${PREAMBLE}
        model Page { @pageItems items: string[]; @nextLink next?: url; }
        @route("/l") interface Links { @list @get list(@header("X-Tenant") tenant: string): Page; }
      `),
      "Endpoints/LinksRequestBuilders.g.cs",
    );

    const wrapper = source.slice(source.indexOf("ListAllAsync("));
    const follow = wrapper.slice(wrapper.indexOf("Client.Request(nextLink"));
    // The declared header is replayed on every continuation request...
    ok(follow.includes('nextRequest.WithHeader("X-Tenant"'), follow);
    // ...but the builder's modifiers are not: they are applied once, when the
    // first page's request is built.
    doesNotMatch(follow, /ApplyModifiers/);
    strictEqual(source.match(/ApplyModifiers\(flurlRequest\);/g)?.length, 1);
    ok(source.includes("applies to the first page only"), source);
  });
});

describe("the client", () => {
  it("creates a new builder from each method, passing the path parameters on", async () => {
    const client = fileContent(
      await emit(`${PREAMBLE}
        @route("/{storeId}/pets") interface Pets {
          @get list(@path storeId: string): void;
          @route("{petId}") @get read(@path storeId: string, @path petId: string): void;
        }
      `),
      "TestApiClientExtensions.g.cs",
    );

    ok(client.includes("public TestApiClient(IFlurlClient flurlClient)"));
    ok(
      client.includes(
        "public PetsItemRequestBuilder Pets(string storeId) =>\n        new PetsItemRequestBuilder(this.FlurlClient, storeId);",
      ),
      client,
    );
    ok(
      client.includes(
        "public PetsItem2RequestBuilder Pets(string storeId, string petId) =>\n        new PetsItem2RequestBuilder(this.FlurlClient, storeId, petId);",
      ),
      client,
    );
  });

  it("registers the client alone with dependency injection", async () => {
    const client = fileContent(
      await emit(`${PREAMBLE}
        @route("/a") interface A { @get read(): void; }
        @route("/b") interface B { @get read(): void; }
      `),
      "TestApiClientExtensions.g.cs",
    );

    strictEqual(client.match(/services\.AddTransient</g)?.length, 1);
    ok(
      client.includes(
        "services.AddTransient<TestApiClient>(sp => new TestApiClient(CreateFlurlClient(sp, models, configureFlurlClient)));",
      ),
    );
  });

  it("keeps an internal interface's builders and client methods internal", async () => {
    const results = await emit(`
      import "@typespec/http";
      import "@massivescale/tsp-flurl-client";
      using Http;
      using MassiveScale.TspFlurlClient;

      @service(#{ title: "Test API" })
      namespace TestApi;

      @access(Access.internal)
      @route("/secrets") interface Secrets { @get read(@path id: string): void; }
      @route("/open") interface Open { @get read(): void; }
    `);
    const client = fileContent(results, "TestApiClientExtensions.g.cs");
    const builders = fileContent(results, "SecretsRequestBuilders.g.cs");

    ok(
      builders.includes(
        "internal sealed class SecretsItemRequestBuilder : RequestBuilder<SecretsItemRequestBuilder>",
      ),
    );
    ok(
      client.includes("internal SecretsItemRequestBuilder Secrets(string id)"),
    );
    ok(client.includes("public OpenRequestBuilder Open()"));
    // The constructor takes no endpoint, so it stays public.
    ok(client.includes("public TestApiClient(IFlurlClient flurlClient)"));
  });

  it("reports an interface named after a member every C# object has", async () => {
    const [results, diagnostics] = await emitWithDiagnostics(`${PREAMBLE}
      @route("/a") interface ToString { @get read(): void; }
      @route("/b") interface Fine { @get read(): void; }
    `);

    const messages = messagesFor(diagnostics, "name-collision");
    ok(
      messages.some(
        (m) => m.includes("ToString") && m.includes("every C# object has"),
      ),
      messages.join("\n"),
    );
    ok(!has(results, "ToStringRequestBuilders.g.cs"));
    ok(has(results, "FineRequestBuilders.g.cs"));
  });

  it("writes no builder file and no client method for an interface whose every operation is left out", async () => {
    // A discriminated hierarchy nested in another is not supported, so an operation
    // that reaches one is reported and left out.
    const [results, diagnostics] = await emitWithDiagnostics(`${PREAMBLE}
      @discriminator("kind") model Animal { kind: string; }
      @discriminator("breed") model Dog extends Animal { kind: "dog"; breed: string; }
      model Labrador extends Dog { breed: "labrador"; }
      @route("/a") interface Kept { @get read(): void; }
      @route("/b") interface Dropped { @get read(): Labrador; }
    `);

    strictEqual(messagesFor(diagnostics, "unsupported-feature").length, 1);
    ok(!has(results, "DroppedRequestBuilders.g.cs"));
    doesNotMatch(
      fileContent(results, "TestApiClientExtensions.g.cs"),
      /Dropped/,
    );
  });
});

describe("request builder names", () => {
  it("reports a model with a builder's name, which the builder keeps", async () => {
    const [results, diagnostics] = await emitWithDiagnostics(`${PREAMBLE}
      model ItemsItemRequestBuilder { id: string; }
      @route("/items") interface Items {
        @get list(): ItemsItemRequestBuilder[];
        @get read(@path id: string): void;
      }
    `);

    ok(
      messagesFor(diagnostics, "output-name-collision").some(
        (m) =>
          m.includes("ItemsItemRequestBuilder") &&
          m.includes("request builder"),
      ),
    );
    ok(!has(results, "Models/ItemsItemRequestBuilder.g.cs"));
    const source = fileContent(results, "ItemsRequestBuilders.g.cs");
    deepStrictEqual(classNames(source), [
      "ItemsRequestBuilder",
      "ItemsItemRequestBuilder",
    ]);
  });

  it("reports a model named like the RequestBuilder helper", async () => {
    const [, diagnostics] = await emitWithDiagnostics(`${PREAMBLE}
      model RequestBuilder { id: string; }
      @route("/items") interface Items { @get read(): RequestBuilder; }
    `);

    ok(
      messagesFor(diagnostics, "output-name-collision").some((m) =>
        m.includes("RequestBuilder helper"),
      ),
    );
  });

  it("writes the Flurl client type in full when a model hides it, but not the property", async () => {
    const results = await emit(`${PREAMBLE}
      model IFlurlClient { id: string; }
      model FlurlClient { id: string; }
      @route("/items") interface Items {
        @get list(): IFlurlClient;
        @get read(@path id: string): FlurlClient;
      }
    `);
    const builders = fileContent(results, "ItemsRequestBuilders.g.cs");
    const client = fileContent(results, "TestApiClientExtensions.g.cs");

    ok(
      builders.includes(
        "internal ItemsItemRequestBuilder(global::Flurl.Http.IFlurlClient flurlClient, string id)",
      ),
      builders,
    );
    ok(
      client.includes("new ItemsItemRequestBuilder(this.FlurlClient, id)"),
      client,
    );
    ok(client.includes("new global::Flurl.Http.FlurlClient(baseUrl)"), client);
  });
});

describe("the RequestBuilder helper", () => {
  it("is written once, with the modifiers every builder offers", async () => {
    const results = await emit(`${PREAMBLE}
      @route("/a") interface A { @get read(): void; }
    `);
    const helper = fileContent(results, "Infrastructure/RequestBuilder.g.cs");

    ok(
      helper.includes(
        "public abstract class RequestBuilder<TBuilder>\n    where TBuilder : RequestBuilder<TBuilder>",
      ),
    );
    for (const signature of [
      "public TBuilder AppendHeader(string name, object? value)",
      "public TBuilder AppendQueryParameter(string name, object? value)",
      "public TBuilder AppendCookie(string name, object? value)",
      "public TBuilder ConfigureRequest(Action<IFlurlRequest> configure)",
      "private protected IFlurlClient Client { get; }",
      "private protected void ApplyModifiers(IFlurlRequest request)",
    ]) {
      ok(helper.includes(signature), signature);
    }
  });

  it("is shared by every version's builders", async () => {
    const results = await emit(
      `
      import "@typespec/http";
      import "@typespec/versioning";
      using Http;
      using Versioning;

      @service(#{ title: "Test API" })
      @versioned(Versions)
      namespace TestApi;
      enum Versions { v1, v2 }

      @route("/a") interface A { @get read(): void; }
    `,
      { "all-versions": true },
    );

    strictEqual(
      Object.keys(results).filter((k) => k.endsWith("RequestBuilder.g.cs"))
        .length,
      1,
    );
    ok(has(results, "v1/Endpoints/ARequestBuilders.g.cs"));
    ok(has(results, "v2/Endpoints/ARequestBuilders.g.cs"));
  });

  it("has no inheriting constructor or Modifiers property in the flat shape", async () => {
    const helper = fileContent(
      await emit(`${PREAMBLE}
        @route("/a") interface A { @get read(): void; }
      `),
      "Infrastructure/RequestBuilder.g.cs",
    );

    doesNotMatch(helper, /inherited/);
    doesNotMatch(helper, /Modifiers =>/);
  });

  for (const shape of ["path", "interface"] as const) {
    it(`lets a ${shape} builder start with the modifiers of the one it is created from`, async () => {
      const helper = fileContent(
        await emit(
          `${PREAMBLE}
          @route("/a") interface A { @get read(): void; }
        `,
          { "client-shape": shape },
        ),
        "Infrastructure/RequestBuilder.g.cs",
      );

      ok(
        helper.includes(
          "private protected RequestBuilder(IFlurlClient client, IEnumerable<Action<IFlurlRequest>>? inherited)\n        : this(client)\n    {\n        if (inherited is not null) _modifiers.AddRange(inherited);\n    }",
        ),
        helper,
      );
      ok(
        helper.includes(
          "private protected IEnumerable<Action<IFlurlRequest>> Modifiers => _modifiers;",
        ),
        helper,
      );
    });
  }
});

/** {@link PREAMBLE} with this emitter's decorators (`@access`, `@clientName`) in scope. */
const DECORATED = `
  import "@typespec/http";
  import "@massivescale/tsp-flurl-client";
  using Http;
  using MassiveScale.TspFlurlClient;

  @service(#{ title: "Test API" })
  namespace TestApi;
`;

const COMMUNITY = `${PREAMBLE}
  model Config { name: string; }

  /** The root configuration. */
  @route("/communities/{communityKey}/configuration")
  interface Community {
    @get read(@path communityKey: string): Config;
    @patch update(@path communityKey: string, @body body: Config): void;
  }

  @route("/communities/{communityKey}/configuration/rewards")
  interface Rewards {
    @get read(@path communityKey: string): Config;
    @patch update(@path communityKey: string, @body body: Config): void;
  }
`;

describe("the client-shape option", () => {
  it("emits exactly the flat shape when it is left out", async () => {
    deepStrictEqual(
      await emit(COMMUNITY),
      await emit(COMMUNITY, { "client-shape": "flat" }),
    );
  });

  it("rejects a shape it does not know", async () => {
    const [, diagnostics] = await emitWithDiagnostics(COMMUNITY, {
      "client-shape": "tree" as "path",
    });
    ok(diagnostics.some((d) => d.code === "invalid-schema"));
  });
});

describe("the path client shape", () => {
  it("chains one builder per URL segment, each holding the path parameters so far", async () => {
    const results = await emit(COMMUNITY, { "client-shape": "path" });
    const source = fileContent(
      results,
      "Endpoints/CommunitiesRequestBuilders.g.cs",
    );

    deepStrictEqual(classNames(source), [
      "CommunitiesItemRequestBuilder",
      "CommunitiesItemConfigurationRequestBuilder",
      "CommunitiesItemConfigurationRewardsRequestBuilder",
    ]);
    ok(
      source.includes(
        "/// Sends the requests to <c>/communities/{communityKey}</c>.\n/// </summary>\npublic sealed class CommunitiesItemRequestBuilder",
      ),
      source,
    );
    const communities = classBody(source, "CommunitiesItemRequestBuilder");
    ok(
      communities.includes(
        "internal CommunitiesItemRequestBuilder(IFlurlClient flurlClient, IEnumerable<Action<IFlurlRequest>>? modifiers, string communityKey)\n        : base(flurlClient, modifiers)",
      ),
      communities,
    );
    ok(
      communities.includes(
        "public CommunitiesItemConfigurationRequestBuilder Configuration() =>\n        new CommunitiesItemConfigurationRequestBuilder(this.Client, this.Modifiers, this._communityKey);\n\n}",
      ),
      communities,
    );
    const rewards = classBody(
      source,
      "CommunitiesItemConfigurationRewardsRequestBuilder",
    );
    ok(rewards.includes("public Task<Config> GetAsync("), rewards);
    ok(rewards.includes("public async Task PatchAsync(Config body"), rewards);
    ok(
      rewards.includes(
        '.AppendPathSegment($"api/communities/{ClientRuntime.EscapePathSegment(this._communityKey)}/configuration/rewards")',
      ),
      rewards,
    );
    ok(
      !has(results, "CommunityRequestBuilders.g.cs") &&
        !has(results, "RewardsRequestBuilders.g.cs"),
    );

    const client = fileContent(results, "TestApiClientExtensions.g.cs");
    ok(
      client.includes(
        "/// Starts a request to <c>/communities/{communityKey}</c>.",
      ),
      client,
    );
    ok(
      client.includes(
        "public CommunitiesItemRequestBuilder Communities(string communityKey) =>\n        new CommunitiesItemRequestBuilder(this.FlurlClient, null, communityKey);",
      ),
      client,
    );
  });

  it("puts a step's methods and steps apart with one blank line", async () => {
    const source = fileContent(
      await emit(COMMUNITY, { "client-shape": "path" }),
      "Endpoints/CommunitiesRequestBuilders.g.cs",
    );
    const configuration = classBody(
      source,
      "CommunitiesItemConfigurationRequestBuilder",
    );

    ok(
      configuration.includes(
        "this._communityKey);\n\n    /// <summary>\n    /// Sends the <c>GET</c>",
      ),
      configuration,
    );
    doesNotMatch(source, /\n\n\n/);
  });

  it("reaches the parameters before the first literal segment through a client indexer", async () => {
    const results = await emit(
      `${PREAMBLE}
        @route("/{storeId}/pets") interface Pets { @get list(@path storeId: string): string[]; }
      `,
      { "client-shape": "path" },
    );
    const source = fileContent(results, "Endpoints/ItemRequestBuilders.g.cs");

    deepStrictEqual(classNames(source), [
      "ItemRequestBuilder",
      "ItemPetsRequestBuilder",
    ]);
    ok(
      fileContent(results, "TestApiClientExtensions.g.cs").includes(
        "public ItemRequestBuilder this[string storeId] =>\n        new ItemRequestBuilder(this.FlurlClient, null, storeId);",
      ),
    );
  });

  it("names a method after its verb, unless another on its builder shares the verb", async () => {
    const source = fileContent(
      await emit(
        `${PREAMBLE}
          @route("/pets") interface Pets {
            @sharedRoute @get list(): string[];
            @get @route("{id}") read(@path id: string): string;
            @delete @route("{id}") remove(@path id: string): void;
          }
          @route("/pets") interface Search {
            @sharedRoute @get search(@query q: string): string[];
          }
        `,
        { "client-shape": "path" },
      ),
      "Endpoints/PetsRequestBuilders.g.cs",
    );

    const collection = classBody(source, "PetsRequestBuilder");
    ok(collection.includes(" ListAsync("), collection);
    ok(collection.includes(" SearchAsync("), collection);
    doesNotMatch(collection, / GetAsync\(/);
    const item = classBody(source, "PetsItemRequestBuilder");
    ok(item.includes(" GetAsync("), item);
    ok(item.includes(" DeleteAsync("), item);
  });

  it("keeps a name given with @clientName, which does not count towards a shared verb", async () => {
    const item = classBody(
      fileContent(
        await emit(
          `${DECORATED}
            @route("/pets/{id}") interface Pets {
              @get read(@path id: string): string;
              @get @clientName("fetch") @route("full") readFull(@path id: string): string;
            }
          `,
          { "client-shape": "path" },
        ),
        "Endpoints/PetsRequestBuilders.g.cs",
      ),
      "PetsItemRequestBuilder",
    );

    ok(item.includes(" GetAsync("), item);
  });

  it("names a paging wrapper after the verb its raw method has", async () => {
    const source = fileContent(
      await emit(
        `${PREAMBLE}
          model Page { @pageItems items: string[]; @nextLink next?: url; }
          @route("/pets") interface Pets { @list @get list(): Page; }
        `,
        { "client-shape": "path" },
      ),
      "Endpoints/PetsRequestBuilders.g.cs",
    );

    ok(source.includes("IAsyncEnumerable<string> GetAllAsync("), source);
    ok(source.includes(" GetAsync("), source);
  });

  it("passes the parameters after a mixed segment to the method and fills the route from them", async () => {
    const source = fileContent(
      await emit(
        `${PREAMBLE}
          @route("/stores/{storeId}") interface Reports {
            @route("{from}-{to}/report") @get report(@path storeId: string, @path from: string, @path to: int32): void;
          }
        `,
        { "client-shape": "path" },
      ),
      "Endpoints/StoresRequestBuilders.g.cs",
    );
    const store = classBody(source, "StoresItemRequestBuilder");

    ok(
      store.includes(
        "public async Task GetAsync(string from, int to, CancellationToken cancellationToken = default)",
      ),
      store,
    );
    ok(
      store.includes(
        '.AppendPathSegment($"api/stores/{ClientRuntime.EscapePathSegment(this._storeId)}/{ClientRuntime.EscapePathSegment(from)}-{ClientRuntime.EscapePathSegment(to)}/report")',
      ),
      store,
    );
  });

  it("keeps the slashes of a reserved-expansion argument", async () => {
    const source = fileContent(
      await emit(
        `${PREAMBLE}
          @route("/docs") interface Docs {
            @route("v{n}/{+rest}") @get read(@path n: int32, @path rest: string): void;
          }
        `,
        { "client-shape": "path" },
      ),
      "Endpoints/DocsRequestBuilders.g.cs",
    );

    ok(
      source.includes(
        '.AppendPathSegment($"api/docs/v{ClientRuntime.EscapePathSegment(n)}/{ClientRuntime.EscapeReservedPath(rest)}")',
      ),
      source,
    );
  });

  it("encodes a held path parameter the way the flat shape does", async () => {
    const source = fileContent(
      await emit(
        `${PREAMBLE}
          @route("/events/{at}") interface Events {
            @get read(@path @encode(DateTimeKnownEncoding.unixTimestamp, int64) at: utcDateTime): void;
          }
        `,
        { "client-shape": "path" },
      ),
      "Endpoints/EventsRequestBuilders.g.cs",
    );

    ok(source.includes("ClientRuntime.Encode(this._at,"), source);
  });

  it("reaches an operation whose route has no step by its interface's name", async () => {
    const results = await emit(
      `${PREAMBLE}
        /** Whether the service is up. */
        @route("/") interface Health { @get check(): void; }
      `,
      { "client-shape": "path" },
    );
    const source = fileContent(results, "Endpoints/HealthRequestBuilders.g.cs");

    ok(source.includes("/// Whether the service is up."), source);
    ok(source.includes('.AppendPathSegment($"api")'), source);
    ok(
      fileContent(results, "TestApiClientExtensions.g.cs").includes(
        "/// Starts a request to the <c>Health</c> endpoint group.",
      ),
    );
  });

  it("numbers a field whose name an earlier builder of the chain holds", async () => {
    const source = fileContent(
      await emit(
        `${PREAMBLE}
          @route("/a") interface A {
            @get @route("{id}") read(@path id: string): void;
            @get @route("{x}/b/{id}") child(@path x: string, @path id: string): void;
          }
        `,
        { "client-shape": "path" },
      ),
      "Endpoints/ARequestBuilders.g.cs",
    );
    const child = classBody(source, "AItemBItemRequestBuilder");

    ok(
      child.includes(
        "internal AItemBItemRequestBuilder(IFlurlClient flurlClient, IEnumerable<Action<IFlurlRequest>>? modifiers, string id, string id2)",
      ),
      child,
    );
    ok(
      child.includes(
        "{ClientRuntime.EscapePathSegment(this._id)}/b/{ClientRuntime.EscapePathSegment(this._id2)}",
      ),
      child,
    );
    ok(
      classBody(source, "AItemRequestBuilder").includes(
        "public AItemBItemRequestBuilder B(string id) =>\n        new AItemBItemRequestBuilder(this.Client, this.Modifiers, this._id, id);",
      ),
    );
  });

  it("gives a method its interface's access, and a builder the widest access below it", async () => {
    const source = fileContent(
      await emit(
        `${DECORATED}
          @route("/a") interface Open { @get read(): void; }
          @access(Access.internal) @route("/a") interface Hidden {
            @post create(): void;
            @get @route("secret") secret(): void;
          }
        `,
        { "client-shape": "path" },
      ),
      "Endpoints/ARequestBuilders.g.cs",
    );

    const a = classBody(source, "ARequestBuilder");
    ok(source.includes("public sealed class ARequestBuilder"), source);
    ok(a.includes("public async Task GetAsync("), a);
    ok(a.includes("internal async Task PostAsync("), a);
    ok(a.includes("internal ASecretRequestBuilder Secret() =>"), a);
    ok(source.includes("internal sealed class ASecretRequestBuilder"), source);
  });

  it("makes a client step internal when everything reached from it is", async () => {
    const results = await emit(
      `${DECORATED}
        @access(Access.internal) @route("/a") interface Hidden { @get read(): void; }
      `,
      { "client-shape": "path" },
    );

    ok(
      fileContent(results, "TestApiClientExtensions.g.cs").includes(
        "internal ARequestBuilder A() =>",
      ),
    );
  });

  it("numbers the constructor's own parameters when a path parameter has their name", async () => {
    const source = fileContent(
      await emit(
        `${PREAMBLE}
          @route("/a/{modifiers}/{flurlClient}") interface A {
            @get read(@path modifiers: string, @path flurlClient: string): void;
          }
        `,
        { "client-shape": "path" },
      ),
      "Endpoints/ARequestBuilders.g.cs",
    );

    ok(
      source.includes(
        "internal AItemRequestBuilder(IFlurlClient flurlClient2, IEnumerable<Action<IFlurlRequest>>? modifiers2, string modifiers, string flurlClient)\n        : base(flurlClient2, modifiers2)",
      ),
      source,
    );
  });

  it("leaves out a paging wrapper whose name another method of the builder has", async () => {
    const [results, diagnostics] = await emitWithDiagnostics(
      `${DECORATED}
        model Page { @pageItems items: string[]; @nextLink next?: url; }
        @route("/pets") interface Pets {
          @list @get list(): Page;
          @post @clientName("getAll") add(): void;
        }
      `,
      { "client-shape": "path" },
    );

    ok(
      messagesFor(diagnostics, "unsupported-paging-style").some((m) =>
        m.includes("of the request builder"),
      ),
    );
    const source = fileContent(results, "Endpoints/PetsRequestBuilders.g.cs");
    doesNotMatch(source, /IAsyncEnumerable/);
    ok(source.includes(" GetAllAsync("), source);
  });

  it("leaves out an operation whose path parameter was left out", async () => {
    const [results, diagnostics] = await emitWithDiagnostics(
      `${PREAMBLE}
        @route("/a") interface A {
          @get list(): void;
          @get @route("{my-id}") read(@path \`my-id\`: string): void;
        }
      `,
      { "client-shape": "path" },
    );

    ok(messagesFor(diagnostics, "invalid-name").length > 0);
    deepStrictEqual(
      classNames(fileContent(results, "Endpoints/ARequestBuilders.g.cs")),
      ["ARequestBuilder"],
    );
  });

  it("leaves out an operation whose name is not a C# name, or that cannot be sent", async () => {
    const [results, diagnostics] = await emitWithDiagnostics(
      `${PREAMBLE}
        @route("/a") interface A {
          @get read(): void;
          @post \`bad-name\`(): void;
          @put upload(@header contentType: "multipart/form-data", @multipartBody body: { name: HttpPart<string>, file: HttpPart<bytes> }): void;
        }
      `,
      { "client-shape": "path" },
    );

    ok(
      messagesFor(diagnostics, "invalid-name").some((m) =>
        m.includes("bad-name"),
      ),
    );
    strictEqual(messagesFor(diagnostics, "unsupported-feature").length, 1);
    const a = classBody(
      fileContent(results, "Endpoints/ARequestBuilders.g.cs"),
      "ARequestBuilder",
    );
    ok(a.includes(" GetAsync("), a);
    doesNotMatch(a, /PostAsync|PutAsync/);
  });

  it("documents a held path parameter with its own documentation", async () => {
    const results = await emit(
      `${PREAMBLE}
        @route("/stores/{storeId}") interface Stores {
          @get read(/** The store's key. */ @path storeId: string): void;
        }
      `,
      { "client-shape": "path" },
    );

    ok(
      fileContent(results, "Endpoints/StoresRequestBuilders.g.cs").includes(
        '/// <param name="storeId">The store\'s key.</param>',
      ),
    );
    ok(
      fileContent(results, "TestApiClientExtensions.g.cs").includes(
        '/// <param name="storeId">The store\'s key.</param>',
      ),
    );
  });

  it("leaves out an interface whose name is not a C# name", async () => {
    const [results, diagnostics] = await emitWithDiagnostics(
      `${PREAMBLE}
        @route("/a") interface \`my-api\` { @get read(): void; }
        @route("/b") interface B { @get read(): void; }
      `,
      { "client-shape": "path" },
    );

    ok(
      messagesFor(diagnostics, "invalid-name").some((m) =>
        m.includes("my-api"),
      ),
    );
    ok(!has(results, "Endpoints/ARequestBuilders.g.cs"));
    ok(has(results, "Endpoints/BRequestBuilders.g.cs"));
  });

  it("emits only the operations of the version being emitted", async () => {
    const results = await emit(
      `
      import "@typespec/http";
      import "@typespec/versioning";
      using Http;
      using Versioning;

      @service(#{ title: "Test API" })
      @versioned(Versions)
      namespace TestApi;
      enum Versions { v1, v2 }

      @route("/a") interface A { @get read(): void; }
      @added(Versions.v2) @route("/b") interface B { @get read(): void; }
    `,
      { "all-versions": true, "client-shape": "path" },
    );

    ok(has(results, "v1/Endpoints/ARequestBuilders.g.cs"));
    ok(!has(results, "v1/Endpoints/BRequestBuilders.g.cs"));
    ok(has(results, "v2/Endpoints/BRequestBuilders.g.cs"));
  });

  it("reports two services whose request builders would share a file", async () => {
    const [, diagnostics] = await emitWithDiagnostics(
      `
      import "@typespec/http";
      using Http;

      @service(#{ title: "A" })
      namespace A { @route("/items") interface One { @get list(): string[]; } }

      @service(#{ title: "B" })
      namespace B { @route("/items") interface Two { @get list(): string[]; } }
    `,
      { "client-shape": "path" },
    );

    ok(
      messagesFor(diagnostics, "output-name-collision").some((m) =>
        m.includes("client.Items"),
      ),
    );
  });

  it("reports a step named like a member every builder has, and leaves it out", async () => {
    const [results, diagnostics] = await emitWithDiagnostics(
      `${PREAMBLE}
        @route("/a") interface A {
          @get read(): void;
          @get @route("append-header") append(): void;
          @get @route("append-header/{id}") appendOne(@path id: string): void;
        }
      `,
      { "client-shape": "path" },
    );

    ok(
      messagesFor(diagnostics, "name-collision").some((m) =>
        m.includes("AppendHeader"),
      ),
    );
    const source = fileContent(results, "Endpoints/ARequestBuilders.g.cs");
    deepStrictEqual(classNames(source), ["ARequestBuilder"]);
  });

  it("reports a client step named like a client member, and leaves it out", async () => {
    const [results, diagnostics] = await emitWithDiagnostics(
      `${PREAMBLE}
        @route("/create") interface Make {
          @get read(): void;
          @get @route("{id}") one(@path id: string): void;
        }
        @route("/fine") interface Fine { @get read(): void; }
      `,
      { "client-shape": "path" },
    );

    ok(
      messagesFor(diagnostics, "name-collision").some((m) =>
        m.includes("Create"),
      ),
    );
    ok(!has(results, "CreateRequestBuilders.g.cs"));
    ok(has(results, "FineRequestBuilders.g.cs"));
  });

  it("reports a client step named Item beside the client's indexer", async () => {
    const [results, diagnostics] = await emitWithDiagnostics(
      `${PREAMBLE}
        @route("/{tenant}/x") interface X { @get read(@path tenant: string): void; }
        @route("/item") interface Items { @get read(): void; }
      `,
      { "client-shape": "path" },
    );

    ok(
      messagesFor(diagnostics, "name-collision").some((m) =>
        m.includes("indexer"),
      ),
    );
    deepStrictEqual(
      classNames(fileContent(results, "Endpoints/ItemRequestBuilders.g.cs")),
      ["ItemRequestBuilder", "ItemXRequestBuilder"],
    );
  });

  it("leaves out a builder whose class name another has, and a builder left with nothing", async () => {
    const [results, diagnostics] = await emitWithDiagnostics(
      `${PREAMBLE}
        @route("/a-b") interface Joined { @get read(): void; }
        @route("/a/b") interface Split { @get read(): void; }
      `,
      { "client-shape": "path" },
    );

    ok(
      messagesFor(diagnostics, "output-name-collision").some((m) =>
        m.includes("ABRequestBuilder"),
      ),
    );
    ok(has(results, "ABRequestBuilders.g.cs"));
    ok(!has(results, "Endpoints/ARequestBuilders.g.cs"));
    doesNotMatch(
      fileContent(results, "TestApiClientExtensions.g.cs"),
      / A\(\)/,
    );
  });

  it("reports the second of two methods with one name on a builder", async () => {
    const [results, diagnostics] = await emitWithDiagnostics(
      `${DECORATED}
        @route("/a") interface A {
          @sharedRoute @get @clientName("get") one(): void;
          @sharedRoute @get two(): void;
        }
      `,
      { "client-shape": "path" },
    );

    ok(
      messagesFor(diagnostics, "name-collision").some((m) =>
        m.includes("GetAsync"),
      ),
    );
    const a = classBody(
      fileContent(results, "Endpoints/ARequestBuilders.g.cs"),
      "ARequestBuilder",
    );
    strictEqual(a.match(/Task GetAsync\(/g)?.length, 1);
  });
});

describe("the interface client shape", () => {
  it("nests an interface under the interface whose route its own starts with", async () => {
    const results = await emit(COMMUNITY, { "client-shape": "interface" });
    const source = fileContent(
      results,
      "Endpoints/CommunityRequestBuilders.g.cs",
    );

    deepStrictEqual(classNames(source), [
      "CommunityItemRequestBuilder",
      "CommunityItemRewardsRequestBuilder",
    ]);
    ok(source.includes("/// The root configuration."), source);
    ok(
      classBody(source, "CommunityItemRequestBuilder").includes(
        "/// Starts a request to the <c>Rewards</c> endpoint group.\n    /// </summary>\n    /// <returns>A new builder that starts with what was added to this one; what is added to it afterwards applies only to the requests it sends.</returns>\n    public CommunityItemRewardsRequestBuilder Rewards() =>\n        new CommunityItemRewardsRequestBuilder(this.Client, this.Modifiers, this._communityKey);",
      ),
      source,
    );
    ok(
      source.includes(
        "/// Sends the requests of the <c>Rewards</c> endpoint group.\n/// </summary>\npublic sealed class CommunityItemRewardsRequestBuilder",
      ),
      source,
    );
    ok(!has(results, "RewardsRequestBuilders.g.cs"));
    ok(
      fileContent(results, "TestApiClientExtensions.g.cs").includes(
        "public CommunityItemRequestBuilder Community(string communityKey) =>\n        new CommunityItemRequestBuilder(this.FlurlClient, null, communityKey);",
      ),
    );
  });

  it("keeps an interface with no parent on the client, named as in flat", async () => {
    const results = await emit(
      `${PREAMBLE}
        @route("/pets") interface Pets {
          @get list(): string[];
          @get read(@path id: string): string;
        }
      `,
      { "client-shape": "interface" },
    );

    deepStrictEqual(
      classNames(fileContent(results, "Endpoints/PetsRequestBuilders.g.cs")),
      ["PetsRequestBuilder", "PetsItemRequestBuilder"],
    );
    const client = fileContent(results, "TestApiClientExtensions.g.cs");
    ok(client.includes("public PetsRequestBuilder Pets() =>"), client);
    ok(
      client.includes("public PetsItemRequestBuilder Pets(string id) =>"),
      client,
    );
  });

  it("holds the path parameters in route order, whatever order they are declared in", async () => {
    const source = fileContent(
      await emit(
        `${PREAMBLE}
          @route("/stores/{storeId}") interface Stores { @get read(@path storeId: string): void; }
          @route("/stores/{storeId}/pets/{petId}") interface Pets {
            @get read(@path petId: int32, @path storeId: string): void;
          }
        `,
        { "client-shape": "interface" },
      ),
      "Endpoints/StoresRequestBuilders.g.cs",
    );

    ok(
      source.includes(
        "public StoresItemPetsItemRequestBuilder Pets(int petId) =>\n        new StoresItemPetsItemRequestBuilder(this.Client, this.Modifiers, this._storeId, petId);",
      ),
      source,
    );
  });
});
