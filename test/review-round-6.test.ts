import { ok, strictEqual } from "node:assert";
import { describe, it } from "node:test";
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

describe("success responses with different bodies", () => {
  it("returns a JsonElement, with no generic overload, when each success status has its own JSON body", async () => {
    const results = await emit(`${PREAMBLE}
      model Item { name: string; }
      model CreatedItem { id: string; }

      @route("/items") interface Items {
        @post upsert(): { @statusCode s: 200; @body b: Item } | { @statusCode s: 201; @body b: CreatedItem };
      }
    `);

    const iface = fileContent(results, "IItems.g.cs");
    ok(iface.includes("Task<JsonElement> UpsertAsync("));
    ok(!iface.includes("UpsertAsync<TResult>"));
    ok(
      fileContent(results, "ItemsEndpoint.g.cs").includes(
        "GetJsonAsync<JsonElement>()",
      ),
    );
    ok(
      fileContent(results, "Item.g.cs"),
      "Each body's model is generated for Deserialize<T>",
    );
    ok(fileContent(results, "CreatedItem.g.cs"));
  });

  it("keeps the declared type when every success status has the same body", async () => {
    const results = await emit(`${PREAMBLE}
      model Item { name: string; }

      @route("/items") interface Items {
        @post upsert(): Item | { @statusCode s: 201; @body b: Item };
      }
    `);

    const iface = fileContent(results, "IItems.g.cs");
    ok(iface.includes("Task<Item> UpsertAsync("));
    ok(iface.includes("Task<TResult> UpsertAsync<TResult>("));
  });

  it("makes the JsonElement nullable when a success response may also be empty", async () => {
    const results = await emit(`${PREAMBLE}
      model Item { name: string; }
      model CreatedItem { id: string; }

      @route("/items") interface Items {
        @post upsert(): { @statusCode s: 200; @body b: Item } | { @statusCode s: 201; @body b: CreatedItem } | { @statusCode s: 204 };
      }
    `);

    ok(
      fileContent(results, "IItems.g.cs").includes(
        "Task<JsonElement?> UpsertAsync(",
      ),
    );
  });

  it("reports different success bodies that are not all JSON", async () => {
    const [results, diagnostics] = await emitWithDiagnostics(`${PREAMBLE}
      model Item { name: string; }

      @route("/items") interface Items {
        @post upsert(): { @statusCode s: 200; @body b: Item } | { @statusCode s: 201; @body b: string };
        @get list(): Item[];
      }
    `);

    const messages = messagesFor(diagnostics, "unsupported-feature");
    strictEqual(messages.length, 1);
    ok(messages[0].includes("different bodies that are not all JSON"));
    ok(!fileContent(results, "IItems.g.cs").includes("UpsertAsync"));
  });
});

describe("responses declared with several media types", () => {
  it("reports a model that may arrive as JSON or XML", async () => {
    const [, diagnostics] = await emitWithDiagnostics(`${PREAMBLE}
      model Item { name: string; }
      @route("/items") interface Items {
        @get read(): { @header contentType: "application/json" | "application/xml"; @body b: Item };
      }
    `);

    const messages = messagesFor(diagnostics, "unsupported-feature");
    strictEqual(messages.length, 1);
    ok(
      messages[0].includes("may arrive as application/json or application/xml"),
    );
  });

  it("reports bytes that may arrive as JSON or raw", async () => {
    const [, diagnostics] = await emitWithDiagnostics(`${PREAMBLE}
      @route("/files") interface Files {
        @get read(): { @header contentType: "application/json" | "application/octet-stream"; @body b: bytes };
      }
    `);

    strictEqual(messagesFor(diagnostics, "unsupported-feature").length, 1);
  });

  it("reads a value that may arrive as JSON or text by the Content-Type that arrives", async () => {
    const results = await emit(`${PREAMBLE}
      @route("/labels") interface Labels {
        @get read(): { @header contentType: "application/json" | "text/plain"; @body b: string };
      }
    `);

    ok(
      fileContent(results, "LabelsEndpoint.g.cs").includes(
        "return await ClientRuntime.ReadJsonOrTextAsync<string>(flurlResponse).ConfigureAwait(false);",
      ),
    );
    const runtime = fileContent(results, "ClientRuntime.g.cs");
    ok(
      runtime.includes(
        "internal static async Task<T> ReadJsonOrTextAsync<T>(IFlurlResponse response)",
      ),
    );
    ok(
      runtime.includes(
        'mediaType.EndsWith("+json", StringComparison.OrdinalIgnoreCase)',
      ),
    );
  });

  it("sends a request declared as JSON or XML as JSON, since the client chooses", async () => {
    const results = await emit(`${PREAMBLE}
      model Item { name: string; }
      @route("/items") interface Items {
        @post create(@header contentType: "application/json" | "application/xml", @body body: Item): void;
      }
    `);

    ok(
      fileContent(results, "ItemsEndpoint.g.cs").includes(
        "SendJsonAsync(HttpMethod.Post, body,",
      ),
    );
  });
});

