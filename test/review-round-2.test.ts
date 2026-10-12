import { ok, strictEqual } from "node:assert";
import { before, describe, it } from "node:test";
import {
  createLinterRuleTester,
  type LinterRuleTester,
} from "@typespec/compiler/testing";
import {
  isCsIdentifier,
  isCsKeyword,
  isCsNamespace,
  isCsTypeName,
} from "../src/identifiers.js";
import { internalAccessLeakRule } from "../src/rules/internal-access-leak.js";
import { BaseTester, emit, emitWithDiagnostics, fileContent } from "./host.js";

const PREAMBLE = `
  import "@typespec/http";
  import "@massivescale/tsp-flurl-client";
  using Http;
  using MassiveScale.TspFlurlClient;

  @service(#{ title: "Test API" })
  namespace TestApi;
`;

const SIMPLE = `${PREAMBLE}
  @route("/items") interface Items { @get list(): string[]; }
`;

const VERSIONED = (body: string) => `
  import "@typespec/http";
  import "@typespec/versioning";
  using Http;
  using Versioning;

  @service(#{ title: "Test API" })
  @versioned(Versions)
  namespace TestApi;

  enum Versions { v1: "v1.0", v2: "v2.0" }

  ${body}
`;

describe("identifier rules", () => {
  it("recognizes plain identifiers", () => {
    ok(isCsIdentifier("Widget"));
    ok(isCsIdentifier("_x1"));
    ok(isCsIdentifier("Étoile"));
    ok(!isCsIdentifier("1abc"));
    ok(!isCsIdentifier("a-b"));
    ok(!isCsIdentifier("a.b"));
    ok(!isCsIdentifier(""));
  });

  it("recognizes keywords", () => {
    ok(isCsKeyword("class"));
    ok(isCsKeyword("string"));
    ok(!isCsKeyword("Class"));
  });

  it("allows a keyword as an identifier but not as a type name", () => {
    ok(isCsIdentifier("class"));
    ok(!isCsTypeName("class"));
    ok(isCsTypeName("Widget"));
  });

  it("validates every segment of a namespace", () => {
    ok(isCsNamespace("Acme.Api.Client"));
    ok(isCsNamespace("Acme"));
    ok(!isCsNamespace("Acme..Client"));
    ok(!isCsNamespace("Acme.class"));
    ok(!isCsNamespace("../Outside"));
  });
});

describe("option validation", () => {
  const invalid = async (options: Record<string, string>) => {
    const [results, diagnostics] = await emitWithDiagnostics(SIMPLE, options);
    return {
      results,
      options: diagnostics
        .filter(
          (d) => d.code === "@massivescale/tsp-flurl-client/invalid-option",
        )
        .map((d) => d.message),
    };
  };

  it("rejects a project name that would write outside the output directory", async () => {
    const { results, options } = await invalid({
      "project-name": "../../Outside",
    });

    strictEqual(options.length, 1);
    ok(options[0].includes('"project-name"'));
    strictEqual(Object.keys(results).length, 0, "Nothing may be written");
  });

  it("rejects a project name containing a path separator", async () => {
    const { options } = await invalid({ "project-name": "Sub/Dir.Client" });
    strictEqual(options.length, 1);
  });

  it("rejects a client name that is a C# keyword", async () => {
    const { results, options } = await invalid({ "client-name": "class" });

    strictEqual(options.length, 1);
    ok(options[0].includes('"client-name"'));
    ok(options[0].includes("keyword"));
    strictEqual(Object.keys(results).length, 0);
  });

  it("rejects a client name that is not an identifier", async () => {
    const { options } = await invalid({ "client-name": "My Client" });
    strictEqual(options.length, 1);
  });

  it("rejects a root namespace that is not a valid C# namespace", async () => {
    const { options } = await invalid({ "root-namespace": "Acme..Client" });

    strictEqual(options.length, 1);
    ok(options[0].includes('"root-namespace"'));
  });

  it("reports every bad value at once", async () => {
    const { options } = await invalid({
      "project-name": "a/b",
      "client-name": "class",
      "root-namespace": "1x",
    });

    strictEqual(options.length, 3);
  });

  it("accepts dotted names", async () => {
    const results = await emit(SIMPLE, {
      "project-name": "Acme.PetStoreClient",
      "client-name": "PetStore",
      "root-namespace": "Acme.PetStore.Client",
    });

    ok(
      Object.keys(results).some((k) =>
        k.endsWith("Acme.PetStoreClient.csproj"),
      ),
    );
  });
});

