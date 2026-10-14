import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ok, strictEqual } from "node:assert";
import { after, describe, it } from "node:test";
import { emit, emitWithDiagnostics, fileContent } from "./host.js";

const PREAMBLE = `
  import "@typespec/http";
  using Http;

  @service(#{ title: "Test API" })
  namespace TestApi;
`;

describe("request records", () => {
  it("names a PUT request record Replace", async () => {
    const results = await emit(`${PREAMBLE}
      model Widget {
        @visibility(Lifecycle.Read) id: string;
        name: string;
      }

      @route("/widgets")
      interface Widgets {
        @put replace(@path id: string, @body body: Widget): Widget;
      }
    `);

    ok(
      fileContent(results, "IWidgets.g.cs").includes(
        "ReplaceAsync(string id, WidgetReplaceRequest body,",
      ),
    );
    ok(
      fileContent(results, "WidgetReplaceRequest.g.cs").includes(
        "public record WidgetReplaceRequest",
      ),
    );
  });

  it("drops properties that do not exist in the emitted version", async () => {
    const results = await emit(
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
        @added(Versions.v2) color: string;
      }

      @route("/widgets")
      interface Widgets {
        @post create(@body body: Widget): Widget;
      }
    `,
      { "target-version": "v1.0" },
    );

    const request = fileContent(results, "WidgetCreateRequest.g.cs");
    ok(request.includes("Name"));
    ok(!request.includes("Color"), "A v2 property must not appear in v1");
  });

  it("keeps a v2 property when v2 is emitted", async () => {
    const results = await emit(`
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
        @added(Versions.v2) color: string;
      }

      @route("/widgets")
      interface Widgets {
        @post create(@body body: Widget): Widget;
      }
    `);

    ok(fileContent(results, "WidgetCreateRequest.g.cs").includes("Color"));
  });
});

describe("diagnostics", () => {
  it("rejects a target-version for an unversioned API", async () => {
    const [, diagnostics] = await emitWithDiagnostics(
      `${PREAMBLE}
      @route("/items") interface Items { @get list(): string[]; }
    `,
      { "target-version": "v1" },
    );

    ok(
      diagnostics.some(
        (d) =>
          d.code === "@massivescale/tsp-flurl-client/version-not-found" &&
          d.message.includes("none (API is not versioned)"),
      ),
    );
  });

  it("reports two models that claim the same output name", async () => {
    const [, diagnostics] = await emitWithDiagnostics(`
      import "@typespec/http";
      import "@massivescale/tsp-flurl-client";
      using Http;
      using MassiveScale.TspFlurlClient;

      @service(#{ title: "Test API" })
      namespace TestApi;

      @clientName("Same") model First { a: string; }
      @clientName("Same") model Second { b: string; }

      @route("/items")
      interface Items {
        @route("a") @get a(): First;
        @route("b") @get b(): Second;
      }
    `);

    ok(
      diagnostics.some(
        (d) =>
          d.code === "@massivescale/tsp-flurl-client/output-name-collision" &&
          d.message.includes('"Same.g.cs"'),
      ),
    );
  });

  it("falls back to the built-in templates when an override cannot be read", async () => {
    const [results, diagnostics] = await emitWithDiagnostics(
      `${PREAMBLE}
      @route("/items") interface Items { @get list(): string[]; }
    `,
      { templates: { record: join(tmpdir(), "does-not-exist.hbs") } },
    );

    ok(
      diagnostics.some(
        (d) => d.code === "@massivescale/tsp-flurl-client/template-load-failed",
      ),
    );
    ok(
      fileContent(results, "ItemsEndpoint.g.cs").includes(
        "class ItemsEndpoint",
      ),
    );
  });
});

describe("scalar mapping", () => {
  const cases: [string, string][] = [
    ["string", "string"],
    ["int8", "sbyte"],
    ["int16", "short"],
    ["int32", "int"],
    ["int64", "long"],
    ["uint8", "byte"],
    ["uint16", "ushort"],
    ["uint32", "uint"],
    ["uint64", "ulong"],
    ["safeint", "long"],
    ["float32", "float"],
    ["float64", "double"],
    ["decimal", "decimal"],
    ["decimal128", "decimal"],
    ["boolean", "bool"],
    ["bytes", "byte[]"],
    ["utcDateTime", "DateTimeOffset"],
    ["offsetDateTime", "DateTimeOffset"],
    ["plainDate", "DateOnly"],
    ["plainTime", "TimeOnly"],
    ["duration", "TimeSpan"],
    ["url", "Uri"],
    ["numeric", "double"],
    ["integer", "long"],
    ["float", "double"],
  ];

  it("maps every built-in scalar to its C# type", async () => {
    const props = cases.map(([t], i) => `p${i}: ${t};`).join("\n");
    const results = await emit(`${PREAMBLE}
      model Everything { ${props} }

      @route("/all") interface All { @get read(): Everything; }
    `);

    const model = fileContent(results, "Everything.g.cs");
    cases.forEach(([tsp, cs], i) => {
      ok(
        new RegExp(
          `public ${cs.replace("[", "\\[").replace("]", "\\]")} P${i} \\{`,
        ).test(model),
        `Expected ${tsp} to map to ${cs}`,
      );
    });
  });

  it("honours @format and custom scalars", async () => {
    const results = await emit(`${PREAMBLE}
      @format("uuid") scalar Uuid extends string;
      @format("uri") scalar Link extends string;
      scalar Money extends decimal;

      model Thing {
        id: Uuid;
        home: Link;
        price: Money;
      }

      @route("/things") interface Things { @get read(): Thing; }
    `);

    const model = fileContent(results, "Thing.g.cs");
    ok(model.includes("public Guid Id"));
    ok(model.includes("public Uri Home"));
    ok(model.includes("public decimal Price"));
  });

  it("maps a boolean encoded as a string to string", async () => {
    const results = await emit(`${PREAMBLE}
      model Thing { @encode("string") active: boolean; plain: boolean; }

      @route("/things") interface Things { @get read(): Thing; }
    `);

    const model = fileContent(results, "Thing.g.cs");
    ok(model.includes("public string Active"));
    ok(model.includes("public bool Plain"));
  });
});

describe("template helpers", () => {
  const dir = mkdtempSync(join(tmpdir(), "flurl-helpers-"));
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("exposes indent, docLines, isDefined and eq to custom templates", async () => {
    const path = join(dir, "record.hbs");
    writeFileSync(
      path,
      [
        "// indent:[{{indent doc}}]",
        "// indent-empty:[{{indent missing}}]",
        '// docLines:[{{docLines doc "/// "}}]',
        "// docLines-default:[{{docLines doc}}]",
        "// docLines-empty:[{{docLines missing}}]",
        "// defined:{{#if (isDefined recordName)}}yes{{else}}no{{/if}}",
        '// eq:{{#if (eq access "public")}}public{{else}}other{{/if}}',
        "{{access}} record {{recordName}};",
      ].join("\n"),
    );

    const results = await emit(
      `${PREAMBLE}
      /** line one
       *  line two */
      model Thing { name: string; }

      @route("/things") interface Things { @get read(): Thing; }
    `,
      { templates: { record: path } },
    );

    const record = fileContent(results, "Thing.g.cs");
    ok(record.includes("// indent:[    "));
    ok(record.includes("// indent-empty:[]"));
    ok(record.includes("// docLines-empty:[]"));
    ok(record.includes("// defined:yes"));
    ok(record.includes("// eq:public"));
    strictEqual(record.includes("public record Thing;"), true);
  });
});
