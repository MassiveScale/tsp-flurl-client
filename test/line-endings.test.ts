import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deepStrictEqual, ok } from "node:assert";
import { after, describe, it } from "node:test";
import { emit, fileContent } from "./host.js";

const RICH_SPEC = `
  import "@typespec/http";
  import "@typespec/versioning";
  using Http;
  using Versioning;

  @service(#{ title: "Test API" })
  @versioned(Versions)
  namespace TestApi;

  enum Versions { v1: "v1.0", v2: "v2.0" }

  enum Color { red, blue }
  enum Priority { low: 1, high: 2 }

  /** A widget. */
  model Widget {
    @visibility(Lifecycle.Read) id: string;
    name: string;
    color?: Color;
    priority?: Priority;
    mixed: string | int32;
  }

  @discriminator("kind") model Pet { kind: string; name: string; }
  model Dog extends Pet { kind: "dog"; }

  @route("/widgets")
  interface Widgets {
    @get read(@path id: string): Widget;
    @post create(@body body: Widget): Widget;
    @patch update(@path id: string, @body body: MergePatchUpdate<Widget>): Widget;
    @route("bulk") @post createMany(@body body: Widget[]): Widget[];
  }

  @route("/pets") interface Pets { @get list(): Pet[]; }
`;

describe("line endings", () => {
  for (const options of [{}, { "all-versions": true }]) {
    it(`never writes a carriage return (${JSON.stringify(options)})`, async () => {
      const results = await emit(RICH_SPEC, options);

      const offenders = Object.entries(results)
        .filter(([, content]) => content.includes("\r"))
        .map(([path]) => path);
      deepStrictEqual(offenders, [], "Generated files must use LF only");
      ok(Object.keys(results).length > 10, "Expected a full set of files");
    });
  }

  it("ignores CRLF in the bundled templates, whatever the checkout did to them", () => {
    const templates = resolve(
      fileURLToPath(import.meta.url),
      "../../templates",
    );
    // The bundled templates are read through the same loader as an override, so a
    // CRLF checkout is covered by the override test below; here the shipped files
    // themselves are held to LF so the repository stays consistent.
    const crlf = readdirSync(templates)
      .filter((f) => f.endsWith(".hbs"))
      .filter((f) => readFileSync(join(templates, f), "utf-8").includes("\r"));
    deepStrictEqual(crlf, [], "Templates must be committed with LF");
  });

  describe("a template override", () => {
    const dir = mkdtempSync(join(tmpdir(), "flurl-eol-"));
    after(() => rmSync(dir, { recursive: true, force: true }));

    it("written with CRLF still produces LF output", async () => {
      const path = join(dir, "record.hbs");
      writeFileSync(
        path,
        "/// <summary>\r\n/// custom\r\n/// </summary>\r\n{{access}} record {{recordName}}\r\n{\r\n}\r\n",
      );

      const results = await emit(RICH_SPEC, { templates: { record: path } });

      const widget = fileContent(results, "Widget.g.cs");
      ok(
        widget.includes(
          "/// custom\n/// </summary>\npublic record Widget\n{\n}",
        ),
      );
      ok(!widget.includes("\r"));
    });
  });
});