describe("@clientName on a type", () => {
  it("rejects a C# keyword for a model", async () => {
    const [, diagnostics] = await emitWithDiagnostics(`${PREAMBLE}
      @clientName("class") model Thing { a: string; }

      @route("/things") interface Things { @get read(): Thing; }
    `);

    ok(
      diagnostics.some(
        (d) => d.code === "@massivescale/tsp-flurl-client/invalid-client-name",
      ),
    );
  });

  it("still accepts a keyword for an operation or a property, which are not type names", async () => {
    const results = await emit(`${PREAMBLE}
      model Thing { @clientName("event") when: string; }

      @route("/things") interface Things {
        @clientName("default") @get read(): Thing;
      }
    `);

    ok(fileContent(results, "IThings.g.cs").includes("DefaultAsync("));
    ok(fileContent(results, "Thing.g.cs").includes("public string Event"));
  });
});

describe("request record access", () => {
  const spec = (modelAccess: string) => `${PREAMBLE}
    @access(Access.internal)
    model Secret { value: string; }

    ${modelAccess}
    model Widget {
      @visibility(Lifecycle.Read) id: string;
      secret: Secret;
    }

    @access(Access.internal)
    @route("/widgets")
    interface Widgets {
      @post create(@body body: Widget): void;
    }
  `;

  it("is internal when the source model is internal", async () => {
    const results = await emit(spec("@access(Access.internal)"));

    ok(
      fileContent(results, "WidgetCreateRequest.g.cs").includes(
        "internal record WidgetCreateRequest",
      ),
    );
  });

  it("is public when the source model is public", async () => {
    const [results] = await emitWithDiagnostics(spec(""));

    ok(
      fileContent(results, "WidgetCreateRequest.g.cs").includes(
        "public record WidgetCreateRequest",
      ),
    );
  });
});

describe("internal-access-leak and template arguments", () => {
  let tester: LinterRuleTester;

  before(async () => {
    const runner = await BaseTester.createInstance();
    tester = createLinterRuleTester(
      runner,
      internalAccessLeakRule,
      "@massivescale/tsp-flurl-client",
    );
  });

  const code = (returnType: string) => `
    import "@massivescale/tsp-flurl-client";
    using MassiveScale.TspFlurlClient;

    namespace TestApi;

    @access(Access.internal)
    model Secret { value: string; }

    model Page<T> { items: T[]; }

    interface Widgets {
      read(): ${returnType};
    }
  `;

  it("flags an internal type argument of a template instance", async () => {
    await tester.expect(code("Page<Secret>")).toEmitDiagnostics({
      code: "@massivescale/tsp-flurl-client/internal-access-leak",
      message:
        '"read" is public but its return type "Secret" is marked @access(Access.internal); the generated C# will fail to compile (CS0053: inconsistent accessibility). Mark "Secret" @access(Access.public), or mark the interface that declares "read" @access(Access.internal) as well.',
    });
  });

  it("flags an internal type argument nested inside another template instance", async () => {
    await tester.expect(code("Page<Page<Secret>>")).toEmitDiagnostics({
      code: "@massivescale/tsp-flurl-client/internal-access-leak",
      message:
        '"read" is public but its return type "Secret" is marked @access(Access.internal); the generated C# will fail to compile (CS0053: inconsistent accessibility). Mark "Secret" @access(Access.public), or mark the interface that declares "read" @access(Access.internal) as well.',
    });
  });

  it("is valid when the type argument is public", async () => {
    await tester
      .expect(
        `
        namespace TestApi;
        model Open { value: string; }
        model Page<T> { items: T[]; }
        interface Widgets { read(): Page<Open>; }
      `,
      )
      .toBeValid();
  });
});

