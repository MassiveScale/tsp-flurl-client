import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ok, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import {
  emit,
  emitWithDiagnostics,
  fileContent,
  messagesFor,
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

describe("XML documentation", () => {
  const DOC = 'Uses A & B for <value> and "quotes"';
  const ESCAPED = 'Uses A &amp; B for &lt;value&gt; and "quotes"';

  it("escapes every documented declaration: interface, operation, model, property, enum, member", async () => {
    const results = await emit(`${PREAMBLE}
      /** ${DOC} */
      enum Color { /** ${DOC} */ red }

      /** ${DOC} */
      model Widget { /** ${DOC} */ name: string; color: Color; }

      /** ${DOC} */
      @route("/w") interface Widgets {
        /** ${DOC} */
        @get read(): Widget;
      }
    `);

    for (const file of [
      "WidgetsRequestBuilders.g.cs",
      "Widget.g.cs",
      "Color.g.cs",
    ]) {
      const content = fileContent(results, file);
      ok(content.includes(ESCAPED), `${file} escapes its docs`);
      ok(!content.includes("A & B"), `${file} has no raw &`);
      ok(!content.includes("<value>"), `${file} has no raw tag`);
    }
  });

  it("reads documentation only through the escaping helper", () => {
    const src = resolve(fileURLToPath(import.meta.url), "../../../src");
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = resolve(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (
          entry.name.endsWith(".ts") &&
          !entry.name.endsWith("utils.ts")
        ) {
          if (/\bgetDoc\(/.test(readFileSync(path, "utf-8")))
            offenders.push(entry.name);
        }
      }
    };
    walk(src);
    strictEqual(
      offenders.length,
      0,
      `getDoc used outside docText in ${offenders.join(", ")}`,
    );
  });
});

describe("unsupported encodings anywhere in a payload", () => {
  const CUSTOM = `model M { @encode("custom") value: string; }`;

  for (const [where, spec] of [
    ["a request body", `@post send(@body body: M): void;`],
    ["a list in a response", `@get list(): M[];`],
    ["a nested property", `@get nested(): { inner: M };`],
    ["a template argument", `@get page(): Page<M>;`],
  ]) {
    it(`leaves out an operation that reaches one through ${where}`, async () => {
      const [results, diagnostics] = await emitWithDiagnostics(`${PREAMBLE}
        ${CUSTOM}
        model Page<T> { items: T[]; }
        @route("/m") interface Things {
          ${spec}
          @route("ok") @get ok(): string;
        }
      `);

      ok(messagesFor(diagnostics, "unsupported-encoding").length >= 1);
      ok(
        messagesFor(diagnostics, "unsupported-feature").some((m) =>
          m.includes('"M.value"'),
        ),
      );
      const iface = fileContent(results, "ThingsRequestBuilders.g.cs");
      ok(iface.includes("OkAsync"));
      strictEqual((iface.match(/Task.*Async\(/g) ?? []).length, 1, iface);
    });
  }

  it("leaves out an operation that reaches one through an inherited property", async () => {
    const [results] = await emitWithDiagnostics(`${PREAMBLE}
      model Base { @encode("custom") value: string; }
      model Derived extends Base { name: string; }
      @route("/m") interface Things {
        @get read(): Derived;
        @route("ok") @get ok(): string;
      }
    `);

    ok(
      !fileContent(results, "ThingsRequestBuilders.g.cs").includes("ReadAsync"),
    );
  });
});

describe("unions emitted as JsonElement", () => {
  it("still generates every variant's model, for Deserialize<T>()", async () => {
    const results = await emit(`${PREAMBLE}
      model Item { name: string; }
      model Other { id: string; }
      @route("/u") interface Unions {
        @get read(): { @body body: Item | Other };
        @route("p") @get nested(): { either: Item | Other };
      }
    `);

    ok(
      fileContent(results, "UnionsRequestBuilders.g.cs").includes(
        "Task<JsonElement> ReadAsync(",
      ),
    );
    ok(has(results, "/Item.g.cs"));
    ok(has(results, "/Other.g.cs"));
  });
});

describe("encodings on nullable properties", () => {
  it("encodes T | null as T, with no diagnostic", async () => {
    const [results, diagnostics] = await emitWithDiagnostics(`${PREAMBLE}
      model Thing {
        @encode(DateTimeKnownEncoding.unixTimestamp, int64) at: utcDateTime | null;
      }
      @route("/t") interface Things {
        @get read(): Thing;
        @patch update(@body body: MergePatchUpdate<Thing>): void;
      }
    `);

    strictEqual(messagesFor(diagnostics, "unsupported-encoding").length, 0);
    ok(
      fileContent(results, "Thing.g.cs").includes(
        "[JsonConverter(typeof(ClientRuntime.UnixSecondsConverter))]",
      ),
    );
    ok(
      fileContent(results, "ThingsRequestBuilders.g.cs").includes(
        "UpdateAsync(IMergePatch<Thing> body,",
      ),
    );
  });
});
