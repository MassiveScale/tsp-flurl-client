import { ok, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import { escapeCsString, sanitizeVersionForNs } from "../src/utils.js";
import { emit, emitWithDiagnostics, fileContent } from "./host.js";

const PREAMBLE = `
  import "@typespec/http";
  import "@massivescale/tsp-flurl-client";
  using Http;
  using MassiveScale.TspFlurlClient;

  @service(#{ title: "Test API" })
  namespace TestApi;
`;

describe("@clientName validation", () => {
  for (const bad of ["my model", "../Client", "a-b", "1abc", "A.B", "   "]) {
    it(`rejects ${JSON.stringify(bad)}`, async () => {
      const [, diagnostics] = await emitWithDiagnostics(`${PREAMBLE}
        @clientName(${JSON.stringify(bad)}) model Thing { a: string; }

        @route("/things") interface Things { @get read(): Thing; }
      `);

      ok(
        diagnostics.some(
          (d) =>
            d.code === "@massivescale/tsp-flurl-client/invalid-client-name",
        ),
        `Expected invalid-client-name for ${JSON.stringify(bad)}`,
      );
    });
  }

  for (const good of ["Pet", "Pet_2", "_pet", "Étoile"]) {
    it(`accepts ${JSON.stringify(good)}`, async () => {
      const results = await emit(`${PREAMBLE}
        @clientName(${JSON.stringify(good)}) model Thing { a: string; }

        @route("/things") interface Things { @get read(): Thing; }
      `);

      ok(
        Object.keys(results).some((k) => k.endsWith(`/${good}.g.cs`)),
        `Expected ${good}.g.cs`,
      );
    });
  }

  it("cannot be used to write outside the Models folder", async () => {
    const [results] = await emitWithDiagnostics(`${PREAMBLE}
      @clientName("../Escape") model Thing { a: string; }

      @route("/things") interface Things { @get read(): Thing; }
    `);

    ok(!Object.keys(results).some((k) => k.includes("..")));
  });
});

describe("internal endpoints in the aggregate client", () => {
  const spec = (access: string) => `${PREAMBLE}
    @route("/pets") interface Pets { @get list(): string[]; }

    ${access}
    @route("/admin") interface Admin { @post reindex(): void; }
  `;

  it("makes an internal endpoint an internal property and the constructor internal", async () => {
    const content = fileContent(
      await emit(spec("@access(Access.internal)")),
      "TestApiClientExtensions.g.cs",
    );

    ok(content.includes("public IPets Pets { get; }"));
    ok(content.includes("internal IAdmin Admin { get; }"));
    ok(
      content.includes(
        "internal TestApiClient(IFlurlClient flurlClient, IPets pets, IAdmin admin)",
      ),
      "A public constructor cannot take an internal parameter type",
    );
  });

  it("keeps everything public when every endpoint is public", async () => {
    const content = fileContent(
      await emit(spec("")),
      "TestApiClientExtensions.g.cs",
    );

    ok(content.includes("public IAdmin Admin { get; }"));
    ok(
      content.includes(
        "public TestApiClient(IFlurlClient flurlClient, IPets pets, IAdmin admin)",
      ),
    );
  });
});

describe("request record name collisions", () => {
  const spec = `${PREAMBLE}
    model Widget {
      @visibility(Lifecycle.Read) id: string;
      name: string;
    }

    model WidgetCreateRequest { reason: string; }

    @route("/widgets")
    interface Widgets {
      @post create(@body body: Widget): Widget;
      @route("audit") @get audit(): WidgetCreateRequest;
    }
  `;

  it("reports a model that claims the synthesized request record's name", async () => {
    const [, diagnostics] = await emitWithDiagnostics(spec);

    ok(
      diagnostics.some(
        (d) =>
          d.code === "@massivescale/tsp-flurl-client/output-name-collision" &&
          d.message.includes("WidgetCreateRequest"),
      ),
    );
  });

  it("does not report a collision between versions, which keep their records in separate folders", async () => {
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

      model Widget {
        @visibility(Lifecycle.Read) id: string;
        name: string;
      }

      @route("/widgets")
      interface Widgets {
        @post create(@body body: Widget): Widget;
      }
    `,
      { "all-versions": true },
    );

    strictEqual(
      diagnostics.filter((d) => d.code.endsWith("output-name-collision"))
        .length,
      0,
    );
  });
});

describe("project file escaping", () => {
  it("escapes XML metacharacters in every option-derived value", async () => {
    const results = await emit(
      `${PREAMBLE}
      @route("/items") interface Items { @get list(): string[]; }
    `,
      {
        "nuget-authors": "A & B",
        "nuget-description": "Uses <b>markup</b> & more",
        "nuget-title": "Title </Title><Evil/>",
        "nuget-tags": "a<b c&d",
        "nuget-package-id": "Pkg&Id",
        "nuget-version": "1.0.0-a&b",
      },
    );

    const csproj = fileContent(results, ".csproj");
    ok(csproj.includes("<Authors>A &amp; B</Authors>"));
    ok(
      csproj.includes(
        "<Description>Uses &lt;b&gt;markup&lt;/b&gt; &amp; more</Description>",
      ),
    );
    ok(csproj.includes("<Title>Title &lt;/Title&gt;&lt;Evil/&gt;</Title>"));
    ok(csproj.includes("<PackageTags>a&lt;b c&amp;d</PackageTags>"));
    ok(csproj.includes("<PackageId>Pkg&amp;Id</PackageId>"));
    ok(csproj.includes("<Version>1.0.0-a&amp;b</Version>"));
    ok(!csproj.includes("<Evil/>"), "A closing tag must not inject elements");
  });

  it("escapes the root namespace and target framework", async () => {
    const results = await emit(
      `${PREAMBLE}
      @route("/items") interface Items { @get list(): string[]; }
    `,
      { "root-namespace": "A&B", "net-version": "net8.0&x" },
    );

    const csproj = fileContent(results, ".csproj");
    ok(csproj.includes("<RootNamespace>A&amp;B</RootNamespace>"));
    ok(csproj.includes("<TargetFramework>net8.0&amp;x</TargetFramework>"));
  });
});

describe("enum wire values", () => {
  it("generates a converter that maps every member to its declared value", async () => {
    const results = await emit(`${PREAMBLE}
      enum Color { red: "red", deepBlue: "deep-blue" }

      model Thing { color: Color; }

      @route("/things") interface Things { @get read(): Thing; }
    `);

    const color = fileContent(results, "Color.g.cs");
    ok(color.includes("[JsonConverter(typeof(ColorJsonConverter))]"));
    ok(!color.includes("JsonStringEnumConverter"));
    ok(
      color.includes(
        "internal sealed class ColorJsonConverter : JsonConverter<Color>",
      ),
    );
    ok(color.includes('"deep-blue" => Color.DeepBlue,'));
    ok(color.includes('Color.DeepBlue => "deep-blue",'));
    ok(color.includes("is not a known Color value"));
    ok(color.includes("using System.Text.Json;"));
  });

  it("escapes a wire value that needs it", async () => {
    const results = await emit(`${PREAMBLE}
      enum Odd { quote: "say \\"hi\\"" }

      model Thing { odd: Odd; }

      @route("/things") interface Things { @get read(): Thing; }
    `);

    const odd = fileContent(results, "Odd.g.cs");
    ok(odd.includes('[EnumMember(Value = "say \\"hi\\"")]'));
    ok(odd.includes('"say \\"hi\\"" => Odd.Quote,'));
  });

  it("keeps the converter as accessible as the enum", async () => {
    const results = await emit(`${PREAMBLE}
      @access(Access.internal) enum Hidden { a }

      @access(Access.internal) model Thing { h: Hidden; }

      @access(Access.internal)
      @route("/things") interface Things { @get read(): Thing; }
    `);

    const hidden = fileContent(results, "Hidden.g.cs");
    ok(hidden.includes("internal enum Hidden"));
    ok(hidden.includes("internal sealed class HiddenJsonConverter"));
  });
});

describe("version namespace segments", () => {
  it("replaces every character that is not valid in an identifier", () => {
    strictEqual(sanitizeVersionForNs("sprint-42"), "Vsprint_42");
    strictEqual(sanitizeVersionForNs("2024-01-15"), "V2024_01_15");
    strictEqual(sanitizeVersionForNs("v1.0-beta+7"), "V1_0_beta_7");
    strictEqual(sanitizeVersionForNs("v2.0"), "V2_0");
  });

  it("emits a compilable namespace for a version like sprint-42", async () => {
    const results = await emit(
      `
      import "@typespec/http";
      import "@typespec/versioning";
      using Http;
      using Versioning;

      @service(#{ title: "Test API" })
      @versioned(Versions)
      namespace TestApi;

      enum Versions { s42: "sprint-42" }

      @route("/items") interface Items { @get list(): string[]; }
    `,
      { "all-versions": true },
    );

    ok(
      fileContent(results, "ItemsClient.g.cs").includes(
        "namespace TestApi.Client.Vsprint_42;",
      ),
    );
  });
});

describe("initializers for required properties", () => {
  it("initializes every required reference type and leaves value types alone", async () => {
    const results = await emit(`${PREAMBLE}
      enum Color { red }
      model Owner { name: string; }

      model Gadget {
        owner: Owner;
        tags: Record<string>;
        owners: Owner[];
        raw: unknown;
        label: string;
        data: bytes;
        count: int32;
        flag: boolean;
        color: Color;
        optionalOwner?: Owner;
      }

      @route("/gadgets") interface Gadgets { @get read(): Gadget; }
    `);

    const gadget = fileContent(results, "Gadget.g.cs");
    ok(gadget.includes("public Owner Owner { get; init; } = default!;"));
    ok(
      gadget.includes(
        "public Dictionary<string, string> Tags { get; init; } = new();",
      ),
    );
    ok(gadget.includes("public List<Owner> Owners { get; init; } = [];"));
    ok(gadget.includes("public object Raw { get; init; } = default!;"));
    ok(gadget.includes("public string Label { get; init; } = default!;"));
    ok(gadget.includes("public byte[] Data { get; init; } = default!;"));
    ok(gadget.includes("public int Count { get; init; }\n"));
    ok(gadget.includes("public bool Flag { get; init; }\n"));
    ok(gadget.includes("public Color Color { get; init; }\n"));
    ok(gadget.includes("public Owner? OptionalOwner { get; init; }\n"));
  });
});

describe("escapeCsString", () => {
  it("escapes quotes, backslashes and line breaks", () => {
    strictEqual(escapeCsString('a"b'), 'a\\"b');
    strictEqual(escapeCsString("a\\b"), "a\\\\b");
    strictEqual(escapeCsString("a\nb\rc\td"), "a\\nb\\rc\\td");
  });

  it("leaves ordinary text alone", () => {
    strictEqual(escapeCsString("plain-name_1"), "plain-name_1");
  });

  it("keeps a property name containing a quote from ending the string literal", async () => {
    const results = await emit(`${PREAMBLE}
      model Thing { \`a"b\`: string; }

      @route("/things") interface Things { @get read(): Thing; }
    `);

    ok(
      fileContent(results, "Thing.g.cs").includes(
        '[JsonPropertyName("a\\"b")]',
      ),
    );
  });

  it("keeps a query name containing a quote from ending the string literal", async () => {
    const results = await emit(`${PREAMBLE}
      @route("/things") interface Things { @get read(@query(#{ name: "a\\"b" }) q?: string): string; }
    `);

    ok(
      fileContent(results, "ThingsClient.g.cs").includes(
        'SetQueryParam("a\\"b", ',
      ),
    );
  });
});
