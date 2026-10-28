import { ok, strictEqual } from "node:assert";
import { before, describe, it } from "node:test";
import {
  createLinterRuleTester,
  type LinterRuleTester,
} from "@typespec/compiler/testing";
import { internalAccessLeakRule } from "../src/rules/internal-access-leak.js";
import {
  BaseTester,
  emit,
  emitWithDiagnostics,
  fileContent,
  messagesFor as codes,
  has,
} from "./host.js";

const PREAMBLE = `
  import "@typespec/http";
  import "@massivescale/tsp-flurl-client";
  using Http;
  using MassiveScale.TspFlurlClient;

  @service(#{ title: "Test API" })
  namespace TestApi;
`;

describe("declarations with the same simple name in different namespaces", () => {
  const interfaces = (second: string) => `
    import "@typespec/http";
    import "@massivescale/tsp-flurl-client";
    using Http;
    using MassiveScale.TspFlurlClient;

    @service(#{ title: "Test API" })
    namespace TestApi {
      namespace A { @route("/a") interface Items { @get listA(): string[]; } }
      namespace B { ${second} @route("/b") interface Items { @get listB(): string[]; } }
    }
  `;

  it("reports two interfaces called Items instead of merging them into one client", async () => {
    const [results, diagnostics] = await emitWithDiagnostics(interfaces(""));

    const collisions = codes(diagnostics, "output-name-collision");
    ok(
      collisions.some((m) => m.includes("Endpoints/ItemsRequestBuilders.g.cs")),
    );
    const iface = fileContent(results, "ItemsRequestBuilders.g.cs");
    ok(iface.includes("ListAAsync("), "The first interface is emitted");
    ok(!iface.includes("ListBAsync("), "The second is not merged into it");
  });

  it("emits both once one is given a different name", async () => {
    const [results, diagnostics] = await emitWithDiagnostics(
      interfaces("").replace(
        '@route("/b") interface Items',
        '@clientName("Things") @route("/b") interface Items',
      ),
    );

    strictEqual(codes(diagnostics, "output-name-collision").length, 0);
    ok(
      fileContent(results, "ItemsRequestBuilders.g.cs").includes("ListAAsync("),
    );
    ok(
      fileContent(results, "ThingsRequestBuilders.g.cs").includes(
        "ListBAsync(",
      ),
    );
    ok(
      !fileContent(results, "ItemsRequestBuilders.g.cs").includes(
        "ListBAsync(",
      ),
    );
  });

  const sibling = (kind: "model" | "enum") => `${PREAMBLE}
    namespace A { ${kind} Thing ${kind === "model" ? "{ a: string; }" : "{ x }"} }
    namespace B { ${kind} Thing ${kind === "model" ? "{ b: string; }" : "{ y }"} }

    model Holder { first: A.Thing; second: B.Thing; }

    @route("/h") interface Holders { @get read(): Holder; }
  `;

  for (const kind of ["model", "enum"] as const) {
    it(`reports two ${kind}s with the same name, naming both`, async () => {
      const [, diagnostics] = await emitWithDiagnostics(sibling(kind));

      const messages = codes(diagnostics, "output-name-collision");
      strictEqual(messages.length, 1);
      ok(messages[0].includes(`TestApi.A.Thing`));
      ok(messages[0].includes(`TestApi.B.Thing`));
    });
  }

  it("emits both models once one is renamed", async () => {
    const [results, diagnostics] = await emitWithDiagnostics(
      sibling("model").replace(
        "namespace B { model Thing",
        'namespace B { @clientName("OtherThing") model Thing',
      ),
    );

    strictEqual(codes(diagnostics, "output-name-collision").length, 0);
    ok(fileContent(results, "Thing.g.cs").includes("public string A"));
    ok(fileContent(results, "OtherThing.g.cs").includes("public string B"));
  });
});

