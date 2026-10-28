import { ok, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import { getAccess, getClientName } from "../src/decorators.js";
import { tryParseSemver } from "../src/project.js";
import {
  BaseTester,
  emit,
  emitWithDiagnostics,
  fileContent,
  has,
  messagesFor,
} from "./host.js";

const PREAMBLE = `
  import "@typespec/http";
  using Http;

  @service(#{ title: "Test API" })
  namespace TestApi;
`;

describe("request records with operation-specific visibility", () => {
  const widget = `
    model Widget {
      @visibility(Lifecycle.Read) id: string;
      @visibility(Lifecycle.Create) secret: string;
      name: string;
    }
  `;

  it("gives two creates with different visible properties their own records", async () => {
    const results = await emit(`${PREAMBLE}
      ${widget}

      @route("/widgets")
      interface Widgets {
        @post create(@body body: Widget): Widget;

        @parameterVisibility(Lifecycle.Update)
        @route("drafts") @post createDraft(@body body: Widget): Widget;
      }
    `);

    const iface = fileContent(results, "WidgetsRequestBuilders.g.cs");
    ok(iface.includes("CreateAsync(WidgetCreateRequest body,"));
    ok(iface.includes("CreateDraftAsync(WidgetCreateDraftRequest body,"));

    const create = fileContent(results, "WidgetCreateRequest.g.cs");
    ok(create.includes("public string Secret"));
    ok(create.includes("public string Name"));

    const draft = fileContent(results, "WidgetCreateDraftRequest.g.cs");
    ok(
      !draft.includes("Secret"),
      "A Create-only property is not in an Update-visibility request",
    );
    ok(draft.includes("public string Name"));
  });

  it("shares one record between operations whose visible properties match", async () => {
    const results = await emit(`${PREAMBLE}
      ${widget}

      @route("/widgets")
      interface Widgets {
        @post create(@body body: Widget): Widget;
        @route("copies") @post createCopy(@body body: Widget): Widget;
      }
    `);

    const iface = fileContent(results, "WidgetsRequestBuilders.g.cs");
    ok(iface.includes("CreateAsync(WidgetCreateRequest body,"));
    ok(iface.includes("CreateCopyAsync(WidgetCreateRequest body,"));
    ok(
      !Object.keys(results).some((k) =>
        k.endsWith("WidgetCreateCopyRequest.g.cs"),
      ),
    );
  });

  it("falls back to the container name when the operation name is already taken", async () => {
    const results = await emit(`${PREAMBLE}
      ${widget}

      @route("/widgets")
      interface Widgets {
        @post create(@body body: Widget): Widget;
      }

      @route("/admin/widgets")
      interface Admin {
        @parameterVisibility(Lifecycle.Update)
        @post create(@body body: Widget): Widget;
      }
    `);

    ok(
      fileContent(results, "AdminRequestBuilders.g.cs").includes(
        "CreateAsync(WidgetAdminCreateRequest body,",
      ),
    );
    ok(
      !fileContent(results, "WidgetAdminCreateRequest.g.cs").includes("Secret"),
    );
  });

  it("reports a collision and leaves the operation out when no candidate name is free", async () => {
    const [results, diagnostics] = await emitWithDiagnostics(`${PREAMBLE}
      model Widget {
        @visibility(Lifecycle.Read) id: string;
        @visibility(Lifecycle.Create) secret: string;
        @visibility(Lifecycle.Update) note: string;
        name: string;
      }

      // Create: secret, name. Claims WidgetCreateRequest.
      @route("/a") interface A { @post create(@body body: Widget): void; }

      // Update: note, name. Takes WidgetXCreateRequest.
      @route("/x") interface X {
        @parameterVisibility(Lifecycle.Update) @post create(@body body: Widget): void;
      }

      // Read: id, name. WidgetCreateRequest and WidgetXCreateRequest differ, so it takes
      // WidgetZXCreateRequest.
      @route("/z") interface Z {
        @parameterVisibility(Lifecycle.Read) @post xCreate(@body body: Widget): void;
      }

      // Delete: name only. WidgetCreateRequest and WidgetZXCreateRequest both differ.
      @route("/zx") interface ZX {
        @parameterVisibility(Lifecycle.Delete) @post create(@body body: Widget): void;
      }
    `);

    ok(fileContent(results, "WidgetCreateRequest.g.cs"));
    ok(fileContent(results, "WidgetXCreateRequest.g.cs"));
    ok(
      fileContent(results, "WidgetZXCreateRequest.g.cs").includes(
        "public string Id",
      ),
    );

    const messages = messagesFor(diagnostics, "name-collision");
    strictEqual(messages.length, 1, messages.join(", "));
    ok(messages[0].includes("request record"));
    ok(messages[0].includes("WidgetZXCreateRequest"));
    ok(messages[0].includes("different visible properties"));
    ok(
      !has(results, "/ZXRequestBuilders.g.cs"),
      "The operation without a record is left out, and with it the only builder of ZX",
    );
    ok(
      !fileContent(results, "TestApiClientExtensions.g.cs").includes(
        "ZXRequestBuilder",
      ),
      "The client has no method for a builder that is not written",
    );
    ok(fileContent(results, "/XRequestBuilders.g.cs").includes("CreateAsync"));
  });
});

describe("JSON media types other than application/json", () => {
  it("sends a vendor JSON body with its declared media type through the configured serializer", async () => {
    const results = await emit(`${PREAMBLE}
      model Item { name: string; }

      @route("/items")
      interface Items {
        @post create(@header contentType: "application/vnd.acme+json", @body body: Item): void;
        @put replace(@header contentType: "application/json" | "application/vnd.acme+json", @body body: Item): void;
      }
    `);

    const client = fileContent(results, "ItemsRequestBuilders.g.cs");
    ok(
      client.includes(
        'ClientRuntime.JsonContent(flurlRequest, body, "application/vnd.acme+json")',
      ),
    );
    ok(
      client.includes("SendJsonAsync(HttpMethod.Put, body,"),
      "application/json is preferred when the operation accepts it",
    );
    ok(
      fileContent(results, "ClientRuntime.g.cs").includes(
        "request.Settings.JsonSerializer.Serialize(body!)",
      ),
    );
  });

  for (const json of [
    "application/problem+json",
    "text/json",
    "application/json; charset=utf-8",
  ]) {
    it(`treats ${json} as JSON`, async () => {
      const results = await emit(`${PREAMBLE}
        model Item { name: string; }
        @route("/items") interface Items {
          @post create(@header contentType: "${json}", @body body: Item): void;
        }
      `);

      ok(
        fileContent(results, "ItemsRequestBuilders.g.cs").includes(
          "JsonContent(",
        ),
      );
    });
  }

  for (const notJson of [
    "application/x-ndjson",
    "application/json-seq",
    "application/x-www-form-urlencoded",
  ]) {
    it(`reports a model sent as ${notJson}`, async () => {
      const [, diagnostics] = await emitWithDiagnostics(`${PREAMBLE}
        model Item { name: string; }
        @route("/items") interface Items {
          @post create(@header contentType: "${notJson}", @body body: Item): void;
        }
      `);

      const messages = messagesFor(diagnostics, "unsupported-feature");
      strictEqual(messages.length, 1);
      ok(messages[0].includes(notJson));
      ok(messages[0].includes("request body"));
    });
  }

  it("reports a model response declared only as XML", async () => {
    const [, diagnostics] = await emitWithDiagnostics(`${PREAMBLE}
      model Item { name: string; }
      @route("/items") interface Items {
        @get read(): { @header contentType: "application/xml"; @body body: Item };
      }
    `);

    const messages = messagesFor(diagnostics, "unsupported-feature");
    strictEqual(messages.length, 1);
    ok(messages[0].includes("response body"));
    ok(messages[0].includes("application/xml"));
  });
});

describe("plain-text scalar payloads", () => {
  for (const [tsp, cs] of [
    ["utcDateTime", "DateTimeOffset"],
    ["int32", "int"],
    ["duration", "TimeSpan"],
    ["boolean", "bool"],
    ["decimal", "decimal"],
  ]) {
    it(`reads a text/plain ${tsp} response with the text parser`, async () => {
      const results = await emit(`${PREAMBLE}
        @route("/v") interface Values { @get read(): ${tsp}; }
      `);

      ok(
        fileContent(results, "ValuesRequestBuilders.g.cs").includes(
          `return ClientRuntime.FromText<${cs}>(await flurlResponse.GetStringAsync().ConfigureAwait(false));`,
        ),
      );
    });

    it(`sends a text/plain ${tsp} body as its wire text`, async () => {
      const results = await emit(`${PREAMBLE}
        @route("/v") interface Values { @post write(@body body: ${tsp}): void; }
      `);

      ok(
        fileContent(results, "ValuesRequestBuilders.g.cs").includes(
          'ClientRuntime.TextContent(ClientRuntime.ToWireString(body), "text/plain")',
        ),
      );
    });
  }

  it("reads a string response as the text itself", async () => {
    const results = await emit(`${PREAMBLE}
      @route("/v") interface Values { @get read(): string; }
    `);

    ok(
      fileContent(results, "ValuesRequestBuilders.g.cs").includes(
        "return await flurlResponse.GetStringAsync().ConfigureAwait(false);",
      ),
    );
  });

  it("reads a union of scalars as text into a JsonElement", async () => {
    const results = await emit(`${PREAMBLE}
      @route("/v") interface Values { @get read(): int32 | string; }
    `);

    ok(
      fileContent(results, "ValuesRequestBuilders.g.cs").includes(
        "ClientRuntime.FromText<JsonElement>(",
      ),
    );
  });

  it("keeps a nullable scalar body as JSON, as TypeSpec declares it", async () => {
    const results = await emit(`${PREAMBLE}
      @route("/v") interface Values { @get read(): { @body b: int32 | null }; }
    `);

    ok(
      fileContent(results, "ValuesRequestBuilders.g.cs").includes(
        "GetJsonAsync<int?>()",
      ),
    );
  });
});

describe("a success response that may have no body", () => {
  it("returns a nullable model, and TResult? from the generic overload, when a 204 is possible", async () => {
    const results = await emit(`${PREAMBLE}
      model Widget { name: string; }
      @route("/w") interface Widgets { @get read(): Widget | void; }
    `);

    const iface = fileContent(results, "WidgetsRequestBuilders.g.cs");
    ok(iface.includes("Task<Widget?> ReadAsync("));
    ok(iface.includes("Task<TResult?> ReadAsync<TResult>("));
    ok(
      fileContent(results, "WidgetsRequestBuilders.g.cs").includes(
        "GetJsonAsync<TResult?>()",
      ),
    );
  });

  it("returns a nullable scalar parsed from text, so an empty body is null rather than an error", async () => {
    const results = await emit(`${PREAMBLE}
      @route("/v") interface Values {
        @route("n") @get count(): int32 | void;
        @route("s") @get label(): string | void;
      }
    `);

    const client = fileContent(results, "ValuesRequestBuilders.g.cs");
    ok(client.includes("Task<int?> CountAsync("));
    ok(client.includes("ClientRuntime.FromText<int?>("));
    ok(client.includes("Task<string?> LabelAsync("));
    ok(client.includes("ClientRuntime.FromText<string?>("));
  });

  it("keeps the result non-nullable when every success response has a body", async () => {
    const results = await emit(`${PREAMBLE}
      model Widget { name: string; }
      @route("/w") interface Widgets { @get read(): Widget | NotFoundResponse; }
    `);

    ok(
      fileContent(results, "WidgetsRequestBuilders.g.cs").includes(
        "Task<Widget> ReadAsync(",
      ),
    );
  });

  it("generates the text parser for every scalar the client maps to", async () => {
    const results = await emit(`${PREAMBLE}
      @route("/v") interface Values { @get read(): int32; }
    `);

    const runtime = fileContent(results, "ClientRuntime.g.cs");
    for (const parse of [
      "bool.Parse(text)",
      "DateTimeOffset.Parse(text, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal)",
      "DateOnly.Parse(text, CultureInfo.InvariantCulture)",
      "TimeOnly.Parse(text, CultureInfo.InvariantCulture)",
      "XmlConvert.ToTimeSpan(text)",
      "Guid.Parse(text)",
      "TextToJsonElement(text)",
      "ParseEnum(target, text)",
      "Convert.ChangeType(text, target, CultureInfo.InvariantCulture)",
    ]) {
      ok(runtime.includes(parse), `Expected ${parse}`);
    }
  });
});

describe("merge-patch values", () => {
  it("serializes a set value by its runtime type", async () => {
    const results = await emit(`${PREAMBLE}
      model Widget { name: string; }
      @route("/w") interface Widgets {
        @patch update(@body body: MergePatchUpdate<Widget>): Widget;
      }
    `);

    ok(
      fileContent(results, "MergePatch.g.cs").includes(
        "JsonSerializer.SerializeToElement(value, value.GetType(), OptionsFor(info, options ?? DefaultSerializerOptions))",
      ),
    );
  });
});

describe("NuGet versions derived from API versions", () => {
  for (const [input, expected] of [
    ["1.2-preview", "1.2.0-preview"],
    ["v2.0-preview.1", "2.0.0-preview.1"],
    ["1.0.0-rc.1+build.5", "1.0.0-rc.1+build.5"],
    ["1.0+20240101", "1.0.0+20240101"],
    ["1.0.0-x-y.0", "1.0.0-x-y.0"],
    ["1.0.0-0a", "1.0.0-0a"],
  ]) {
    it(`keeps the valid SemVer suffix of ${JSON.stringify(input)}`, () => {
      strictEqual(tryParseSemver(input), expected);
    });
  }

  for (const input of [
    "1.2-preview build",
    "1.2-preview_1",
    "1.2-",
    "1.2-pre..1",
    "1.2-01",
    "1.2+",
    "1.2+build+again",
    "01.2",
    "1.02",
    "1.2.03",
    "1.2-é",
  ]) {
    it(`does not treat ${JSON.stringify(input)} as SemVer`, () => {
      strictEqual(tryParseSemver(input), undefined);
    });
  }

  it("falls back to CalVer for a version that is not valid SemVer", async () => {
    const results = await emit(`
      import "@typespec/http";
      import "@typespec/versioning";
      using Http;
      using Versioning;

      @service(#{ title: "Test API" })
      @versioned(Versions)
      namespace TestApi;

      enum Versions { v1: "1.2-preview build" }

      @route("/w") interface Widgets { @get read(): string; }
    `);

    const version = /<Version>([^<]+)<\/Version>/.exec(
      fileContent(results, ".csproj"),
    )?.[1];
    ok(version && /^\d{4}\.\d{2}\.\d{2}$/.test(version), `Got ${version}`);
  });
});

describe("decorators on a template declaration", () => {
  const LIB_PREAMBLE = `
    import "@typespec/http";
    import "@massivescale/tsp-flurl-client";
    using Http;
    using MassiveScale.TspFlurlClient;

    @service(#{ title: "Test API" })
    namespace TestApi;
  `;

  it("emits a generic model marked @access(Access.internal) as internal", async () => {
    const results = await emit(`${LIB_PREAMBLE}
      @access(Access.internal) model Page<T> { items: T[]; }

      @access(Access.internal)
      @route("/v") interface Values { @get list(): Page<string>; }
    `);

    ok(fileContent(results, "Page.g.cs").includes("internal record Page<T>"));
  });

  it("emits a generic model renamed with @clientName under its new name everywhere", async () => {
    const results = await emit(`${LIB_PREAMBLE}
      @clientName("Paged") model Page<T> { items: T[]; }

      @route("/v") interface Values { @get list(): Page<string>; }
    `);

    ok(fileContent(results, "Paged.g.cs").includes("public record Paged<T>"));
    ok(
      fileContent(results, "ValuesRequestBuilders.g.cs").includes(
        "Task<Paged<string>> ListAsync(",
      ),
    );
    ok(!Object.keys(results).some((k) => k.endsWith("/Page.g.cs")));
  });

  it("does not emit when an instance of a template has an invalid @clientName", async () => {
    const [results, diagnostics] = await emitWithDiagnostics(`${LIB_PREAMBLE}
      @clientName("not valid") model Page<T> { items: T[]; }

      @route("/v") interface Values { @get list(): Page<string>; }
    `);

    ok(messagesFor(diagnostics, "invalid-client-name").length >= 1);
    strictEqual(Object.keys(results).length, 0);
  });

  it("reads the declaration's own decorators, ignoring an invalid name or access value", async () => {
    const { program } = await BaseTester.importLibraries().compile(`
      using MassiveScale.TspFlurlClient;
      namespace T;

      @clientName("not valid") model Bad<X> { x: X; }
      @clientName("  Good  ") @access(Access.internal) model Fine<X> { x: X; }
      model Plain<X> { x: X; }
      @clientName("Concrete") model NotTemplate { x: string; }
    `);

    const models = program.getGlobalNamespaceType().namespaces.get("T")!.models;
    strictEqual(getClientName(program, models.get("Bad")!), undefined);
    strictEqual(getAccess(program, models.get("Bad")!), undefined);
    strictEqual(getClientName(program, models.get("Fine")!), "Good");
    strictEqual(getAccess(program, models.get("Fine")!), "internal");
    strictEqual(getClientName(program, models.get("Plain")!), undefined);
    strictEqual(getAccess(program, models.get("Plain")!), undefined);
    strictEqual(getClientName(program, models.get("NotTemplate")!), "Concrete");
  });

  it("treats a template declaration without @access as public", async () => {
    const results = await emit(`${LIB_PREAMBLE}
      model Page<T> { items: T[]; }
      @route("/v") interface Values { @get list(): Page<string>; }
    `);

    ok(fileContent(results, "Page.g.cs").includes("public record Page<T>"));
  });
});
