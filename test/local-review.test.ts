import { ok, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import { emit, emitWithDiagnostics, fileContent } from "./host.js";

const PREAMBLE = `
  import "@typespec/http";
  using Http;

  @service(#{ title: "Test API" })
  namespace TestApi;
`;

const codes = (
  diagnostics: readonly { code: string; message: string }[],
  suffix: string,
): string[] =>
  diagnostics.filter((d) => d.code.endsWith(suffix)).map((d) => d.message);

describe("cookie parameters", () => {
  it("sends a cookie parameter as a cookie", async () => {
    const results = await emit(`${PREAMBLE}
      @route("/c") interface Cookies {
        @get read(@cookie session: string, @cookie flavour?: string): string;
      }
    `);

    const client = fileContent(results, "CookiesEndpoint.g.cs");
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
      fileContent(results, "ICookies.g.cs").includes(
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
      "QueriesEndpoint.g.cs",
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
      fileContent(results, "QueriesEndpoint.g.cs").includes(
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

      const iface = fileContent(results, "IUploads.g.cs");
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

    const iface = fileContent(results, "IItems.g.cs");
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

  const unsupported: [string, string][] = [
    [
      "unixTimestamp",
      `@encode(DateTimeKnownEncoding.unixTimestamp, int64) when: utcDateTime;`,
    ],
    ["rfc7231", `@encode(DateTimeKnownEncoding.rfc7231) when: utcDateTime;`],
    [
      "seconds",
      `@encode(DurationKnownEncoding.seconds, float32) took: duration;`,
    ],
    ["base64url", `@encode(BytesKnownEncoding.base64url) raw: bytes;`],
  ];

  for (const [encoding, property] of unsupported) {
    it(`warns that ${encoding} cannot be honoured, rather than using the wrong format silently`, async () => {
      const { warnings } = await model(property);

      strictEqual(warnings.length, 1, encoding);
      ok(warnings[0].includes(`"${encoding}"`));
      ok(warnings[0].includes("default wire format"));
    });
  }

  it("warns for a parameter too", async () => {
    const [, diagnostics] = await emitWithDiagnostics(`${PREAMBLE}
      @route("/t") interface Things {
        @get read(@header @encode(DateTimeKnownEncoding.rfc7231) ifModifiedSince?: utcDateTime): string;
      }
    `);

    const warnings = codes(diagnostics, "unsupported-encoding");
    strictEqual(warnings.length, 1);
    ok(warnings[0].includes("parameter"));
    ok(warnings[0].includes('"rfc7231"'));
  });

  it("is only a warning, so generation still completes", async () => {
    const [results, diagnostics] = await emitWithDiagnostics(`${PREAMBLE}
      model Thing { @encode(DateTimeKnownEncoding.rfc7231) when: utcDateTime; }
      @route("/t") interface Things { @get read(): Thing; }
    `);

    ok(
      diagnostics
        .filter((d) => d.code.endsWith("unsupported-encoding"))
        .every((d) => d.severity === "warning"),
    );
    ok(Object.keys(results).some((k) => k.endsWith("Thing.g.cs")));
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
    ok(fileContent(results, "IPetstore.g.cs").includes("PingAsync("));
    ok(
      fileContent(results, "PetstoreEndpoint.g.cs").includes(
        "internal sealed class PetstoreEndpoint : IPetstore",
      ),
    );
    ok(
      fileContent(results, "PetstoreClientExtensions.g.cs").includes(
        "public class PetstoreClient",
      ),
    );
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
    ok(fileContent(results, "IPetstore.g.cs").includes("PingAsync("));
    ok(fileContent(results, "IAdmin.g.cs").includes("ReindexAsync("));
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
  for (const declaration of [
    `@encode("string") a: string;`,
    `@encode("string") when: utcDateTime;`,
    `@encode("string") took: duration;`,
  ]) {
    it(`warns for ${declaration}`, async () => {
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
