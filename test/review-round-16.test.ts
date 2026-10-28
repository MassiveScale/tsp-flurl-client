import { ok, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import { emit, fileContent } from "./host.js";

const PREAMBLE = `
  import "@typespec/http";
  using Http;

  @service(#{ title: "Test API" })
  namespace TestApi;
`;

describe("request builder constructor parameters", () => {
  it("gives the Flurl client another name when a path parameter is called flurlClient", async () => {
    const results = await emit(`${PREAMBLE}
      @route("/a") interface Items { @get read(@path flurlClient: string): void; }
    `);

    const builders = fileContent(results, "ItemsRequestBuilders.g.cs");
    ok(
      builders.includes(
        "internal ItemsItemRequestBuilder(IFlurlClient flurlClient2, string flurlClient)",
      ),
      builders,
    );
    ok(builders.includes(": base(flurlClient2)"), builders);
    ok(builders.includes("this._flurlClient = flurlClient;"), builders);
  });

  it("documents an escaped path parameter by its unescaped name", async () => {
    const results = await emit(`${PREAMBLE}
      @route("/a") interface Items { @get read(@path params: string): void; }
    `);

    const extensions = fileContent(results, "TestApiClientExtensions.g.cs");
    ok(extensions.includes("Items(string @params)"), extensions);
    ok(extensions.includes('<param name="params">'), extensions);
    ok(!extensions.includes('<param name="@params">'), extensions);
  });
});

describe("the aggregate client file", () => {
  it("declares a lower-case client name verbatim (CS8981)", async () => {
    const results = await emit(
      `${PREAMBLE} @route("/a") interface Items { @get read(): void; }`,
      { "client-name": "petstore" },
    );

    const extensions = fileContent(results, "petstoreExtensions.g.cs");
    ok(extensions.includes("public class @petstore"), extensions);
  });

  it("applies additional-usings like every other file", async () => {
    const results = await emit(
      `${PREAMBLE} @route("/a") interface Items { @get read(): void; }`,
      { "additional-usings": ["Acme.Shared"] },
    );

    ok(
      fileContent(results, "TestApiClientExtensions.g.cs").includes(
        "using Acme.Shared;",
      ),
    );
  });
});

describe("enum members that share a wire value", () => {
  for (const [kind, members, arm] of [
    ["string", `first: "x", second: "x", third: "y"`, `"x" =>`],
    ["number", `first: 1, second: 1, third: 2`, `1L =>`],
  ]) {
    it(`reads a shared ${kind} value as the first member, and writes each`, async () => {
      const results = await emit(`${PREAMBLE}
        enum Shared { ${members} }
        @route("/s") interface Things { @get read(@query v: Shared): Shared; }
      `);

      const source = fileContent(results, "/Shared.g.cs");
      strictEqual(source.split(arm).length - 1, 1, source);
      ok(source.includes(`${arm} Shared.First`), source);
      ok(source.includes("case Shared.Second:"), source);
      ok(source.includes("Second,"), source);
    });
  }
});

describe("dictionary request bodies", () => {
  const SPEC = `${PREAMBLE}
    model Widget { @visibility(Lifecycle.Read) id: string; name: string; }
  `;

  it("add overloads generic in the items, which a dictionary of a derived type matches", async () => {
    const results = await emit(`${SPEC}
      @route("/w") interface Widgets { @post create(@body body: Record<Widget>): Record<Widget>; }
    `);

    const iface = fileContent(results, "WidgetsRequestBuilders.g.cs");
    for (const signature of [
      "CreateAsync(IReadOnlyDictionary<string, WidgetCreateRequest> body,",
      "CreateAsync<TResult>(IReadOnlyDictionary<string, WidgetCreateRequest> body,",
      "CreateAsync<TBody>(IReadOnlyDictionary<string, TBody> body,",
      "CreateAsync<TResult, TBody>(IReadOnlyDictionary<string, TBody> body,",
    ]) {
      ok(iface.includes(signature), signature);
    }
    ok(iface.includes("where TBody : WidgetCreateRequest"), iface);
    ok(iface.includes('<typeparam name="TBody">'), iface);

    const client = fileContent(results, "WidgetsRequestBuilders.g.cs");
    strictEqual((client.match(/public async /g) ?? []).length, 1, client);
    ok(
      client.includes("CreateAsync<Widget, WidgetCreateRequest>(body,"),
      client,
    );
  });

  it("look through lists and nullables to the dictionary", async () => {
    const results = await emit(`${SPEC}
      @route("/w") interface Widgets { @post create(@body body: Record<Widget>[] | null): void; }
    `);

    ok(
      fileContent(results, "WidgetsRequestBuilders.g.cs").includes(
        "CreateAsync<TBody>(IEnumerable<IReadOnlyDictionary<string, TBody>>? body,",
      ),
    );
  });

  it("leave out the items-only overload of an optional body that would be ambiguous", async () => {
    const results = await emit(`${SPEC}
      @route("/w") interface Widgets { @post create(@body body?: Record<Widget>): Widget; }
    `);

    const iface = fileContent(results, "WidgetsRequestBuilders.g.cs");
    ok(!iface.includes("CreateAsync<TBody>("), iface);
    ok(iface.includes("CreateAsync<TResult, TBody>("), iface);
  });

  it("are not added for a list, which is already covariant", async () => {
    const results = await emit(`${SPEC}
      @route("/w") interface Widgets { @post create(@body body: Widget[]): void; }
    `);

    ok(!fileContent(results, "WidgetsRequestBuilders.g.cs").includes("TBody"));
  });
});
