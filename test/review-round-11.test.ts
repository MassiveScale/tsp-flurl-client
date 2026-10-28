import { ok, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import { escapeCsString } from "../src/utils.js";
import { emit, emitWithDiagnostics, fileContent } from "./host.js";

const PREAMBLE = `
  import "@typespec/http";
  using Http;

  @service(#{ title: "Test API" })
  namespace TestApi;
`;

const SPEC = `${PREAMBLE}
  @route("/w") interface Widgets { @get read(): string; }
`;

/** Every character C# treats as a line break inside a string literal. */
const LINE_BREAKS = [0x0d, 0x0a, 0x85, 0x2028, 0x2029].map((code) =>
  String.fromCharCode(code),
);

describe("line breaks in C# string literals", () => {
  it("escapes every character C# treats as a line break", () => {
    const escaped = escapeCsString(`a${LINE_BREAKS.join("")}b`);

    for (const ch of LINE_BREAKS) {
      ok(!escaped.includes(ch), `U+${ch.charCodeAt(0).toString(16)} left raw`);
    }
    strictEqual(escaped, "a\\r\\n\\u0085\\u2028\\u2029b");
  });

  it("escapes a line break in route-prefix, so the generated route stays one literal", async () => {
    const results = await emit(SPEC, {
      "route-prefix": `api${String.fromCharCode(0x0a)}v1${String.fromCharCode(0x2028)}x`,
    });

    const line = fileContent(results, "WidgetsRequestBuilders.g.cs")
      .split("\n")
      .find((l) => l.includes("AppendPathSegment"));
    ok(line, "the route is on one line");
    ok(line.includes('$"api\\nv1\\u2028x/w"'), line);
  });

  it("still doubles braces in a route-prefix", async () => {
    const results = await emit(SPEC, { "route-prefix": "api/{static}" });

    ok(
      fileContent(results, "WidgetsRequestBuilders.g.cs").includes(
        '$"api/{{static}}/w"',
      ),
    );
  });
});

describe("target framework suffixes", () => {
  for (const bad of [
    "net8.0-.",
    "net8.0-..",
    "net8.0-windows.",
    "net8.0-windows10.",
    "net8.0-windows10..0",
    "net8.0-1",
    "net8.0-",
  ]) {
    it(`rejects ${JSON.stringify(bad)}`, async () => {
      const [, diagnostics] = await emitWithDiagnostics(SPEC, {
        "net-version": bad,
      });

      ok(
        diagnostics.some(
          (d) => d.code.endsWith("invalid-option") && d.message.includes(bad),
        ),
      );
    });
  }

  for (const good of [
    "net8.0-windows",
    "net8.0-windows10.0.19041",
    "net9.0-ios18.0",
    "net8.0-android",
    "net10.0-maccatalyst",
  ]) {
    it(`accepts ${JSON.stringify(good)}`, async () => {
      const results = await emit(SPEC, { "net-version": good });

      ok(fileContent(results, ".csproj").includes(good));
    });
  }
});
