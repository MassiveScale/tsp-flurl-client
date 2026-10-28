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
});
