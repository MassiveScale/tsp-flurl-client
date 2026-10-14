import { ok, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import { emit, fileContent } from "./host.js";

const PREAMBLE = `
  import "@typespec/http";
  using Http;

  @service(#{ title: "Test API" })
  namespace TestApi;
`;

/** Emits a model with the given property declarations and returns its C# source. */
const modelWith = async (properties: string, extra = ""): Promise<string> => {
  const results = await emit(`${PREAMBLE}
    ${extra}
    model Thing { ${properties} }

    @route("/things") interface Things { @get read(): Thing; }
  `);
  return fileContent(results, "Thing.g.cs");
};

describe("literal types", () => {
  it("maps a literal to its underlying C# type", async () => {
    const thing = await modelWith(`
      s: "x";
      b: true;
      small: 5;
      negative: -7;
      big: 3000000000;
      fraction: 1.5;
    `);

    ok(thing.includes("public string S {"));
    ok(thing.includes("public bool B {"));
    ok(thing.includes("public int Small {"));
    ok(thing.includes("public int Negative {"));
    ok(thing.includes("public long Big {"));
    ok(thing.includes("public double Fraction {"));
  });

  it("initializes a required string literal like any other string", async () => {
    const thing = await modelWith(`s: "x";`);

    ok(thing.includes("public string S { get; init; } = default!;"));
  });
});

describe("unions", () => {
  it("maps T | null to a nullable T", async () => {
    const thing = await modelWith(
      `a: string | null; b: int32 | null; c: Owner | null;`,
      `model Owner { name: string; }`,
    );

    ok(thing.includes("public string? A { get; init; }\n"));
    ok(thing.includes("public int? B { get; init; }\n"));
    ok(thing.includes("public Owner? C { get; init; }\n"));
  });

  it("does not double the question mark on an optional nullable property", async () => {
    const thing = await modelWith(`a?: string | null; b?: int32 | null;`);

    ok(thing.includes("public string? A { get; init; }\n"));
    ok(thing.includes("public int? B { get; init; }\n"));
    ok(!thing.includes("??"));
  });

  it("maps a union of strings to string", async () => {
    const thing = await modelWith(
      `a: "x" | "y"; b: string | "z"; c: Color | Size; d: ("a" | "b") | "c";`,
      `enum Color { red } enum Size { small }`,
    );

    for (const name of ["A", "B", "C", "D"]) {
      ok(
        thing.includes(`public string ${name} { get; init; } = default!;`),
        `Expected ${name} to be a string`,
      );
    }
  });

  it("maps a union that is not all strings to JsonElement", async () => {
    const thing = await modelWith(
      `a: string | int32; b: Owner | Other; c: Owner | string; d: Count | string;`,
      `model Owner { name: string; } model Other { id: string; } enum Count { one: 1 }`,
    );

    for (const name of ["A", "B", "C", "D"]) {
      ok(
        thing.includes(`public JsonElement ${name} { get; init; }\n`),
        `Expected ${name} to be a JsonElement`,
      );
    }
  });

  it("maps a named union to JsonElement", async () => {
    const thing = await modelWith(
      `pet: Pet;`,
      `model Dog { bark: string; } model Cat { meow: string; } union Pet { dog: Dog, cat: Cat }`,
    );

    ok(thing.includes("public JsonElement Pet { get; init; }\n"));
  });

  it("needs no initializer for JsonElement or a nullable type", async () => {
    const thing = await modelWith(`a: string | int32; b: string | null;`);

    ok(thing.includes("public JsonElement A { get; init; }\n"));
    ok(thing.includes("public string? B { get; init; }\n"));
  });

  it("maps a union with a single non-null variant to that variant", async () => {
    const thing = await modelWith(
      `a: string | null; b: Owner[] | null;`,
      `model Owner { n: string; }`,
    );

    ok(thing.includes("public string? A"));
    ok(thing.includes("public List<Owner>? B"));
  });

  it("maps a property whose only value is null to object?, written even when null", async () => {
    const thing = await modelWith(`a: null;`);

    ok(thing.includes("public object? A"));
    ok(thing.includes("[JsonIgnore(Condition = JsonIgnoreCondition.Never)]"));
  });

  it("adds the using that JsonElement needs", async () => {
    const thing = await modelWith(`a: string | int32;`);

    ok(thing.includes("using System.Text.Json;"));
  });
});

describe("unions in operations", () => {
  it("reads a response that is a union of models as JsonElement", async () => {
    const results = await emit(`${PREAMBLE}
      model Item { id: string; }
      model Other { name: string; }

      @route("/items") interface Items { @get read(): Item | Other; }
    `);

    const iface = fileContent(results, "IItems.g.cs");
    ok(iface.includes("Task<JsonElement> ReadAsync("));
    ok(iface.includes("using System.Text.Json;"));
    ok(!iface.includes("<TResult>"), "A union has no model to substitute");
    ok(
      fileContent(results, "ItemsEndpoint.g.cs").includes(
        "GetJsonAsync<JsonElement>()",
      ),
    );
  });

  it("types a union parameter without doubling its question mark", async () => {
    const results = await emit(`${PREAMBLE}
      @route("/items")
      interface Items {
        @get read(@query a?: string | int32, @query b?: string | null, @query c: string | null): string;
      }
    `);

    const iface = fileContent(results, "IItems.g.cs");
    ok(iface.includes("string? c,"));
    ok(iface.includes("JsonElement? a = null"));
    ok(iface.includes("string? b = null"));
    ok(!iface.includes("??"));
  });

  it("sends a union body as JSON", async () => {
    const results = await emit(`${PREAMBLE}
      model Item { id: string; }
      model Other { name: string; }

      @route("/items") interface Items { @post create(@body body: Item | Other): void; }
    `);

    ok(
      fileContent(results, "IItems.g.cs").includes(
        "CreateAsync(JsonElement body,",
      ),
    );
    ok(
      fileContent(results, "ItemsEndpoint.g.cs").includes(
        "SendJsonAsync(HttpMethod.Post, body,",
      ),
    );
  });
});

describe("which models and enums are emitted", () => {
  it("emits models in the service namespace and its children, not in others", async () => {
    const results = await emit(`
      import "@typespec/http";
      using Http;

      namespace Elsewhere { model Foreign { a: string; } enum ForeignColor { red } }

      @service(#{ title: "Test API" })
      namespace TestApi {
        namespace Sub { model Nested { a: string; } enum NestedColor { red } }

        model Local { f: Elsewhere.Foreign; n: Sub.Nested; c: Elsewhere.ForeignColor; s: Sub.NestedColor; }

        @route("/things") interface Things { @get read(): Local; }
      }
    `);

    const names = Object.keys(results).map((k) => k.split("/").pop());
    ok(names.includes("Local.g.cs"));
    ok(names.includes("Nested.g.cs"), "A child namespace's model is emitted");
    ok(
      names.includes("NestedColor.g.cs"),
      "A child namespace's enum is emitted",
    );
    ok(
      !names.includes("Foreign.g.cs"),
      "Another namespace's model is not emitted",
    );
    ok(
      !names.includes("ForeignColor.g.cs"),
      "Another namespace's enum is not emitted",
    );
  });

  it("emits a model declared in the global namespace", async () => {
    const results = await emit(`
      import "@typespec/http";
      using Http;

      model Global { a: string; }

      @service(#{ title: "Test API" })
      namespace TestApi {
        @route("/things") interface Things { @get read(): Global; }
      }
    `);

    strictEqual(
      Object.keys(results).some((k) => k.endsWith("Global.g.cs")),
      true,
    );
  });
});

describe("@format on a property or parameter", () => {
  it("maps a formatted string property like a formatted scalar", async () => {
    const thing = await modelWith(`
      @format("uuid") id: string;
      @format("uri") home: string;
      @format("url") link: string;
      @format("uuid") optionalId?: string;
      plain: string;
    `);

    ok(thing.includes("public Guid Id { get; init; }\n"));
    ok(thing.includes("public Uri Home { get; init; } = default!;"));
    ok(thing.includes("public Uri Link { get; init; } = default!;"));
    ok(thing.includes("public Guid? OptionalId { get; init; }\n"));
    ok(thing.includes("public string Plain { get; init; } = default!;"));
  });

  it("ignores a format it does not know", async () => {
    const thing = await modelWith(`@format("email") a: string;`);

    ok(thing.includes("public string A {"));
  });

  it("applies to an operation parameter", async () => {
    const results = await emit(`${PREAMBLE}
      @route("/items/{id}")
      interface Items {
        @get read(@path @format("uuid") id: string, @query @format("uri") home?: string): string;
      }
    `);

    ok(
      fileContent(results, "IItems.g.cs").includes("Guid id, Uri? home = null"),
    );
  });

  it("still honours a format on the scalar itself", async () => {
    const thing = await modelWith(
      `id: Uuid;`,
      `@format("uuid") scalar Uuid extends string;`,
    );

    ok(thing.includes("public Guid Id {"));
  });
});
