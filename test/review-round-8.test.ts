import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import { sortUsings } from "../src/utils.js";
import { emit, emitWithDiagnostics, fileContent } from "./host.js";

const PREAMBLE = `
  import "@typespec/http";
  using Http;

  @service(#{ title: "Test API" })
  namespace TestApi;
`;

const messagesFor = (
  diagnostics: readonly { code: string; message: string }[],
  suffix: string,
): string[] =>
  diagnostics.filter((d) => d.code.endsWith(suffix)).map((d) => d.message);

describe("members a derived record inherits", () => {
  const VEHICLES = `
    @discriminator("type")
    model Vehicle { type: string; wheels: int32; label: string; }
  `;

  it("reports a derived property whose C# name hides an inherited one", async () => {
    const [, diagnostics] = await emitWithDiagnostics(`${PREAMBLE}
      ${VEHICLES}
      model Car extends Vehicle { type: "car"; Label: string; }
      @route("/v") interface Vehicles { @get read(): Vehicle; }
    `);

    const messages = messagesFor(diagnostics, "name-collision");
    strictEqual(messages.length, 1);
    ok(messages[0].includes('the inherited property "label"'));
    ok(messages[0].includes("record Car"));
  });

  it("leaves a narrowing override to the inherited member", async () => {
    const [results, diagnostics] = await emitWithDiagnostics(`${PREAMBLE}
      ${VEHICLES}
      model Car extends Vehicle { type: "car"; wheels: 4; seats: int32; }
      @route("/v") interface Vehicles { @get read(): Vehicle; }
    `);

    strictEqual(messagesFor(diagnostics, "name-collision").length, 0);
    const car = fileContent(results, "Car.g.cs");
    ok(!car.includes("Wheels"));
    ok(car.includes("public int Seats"));
  });

  it("checks a request record only against the inherited properties visible in the request", async () => {
    const [results, diagnostics] = await emitWithDiagnostics(`${PREAMBLE}
      @discriminator("type")
      model Vehicle { type: string; @visibility(Lifecycle.Read) id: string; }
      model Car extends Vehicle { type: "car"; Id: string; }
      @route("/v") interface Vehicles { @post create(@body body: Vehicle): void; }
    `);

    // `id` is read-only, so CarCreateRequest inherits nothing called Id; the Car
    // model itself still reports the clash.
    const messages = messagesFor(diagnostics, "name-collision");
    ok(messages.every((m) => !m.includes("CarCreateRequest")));
    ok(
      fileContent(results, "CarCreateRequest.g.cs").includes(
        "public string Id",
      ),
    );
  });
});

describe("required properties that allow null", () => {
  it("writes a null for a required nullable property and leaves out an optional one", async () => {
    const results = await emit(`${PREAMBLE}
      model Thing {
        note: string | null;
        count: int32 | null;
        label?: string | null;
        name: string;
      }
      @route("/t") interface Things { @post create(@body body: Thing): void; }
    `);

    const thing = fileContent(results, "Thing.g.cs");
    const never = "[JsonIgnore(Condition = JsonIgnoreCondition.Never)]";
    const before = (property: string): string => {
      const at = thing.indexOf(`public ${property}`);
      return thing.slice(thing.lastIndexOf("[JsonPropertyName", at), at);
    };
    ok(before("string? Note").includes(never));
    ok(before("int? Count").includes(never));
    ok(!before("string? Label").includes(never));
    ok(!before("string Name").includes(never));
  });
});

