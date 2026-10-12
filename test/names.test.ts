import { ok, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import type { Diagnostic, Program } from "@typespec/compiler";
import { toCsIdentifier } from "../src/identifiers.js";
import { runDotnetFormat, type FormatDeps } from "../src/emitter.js";
import { emit, emitWithDiagnostics, fileContent } from "./host.js";

const PREAMBLE = `
  import "@typespec/http";
  import "@massivescale/tsp-flurl-client";
  using Http;
  using MassiveScale.TspFlurlClient;

  @service(#{ title: "Test API" })
  namespace TestApi;
`;

const invalidNames = (diagnostics: readonly Diagnostic[]): string[] =>
  diagnostics
    .filter((d) => d.code === "@massivescale/tsp-flurl-client/invalid-name")
    .map((d) => d.message);

describe("toCsIdentifier", () => {
  it("replaces every character that is not a letter, digit or underscore", () => {
    strictEqual(toCsIdentifier("my-member"), "my_member");
    strictEqual(toCsIdentifier("a b.c"), "a_b_c");
    strictEqual(toCsIdentifier("ok_1"), "ok_1");
  });

  it("prefixes a name that would start with a digit", () =>
    strictEqual(toCsIdentifier("2fast"), "_2fast"));

  it("handles an empty name", () => strictEqual(toCsIdentifier(""), "_"));

  it("keeps non-ASCII letters", () =>
    strictEqual(toCsIdentifier("Étoile"), "Étoile"));
});

describe("names that come from the TypeSpec", () => {
  it("rejects a model name that is not a C# type name, and writes nothing for it", async () => {
    const [results, diagnostics] = await emitWithDiagnostics(`${PREAMBLE}
      model \`my model\` { a: string; }

      @route("/things") interface Things { @get read(): \`my model\`; }
    `);

    const messages = invalidNames(diagnostics);
    strictEqual(messages.length, 1);
    ok(messages[0].includes('model name "my model"'));
    ok(messages[0].includes("@clientName"));
    ok(!Object.keys(results).some((k) => k.includes("my model")));
  });

  it("cannot be used to write outside the Models folder", async () => {
    const [results, diagnostics] = await emitWithDiagnostics(`${PREAMBLE}
      model \`../Evil\` { a: string; }

      @route("/things") interface Things { @get read(): \`../Evil\`; }
    `);

    strictEqual(invalidNames(diagnostics).length, 1);
    ok(!Object.keys(results).some((k) => k.includes("..")));
  });

  it("accepts a bad model name once @clientName gives it a good one", async () => {
    const [results, diagnostics] = await emitWithDiagnostics(`${PREAMBLE}
      @clientName("Thing") model \`my model\` { a: string; }

      @route("/things") interface Things { @get read(): \`my model\`; }
    `);

    strictEqual(invalidNames(diagnostics).length, 0);
    ok(fileContent(results, "Thing.g.cs").includes("public record Thing"));
  });

  it("rejects a model name that is a C# keyword", async () => {
    const [, diagnostics] = await emitWithDiagnostics(`${PREAMBLE}
      model \`class\` { a: string; }

      @route("/things") interface Things { @get read(): \`class\`; }
    `);

    strictEqual(invalidNames(diagnostics).length, 1);
  });

  it("rejects an enum name that is not a C# type name", async () => {
    const [results, diagnostics] = await emitWithDiagnostics(`${PREAMBLE}
      enum \`my enum\` { a }
      model Thing { e: \`my enum\`; }

      @route("/things") interface Things { @get read(): Thing; }
    `);

    ok(
      invalidNames(diagnostics).some((m) => m.includes('enum name "my enum"')),
    );
    ok(!Object.keys(results).some((k) => k.includes("my enum")));
  });

  it("rejects an interface name that is not a C# type name, and writes no endpoint for it", async () => {
    const [results, diagnostics] = await emitWithDiagnostics(`${PREAMBLE}
      @route("/things") interface \`my things\` { @get read(): string; }
      @route("/ok") interface Fine { @get read(): string; }
    `);

    ok(
      invalidNames(diagnostics).some((m) =>
        m.includes('interface name "my things"'),
      ),
    );
    ok(!Object.keys(results).some((k) => k.includes("my things")));
    ok(Object.keys(results).some((k) => k.endsWith("IFine.g.cs")));
  });

  it("rejects a property name that is not a C# identifier", async () => {
    const [, diagnostics] = await emitWithDiagnostics(`${PREAMBLE}
      model Thing { \`a-b\`: string; }

      @route("/things") interface Things { @get read(): Thing; }
    `);

    ok(
      invalidNames(diagnostics).some((m) => m.includes('property name "a-b"')),
    );
  });

  it("accepts a bad property name once @clientName renames it, keeping the wire name", async () => {
    const [results, diagnostics] = await emitWithDiagnostics(`${PREAMBLE}
      model Thing { @clientName("ab") \`a-b\`: string; }

      @route("/things") interface Things { @get read(): Thing; }
    `);

    strictEqual(invalidNames(diagnostics).length, 0);
    const thing = fileContent(results, "Thing.g.cs");
    ok(thing.includes('[JsonPropertyName("a-b")]'));
    ok(thing.includes("public string Ab"));
  });

  it("accepts a C# keyword as a property name, which is PascalCased", async () => {
    const [results, diagnostics] = await emitWithDiagnostics(`${PREAMBLE}
      model Thing { \`class\`: string; }

      @route("/things") interface Things { @get read(): Thing; }
    `);

    strictEqual(invalidNames(diagnostics).length, 0);
    ok(fileContent(results, "Thing.g.cs").includes("public string Class"));
  });

  it("rejects an operation name that is not a C# identifier", async () => {
    const [, diagnostics] = await emitWithDiagnostics(`${PREAMBLE}
      @route("/things") interface Things { @get \`do it\`(): string; }
    `);

    ok(
      invalidNames(diagnostics).some((m) =>
        m.includes('operation name "do it"'),
      ),
    );
  });

  it("rejects a parameter name that is not a C# identifier", async () => {
    const [, diagnostics] = await emitWithDiagnostics(`${PREAMBLE}
      @route("/things") interface Things { @get read(@query \`page-size\`?: int32): string; }
    `);

    ok(
      invalidNames(diagnostics).some((m) =>
        m.includes('parameter name "page-size"'),
      ),
    );
  });

  it("uses @clientName for a parameter and keeps its wire name", async () => {
    const [results, diagnostics] = await emitWithDiagnostics(`${PREAMBLE}
      @route("/things") interface Things {
        @get read(@clientName("pageSize") @query(#{ name: "page-size" }) size?: int32): string;
      }
    `);

    strictEqual(invalidNames(diagnostics).length, 0);
    ok(fileContent(results, "IThings.g.cs").includes("int? pageSize = null"));
    ok(
      fileContent(results, "ThingsEndpoint.g.cs").includes(
        'SetQueryParam("page-size", ClientRuntime.ToQueryValue(pageSize))',
      ),
    );
  });

  it("reports a bad name once however many versions use it", async () => {
    const [, diagnostics] = await emitWithDiagnostics(
      `
      import "@typespec/http";
      import "@typespec/versioning";
      using Http;
      using Versioning;

      @service(#{ title: "Test API" })
      @versioned(Versions)
      namespace TestApi;

      enum Versions { v1: "v1.0", v2: "v2.0", v3: "v3.0" }

      model \`my model\` { a: string; }

      @route("/things") interface Things { @get read(): \`my model\`; }
    `,
      { "all-versions": true },
    );

    strictEqual(invalidNames(diagnostics).length, 1);
  });
});

describe("enum member names", () => {
  it("sanitizes an odd member name and keeps its wire value", async () => {
    const [results, diagnostics] = await emitWithDiagnostics(`${PREAMBLE}
      enum Kind { \`my-member\`: "x", \`2fast\`: "y" }
      model Thing { kind: Kind; }

      @route("/things") interface Things { @get read(): Thing; }
    `);

    strictEqual(invalidNames(diagnostics).length, 0);
    const kind = fileContent(results, "Kind.g.cs");
    ok(kind.includes('[EnumMember(Value = "x")]'));
    ok(kind.includes("My_member,"));
    ok(kind.includes("_2fast,"));
    ok(kind.includes('"x" => Kind.My_member,'));
  });

  it("reports two members that end up with the same C# name", async () => {
    const [results, diagnostics] = await emitWithDiagnostics(`${PREAMBLE}
      enum Kind { \`a-b\`: "x", a_b: "y" }
      model Thing { kind: Kind; }

      @route("/things") interface Things { @get read(): Thing; }
    `);

    const messages = invalidNames(diagnostics);
    strictEqual(messages.length, 1);
    ok(messages[0].includes("enum member name"));
    ok(messages[0].includes('"A_b"'));
    strictEqual(
      [...fileContent(results, "Kind.g.cs").matchAll(/^\s+A_b,$/gm)].length,
      1,
      "The enum must still compile with one A_b member",
    );
  });
});

describe("version folder names", () => {
  const spec = (value: string) => `
    import "@typespec/http";
    import "@typespec/versioning";
    using Http;
    using Versioning;

    @service(#{ title: "Test API" })
    @versioned(Versions)
    namespace TestApi;

    enum Versions { v1: ${JSON.stringify(value)}, v2: "v2.0" }

    @route("/things") interface Things { @get read(): string; }
  `;

  for (const unsafe of ["../x", "a/b", "..", "v 1", "a\\b"]) {
    it(`rejects ${JSON.stringify(unsafe)} as a folder`, async () => {
      const [results, diagnostics] = await emitWithDiagnostics(spec(unsafe), {
        "all-versions": true,
      });

      ok(
        invalidNames(diagnostics).some((m) => m.includes("version name")),
        `Expected a version diagnostic for ${unsafe}`,
      );
      ok(
        !Object.keys(results).some((k) => k.includes("..")),
        "Nothing may be written outside the output directory",
      );
      ok(
        Object.keys(results).some((k) => k.includes("v2.0/")),
        "The remaining versions are still emitted",
      );
    });
  }

  it("does not care about the folder when one version is emitted", async () => {
    const [, diagnostics] = await emitWithDiagnostics(spec("../x"), {
      "target-version": "../x",
    });

    strictEqual(invalidNames(diagnostics).length, 0);
  });

  it("accepts an ordinary version value", async () => {
    const results = await emit(spec("2024-01-15"), { "all-versions": true });

    ok(Object.keys(results).some((k) => k.includes("2024-01-15/")));
  });
});

describe("runDotnetFormat", () => {
  const run = (deps: Partial<FormatDeps>) => {
    const reported: string[] = [];
    const calls: { command: string; args: string[] }[] = [];
    const program = {
      reportDiagnostic: (d: { message: string }) => reported.push(d.message),
    } as unknown as Program;
    runDotnetFormat(program, "/out", {
      exists: () => true,
      spawn: (command, args) => {
        calls.push({ command, args });
        return { error: undefined, status: 0, stderr: "" };
      },
      ...deps,
    });
    return { reported, calls };
  };

  it("does nothing when the output directory is not on the real filesystem", () => {
    const { reported, calls } = run({ exists: () => false });

    strictEqual(calls.length, 0);
    strictEqual(reported.length, 0);
  });

  it("formats the output directory without restoring", () => {
    const { reported, calls } = run({});

    strictEqual(calls.length, 1);
    strictEqual(calls[0].command, "dotnet");
    strictEqual(calls[0].args.join(" "), "format /out --no-restore");
    strictEqual(reported.length, 0);
  });

  it("reports the start error when dotnet cannot be run", () => {
    const { reported } = run({
      spawn: () => ({
        error: new Error("spawn dotnet ENOENT"),
        status: null,
        stderr: "",
      }),
    });

    strictEqual(reported.length, 1);
    ok(reported[0].includes("spawn dotnet ENOENT"));
  });

  it("reports stderr when dotnet exits with a failure", () => {
    const { reported } = run({
      spawn: () => ({ error: undefined, status: 2, stderr: "  boom  \n" }),
    });

    strictEqual(reported.length, 1);
    ok(reported[0].includes("dotnet format failed: boom"));
  });

  it("reports the exit code when dotnet fails without saying why", () => {
    const { reported } = run({
      spawn: () => ({ error: undefined, status: 3, stderr: "" }),
    });

    strictEqual(reported.length, 1);
    ok(reported[0].includes("exited with code 3"));
  });

  it("ignores a process that ended without a status and without an error", () => {
    const { reported } = run({
      spawn: () => ({ error: undefined, status: null, stderr: "" }),
    });

    strictEqual(reported.length, 0);
  });
});