describe("text bodies with a declared charset", () => {
  it("encodes text and vendor JSON with the charset the media type declares", async () => {
    const results = await emit(`${PREAMBLE}
      @route("/notes") interface Notes {
        @post write(@header contentType: "text/plain; charset=iso-8859-1", @body body: string): void;
      }
    `);

    ok(
      fileContent(results, "NotesEndpoint.g.cs").includes(
        'ClientRuntime.TextContent(ClientRuntime.ToWireString(body), "text/plain; charset=iso-8859-1")',
      ),
    );
    const runtime = fileContent(results, "ClientRuntime.g.cs");
    ok(
      runtime.includes(
        "private static HttpContent EncodedContent(string text, string contentType)",
      ),
    );
    ok(runtime.includes("Encoding.GetEncoding(charSet)"));
    ok(
      !runtime.includes("new StringContent("),
      "StringContent rejects a media type with parameters",
    );
  });
});

describe("decorators on a body property", () => {
  it('maps a @format("uuid") body to Guid in both directions', async () => {
    const results = await emit(`${PREAMBLE}
      @route("/ids") interface Ids {
        @post send(@body @format("uuid") id: string): void;
        @get read(): { @body @format("uuid") id: string };
      }
    `);

    ok(fileContent(results, "IIds.g.cs").includes("SendAsync(Guid body,"));
    ok(fileContent(results, "IIds.g.cs").includes("Task<Guid> ReadAsync("));
    ok(
      fileContent(results, "IdsEndpoint.g.cs").includes(
        "ClientRuntime.FromText<Guid>(",
      ),
    );
  });

  it('maps an @encode("string") boolean body to string', async () => {
    const results = await emit(`${PREAMBLE}
      @route("/flags") interface Flags {
        @post send(@body @encode("string") flag: boolean): void;
      }
    `);

    ok(fileContent(results, "IFlags.g.cs").includes("SendAsync(string body,"));
  });

  it("warns once about an encoding the client cannot produce on a request or response body", async () => {
    const [, diagnostics] = await emitWithDiagnostics(`${PREAMBLE}
      @route("/d") interface Durations {
        @post send(@body @encode(DurationKnownEncoding.seconds, int32) value: duration): void;
        @get read(): { @body @encode(DurationKnownEncoding.seconds, int32) took: duration };
      }
    `);

    const messages = messagesFor(diagnostics, "unsupported-encoding");
    strictEqual(messages.length, 2, messages.join(", "));
    ok(messages.some((m) => m.includes('The body "value"')));
    ok(messages.some((m) => m.includes('The body "took"')));
  });

  it("accepts a number encoded as a string when it travels as plain text", async () => {
    const [results, diagnostics] = await emitWithDiagnostics(`${PREAMBLE}
      @route("/n") interface Numbers {
        @post send(@body @encode("string") n: int64): void;
      }
    `);

    strictEqual(messagesFor(diagnostics, "unsupported-encoding").length, 0);
    ok(
      fileContent(results, "NumbersEndpoint.g.cs").includes(
        'ClientRuntime.TextContent(ClientRuntime.ToWireString(body), "text/plain")',
      ),
    );
  });

  it("warns about a number encoded as a string in a JSON body, which has no property to carry it", async () => {
    const [, diagnostics] = await emitWithDiagnostics(`${PREAMBLE}
      @route("/n") interface Numbers {
        @post send(@header contentType: "application/json", @body @encode("string") n: int64): void;
      }
    `);

    const messages = messagesFor(diagnostics, "unsupported-encoding");
    strictEqual(messages.length, 1);
    ok(messages[0].includes('The body "n"'));
  });
});

describe("encoding warnings across versions", () => {
  it("reports each declaration once, however many versions are emitted", async () => {
    const [, diagnostics] = await emitWithDiagnostics(
      `
      import "@typespec/http";
      import "@typespec/versioning";
      using Http;
      using Versioning;

      @service(#{ title: "Test API" })
      @versioned(Versions)
      namespace TestApi;

      enum Versions { v1: "1.0", v2: "2.0" }

      model M { @encode(DurationKnownEncoding.seconds, int32) d: duration; }

      @route("/x") interface X {
        @post send(
          @body @encode(DurationKnownEncoding.seconds, int32) value: duration,
          @query @encode(DurationKnownEncoding.seconds, int32) q: duration,
        ): M;
      }
    `,
      { "all-versions": true },
    );

    const messages = messagesFor(diagnostics, "unsupported-encoding");
    strictEqual(messages.length, 3, messages.join("; "));
  });
});
