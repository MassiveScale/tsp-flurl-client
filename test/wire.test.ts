import { ok, strictEqual, doesNotMatch } from "node:assert";
import { describe, it } from "node:test";
import { buildRouteExpression } from "../src/endpoints.js";
import { escapeCsIdentifier } from "../src/utils.js";
import { emit, fileContent } from "./host.js";

const PREAMBLE = `
  import "@typespec/http";
  using Http;

  @service(#{ title: "Test API" })
  namespace TestApi;
`;

describe("buildRouteExpression", () => {
  it("drops the leading slash", () =>
    strictEqual(buildRouteExpression("/api/items", new Map()), "api/items"));

  it("turns a path parameter into an encoding hole", () =>
    strictEqual(
      buildRouteExpression("/items/{id}", new Map([["id", "id"]])),
      "items/{ClientRuntime.EscapePathSegment(id)}",
    ));

  it("keeps the literal text around several parameters", () =>
    strictEqual(
      buildRouteExpression(
        "/stores/{storeId}/items/{id}/analyze",
        new Map([
          ["storeId", "storeId"],
          ["id", "itemId"],
        ]),
      ),
      "stores/{ClientRuntime.EscapePathSegment(storeId)}/items/{ClientRuntime.EscapePathSegment(itemId)}/analyze",
    ));

  it("tolerates RFC 6570 operators and explode markers", () =>
    strictEqual(
      buildRouteExpression(
        "/a/{+path}/{/id*}",
        new Map([
          ["path", "path"],
          ["id", "id"],
        ]),
      ),
      "a/{ClientRuntime.EscapePathSegment(path)}/{ClientRuntime.EscapePathSegment(id)}",
    ));

  it("leaves an unbound placeholder as escaped literal text", () =>
    strictEqual(
      buildRouteExpression("/items/{missing}", new Map()),
      "items/{{missing}}",
    ));

  it("escapes braces, quotes and backslashes in literal text", () =>
    strictEqual(buildRouteExpression('/a"b\\c}d', new Map()), 'a\\"b\\\\c}}d'));
});

describe("escapeCsIdentifier", () => {
  it("prefixes a reserved keyword with @", () =>
    strictEqual(escapeCsIdentifier("params"), "@params"));
  it("leaves any other identifier alone", () =>
    strictEqual(escapeCsIdentifier("widgetId"), "widgetId"));
});

describe("parameter binding", () => {
  it("binds query parameters by wire name", async () => {
    const results = await emit(`${PREAMBLE}
      @route("/items")
      interface Items {
        @get list(@query("page-size") pageSize?: int32, @query filter?: string): string[];
      }
    `);

    const client = fileContent(results, "ItemsEndpoint.g.cs");
    ok(
      client.includes(
        'flurlRequest.SetQueryParam("page-size", ClientRuntime.ToQueryValue(pageSize));',
      ),
    );
    ok(
      client.includes(
        'flurlRequest.SetQueryParam("filter", ClientRuntime.ToQueryValue(filter));',
      ),
    );
  });

  it("sends a header only when it has a value", async () => {
    const results = await emit(`${PREAMBLE}
      @route("/items")
      interface Items {
        @get list(@header("X-Trace") trace?: string): string[];
      }
    `);

    ok(
      fileContent(results, "ItemsEndpoint.g.cs").includes(
        'if (trace is not null) flurlRequest.WithHeader("X-Trace", ClientRuntime.ToWireString(trace));',
      ),
    );
  });

  it("encodes every path parameter", async () => {
    const results = await emit(`${PREAMBLE}
      @route("/stores/{storeId}/items/{itemId}")
      interface Items {
        @get read(@path storeId: string, @path itemId: string): string;
      }
    `);

    const client = fileContent(results, "ItemsEndpoint.g.cs");
    ok(
      client.includes(
        'AppendPathSegment($"api/stores/{ClientRuntime.EscapePathSegment(storeId)}/items/{ClientRuntime.EscapePathSegment(itemId)}")',
      ),
    );
  });

  it("escapes a parameter named after a C# keyword", async () => {
    const results = await emit(`${PREAMBLE}
      @route("/items")
      interface Items {
        @get list(@query params?: string, @query event?: string): string[];
      }
    `);

    const iface = fileContent(results, "IItems.g.cs");
    ok(iface.includes("string? @params = null"));
    ok(iface.includes("string? @event = null"));
    ok(
      fileContent(results, "ItemsEndpoint.g.cs").includes(
        "ClientRuntime.ToQueryValue(@params)",
      ),
    );
  });

  it("does not expose a Content-Type header as a parameter", async () => {
    const results = await emit(`${PREAMBLE}
      @route("/files")
      interface Files {
        @post upload(@header contentType: "application/octet-stream", @body body: bytes): void;
      }
    `);

    const iface = fileContent(results, "IFiles.g.cs");
    ok(iface.includes("UploadAsync(byte[] body,"));
    doesNotMatch(iface, /contentType/);
  });

  it("sends every verb with the matching HttpMethod", async () => {
    const results = await emit(`${PREAMBLE}
      model Item { name: string; }

      @route("/items")
      interface Items {
        @get a(): Item;
        @post b(@body body: Item): Item;
        @put c(@body body: Item): Item;
        @patch d(@body body: Item): Item;
        @delete e(): void;
        @head f(): void;
      }
    `);

    const client = fileContent(results, "ItemsEndpoint.g.cs");
    for (const verb of ["Get", "Post", "Put", "Patch", "Delete", "Head"]) {
      ok(client.includes(`HttpMethod.${verb}`), `Expected HttpMethod.${verb}`);
    }
  });
});

