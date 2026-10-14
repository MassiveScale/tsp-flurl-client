import { ok, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import { buildExtensions } from "../src/client.js";
import { createRenderer } from "../src/renderer.js";
import { emit, fileContent } from "./host.js";

const PREAMBLE = `
  import "@typespec/http";
  using Http;

  @service(#{ title: "Test API" })
  namespace TestApi;
`;

/** The constructor parameter list of the aggregate client. */
const constructorParameters = (extensions: string): string =>
  /public TestApiClient\(([^)]*)\)/.exec(extensions)?.[1] ??
  /internal TestApiClient\(([^)]*)\)/.exec(extensions)?.[1] ??
  "";

describe("aggregate client constructor parameters", () => {
  it("gives an endpoint that would become flurlClient another parameter name", async () => {
    const results = await emit(`${PREAMBLE}
      @route("/a") interface flurlClient { @get read(): void; }
    `);

    const parameters = constructorParameters(
      fileContent(results, "TestApiClientExtensions.g.cs"),
    );
    ok(parameters.includes("IFlurlClient flurlClient"), parameters);
    ok(parameters.includes("IflurlClient flurlClientEndpoint"), parameters);
    // The property `flurlClient` is set through `this`, since the parameter of the
    // same name would otherwise be the one assigned.
    ok(
      fileContent(results, "TestApiClientExtensions.g.cs").includes(
        "this.flurlClient = flurlClientEndpoint",
      ),
    );
  });

  it("gives endpoints whose names differ only in their first letter different parameter names", () => {
    // Two such interfaces are reported as a file-name clash by the emitter, so the
    // builder is called directly.
    const parameters = constructorParameters(
      buildExtensions(
        "TestApiClient",
        "TestApi",
        [
          {
            interfaceName: "IItems",
            clientName: "ItemsEndpoint",
            access: "public",
          },
          {
            interfaceName: "Iitems",
            clientName: "itemsEndpoint",
            access: "public",
          },
        ],
        createRenderer(),
      ),
    );
    ok(parameters.includes("IItems items"), parameters);
    ok(parameters.includes("Iitems itemsEndpoint"), parameters);
  });

  it("documents an escaped parameter by its unescaped name", async () => {
    const results = await emit(`${PREAMBLE}
      @route("/a") interface Params { @get read(): void; }
    `);

    const extensions = fileContent(results, "TestApiClientExtensions.g.cs");
    ok(extensions.includes("IParams @params"), extensions);
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

    const iface = fileContent(results, "IWidgets.g.cs");
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

    const client = fileContent(results, "WidgetsEndpoint.g.cs");
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
      fileContent(results, "IWidgets.g.cs").includes(
        "CreateAsync<TBody>(IEnumerable<IReadOnlyDictionary<string, TBody>>? body,",
      ),
    );
  });

  it("leave out the items-only overload of an optional body that would be ambiguous", async () => {
    const results = await emit(`${SPEC}
      @route("/w") interface Widgets { @post create(@body body?: Record<Widget>): Widget; }
    `);

    const iface = fileContent(results, "IWidgets.g.cs");
    ok(!iface.includes("CreateAsync<TBody>("), iface);
    ok(iface.includes("CreateAsync<TResult, TBody>("), iface);
  });

  it("are not added for a list, which is already covariant", async () => {
    const results = await emit(`${SPEC}
      @route("/w") interface Widgets { @post create(@body body: Widget[]): void; }
    `);

    ok(!fileContent(results, "IWidgets.g.cs").includes("TBody"));
  });
});