describe("numeric enum values", () => {
  it("reads and writes a numeric member as a JSON number", async () => {
    const results = await emit(`${PREAMBLE}
      enum Status { ready: 1, done: 2 }

      model Thing { status: Status; }

      @route("/things") interface Things { @get read(): Thing; }
    `);

    const status = fileContent(results, "Status.g.cs");
    ok(status.includes("reader.TokenType == JsonTokenType.Number"));
    ok(status.includes("1L => Status.Ready,"));
    ok(status.includes("writer.WriteNumberValue(1L);"));
    ok(status.includes("writer.WriteNumberValue(2L);"));
    ok(status.includes("Expected a number for Status"));
    ok(
      !status.includes("JsonTokenType.String"),
      "A purely numeric enum has no string branch",
    );
    ok(status.includes('[EnumMember(Value = "1")]'));
  });

  it("reads a fractional value as a double", async () => {
    const results = await emit(`${PREAMBLE}
      enum Ratio { half: 0.5 }

      model Thing { ratio: Ratio; }

      @route("/things") interface Things { @get read(): Thing; }
    `);

    const ratio = fileContent(results, "Ratio.g.cs");
    ok(ratio.includes("0.5D => Ratio.Half,"));
    ok(ratio.includes("writer.WriteNumberValue(0.5D);"));
  });

  it("handles an enum that mixes strings and numbers", async () => {
    const results = await emit(`${PREAMBLE}
      enum Mixed { auto: "auto", one: 1 }

      model Thing { mixed: Mixed; }

      @route("/things") interface Things { @get read(): Thing; }
    `);

    const mixed = fileContent(results, "Mixed.g.cs");
    ok(mixed.includes("reader.TokenType == JsonTokenType.String"));
    ok(mixed.includes("reader.TokenType == JsonTokenType.Number"));
    ok(mixed.includes('"auto" => Mixed.Auto,'));
    ok(mixed.includes("1L => Mixed.One,"));
    ok(mixed.includes("Expected a string or a number for Mixed"));
    ok(
      !mixed.includes('"1" => Mixed.One'),
      "A numeric member must not also match as a string",
    );
  });

  it("keeps a string enum string-only", async () => {
    const results = await emit(`${PREAMBLE}
      enum Color { red: "red" }

      model Thing { color: Color; }

      @route("/things") interface Things { @get read(): Thing; }
    `);

    const color = fileContent(results, "Color.g.cs");
    ok(color.includes("Expected a string for Color"));
    ok(!color.includes("JsonTokenType.Number"));
  });

  it("treats a member with no declared value as its name", async () => {
    const results = await emit(`${PREAMBLE}
      enum Plain { first, second }

      model Thing { plain: Plain; }

      @route("/things") interface Things { @get read(): Thing; }
    `);

    ok(fileContent(results, "Plain.g.cs").includes('"first" => Plain.First,'));
  });
});

