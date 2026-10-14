import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ok, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import { emit, emitWithDiagnostics, fileContent } from "./host.js";

const PREAMBLE = `
  import "@typespec/http";
  import "@massivescale/tsp-flurl-client";
  using Http;
  using MassiveScale.TspFlurlClient;

  @service(#{ title: "Test API" })
  namespace TestApi;
`;

const messagesFor = (
  diagnostics: readonly { code: string; message: string }[],
  suffix: string,
): string[] =>
  diagnostics.filter((d) => d.code.endsWith(suffix)).map((d) => d.message);

const has = (results: Record<string, string>, suffix: string): boolean =>
  Object.keys(results).some((k) => k.endsWith(suffix));

/** The `[JsonPropertyName]` values a generated record writes. */
const jsonNames = (record: string): string[] =>
  [...record.matchAll(/\[JsonPropertyName\("([^"]*)"\)\]/g)].map((m) => m[1]);

describe("JSON property names that collide", () => {
  const collide = async (models: string) => {
    const [results, diagnostics] = await emitWithDiagnostics(`${PREAMBLE}
      ${models}
      @route("/t") interface Things { @get read(): Thing; }
    `);
    return {
      results,
      messages: messagesFor(diagnostics, "name-collision"),
    };
  };

  // TypeSpec itself rejects two properties of one model with exactly the same
  // encoded name (encoded-name-conflict). These are the collisions it lets through.
  it("reports a name that differs from another only in case, which the client reads as the same, and leaves it out", async () => {
    const { results, messages } = await collide(
      `model Thing { x: string; @encodedName("application/json", "X") y: string; }`,
    );

    strictEqual(messages.length, 1, messages.join("; "));
    ok(messages[0].includes('JSON property name "X"'), messages[0]);
    ok(messages[0].includes('"x"'), messages[0]);
    ok(messages[0].includes('"y"'), messages[0]);
    ok(messages[0].includes("@encodedName"), messages[0]);
    const record = fileContent(results, "/Thing.g.cs");
    ok(record.includes("public string X"));
    ok(!record.includes("public string Y"));
    strictEqual(
      jsonNames(record).filter((n) => n.toLowerCase() === "x").length,
      1,
    );
  });

  it("reports property names that differ only in case", async () => {
    const { messages } = await collide(
      `model Thing { foo: string; @clientName("bar") Foo: string; }`,
    );

    strictEqual(messages.length, 1, messages.join("; "));
    ok(messages[0].includes('"Foo"'), messages[0]);
  });

  it("reports a property that collides with one inherited from a plain base", async () => {
    const { messages } = await collide(`
      model Base { name: string; }
      model Thing extends Base { @encodedName("application/json", "name") label: string; }
    `);

    strictEqual(messages.length, 1, messages.join("; "));
    ok(messages[0].includes('"label"'), messages[0]);
  });

  it("reports a property that collides with an inherited property", async () => {
    const { results, messages } = await collide(`
      @discriminator("kind") model Base { kind: string; name: string; }
      model Thing extends Base { kind: "thing"; @encodedName("application/json", "name") label: string; }
    `);

    strictEqual(messages.length, 1, messages.join("; "));
    ok(messages[0].includes('the inherited property "name"'), messages[0]);
    ok(!fileContent(results, "/Thing.g.cs").includes("Label"));
  });

  it("reports a property of a derived model that collides with the discriminator", async () => {
    const { messages } = await collide(`
      @discriminator("kind") model Base { kind: string; }
      model Thing extends Base { kind: "thing"; @encodedName("application/json", "KIND") other: string; }
    `);

    strictEqual(messages.length, 1, messages.join("; "));
    ok(messages[0].includes('the discriminator "kind"'), messages[0]);
  });

  it("reports a property of the discriminated root that collides with its discriminator", async () => {
    const { messages } = await collide(`
      @discriminator("kind") model Thing { kind: string; @encodedName("application/json", "Kind") other: string; }
      model Sub extends Thing { kind: "sub"; }
    `);

    strictEqual(messages.length, 1, messages.join("; "));
    ok(messages[0].includes('the discriminator "kind"'), messages[0]);
  });

  it("uses the discriminator's encoded name", async () => {
    const { messages } = await collide(`
      @discriminator("kind") model Base { @encodedName("application/json", "$type") kind: string; }
      model Thing extends Base { kind: "thing"; other: string; @encodedName("application/json", "$type") clash: string; }
    `);

    strictEqual(messages.length, 1, messages.join("; "));
    ok(messages[0].includes('"$type"'), messages[0]);
  });

  it("accepts a property renamed for C# but not on the wire, alongside a distinct name", async () => {
    const { messages } = await collide(`
      model Thing { x: string; @encodedName("application/json", "y") z: string; }
    `);

    strictEqual(messages.length, 0, messages.join("; "));
  });

  it("applies to request records too", async () => {
    const [, diagnostics] = await emitWithDiagnostics(`${PREAMBLE}
      model Thing {
        @visibility(Lifecycle.Read) id: string;
        x: string;
        @encodedName("application/json", "X") y: string;
      }
      @route("/t") interface Things { @post create(@body body: Thing): void; }
    `);

    ok(
      messagesFor(diagnostics, "name-collision").some((m) =>
        m.includes("record ThingCreateRequest"),
      ),
    );
  });
});

describe("nullable request bodies", () => {
  const MODELS = `
    model Item { @visibility(Lifecycle.Read) id: string; name: string; }
  `;

  it("sends a request record for Item | null, and keeps it nullable", async () => {
    const results = await emit(`${PREAMBLE}
      ${MODELS}
      @route("/i") interface Items { @post create(@body body: Item | null): void; }
    `);

    const iface = fileContent(results, "IItems.g.cs");
    ok(iface.includes("CreateAsync(ItemCreateRequest? body,"), iface);
    ok(!fileContent(results, "ItemCreateRequest.g.cs").includes(" Id "));
  });

  it("keeps nullable elements of a list body", async () => {
    const results = await emit(`${PREAMBLE}
      ${MODELS}
      @route("/i") interface Items { @post create(@body body: (Item | null)[]): void; }
    `);

    ok(
      fileContent(results, "IItems.g.cs").includes(
        "CreateAsync(IEnumerable<ItemCreateRequest?> body,",
      ),
    );
  });

  it("sends a request record for an optional nullable body", async () => {
    const results = await emit(`${PREAMBLE}
      ${MODELS}
      @route("/i") interface Items { @post create(@body body?: Item | null): void; }
    `);

    ok(
      fileContent(results, "IItems.g.cs").includes(
        "ItemCreateRequest? body = null",
      ),
    );
  });
});

describe("request records for nested models", () => {
  const create = (models: string, body = "Wrapper") =>
    emit(`${PREAMBLE}
      ${models}
      @route("/w") interface Wrappers { @post create(@body body: ${body}): void; }
    `);

  it("filters a nested model with a read-only property", async () => {
    const results = await create(`
      model Child { @visibility(Lifecycle.Read) id: string; name: string; }
      model Wrapper { child: Child; }
    `);

    ok(
      fileContent(results, "IWrappers.g.cs").includes(
        "CreateAsync(WrapperCreateRequest body,",
      ),
    );
    ok(
      fileContent(results, "WrapperCreateRequest.g.cs").includes(
        "public ChildCreateRequest Child",
      ),
    );
    const child = fileContent(results, "ChildCreateRequest.g.cs");
    ok(!child.includes(" Id "), child);
    ok(child.includes("public string Name"), child);
  });

  it("filters through lists, dictionaries, nullables and several levels", async () => {
    const results = await create(`
      model Leaf { @visibility(Lifecycle.Read) id: string; value: string; }
      model Middle { leaves: Leaf[]; byName: Record<Leaf>; maybe: Leaf | null; }
      model Wrapper { middle: Middle; }
    `);

    const middle = fileContent(results, "MiddleCreateRequest.g.cs");
    ok(middle.includes("List<LeafCreateRequest> Leaves"), middle);
    ok(middle.includes("Dictionary<string, LeafCreateRequest> ByName"), middle);
    ok(middle.includes("LeafCreateRequest? Maybe"), middle);
    ok(
      fileContent(results, "WrapperCreateRequest.g.cs").includes(
        "MiddleCreateRequest Middle",
      ),
    );
    ok(!fileContent(results, "LeafCreateRequest.g.cs").includes(" Id "));
  });

  it("filters a recursive model", async () => {
    const results = await create(
      `model Node { @visibility(Lifecycle.Read) id: string; children: Node[]; }`,
      "Node",
    );

    const node = fileContent(results, "NodeCreateRequest.g.cs");
    ok(node.includes("List<NodeCreateRequest> Children"), node);
    ok(!node.includes(" Id "), node);
  });

  it("leaves a nested model with nothing hidden as it is", async () => {
    const results = await create(`
      model Plain { name: string; }
      model Wrapper { @visibility(Lifecycle.Read) id: string; plain: Plain; }
    `);

    ok(
      fileContent(results, "WrapperCreateRequest.g.cs").includes(
        "public Plain Plain",
      ),
    );
    ok(!has(results, "PlainCreateRequest.g.cs"));
  });

  it("sends the model as it is when nothing is hidden at any depth", async () => {
    const results = await create(`
      model Child { name: string; }
      model Wrapper { child: Child; }
    `);

    ok(
      fileContent(results, "IWrappers.g.cs").includes(
        "CreateAsync(Wrapper body,",
      ),
    );
    ok(!has(results, "CreateRequest.g.cs"));
  });

  it("filters a nested discriminated hierarchy as a whole", async () => {
    const results = await create(`
      @discriminator("kind") model Pet { kind: string; name: string; }
      model Dog extends Pet { kind: "dog"; @visibility(Lifecycle.Read) id: string; }
      model Cat extends Pet { kind: "cat"; lives: int32; }
      model Wrapper { pet: Pet; }
    `);

    ok(
      fileContent(results, "WrapperCreateRequest.g.cs").includes(
        "public PetCreateRequest Pet",
      ),
    );
    const pet = fileContent(results, "PetCreateRequest.g.cs");
    ok(pet.includes("typeof(DogCreateRequest)"), pet);
    ok(pet.includes("typeof(CatCreateRequest)"), pet);
    const dog = fileContent(results, "DogCreateRequest.g.cs");
    ok(dog.includes(": PetCreateRequest"), dog);
    ok(!dog.includes(" Id "), dog);
    ok(
      fileContent(results, "CatCreateRequest.g.cs").includes(
        ": PetCreateRequest",
      ),
    );
  });

  it("does not look inside a union of models, which is held as a JsonElement", async () => {
    const results = await create(`
      model Child { @visibility(Lifecycle.Read) id: string; }
      model Other { name: string; }
      model Wrapper { either: Child | Other; }
    `);

    ok(
      fileContent(results, "IWrappers.g.cs").includes(
        "CreateAsync(Wrapper body,",
      ),
    );
    ok(!has(results, "ChildCreateRequest.g.cs"));
  });

  it("does not share a record whose nested models are filtered differently", async () => {
    const results = await emit(`${PREAMBLE}
      model Child { @visibility(Lifecycle.Create) secret?: string; name: string; }
      model Wrapper { @visibility(Lifecycle.Read) id: string; child: Child; }
      @route("/a") interface First { @post create(@body body: Wrapper): void; }
      @route("/b") interface Second {
        @parameterVisibility(Lifecycle.Update) @post create(@body body: Wrapper): void;
      }
    `);

    ok(
      fileContent(results, "WrapperCreateRequest.g.cs").includes(
        "public Child Child",
      ),
    );
    const second = fileContent(results, "ISecond.g.cs");
    const name = /CreateAsync\((\w+) body,/.exec(second)?.[1];
    ok(name && name !== "WrapperCreateRequest", second);
    const wrapper = fileContent(results, `/${name}.g.cs`);
    const childType = /public (\w+) Child/.exec(wrapper)?.[1];
    ok(childType && childType !== "Child", wrapper);
    ok(!fileContent(results, `/${childType}.g.cs`).includes("Secret"));
  });

  it("shares a nested model's record with an operation that sends the model directly", async () => {
    const results = await emit(`${PREAMBLE}
      model Child { @visibility(Lifecycle.Read) id: string; name: string; }
      model Wrapper { @visibility(Lifecycle.Read) id: string; child: Child; }
      @route("/c") interface Children { @post create(@body body: Child): void; }
      @route("/w") interface Wrappers { @post create(@body body: Wrapper): void; }
    `);

    ok(
      fileContent(results, "IWrappers.g.cs").includes(
        "CreateAsync(WrapperCreateRequest body,",
      ),
    );
    ok(
      fileContent(results, "WrapperCreateRequest.g.cs").includes(
        "public ChildCreateRequest Child",
      ),
    );
    strictEqual(
      Object.keys(results).filter((k) => k.endsWith("Request.g.cs")).length,
      2,
      Object.keys(results).join(", "),
    );
  });

  it("reports two nested models that would share a request record name", async () => {
    const [, diagnostics] = await emitWithDiagnostics(`${PREAMBLE}
      namespace A { model Child { @visibility(Lifecycle.Read) id: string; } }
      namespace B { model Child { @visibility(Lifecycle.Read) id: string; } }
      model Wrapper { a: A.Child; b: B.Child; }
      @route("/w") interface Wrappers { @post create(@body body: Wrapper): void; }
    `);

    ok(
      messagesFor(diagnostics, "name-collision").some((m) =>
        m.includes("request record"),
      ),
    );
  });
});

describe("nullable response bodies", () => {
  for (const [body, plain, generic] of [
    ["Item | null", "Task<Item?>", "Task<TResult?> ReadAsync<TResult>("],
    [
      "Item[] | null",
      "Task<List<Item>?>",
      "Task<List<TResult>?> ReadAsync<TResult>(",
    ],
    [
      "(Item | null)[]",
      "Task<List<Item?>>",
      "Task<List<TResult?>> ReadAsync<TResult>(",
    ],
  ]) {
    it(`offers the generic overload for ${body}, and keeps it nullable`, async () => {
      const results = await emit(`${PREAMBLE}
        model Item { name: string; }
        @route("/i") interface Items { @get read(): { @body body: ${body} }; }
      `);

      const iface = fileContent(results, "IItems.g.cs");
      ok(iface.includes(`${plain} ReadAsync(`), iface);
      ok(iface.includes(generic), iface);
      ok(!iface.includes("??"), iface);
    });
  }

  it("follows TypeSpec in reading a returned Item | null as an Item", async () => {
    // @typespec/http drops null from a returned union, so the response is a plain Item.
    const results = await emit(`${PREAMBLE}
      model Item { name: string; }
      @route("/i") interface Items { @get read(): Item | null; }
    `);

    ok(
      fileContent(results, "IItems.g.cs").includes(
        "Task<TResult> ReadAsync<TResult>(",
      ),
    );
  });
});

describe("XML documentation warnings", () => {
  it("leaves CS1591 on, so a project that wants documented members still gets the warning", async () => {
    const results = await emit(`${PREAMBLE}
      model Item { name: string; }
      @route("/i") interface Items { @get read(): Item; }
    `);

    for (const [path, content] of Object.entries(results)) {
      if (path.endsWith(".cs")) ok(!content.includes("CS1591"), path);
    }
  });
});

describe("enum parameters", () => {
  it("rejects a value that is not a declared member instead of sending its number", async () => {
    const results = await emit(`${PREAMBLE}
      enum Color { red, blue }
      @route("/i") interface Items { @get list(@query color?: Color): void; }
    `);

    const runtime = fileContent(results, "ClientRuntime.g.cs");
    ok(
      /GetField\(name, BindingFlags\.Public \| BindingFlags\.Static\)\s*\?\? throw new ArgumentException/.test(
        runtime,
      ),
      runtime,
    );
  });
});

describe("parameters named after contextual keywords", () => {
  it("escapes await, which the generated async methods reserve", async () => {
    const results = await emit(`${PREAMBLE}
      @route("/k") interface Keywords {
        @route("{await}") @get read(@path await: string, @query var?: string): void;
      }
    `);

    const iface = fileContent(results, "IKeywords.g.cs");
    ok(iface.includes("ReadAsync(string @await, string? var = null,"), iface);
    const client = fileContent(results, "KeywordsEndpoint.g.cs");
    ok(client.includes("EscapePathSegment(@await)"), client);
    ok(!/[^@\w]await\)/.test(client), client);
  });

  it("still accepts await as a model name, which C# allows", async () => {
    const [, diagnostics] = await emitWithDiagnostics(`${PREAMBLE}
      model \`await\` { name: string; }
      @route("/k") interface Keywords { @get read(): \`await\`; }
    `);

    strictEqual(messagesFor(diagnostics, "invalid-name").length, 0);
  });
});

describe("success responses of one type in different media types", () => {
  const response = (status: number, contentType: string, body: string) =>
    `{ @statusCode _: ${status}; @header contentType: "${contentType}"; @body body: ${body} }`;

  const compile = (responses: string) =>
    emitWithDiagnostics(`${PREAMBLE}
      @route("/r") interface Things {
        @get read(): ${responses};
        @route("ok") @get ok(): string;
      }
    `);

  for (const [name, responses] of [
    [
      "JSON bytes beside raw octets",
      `${response(200, "application/json", "bytes")} | ${response(201, "application/octet-stream", "bytes")}`,
    ],
    [
      "base64 text beside raw octets",
      `{ @statusCode _: 200; @header contentType: "text/plain"; @body @encode("base64") body: bytes } | ${response(201, "application/octet-stream", "bytes")}`,
    ],
  ]) {
    it(`leaves out an operation with ${name}`, async () => {
      const [results, diagnostics] = await compile(responses);

      ok(
        messagesFor(diagnostics, "unsupported-feature").some((m) =>
          m.includes("travel in ways one method cannot read"),
        ),
        diagnostics.map((d) => d.message).join("; "),
      );
      const iface = fileContent(results, "IThings.g.cs");
      ok(!iface.includes("ReadAsync"), iface);
      ok(iface.includes("OkAsync"), iface);
    });
  }

  it("still reads JSON and text of one value by the Content-Type that arrives", async () => {
    const [results, diagnostics] = await compile(
      `${response(200, "application/json", "string")} | ${response(201, "text/plain", "string")}`,
    );

    strictEqual(
      messagesFor(diagnostics, "unsupported-feature").length,
      0,
      diagnostics.map((d) => d.message).join("; "),
    );
    ok(
      fileContent(results, "IThings.g.cs").includes("Task<string> ReadAsync("),
    );
  });

  it("still reads raw octets from two statuses", async () => {
    const [results, diagnostics] = await compile(
      `${response(200, "application/octet-stream", "bytes")} | ${response(201, "application/octet-stream", "bytes")}`,
    );

    strictEqual(messagesFor(diagnostics, "unsupported-feature").length, 0);
    ok(
      fileContent(results, "IThings.g.cs").includes("Task<byte[]> ReadAsync("),
    );
  });
});

describe("template comments", () => {
  it("use plain headings rather than decorative dividers", () => {
    const templates = resolve(
      fileURLToPath(import.meta.url),
      "../../../src/templates",
    );
    for (const file of readdirSync(templates)) {
      const content = readFileSync(resolve(templates, file), "utf-8");
      ok(!content.includes("──"), file);
    }
  });
});

describe("dependency injection", () => {
  it("explains why the Flurl client it creates is not disposed", async () => {
    const results = await emit(`${PREAMBLE}
      model Item { name: string; }
      @route("/i") interface Items { @get read(): Item; }
    `);

    const extensions = fileContent(results, "Extensions.g.cs");
    ok(extensions.includes("IHttpClientFactory"), extensions);
    ok(/dispos/i.test(extensions), extensions);
  });
});

describe("template parameter names", () => {
  it("escapes a keyword as a verbatim identifier in the declaration and every use", async () => {
    const results = await emit(`${PREAMBLE}
      model Item { name: string; }
      model Page<class> { items: class[]; first: class; }
      @route("/p") interface Pages { @get read(): Page<Item>; }
    `);

    const page = fileContent(results, "/Page.g.cs");
    ok(page.includes("record Page<@class>"), page);
    ok(page.includes("List<@class> Items"), page);
    ok(page.includes("@class First"), page);
    ok(fileContent(results, "IPages.g.cs").includes("Task<Page<Item>>"));
  });

  it("replaces the characters of a quoted name that is not an identifier", async () => {
    const results = await emit(`${PREAMBLE}
      model Box<\`my-T\`> { value: \`my-T\`; }
      @route("/b") interface Boxes { @get read(): Box<string>; }
    `);

    const box = fileContent(results, "/Box.g.cs");
    ok(box.includes("record Box<my_T>"), box);
    ok(box.includes("my_T Value"), box);
  });

  it("reports a property that would share a type parameter's name", async () => {
    const [, diagnostics] = await emitWithDiagnostics(`${PREAMBLE}
      model Bag<Items> { items: Items[]; }
      @route("/b") interface Bags { @get read(): Bag<string>; }
    `);

    ok(
      messagesFor(diagnostics, "name-collision").some((m) =>
        m.includes('the type parameter "Items"'),
      ),
      diagnostics.map((d) => d.message).join("; "),
    );
  });

  it("reports a type parameter that would share its record's name", async () => {
    const [, diagnostics] = await emitWithDiagnostics(`${PREAMBLE}
      model Wrap<Wrap> { value: Wrap; }
      @route("/w") interface Wraps { @get read(): Wrap<string>; }
    `);

    ok(
      messagesFor(diagnostics, "name-collision").some((m) =>
        m.includes("type parameter"),
      ),
      diagnostics.map((d) => d.message).join("; "),
    );
  });

  it("keeps a literal argument to a parameter no property uses", async () => {
    const results = await emit(`${PREAMBLE}
      model Item { name: string; }
      model Tagged<T, U> { value: T; }
      @route("/t") interface Tags { @get read(): Tagged<Item, "x">; }
    `);

    ok(
      fileContent(results, "ITags.g.cs").includes("Task<Tagged<Item, string>>"),
    );
  });
});

describe("value template parameters", () => {
  const SIZED = `model Sized<N extends valueof int32> { x: string; }`;

  for (const [where, signature] of [
    ["a response", `@get read(): Sized<3>;`],
    ["a request body", `@post send(@body body: Sized<3>): void;`],
    ["a nested property", `@get nested(): { inner: Sized<3> };`],
    [
      "a union held as a JsonElement",
      `@get either(): { @body body: Sized<3> | Other };`,
    ],
  ]) {
    it(`leaves out an operation that reaches one through ${where}`, async () => {
      const [results, diagnostics] = await emitWithDiagnostics(`${PREAMBLE}
        ${SIZED}
        model Other { id: string; }
        @route("/s") interface Things {
          ${signature}
          @route("ok") @get ok(): string;
        }
      `);

      ok(
        messagesFor(diagnostics, "unsupported-value-template").some((m) =>
          m.includes('"N"'),
        ),
        diagnostics.map((d) => d.message).join("; "),
      );
      const iface = fileContent(results, "IThings.g.cs");
      strictEqual((iface.match(/Task.*Async\(/g) ?? []).length, 1, iface);
      ok(!has(results, "/Sized.g.cs"));
    });
  }

  it("accepts a type for a parameter that takes a type or a value", async () => {
    const [results, diagnostics] = await emitWithDiagnostics(`${PREAMBLE}
      model Mixed<T extends string | valueof string> { x: string; }
      @route("/m") interface Things { @get read(): Mixed<string>; }
    `);

    strictEqual(
      messagesFor(diagnostics, "unsupported-value-template").length,
      0,
    );
    ok(fileContent(results, "/Mixed.g.cs").includes("record Mixed<T>"));
  });

  it("reports a literal for a parameter that takes a type or a value", async () => {
    const [, diagnostics] = await emitWithDiagnostics(`${PREAMBLE}
      model Mixed<T extends string | valueof string> { x: string; }
      @route("/m") interface Things { @get read(): Mixed<"lit">; }
    `);

    ok(messagesFor(diagnostics, "unsupported-value-template").length > 0);
  });
});
