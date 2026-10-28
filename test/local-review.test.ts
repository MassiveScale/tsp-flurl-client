import { ok, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import {
  emit,
  emitWithDiagnostics,
  fileContent,
  messagesFor as codes,
} from "./host.js";

const PREAMBLE = `
  import "@typespec/http";
  using Http;

  @service(#{ title: "Test API" })
  namespace TestApi;
`;

describe("cookie parameters", () => {
  it("sends a cookie parameter as a cookie", async () => {
    const results = await emit(`${PREAMBLE}
      @route("/c") interface Cookies {
        @get read(@cookie session: string, @cookie flavour?: string): string;
      }
    `);

    const client = fileContent(results, "CookiesRequestBuilders.g.cs");
    ok(
      client.includes(
        'if (session is not null) flurlRequest.WithCookie("session", ClientRuntime.ToWireString(session));',
      ),
    );
    ok(
      client.includes(
        'if (flavour is not null) flurlRequest.WithCookie("flavour", ClientRuntime.ToWireString(flavour));',
      ),
    );
    ok(
      fileContent(results, "CookiesRequestBuilders.g.cs").includes(
        "string session, string? flavour = null",
      ),
    );
  });
});

describe("array query parameters", () => {
  const read = async (declaration: string) =>
    fileContent(
      await emit(`${PREAMBLE}
        @route("/q") interface Queries { @get read(${declaration}): string; }
      `),
      "QueriesRequestBuilders.g.cs",
    );

  it("sends an array as one comma-separated value by default, as TypeSpec defines", async () => {
    const client = await read("@query tags?: string[]");

    ok(
      client.includes(
        'SetQueryParam("tags", ClientRuntime.ToDelimitedQueryValue(tags))',
      ),
    );
  });

  it("sends an exploded array as repeated parameters", async () => {
    const client = await read("@query(#{ explode: true }) tags?: string[]");

    ok(
      client.includes(
        'SetQueryParam("tags", ClientRuntime.ToQueryValue(tags))',
      ),
    );
  });

  it("sends an explicitly unexploded array as one comma-separated value", async () => {
    const client = await read("@query(#{ explode: false }) tags?: string[]");

    ok(client.includes("ToDelimitedQueryValue(tags)"));
  });

  it("does not change how a scalar is sent", async () => {
    const client = await read("@query skip?: int32, @query name?: string");

    ok(
      client.includes(
        'SetQueryParam("skip", ClientRuntime.ToQueryValue(skip))',
      ),
    );
    ok(
      client.includes(
        'SetQueryParam("name", ClientRuntime.ToQueryValue(name))',
      ),
    );
  });

  it("applies to arrays of enums too", async () => {
    const results = await emit(`${PREAMBLE}
      enum Color { red, blue }
      @route("/q") interface Queries { @get read(@query colors?: Color[]): string; }
    `);

    ok(
      fileContent(results, "QueriesRequestBuilders.g.cs").includes(
        "ToDelimitedQueryValue(colors)",
      ),
    );
  });
});

describe("bodies that cannot be sent correctly", () => {
  const spec = (operation: string) => `${PREAMBLE}
    @route("/u") interface Uploads {
      ${operation}
      @route("ok") @get fine(): string;
    }
  `;

  const cases: [string, string, string][] = [
    [
      "a multipart request",
      `@post create(@header contentType: "multipart/form-data", @multipartBody body: { name: HttpPart<string>, file: HttpPart<bytes> }): void;`,
      "A multipart request body",
    ],
    [
      "a file request",
      `@post create(@body body: Http.File): void;`,
      "A file request body (Http.File)",
    ],
    [
      "a file response",
      `@get create(): Http.File;`,
      "A file response body (Http.File)",
    ],
  ];

  for (const [label, operation, feature] of cases) {
    it(`reports ${label} and leaves only that operation out`, async () => {
      const [results, diagnostics] = await emitWithDiagnostics(spec(operation));

      const messages = codes(diagnostics, "unsupported-feature");
      strictEqual(messages.length, 1, label);
      ok(messages[0].includes(feature), messages[0]);
      ok(messages[0].includes("FlurlClient"), "It says what to do instead");

      const iface = fileContent(results, "UploadsRequestBuilders.g.cs");
      ok(!iface.includes("CreateAsync("), "The operation is not generated");
      ok(iface.includes("FineAsync("), "Other operations are");
    });
  }

  it("still allows a multipart-looking error response, which is never read", async () => {
    const [, diagnostics] = await emitWithDiagnostics(`${PREAMBLE}
      @error model Oops { message: string; }
      @route("/u") interface Uploads { @get read(): string | Oops; }
    `);

    strictEqual(codes(diagnostics, "unsupported-feature").length, 0);
  });
});

describe("error models", () => {
  it("generates a model that only an error response uses", async () => {
    const results = await emit(`${PREAMBLE}
      @error model ApiError { code: int32; message: string; }
      model Item { id: string; }

      @route("/items") interface Items { @get read(): Item | ApiError; }
    `);

    const error = fileContent(results, "ApiError.g.cs");
    ok(error.includes("public record ApiError"));
    ok(error.includes("public int Code"));
  });

  it("generates the enums an error model uses", async () => {
    const results = await emit(`${PREAMBLE}
      enum Reason { missing, forbidden }
      @error model ApiError { reason: Reason; }

      @route("/items") interface Items { @get read(): string | ApiError; }
    `);

    ok(Object.keys(results).some((k) => k.endsWith("Reason.g.cs")));
  });

  it("does not make an error model a success type", async () => {
    const results = await emit(`${PREAMBLE}
      @error model ApiError { message: string; }
      model Item { id: string; }

      @route("/items") interface Items { @get read(): Item | ApiError; }
    `);

    const iface = fileContent(results, "ItemsRequestBuilders.g.cs");
    ok(iface.includes("Task<Item> ReadAsync("));
    ok(!iface.includes("where TResult : ApiError"));
  });
});

describe("@encode", () => {
  const model = async (properties: string) => {
    const [results, diagnostics] = await emitWithDiagnostics(`${PREAMBLE}
      model Thing { ${properties} }
      @route("/t") interface Things { @get read(): Thing; }
    `);
    return {
      thing: fileContent(results, "Thing.g.cs"),
      warnings: codes(diagnostics, "unsupported-encoding"),
    };
  };

  it("writes a number as a string when @encode(string) says so", async () => {
    const { thing, warnings } = await model(`
      @encode("string") big: int64;
      @encode("string") ratio: float64;
      @encode("string") price: decimal;
      @encode("string") optionalCount?: int32;
    `);

    strictEqual(warnings.length, 0);
    for (const [type, name] of [
      ["long", "Big"],
      ["double", "Ratio"],
      ["decimal", "Price"],
    ]) {
      ok(
        new RegExp(
          `\\[JsonNumberHandling\\(JsonNumberHandling.WriteAsString \\| JsonNumberHandling.AllowReadingFromString\\)\\]\\s+public ${type} ${name} `,
        ).test(thing),
        `Expected ${name} to be a ${type} written as a string`,
      );
    }
    ok(thing.includes("public int? OptionalCount"));
  });

  it("leaves an ordinary number alone", async () => {
    const { thing } = await model("plain: int64;");

    ok(!thing.includes("JsonNumberHandling"));
  });

  it("still maps a string-encoded boolean to a string", async () => {
    const { thing, warnings } = await model(`@encode("string") flag: boolean;`);

    strictEqual(warnings.length, 0);
    ok(thing.includes("public string Flag"));
  });

  it("accepts the encodings that are already the default", async () => {
    const { warnings } = await model(`
      @encode(DateTimeKnownEncoding.rfc3339) at: utcDateTime;
      @encode(DurationKnownEncoding.ISO8601) took: duration;
      @encode(BytesKnownEncoding.base64) blob: bytes;
    `);

    strictEqual(warnings.length, 0);
  });

  const implemented: [string, string, string][] = [
    [
      "unixTimestamp",
      `@encode(DateTimeKnownEncoding.unixTimestamp, int64) when: utcDateTime;`,
      "ClientRuntime.UnixSecondsConverter",
    ],
    [
      "rfc7231",
      `@encode(DateTimeKnownEncoding.rfc7231) when: utcDateTime;`,
      "ClientRuntime.Rfc7231Converter",
    ],
    [
      "seconds with a fraction",
      `@encode(DurationKnownEncoding.seconds, float32) took: duration;`,
      "ClientRuntime.SecondsConverter",
    ],
    [
      "whole seconds",
      `@encode(DurationKnownEncoding.seconds, int32) took: duration;`,
      "ClientRuntime.WholeSecondsConverter",
    ],
    [
      "milliseconds with a fraction",
      `@encode(DurationKnownEncoding.milliseconds, float64) took: duration;`,
      "ClientRuntime.MillisecondsConverter",
    ],
    [
      "whole milliseconds",
      `@encode(DurationKnownEncoding.milliseconds, int64) took: duration;`,
      "ClientRuntime.WholeMillisecondsConverter",
    ],
    [
      "base64url",
      `@encode(BytesKnownEncoding.base64url) raw: bytes;`,
      "ClientRuntime.Base64UrlConverter",
    ],
    [
      "a pipe-delimited list",
      `@encode(ArrayEncoding.pipeDelimited) tags: string[];`,
      "ClientRuntime.PipeDelimitedConverter<string>",
    ],
    [
      "a space-delimited list of numbers",
      `@encode(ArrayEncoding.spaceDelimited) counts: int32[];`,
      "ClientRuntime.SpaceDelimitedConverter<int>",
    ],
    [
      "an optional comma-delimited list",
      `@encode(ArrayEncoding.commaDelimited) maybe?: string[];`,
      "ClientRuntime.CommaDelimitedConverter<string>",
    ],
  ];

  for (const [name, property, converter] of implemented) {
    it(`writes ${name} with its converter`, async () => {
      const { thing, warnings } = await model(property);

      strictEqual(warnings.length, 0, warnings.join("; "));
      ok(thing.includes(`[JsonConverter(typeof(${converter}))]`), thing);
    });
  }

  it("applies the format to a parameter through the runtime encoder", async () => {
    const [results, diagnostics] = await emitWithDiagnostics(`${PREAMBLE}
      @route("/t") interface Things {
        @get read(@header @encode(DateTimeKnownEncoding.rfc7231) ifModifiedSince?: utcDateTime): string;
      }
    `);

    strictEqual(codes(diagnostics, "unsupported-encoding").length, 0);
    ok(
      fileContent(results, "ThingsRequestBuilders.g.cs").includes(
        'if (ifModifiedSince is not null) flurlRequest.WithHeader("if-modified-since", ClientRuntime.ToWireString(ClientRuntime.Encode(ifModifiedSince, ClientRuntime.WireEncoding.Rfc7231)));',
      ),
    );
  });

  it("reports an encoding the client cannot honour as an error", async () => {
    const [, diagnostics] = await emitWithDiagnostics(`${PREAMBLE}
      model Thing { @encode("custom") name: string; }
      @route("/t") interface Things { @get read(): Thing; }
    `);

    const errors = diagnostics.filter((d) =>
      d.code.endsWith("unsupported-encoding"),
    );
    strictEqual(errors.length, 1);
    strictEqual(errors[0].severity, "error");
    ok(errors[0].message.includes('"custom"'));
  });

  it("leaves out an operation whose parameter cannot be encoded", async () => {
    const [results, diagnostics] = await emitWithDiagnostics(`${PREAMBLE}
      @route("/t") interface Things {
        @get read(@query @encode("custom") q: string): string;
        @route("other") @get other(): string;
      }
    `);

    strictEqual(codes(diagnostics, "unsupported-encoding").length, 1);
    const iface = fileContent(results, "ThingsRequestBuilders.g.cs");
    ok(!iface.includes("ReadAsync"));
    ok(iface.includes("OtherAsync"));
  });

  it("reports a delimited list of models, which has no text form", async () => {
    const [, diagnostics] = await emitWithDiagnostics(`${PREAMBLE}
      model Item { name: string; }
      model Thing { @encode(ArrayEncoding.pipeDelimited) items: Item[]; }
      @route("/t") interface Things { @get read(): Thing; }
    `);

    strictEqual(codes(diagnostics, "unsupported-encoding").length, 1);
  });
});

describe("durations and integers", () => {
  it("writes and reads a duration as ISO 8601, which TimeSpan does not by default", async () => {
    const results = await emit(`${PREAMBLE}
      model Thing { took: duration; }
      @route("/t") interface Things { @get read(): Thing; }
    `);

    ok(fileContent(results, "Thing.g.cs").includes("public TimeSpan Took"));
    const runtime = fileContent(results, "ClientRuntime.g.cs");
    ok(
      runtime.includes(
        "class Iso8601DurationConverter : JsonConverter<TimeSpan>",
      ),
    );
    ok(runtime.includes("XmlConvert.ToTimeSpan"));
    ok(
      runtime.includes(
        "options.Converters.Add(new Iso8601DurationConverter());",
      ),
    );
  });

  it("makes a merge patch use the same options as the client", async () => {
    const results = await emit(`${PREAMBLE}
      model Thing { id: string; took: duration; }
      @route("/t") interface Things {
        @patch update(@path id: string, @body body: MergePatchUpdate<Thing>): Thing;
      }
    `);

    ok(
      fileContent(results, "MergePatch.g.cs").includes(
        "DefaultSerializerOptions =\n        ClientRuntime.CreateJsonOptions(null);",
      ),
    );
  });

  it("maps an integer to long and numeric to double", async () => {
    const results = await emit(`${PREAMBLE}
      model Thing { whole: integer; any: numeric; fl: float; }
      @route("/t") interface Things { @get read(): Thing; }
    `);

    const thing = fileContent(results, "Thing.g.cs");
    ok(thing.includes("public long Whole"));
    ok(thing.includes("public double Any"));
    ok(thing.includes("public double Fl"));
  });
});

describe("operations declared directly in the service namespace", () => {
  it("generates them with the default names, without colliding with the client", async () => {
    const [results, diagnostics] = await emitWithDiagnostics(`
      import "@typespec/http";
      using Http;

      @service(#{ title: "Petstore" })
      namespace Petstore;

      @get op ping(): string;
    `);

    strictEqual(
      diagnostics.filter((d) => d.severity === "error").length,
      0,
      "A bare operation must work with default names",
    );
    ok(
      fileContent(results, "PetstoreRequestBuilders.g.cs").includes(
        "PingAsync(",
      ),
    );
    ok(
      fileContent(results, "PetstoreRequestBuilders.g.cs").includes(
        "public sealed class PetstoreRequestBuilder : RequestBuilder<PetstoreRequestBuilder>",
      ),
    );
    const client = fileContent(results, "PetstoreClientExtensions.g.cs");
    ok(client.includes("public class PetstoreClient"));
    ok(client.includes("public PetstoreRequestBuilder Petstore() =>"));
  });

  it("names a child namespace's operations after the child namespace", async () => {
    const [results, diagnostics] = await emitWithDiagnostics(`
      import "@typespec/http";
      using Http;

      @service(#{ title: "Petstore" })
      namespace Petstore {
        @get op ping(): string;
        namespace Admin { @route("/admin") @post op reindex(): void; }
      }
    `);

    strictEqual(diagnostics.filter((d) => d.severity === "error").length, 0);
    ok(
      fileContent(results, "PetstoreRequestBuilders.g.cs").includes(
        "PingAsync(",
      ),
    );
    ok(
      fileContent(results, "AdminRequestBuilders.g.cs").includes(
        "ReindexAsync(",
      ),
    );
  });
});

describe("the runtime helper", () => {
  it("converts an array query value to one comma-separated value", async () => {
    const results = await emit(`${PREAMBLE}
      @route("/q") interface Q { @get read(@query tags?: string[]): string; }
    `);

    const runtime = fileContent(results, "ClientRuntime.g.cs");
    ok(
      runtime.includes(
        "internal static object? ToDelimitedQueryValue(object? value) =>",
      ),
    );
    ok(runtime.includes("value is null ? null : ToWireString(value);"));
  });
});

describe("nested discriminators", () => {
  const nested = `${PREAMBLE}
    @discriminator("kind") model Animal { kind: string; name: string; }

    @discriminator("breed")
    model Dog extends Animal { kind: "dog"; breed: string; }

    model Labrador extends Dog { breed: "labrador"; }

    @route("/animals") interface Animals { @get list(): Animal[]; }
  `;

  it("reports a model that is both a variant and the root of a discriminator of its own", async () => {
    const [, diagnostics] = await emitWithDiagnostics(nested);

    const messages = codes(diagnostics, "unsupported-nested-discriminator");
    strictEqual(messages.length, 1);
    ok(messages[0].includes('"Dog"'));
    ok(messages[0].includes('"Animal"'));
    ok(messages[0].includes("single discriminator"));
  });

  it("accepts a grouping model that has no discriminator of its own", async () => {
    const [results, diagnostics] = await emitWithDiagnostics(`${PREAMBLE}
      @discriminator("kind") model Animal { kind: string; name: string; }
      model Dog extends Animal {}
      model Labrador extends Dog { kind: "labrador"; }
      model Cat extends Animal { kind: "cat"; }

      @route("/animals") interface Animals { @get list(): Animal[]; }
    `);

    strictEqual(
      codes(diagnostics, "unsupported-nested-discriminator").length,
      0,
    );
    const animal = fileContent(results, "Animal.g.cs");
    ok(animal.includes('typeof(Labrador), "labrador"'));
    ok(animal.includes('typeof(Cat), "cat"'));
    ok(
      fileContent(results, "Dog.g.cs").includes(
        "public abstract record Dog : Animal",
      ),
    );
  });

  it("accepts a single-level hierarchy", async () => {
    const [, diagnostics] = await emitWithDiagnostics(`${PREAMBLE}
      @discriminator("kind") model Animal { kind: string; }
      model Dog extends Animal { kind: "dog"; }

      @route("/animals") interface Animals { @get list(): Animal[]; }
    `);

    strictEqual(
      codes(diagnostics, "unsupported-nested-discriminator").length,
      0,
    );
  });
});

describe("@encode(string) where it does not apply", () => {
  it("accepts @encode(string) on a string, which already is one", async () => {
    const [, diagnostics] = await emitWithDiagnostics(`${PREAMBLE}
      model Thing { @encode("string") a: string; }
      @route("/t") interface Things { @get read(): Thing; }
    `);

    strictEqual(codes(diagnostics, "unsupported-encoding").length, 0);
  });

  for (const declaration of [
    `@encode("string") when: utcDateTime;`,
    `@encode("string") took: duration;`,
  ]) {
    it(`reports ${declaration}`, async () => {
      const [, diagnostics] = await emitWithDiagnostics(`${PREAMBLE}
        model Thing { ${declaration} }
        @route("/t") interface Things { @get read(): Thing; }
      `);

      const warnings = codes(diagnostics, "unsupported-encoding");
      strictEqual(warnings.length, 1);
      ok(warnings[0].includes('"string"'));
    });
  }
});

describe("all-versions on an unversioned API", () => {
  it("emits the API as a normal unversioned unit instead of only a project file", async () => {
    const results = await emit(
      `${PREAMBLE}
      model Widget { id: string; }
      @route("/widgets") interface Widgets { @get read(): Widget; }
    `,
      { "all-versions": true },
    );

    ok(fileContent(results, "WidgetsRequestBuilders.g.cs"));
    ok(fileContent(results, "Widget.g.cs"));
    ok(fileContent(results, "ModelMap.g.cs"));
    ok(fileContent(results, ".csproj"));
    ok(
      !Object.keys(results).some((k) => /[\\/]v\d/.test(k)),
      "No version folder should be created",
    );
  });
});

describe("additional-usings validation", () => {
  const spec = `${PREAMBLE}
    @route("/w") interface Widgets { @get read(): string; }
  `;

  for (const bad of [
    "Acme.Shared-Models",
    "Acme..Shared",
    "class",
    "A;B",
    "A\nnamespace Evil",
  ]) {
    it(`rejects ${JSON.stringify(bad)}`, async () => {
      const [results, diagnostics] = await emitWithDiagnostics(spec, {
        "additional-usings": ["Acme.Shared", bad],
      });

      const messages = codes(diagnostics, "invalid-option");
      strictEqual(messages.length, 1, messages.join(", "));
      ok(messages[0].includes("additional-usings"));
      strictEqual(Object.keys(results).length, 0, "Nothing is written");
    });
  }

  it("accepts dotted namespaces", async () => {
    const results = await emit(spec, {
      "additional-usings": ["Acme.Shared", "Other"],
    });

    ok(
      fileContent(results, "WidgetsRequestBuilders.g.cs").includes(
        "using Acme.Shared;",
      ),
    );
  });
});

describe("net-version validation", () => {
  const spec = `${PREAMBLE}
    @route("/w") interface Widgets { @get read(): string; }
  `;

  for (const bad of [
    "net7.0",
    "net6.0",
    "netstandard2.0",
    "netcoreapp3.1",
    "net8",
    "net8.0&x",
    "net8.0;net7.0",
  ]) {
    it(`rejects ${JSON.stringify(bad)}`, async () => {
      const [results, diagnostics] = await emitWithDiagnostics(spec, {
        "net-version": bad,
      });

      const messages = codes(diagnostics, "invalid-option");
      strictEqual(messages.length, 1, messages.join(", "));
      ok(messages[0].includes("net-version"));
      ok(messages[0].includes(".NET 8"));
      strictEqual(Object.keys(results).length, 0, "Nothing is written");
    });
  }

  it("rejects a value that names no framework", async () => {
    const [, diagnostics] = await emitWithDiagnostics(spec, {
      "net-version": " ; ",
    });

    const messages = codes(diagnostics, "invalid-option");
    strictEqual(messages.length, 1);
    ok(messages[0].includes("names no target framework"));
  });

  for (const good of [
    "net8.0",
    "net9.0",
    "net10.0",
    "net8.0;net10.0",
    "net8.0-windows",
  ]) {
    it(`accepts ${JSON.stringify(good)}`, async () => {
      const results = await emit(spec, { "net-version": good });

      ok(fileContent(results, ".csproj").includes(good));
    });
  }
});

describe("numeric enum members beyond the long range", () => {
  it("emits a double literal for a value a long cannot hold", async () => {
    const results = await emit(`${PREAMBLE}
      enum Magnitude { one: 1, huge: 100000000000000000000, tiny: 0.5 }
      @route("/m") interface Ms { @get read(): Magnitude; }
    `);

    const enumSource = fileContent(results, "Magnitude.g.cs");
    ok(enumSource.includes("1L"));
    ok(enumSource.includes("100000000000000000000D"));
    ok(!enumSource.includes("100000000000000000000L"));
    ok(enumSource.includes("0.5D"));
  });

  it("emits a double literal when JavaScript prints the number in exponent form", async () => {
    const results = await emit(`${PREAMBLE}
      enum Magnitude { one: 1, huge: 1e21 }
      @route("/m") interface Ms { @get read(): Magnitude; }
    `);

    const enumSource = fileContent(results, "Magnitude.g.cs");
    ok(enumSource.includes("1e+21D"));
  });
});

describe("bytes in a query, header, or path", () => {
  it("renders them as base64 before treating them as a sequence", async () => {
    const results = await emit(`${PREAMBLE}
      @route("/b") interface Bs { @get read(@query data: bytes, @header("X-Blob") token: bytes): string; }
    `);

    const runtime = fileContent(results, "ClientRuntime.g.cs");
    const bytes = runtime.indexOf(
      "byte[] bytes => Convert.ToBase64String(bytes)",
    );
    ok(bytes > -1);
    ok(
      bytes < runtime.indexOf("IEnumerable sequence"),
      "byte[] must be matched before the IEnumerable case",
    );
  });
});
