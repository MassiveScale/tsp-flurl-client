import { ok, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import { emitWithDiagnostics, fileContent, messagesFor } from "./host.js";

const PREAMBLE = `
  import "@typespec/http";
  using Http;

  @service(#{ title: "Test API" })
  namespace TestApi;
`;

describe("operations using a nested discriminator", () => {
  const NESTED = `${PREAMBLE}
    @discriminator("kind") model Animal { kind: string; name: string; }
    @discriminator("breed") model Dog extends Animal { kind: "dog"; breed: string; }
    model Labrador extends Dog { breed: "labrador"; }
    model Kennel { residents: Animal[]; }
  `;

  it("leaves out an operation whose response reaches the hierarchy, before writing it", async () => {
    const [results, diagnostics] = await emitWithDiagnostics(`${NESTED}
      @route("/k") interface Kennels {
        @get read(): Kennel;
        @route("ping") @get ping(): string;
      }
    `);

    const features = messagesFor(diagnostics, "unsupported-feature");
    strictEqual(features.length, 1, features.join("; "));
    ok(features[0].includes('"Dog"'));
    ok(features[0].includes('"Animal"'));
    strictEqual(
      messagesFor(diagnostics, "unsupported-nested-discriminator").length,
      1,
    );
    const iface = fileContent(results, "IKennels.g.cs");
    ok(!iface.includes("ReadAsync"));
    ok(iface.includes("PingAsync"));
  });

  it("leaves out an operation whose request body reaches the hierarchy", async () => {
    const [results] = await emitWithDiagnostics(`${NESTED}
      @route("/k") interface Kennels {
        @post create(@body body: Animal): void;
        @route("ping") @get ping(): string;
      }
    `);

    ok(!fileContent(results, "IKennels.g.cs").includes("CreateAsync"));
  });
});

describe("nested discriminators reached only through an error response", () => {
  it("still reports the hierarchy when its models are written", async () => {
    const [, diagnostics] = await emitWithDiagnostics(`${PREAMBLE}
      @discriminator("kind") model Animal { kind: string; }
      @discriminator("breed") model Dog extends Animal { kind: "dog"; breed: string; }
      model Labrador extends Dog { breed: "labrador"; }
      @error model Problem { culprit: Animal; }
      @route("/k") interface Kennels { @get read(): string | Problem; }
    `);

    strictEqual(
      messagesFor(diagnostics, "unsupported-nested-discriminator").length,
      1,
    );
  });
});

describe("delimited lists of union items", () => {
  it("writes a delimited list whose items are a union of literals", async () => {
    const [results, diagnostics] = await emitWithDiagnostics(`${PREAMBLE}
      model Thing { @encode(ArrayEncoding.pipeDelimited) sizes: ("small" | "large")[]; }
      @route("/t") interface Things { @get read(): Thing; }
    `);

    strictEqual(messagesFor(diagnostics, "unsupported-encoding").length, 0);
    ok(
      fileContent(results, "Thing.g.cs").includes(
        "PipeDelimitedConverter<string>",
      ),
    );
  });
});