describe("method names that collide once converted", () => {
  it("reports read and Read, which both become ReadAsync, and emits only the first", async () => {
    const [results, diagnostics] = await emitWithDiagnostics(`${PREAMBLE}
      @route("/items") interface Items {
        @route("a") @get read(): string;
        @route("b") @get Read(): string;
      }
    `);

    const messages = codes(diagnostics, "name-collision");
    strictEqual(messages.length, 1);
    ok(messages[0].includes('"ReadAsync"'));
    ok(messages[0].includes("endpoint group Items"));
    strictEqual(
      [
        ...fileContent(results, "ItemsRequestBuilders.g.cs").matchAll(
          / ReadAsync\(/g,
        ),
      ].length,
      1,
    );
  });

  it("reports operations given the same name by @clientName", async () => {
    const [, diagnostics] = await emitWithDiagnostics(`${PREAMBLE}
      @route("/items") interface Items {
        @clientName("fetch") @route("a") @get one(): string;
        @clientName("fetch") @route("b") @get two(): string;
      }
    `);

    strictEqual(codes(diagnostics, "name-collision").length, 1);
  });

  it("reports a collision once however many versions emit it", async () => {
    const [, diagnostics] = await emitWithDiagnostics(
      `
      import "@typespec/http";
      import "@typespec/versioning";
      using Http;
      using Versioning;

      @service(#{ title: "Test API" })
      @versioned(Versions)
      namespace TestApi;

      enum Versions { v1: "v1.0", v2: "v2.0" }

      @route("/items") interface Items {
        @route("a") @get read(): string;
        @route("b") @get Read(): string;
      }
    `,
      { "all-versions": true },
    );

    strictEqual(codes(diagnostics, "name-collision").length, 1);
  });

  it("accepts distinct operations", async () => {
    const [, diagnostics] = await emitWithDiagnostics(`${PREAMBLE}
      @route("/items") interface Items {
        @route("a") @get read(): string;
        @route("b") @get write(): string;
      }
    `);

    strictEqual(codes(diagnostics, "name-collision").length, 0);
  });
});

describe("parameter names that collide", () => {
  const params = async (declarations: string, body = "") => {
    const [results, diagnostics] = await emitWithDiagnostics(`${PREAMBLE}
      model Item { id: string; }

      @route("/items") interface Items {
        @${body ? "post" : "get"} act(${declarations}): string;
      }
    `);
    return { results, messages: codes(diagnostics, "name-collision") };
  };

  it("reports foo and Foo, which are both foo, and keeps the first", async () => {
    const { results, messages } = await params(
      '@query foo?: string, @query(#{ name: "other" }) Foo?: string',
    );

    strictEqual(messages.length, 1);
    ok(messages[0].includes('"foo"'));
    strictEqual(
      [
        ...fileContent(results, "ItemsRequestBuilders.g.cs").matchAll(
          /string\? foo = null/g,
        ),
      ].length,
      1,
      "The second parameter is left out, so foo is declared once",
    );
  });

  for (const reserved of [
    "cancellationToken",
    "flurlRequest",
    "flurlResponse",
  ]) {
    it(`reports a parameter named ${reserved}, which the generated method already uses`, async () => {
      const { messages } = await params(`@query ${reserved}?: string`);

      strictEqual(messages.length, 1, reserved);
      ok(messages[0].includes(`"${reserved}"`));
    });
  }

  for (const formerlyReserved of ["additionalQueryParameters", "_client"]) {
    it(`accepts a parameter named ${formerlyReserved}, which the generated method no longer uses`, async () => {
      const { results, messages } = await params(
        `@query ${formerlyReserved}?: string`,
      );

      strictEqual(messages.length, 0, formerlyReserved);
      const builders = fileContent(results, "ItemsRequestBuilders.g.cs");
      ok(
        builders.includes(
          `ActAsync(string? ${formerlyReserved} = null, CancellationToken cancellationToken = default)`,
        ),
      );
      ok(
        builders.includes(
          `flurlRequest.SetQueryParam("${formerlyReserved}", ClientRuntime.ToQueryValue(${formerlyReserved}));`,
        ),
      );
    });
  }

  it("reports a parameter named body when the operation has a body", async () => {
    const { messages } = await params(
      "@query body?: string, @body payload: Item",
      "post",
    );

    strictEqual(messages.length, 1);
    ok(messages[0].includes('"body"'));
  });

  it("allows a parameter named body when the operation has no body", async () => {
    const { messages } = await params("@query body?: string");

    strictEqual(messages.length, 0);
  });

  it("resolves a collision with @clientName", async () => {
    const { results, messages } = await params(
      '@query foo?: string, @clientName("fooTwo") @query(#{ name: "other" }) Foo?: string',
    );

    strictEqual(messages.length, 0);
    ok(
      fileContent(results, "ItemsRequestBuilders.g.cs").includes(
        "string? foo = null, string? fooTwo = null",
      ),
    );
  });
});

describe("property names that collide", () => {
  const model = async (properties: string, name = "Thing") => {
    const [results, diagnostics] = await emitWithDiagnostics(`${PREAMBLE}
      model ${name} { ${properties} }

      @route("/things") interface Things { @get read(): ${name}; }
    `);
    return { results, messages: codes(diagnostics, "name-collision") };
  };

  it("reports foo and Foo, which both become Foo, and keeps the first", async () => {
    const { results, messages } = await model("foo: string; Foo: int32;");

    strictEqual(messages.length, 1);
    ok(messages[0].includes('"Foo"'));
    ok(messages[0].includes("record Thing"));
    strictEqual(
      [...fileContent(results, "Thing.g.cs").matchAll(/public \S+ Foo \{/g)]
        .length,
      1,
    );
  });

  it("reports two @clientName values that differ only in the case of the first letter", async () => {
    const { messages } = await model(
      '@clientName("alpha") a: string; @clientName("Alpha") b: string;',
    );

    strictEqual(messages.length, 1);
  });

  it("reports a property named after its own record, which C# rejects (CS0542)", async () => {
    const { messages } = await model("thing: string;");

    strictEqual(messages.length, 1);
    ok(messages[0].includes("whose name a member cannot share"));
  });

  for (const reserved of [
    "equalityContract",
    "equals",
    "getHashCode",
    "toString",
    "getType",
    "deconstruct",
    "printMembers",
  ]) {
    it(`reports a property that becomes ${reserved[0].toUpperCase()}${reserved.slice(1)}, a member every record already has`, async () => {
      const { messages } = await model(`${reserved}: string;`);

      strictEqual(messages.length, 1, reserved);
    });
  }

  it("applies to request records too", async () => {
    const [, diagnostics] = await emitWithDiagnostics(`${PREAMBLE}
      model Thing {
        @visibility(Lifecycle.Read) id: string;
        foo: string;
        Foo: string;
      }

      @route("/things") interface Things { @post create(@body body: Thing): Thing; }
    `);

    ok(
      codes(diagnostics, "name-collision").some((m) =>
        m.includes("record ThingCreateRequest"),
      ),
    );
  });

  it("resolves a collision with @clientName", async () => {
    // The JSON names must differ too: the client reads JSON without regard to case.
    const { results, messages } = await model(
      'foo: string; @clientName("fooTwo") @encodedName("application/json", "foo2") Foo: string;',
    );

    strictEqual(messages.length, 0);
    ok(fileContent(results, "Thing.g.cs").includes("public string Foo"));
    ok(fileContent(results, "Thing.g.cs").includes("public string FooTwo"));
  });

  it("accepts a property whose name merely contains the record's name", async () => {
    const { messages } = await model("thingId: string; owner: string;");

    strictEqual(messages.length, 0);
  });
});

describe("endpoint names that collide with the aggregate client", () => {
  const withInterface = async (name: string, options = {}) => {
    const [results, diagnostics] = await emitWithDiagnostics(
      `${PREAMBLE}
      @route("/x") interface ${name} { @get read(): string; }
    `,
      options,
    );
    return { results, messages: codes(diagnostics, "name-collision") };
  };

  for (const reserved of ["FlurlClient", "Create"]) {
    it(`reports an interface named ${reserved}`, async () => {
      const { results, messages } = await withInterface(reserved);

      strictEqual(messages.length, 1);
      ok(messages[0].includes(`"${reserved}"`));
      ok(
        !has(results, `${reserved}RequestBuilders.g.cs`),
        "The endpoint is not written",
      );
    });
  }

  it("reports an interface named like the client class itself", async () => {
    const { messages } = await withInterface("Widgets", {
      "client-name": "Widgets",
    });

    strictEqual(messages.length, 1);
    ok(messages[0].includes("whose name a member cannot share"));
  });

  it("accepts an ordinary interface name", async () => {
    const { messages } = await withInterface("Widgets");

    strictEqual(messages.length, 0);
  });
});

describe("internal-access-leak", () => {
  let tester: LinterRuleTester;

  before(async () => {
    const runner = await BaseTester.createInstance();
    tester = createLinterRuleTester(
      runner,
      internalAccessLeakRule,
      "@massivescale/tsp-flurl-client",
    );
  });

  const header = `
    import "@massivescale/tsp-flurl-client";
    using MassiveScale.TspFlurlClient;

    namespace TestApi;
  `;

  it("flags a namespace-level operation that returns an internal type", async () => {
    await tester
      .expect(
        `${header}
        @access(Access.internal) model Secret { value: string; }

        op read(): Secret;
      `,
      )
      .toEmitDiagnostics({
        code: "@massivescale/tsp-flurl-client/internal-access-leak",
        message:
          '"read" is a namespace-level operation, which is emitted as a public request builder method, but its return type "Secret" is marked @access(Access.internal); the generated C# will fail to compile (CS0053: inconsistent accessibility). Mark "Secret" @access(Access.public), or move the operation into an interface marked @access(Access.internal).',
      });
  });

  it("flags a namespace-level operation that takes an internal type", async () => {
    await tester
      .expect(
        `${header}
        @access(Access.internal) model Secret { value: string; }

        op write(secret: Secret): void;
      `,
      )
      .toEmitDiagnostics({
        code: "@massivescale/tsp-flurl-client/internal-access-leak",
        message:
          '"write" is a namespace-level operation, which is emitted as a public request builder method, but its parameter type "Secret" is marked @access(Access.internal); the generated C# will fail to compile (CS0053: inconsistent accessibility). Mark "Secret" @access(Access.public), or move the operation into an interface marked @access(Access.internal).',
      });
  });

  it("reports an operation inside an interface once, not also as namespace-level", async () => {
    await tester
      .expect(
        `${header}
        @access(Access.internal) model Secret { value: string; }

        interface Widgets { read(): Secret; }
      `,
      )
      .toEmitDiagnostics({
        code: "@massivescale/tsp-flurl-client/internal-access-leak",
        message:
          '"read" is public but its return type "Secret" is marked @access(Access.internal); the generated C# will fail to compile (CS0053: inconsistent accessibility). Mark "Secret" @access(Access.public), or mark the interface that declares "read" @access(Access.internal) as well.',
      });
  });

  it("accepts a namespace-level operation over public types", async () => {
    await tester
      .expect(`${header} model Open { value: string; } op read(): Open;`)
      .toBeValid();
  });

  it("flags a public model that extends an internal discriminated base", async () => {
    await tester
      .expect(
        `${header}
        @access(Access.internal) @discriminator("kind") model Pet { kind: string; }
        model Dog extends Pet { kind: "dog"; }
      `,
      )
      .toEmitDiagnostics({
        code: "@massivescale/tsp-flurl-client/internal-access-leak",
        message:
          '"Dog" is public but its base type "Pet" is marked @access(Access.internal); the generated C# will fail to compile (CS0060: inconsistent accessibility of the base type). Mark "Pet" @access(Access.public), or mark "Dog" @access(Access.internal) as well.',
      });
  });

  it("accepts an internal model that extends an internal discriminated base", async () => {
    await tester
      .expect(
        `${header}
        @access(Access.internal) @discriminator("kind") model Pet { kind: string; }
        @access(Access.internal) model Dog extends Pet { kind: "dog"; }
      `,
      )
      .toBeValid();
  });

  it("accepts a public model that extends a public discriminated base", async () => {
    await tester
      .expect(
        `${header}
        @discriminator("kind") model Pet { kind: string; }
        model Dog extends Pet { kind: "dog"; }
      `,
      )
      .toBeValid();
  });

  it("does not flag a model that extends an internal base outside a discriminated hierarchy, which is flattened", async () => {
    await tester
      .expect(
        `${header}
        @access(Access.internal) model Base { id: string; }
        model Derived extends Base { name: string; }
      `,
      )
      .toBeValid();
  });
});

describe("generated output stays valid when names are chosen well", () => {
  it("emits everything when no name collides", async () => {
    const results = await emit(`${PREAMBLE}
      model Thing { id: string; thingName: string; }

      @route("/things") interface Things {
        @route("a") @get read(@query body?: string): Thing;
        @route("b") @get write(): Thing;
      }
    `);

    ok(fileContent(results, "Thing.g.cs").includes("public string ThingName"));
    ok(
      fileContent(results, "ThingsRequestBuilders.g.cs").includes(
        "ReadAsync(string? body = null",
      ),
    );
  });
});

describe("generated type names that collide with models", () => {
  const collisions = async (code: string, options = {}) => {
    const [results, diagnostics] = await emitWithDiagnostics(code, options);
    return { results, messages: codes(diagnostics, "output-name-collision") };
  };

  it("reports a model named like a request builder", async () => {
    const { messages } = await collisions(`${PREAMBLE}
      model ItemsRequestBuilder { id: string; }

      @route("/items") interface Items { @get read(): ItemsRequestBuilder; }
    `);

    ok(
      messages.some(
        (m) =>
          m.includes("ItemsRequestBuilder") &&
          m.includes("the ItemsRequestBuilder request builder"),
      ),
    );
  });

  it("reports a model named like an item request builder", async () => {
    const { messages } = await collisions(`${PREAMBLE}
      model ItemsItemRequestBuilder { id: string; }

      @route("/items") interface Items {
        @get read(@path id: string): ItemsItemRequestBuilder;
      }
    `);

    ok(
      messages.some(
        (m) =>
          m.includes("ItemsItemRequestBuilder") &&
          m.includes("the ItemsItemRequestBuilder request builder"),
      ),
    );
  });

  it("reports a model named like the aggregate client or its extensions class", async () => {
    const aggregate = await collisions(`${PREAMBLE}
      model TestApiClient { id: string; }

      @route("/items") interface Items { @get read(): TestApiClient; }
    `);
    ok(aggregate.messages.some((m) => m.includes("TestApiClient")));

    const extensions = await collisions(`${PREAMBLE}
      model TestApiClientExtensions { id: string; }

      @route("/items") interface Items { @get read(): TestApiClientExtensions; }
    `);
    ok(extensions.messages.some((m) => m.includes("TestApiClientExtensions")));
  });

  it("reports a model named like an enum's generated converter", async () => {
    const { messages } = await collisions(`${PREAMBLE}
      enum Color { red }
      model ColorJsonConverter { id: string; }
      model Holder { color: Color; converter: ColorJsonConverter; }

      @route("/items") interface Items { @get read(): Holder; }
    `);

    ok(messages.some((m) => m.includes("ColorJsonConverter")));
  });

  it("reports the clash when endpoints and models are in different namespaces too", async () => {
    const { messages } = await collisions(
      `
      import "@typespec/http";
      import "@typespec/versioning";
      using Http;
      using Versioning;

      @service(#{ title: "Test API" })
      @versioned(Versions)
      namespace TestApi;

      enum Versions { v1: "v1.0" }

      model ItemsRequestBuilder { id: string; }

      @route("/items") interface Items { @get read(): ItemsRequestBuilder; }
    `,
      { "all-versions": true },
    );

    ok(messages.some((m) => m.includes("ItemsRequestBuilder")));
  });

  it("accepts models whose names only resemble generated types", async () => {
    const { messages } = await collisions(`${PREAMBLE}
      model Item { id: string; }
      model ItemsClientConfig { id: string; }
      model Holder { item: Item; config: ItemsClientConfig; }

      @route("/items") interface Items { @get read(): Holder; }
    `);

    strictEqual(messages.length, 0);
  });
});

describe("version values that become the same namespace", () => {
  it("reports 1.0 and 1_0, which are both V1_0", async () => {
    const [results, diagnostics] = await emitWithDiagnostics(
      `
      import "@typespec/http";
      import "@typespec/versioning";
      using Http;
      using Versioning;

      @service(#{ title: "Test API" })
      @versioned(Versions)
      namespace TestApi;

      enum Versions { a: "1.0", b: "1_0" }

      @route("/items") interface Items { @get read(): string; }
    `,
      { "all-versions": true },
    );

    const messages = codes(diagnostics, "name-collision");
    strictEqual(messages.length, 1);
    ok(messages[0].includes('"V1_0"'));
    ok(has(results, "1.0/Endpoints/ItemsRequestBuilders.g.cs"));
    ok(
      !has(results, "1_0/Endpoints/ItemsRequestBuilders.g.cs"),
      "The second is left out",
    );
  });
});