describe("payload kinds", () => {
  it("sends a model body as JSON", async () => {
    const results = await emit(`${PREAMBLE}
      model Item { name: string; }

      @route("/items")
      interface Items {
        @post create(@body body: Item): Item;
      }
    `);

    ok(
      fileContent(results, "ItemsEndpoint.g.cs").includes(
        "SendJsonAsync(HttpMethod.Post, body,",
      ),
    );
  });

  it("sends bytes raw with their media type", async () => {
    const results = await emit(`${PREAMBLE}
      @route("/files")
      interface Files {
        @post upload(@header contentType: "application/octet-stream", @body body: bytes): void;
      }
    `);

    ok(
      fileContent(results, "FilesEndpoint.g.cs").includes(
        'ClientRuntime.BytesContent(body, "application/octet-stream")',
      ),
    );
  });

  it("sends plain text raw with its media type", async () => {
    const results = await emit(`${PREAMBLE}
      @route("/notes")
      interface Notes {
        @post add(@header contentType: "text/plain", @body body: string): void;
      }
    `);

    ok(
      fileContent(results, "NotesEndpoint.g.cs").includes(
        'ClientRuntime.TextContent(body, "text/plain")',
      ),
    );
  });

  it("sends a string body as text, the TypeSpec default for strings", async () => {
    const results = await emit(`${PREAMBLE}
      @route("/notes")
      interface Notes {
        @post add(@body body: string): void;
      }
    `);

    ok(
      fileContent(results, "NotesEndpoint.g.cs").includes(
        'ClientRuntime.TextContent(body, "text/plain")',
      ),
    );
  });

  it("sends a string body as JSON when JSON is declared", async () => {
    const results = await emit(`${PREAMBLE}
      @route("/notes")
      interface Notes {
        @post add(@header contentType: "application/json", @body body: string): void;
      }
    `);

    ok(
      fileContent(results, "NotesEndpoint.g.cs").includes(
        "SendJsonAsync(HttpMethod.Post, body,",
      ),
    );
  });

  it("falls back to JSON for a non-JSON media type on a model", async () => {
    const results = await emit(`${PREAMBLE}
      model Item { name: string; }

      @route("/items")
      interface Items {
        @post create(@header contentType: "application/xml", @body body: Item): void;
      }
    `);

    ok(
      fileContent(results, "ItemsEndpoint.g.cs").includes(
        "SendJsonAsync(HttpMethod.Post, body,",
      ),
    );
  });

  it("reads a byte response raw", async () => {
    const results = await emit(`${PREAMBLE}
      @route("/files")
      interface Files {
        @get download(): { @header contentType: "application/octet-stream"; @body body: bytes };
      }
    `);

    const client = fileContent(results, "FilesEndpoint.g.cs");
    ok(client.includes("public async Task<byte[]> DownloadAsync("));
    ok(client.includes("GetBytesAsync()"));
  });

  it("reads a plain-text response raw", async () => {
    const results = await emit(`${PREAMBLE}
      @route("/notes")
      interface Notes {
        @get read(): { @header contentType: "text/plain"; @body body: string };
      }
    `);

    const client = fileContent(results, "NotesEndpoint.g.cs");
    ok(client.includes("public async Task<string> ReadAsync("));
    ok(client.includes("GetStringAsync()"));
  });

  it("reads nothing for a response with no body", async () => {
    const results = await emit(`${PREAMBLE}
      @route("/items")
      interface Items {
        @delete remove(@path id: string): void;
      }
    `);

    const client = fileContent(results, "ItemsEndpoint.g.cs");
    ok(client.includes("public async Task RemoveAsync("));
    doesNotMatch(client, /GetJsonAsync|GetBytesAsync|GetStringAsync/);
  });
});

describe("response selection", () => {
  it("reads the first success response that has a body", async () => {
    const results = await emit(`${PREAMBLE}
      model Item { id: string; }
      @error model Missing { reason: string; }

      @route("/items")
      interface Items {
        @get read(): Item | Missing;
      }
    `);

    const iface = fileContent(results, "IItems.g.cs");
    ok(iface.includes("Task<Item> ReadAsync("));
    ok(
      !iface.includes("Task<Missing>"),
      "The error model is not a success type",
    );
  });

  it("ignores a response with a wildcard status code", async () => {
    const results = await emit(`${PREAMBLE}
      model Item { id: string; }

      @route("/items")
      interface Items {
        @get read(): { @statusCode _: 200; @body body: Item } | { @statusCode _: 404; @body body: string };
      }
    `);

    ok(fileContent(results, "IItems.g.cs").includes("Task<Item> ReadAsync("));
  });
});

describe("access", () => {
  it("keeps the implementation internal whatever the interface access", async () => {
    const results = await emit(`${PREAMBLE}
      @route("/items")
      interface Items {
        @get list(): string[];
      }
    `);

    ok(
      fileContent(results, "ItemsEndpoint.g.cs").includes(
        "internal sealed class ItemsEndpoint : IItems",
      ),
    );
    ok(fileContent(results, "IItems.g.cs").includes("public interface IItems"));
  });
});