describe("endpoint output name collisions", () => {
  const diagnosticsFor = async (code: string, options = {}) => {
    const [results, diagnostics] = await emitWithDiagnostics(code, options);
    return {
      results,
      collisions: diagnostics
        .filter((d) => d.code.endsWith("output-name-collision"))
        .map((d) => d.message),
    };
  };

  it("reports two services that declare the same interface", async () => {
    const { results, collisions } = await diagnosticsFor(`
      import "@typespec/http";
      using Http;

      @service(#{ title: "A" })
      namespace A { @route("/a") interface Items { @get list(): string[]; } }

      @service(#{ title: "B" })
      namespace B { @route("/b") interface Items { @get list(): string[]; } }
    `);

    ok(collisions.some((m) => m.includes("Endpoints/IItems.g.cs")));
    ok(collisions.some((m) => m.includes("Endpoints/ItemsClient.g.cs")));
    ok(
      fileContent(results, "IItems.g.cs").includes("namespace A.Client;"),
      "The first claim is kept rather than overwritten",
    );
  });

  it("reports two interfaces given the same @clientName", async () => {
    const { collisions } = await diagnosticsFor(`${PREAMBLE}
      @clientName("Same") @route("/a") interface First { @get list(): string[]; }
      @clientName("Same") @route("/b") interface Second { @get list(): string[]; }
    `);

    ok(collisions.some((m) => m.includes("Endpoints/ISame.g.cs")));
  });

  it("reports two services that share an aggregate client name", async () => {
    const { collisions } = await diagnosticsFor(
      `
      import "@typespec/http";
      using Http;

      @service(#{ title: "A" })
      namespace A { @route("/a") interface AItems { @get list(): string[]; } }

      @service(#{ title: "B" })
      namespace B { @route("/b") interface BItems { @get list(): string[]; } }
    `,
      { "client-name": "Shared" },
    );

    ok(collisions.some((m) => m.includes("SharedExtensions.g.cs")));
  });

  it("does not report the same interface emitted once per version", async () => {
    const { collisions } = await diagnosticsFor(
      VERSIONED(`@route("/items") interface Items { @get list(): string[]; }`),
      { "all-versions": true },
    );

    strictEqual(collisions.length, 0);
  });

  it("does not report distinct interfaces", async () => {
    const { collisions } = await diagnosticsFor(`${PREAMBLE}
      @route("/a") interface First { @get list(): string[]; }
      @route("/b") interface Second { @get list(): string[]; }
    `);

    strictEqual(collisions.length, 0);
  });
});

describe("version projection", () => {
  const spec = VERSIONED(`
    model Widget {
      id: string;
      @added(Versions.v2) color: string;
      @removed(Versions.v2) legacy: string;
    }

    @route("/widgets")
    interface Widgets {
      @get list(
        @query always?: string,
        @added(Versions.v2) @query extra?: string,
      ): Widget[];
    }
  `);

  it("leaves a parameter added in v2 out of a v1 client", async () => {
    const results = await emit(spec, { "target-version": "v1.0" });

    const client = fileContent(results, "WidgetsClient.g.cs");
    ok(client.includes('SetQueryParam("always"'));
    ok(!client.includes('SetQueryParam("extra"'));
    ok(!fileContent(results, "IWidgets.g.cs").includes("extra"));
  });

  it("keeps a parameter added in v2 in a v2 client", async () => {
    const results = await emit(spec, { "target-version": "v2.0" });

    ok(
      fileContent(results, "WidgetsClient.g.cs").includes(
        'SetQueryParam("extra"',
      ),
    );
  });

  it("projects model properties onto a single emitted version", async () => {
    const v1 = fileContent(
      await emit(spec, { "target-version": "v1.0" }),
      "Widget.g.cs",
    );
    ok(v1.includes("Legacy"), "A property removed in v2 exists in v1");
    ok(!v1.includes("Color"), "A property added in v2 is not in v1");

    const v2 = fileContent(await emit(spec), "Widget.g.cs");
    ok(v2.includes("Color"));
    ok(!v2.includes("Legacy"), "A property removed in v2 is not in v2");
  });

  it("keeps every version's properties when all versions are emitted together", async () => {
    const results = await emit(spec, { "all-versions": true });

    const widget = fileContent(results, "Widget.g.cs");
    ok(widget.includes("Color"));
    ok(widget.includes("Legacy"));
    ok(
      !fileContent(results, "v1.0/Endpoints/WidgetsClient.g.cs").includes(
        'SetQueryParam("extra"',
      ),
      "The v1 client still omits the v2 parameter",
    );
    ok(
      fileContent(results, "v2.0/Endpoints/WidgetsClient.g.cs").includes(
        'SetQueryParam("extra"',
      ),
    );
  });
});