describe("bodyless success responses", () => {
  it("returns null for the modeled empty status instead of reading the body", async () => {
    const results = await emit(`${PREAMBLE}
      model Item { name: string; }
      @route("/x") interface X {
        @get blob(): { @header contentType: "application/octet-stream"; @body body: bytes } | void;
        @route("i") @get item(): Item | void;
        @route("r") @get ranged(): { @statusCode _: 200; @body b: Item } | { @statusCode @minValue(204) @maxValue(205) _: int32 };
      }
    `);

    const client = fileContent(results, "XEndpoint.g.cs");
    ok(client.includes("if (flurlResponse.StatusCode == 204) return default;"));
    ok(client.includes("Task<byte[]?> BlobAsync("));
    ok(client.includes("flurlResponse.StatusCode is >= 204 and <= 205"));
  });

  it("does not treat a status that also carries a body as empty", async () => {
    const results = await emit(`${PREAMBLE}
      model Item { name: string; }
      @route("/x") interface X { @get read(): Item; }
    `);

    ok(!fileContent(results, "XEndpoint.g.cs").includes("return default;"));
  });
});

describe("charsets", () => {
  it("finds Windows and IBM code pages without registering a global provider", async () => {
    const results = await emit(`${PREAMBLE}
      @route("/n") interface Notes {
        @post write(@header contentType: "text/plain; charset=windows-1252", @body body: string): void;
      }
    `);

    const runtime = fileContent(results, "ClientRuntime.g.cs");
    ok(
      runtime.includes(
        "CodePagesEncodingProvider.Instance.GetEncoding(charSet) ?? Encoding.GetEncoding(charSet)",
      ),
    );
    ok(!runtime.includes("Encoding.RegisterProvider"));
  });
});

describe("using directives", () => {
  it("keeps a validated Unicode namespace exactly as given", () => {
    deepStrictEqual(sortUsings(["München.Models", "System"]), [
      "System",
      "München.Models",
    ]);
  });

  it("emits a Unicode additional-usings entry unchanged", async () => {
    const results = await emit(
      `${PREAMBLE}
      @route("/w") interface Widgets { @get read(): string; }
    `,
      { "additional-usings": ["München.Models"] },
    );

    ok(fileContent(results, "IWidgets.g.cs").includes("using München.Models;"));
  });

  it("sorts ordinally, with System and its children first, and dedupes", () => {
    deepStrictEqual(
      sortUsings([
        " b.X ",
        "a.Y",
        "SystemX",
        "System.Text",
        "System",
        "a.Y",
        "",
      ]),
      ["System", "System.Text", "SystemX", "a.Y", "b.X"],
    );
  });
});

describe("encodings of every success response body", () => {
  it("reports a later status whose body cannot be read with its encoding", async () => {
    const [results, diagnostics] = await emitWithDiagnostics(`${PREAMBLE}
      @route("/n") interface Numbers {
        @get read():
          | { @statusCode _: 200; @header contentType: "application/json"; @body n: int64 }
          | { @statusCode _: 201; @header contentType: "application/json"; @body @encode("string") m: int64 };
      }
    `);

    const messages = messagesFor(diagnostics, "unsupported-encoding");
    strictEqual(messages.length, 1, messages.join("; "));
    ok(messages[0].includes('The body "m"'));
    ok(fileContent(results, "INumbers.g.cs").includes("Task<long> ReadAsync("));
  });

  it("checks every body when the bodies differ and the result is a JsonElement", async () => {
    const [, diagnostics] = await emitWithDiagnostics(`${PREAMBLE}
      model Item { name: string; }
      @route("/n") interface Things {
        @get read():
          | { @statusCode _: 200; @body item: Item }
          | { @statusCode _: 201; @header contentType: "application/json"; @body @encode(DurationKnownEncoding.seconds, int32) took: duration };
      }
    `);

    const messages = messagesFor(diagnostics, "unsupported-encoding");
    strictEqual(messages.length, 1, messages.join("; "));
    ok(messages[0].includes('The body "took"'));
  });

  it("accepts a number encoded as a string when that body travels as plain text", async () => {
    const [, diagnostics] = await emitWithDiagnostics(`${PREAMBLE}
      @route("/n") interface Numbers {
        @get read():
          | { @statusCode _: 200; @body n: int64 }
          | { @statusCode _: 201; @body @encode("string") m: int64 };
      }
    `);

    strictEqual(messagesFor(diagnostics, "unsupported-encoding").length, 0);
  });
});
