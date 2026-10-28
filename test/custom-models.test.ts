import { ok, match, doesNotMatch, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import { emit, fileContent } from "./host.js";

const PREAMBLE = `
  import "@typespec/http";
  using Http;

  @service(#{ title: "Test API" })
  namespace TestApi;
`;

describe("generic overloads", () => {
  it("adds a generic overload constrained to the declared response model", async () => {
    const results = await emit(`${PREAMBLE}
      model Widget { id: string; }

      @route("/widgets")
      interface Widgets {
        @get read(@path id: string): Widget;
      }
    `);

    const iface = fileContent(results, "WidgetsRequestBuilders.g.cs");
    ok(
      iface.includes("Task<Widget> ReadAsync(CancellationToken"),
      "Expected the declared overload",
    );
    ok(
      iface.includes("Task<TResult> ReadAsync<TResult>(CancellationToken"),
      "Expected the generic overload",
    );
    match(
      iface,
      /where TResult : Widget$/m,
      "Expected the constraint on the declared model",
    );
    ok(
      iface.includes('<typeparam name="TResult">'),
      "Expected the type parameter to be documented",
    );
  });

  it("implements the declared overload by forwarding to the generic one", async () => {
    const results = await emit(`${PREAMBLE}
      model Widget { id: string; }

      @route("/widgets")
      interface Widgets {
        @get read(@path id: string): Widget;
      }
    `);

    const client = fileContent(results, "WidgetsRequestBuilders.g.cs");
    ok(
      client.includes("ReadAsync<Widget>(cancellationToken);"),
      "Expected the declared overload to forward with the declared model",
    );
    ok(
      client.includes("public async Task<TResult> ReadAsync<TResult>("),
      "Expected the generic overload to carry the implementation",
    );
    ok(
      client.includes("GetJsonAsync<TResult>()"),
      "Expected the response to be read as the type argument",
    );
  });

  it("keeps the type argument at the core of an array response", async () => {
    const results = await emit(`${PREAMBLE}
      model Widget { id: string; }

      @route("/widgets")
      interface Widgets {
        @get list(): Widget[];
      }
    `);

    const iface = fileContent(results, "WidgetsRequestBuilders.g.cs");
    ok(iface.includes("Task<List<Widget>> ListAsync("));
    ok(iface.includes("Task<List<TResult>> ListAsync<TResult>("));
    match(iface, /where TResult : Widget$/m);
    ok(
      fileContent(results, "WidgetsRequestBuilders.g.cs").includes(
        "GetJsonAsync<List<TResult>>()",
      ),
    );
  });

  it("keeps the type argument at the core of a record response", async () => {
    const results = await emit(`${PREAMBLE}
      model Widget { id: string; }

      @route("/widgets")
      interface Widgets {
        @get byName(): Record<Widget>;
      }
    `);

    const iface = fileContent(results, "WidgetsRequestBuilders.g.cs");
    ok(iface.includes("Task<Dictionary<string, Widget>> ByNameAsync("));
    ok(
      iface.includes("Task<Dictionary<string, TResult>> ByNameAsync<TResult>("),
    );
  });

  it("looks through nested collections", async () => {
    const results = await emit(`${PREAMBLE}
      model Widget { id: string; }

      @route("/widgets")
      interface Widgets {
        @get grid(): Widget[][];
      }
    `);

    ok(
      fileContent(results, "WidgetsRequestBuilders.g.cs").includes(
        "Task<List<List<TResult>>> GridAsync<TResult>(",
      ),
    );
  });

  it("constrains to a template instance as written", async () => {
    const results = await emit(`${PREAMBLE}
      model Widget { id: string; }
      model Page<T> { items: T[]; }

      @route("/widgets")
      interface Widgets {
        @get list(): Page<Widget>;
      }
    `);

    match(
      fileContent(results, "WidgetsRequestBuilders.g.cs"),
      /where TResult : Page<Widget>$/m,
    );
  });

  it("allows a discriminated base as the constraint", async () => {
    const results = await emit(`${PREAMBLE}
      @discriminator("kind")
      model Pet { kind: string; name: string; }
      model Dog extends Pet { kind: "dog"; }

      @route("/pets")
      interface Pets {
        @get list(): Pet[];
      }
    `);

    ok(
      fileContent(results, "PetsRequestBuilders.g.cs").includes(
        "Task<List<TResult>> ListAsync<TResult>(",
      ),
    );
    match(
      fileContent(results, "PetsRequestBuilders.g.cs"),
      /where TResult : Pet$/m,
    );
  });

  for (const [label, returnType] of [
    ["a scalar", "string"],
    ["a scalar array", "string[]"],
    ["an integer", "int32"],
    ["an enum", "Color"],
    ["no body", "void"],
    ["an anonymous model", "{ id: string }"],
    ["a union", "string | int32"],
  ] as const) {
    it(`adds no generic overload for ${label}`, async () => {
      const results = await emit(`${PREAMBLE}
        enum Color { red, blue }

        @route("/things")
        interface Things {
          @get read(): ${returnType};
        }
      `);

      doesNotMatch(
        fileContent(results, "ThingsRequestBuilders.g.cs"),
        /<TResult>/,
        `Unexpected generic overload for ${label}`,
      );
      doesNotMatch(
        fileContent(results, "ThingsRequestBuilders.g.cs"),
        /<TResult>/,
      );
    });
  }

  it("adds no generic overload for a merge-patch response model", async () => {
    const results = await emit(`${PREAMBLE}
      model Widget { id: string; name: string; }

      @route("/widgets")
      interface Widgets {
        @patch update(@path id: string, @body body: MergePatchUpdate<Widget>): MergePatchUpdate<Widget>;
      }
    `);

    doesNotMatch(
      fileContent(results, "WidgetsRequestBuilders.g.cs"),
      /<TResult>/,
    );
  });

  it("uses the same parameter list for both overloads", async () => {
    const results = await emit(`${PREAMBLE}
      model Widget { id: string; }

      @route("/widgets")
      interface Widgets {
        @get list(@query skip?: int32, @header("X-Trace") trace?: string): Widget[];
      }
    `);

    const iface = fileContent(results, "WidgetsRequestBuilders.g.cs");
    const params =
      "int? skip = null, string? trace = null, CancellationToken cancellationToken = default";
    ok(iface.includes(`ListAsync(${params}) =>`));
    ok(iface.includes(`ListAsync<TResult>(${params})`));
  });

  it("honours @clientName on the operation for both overloads", async () => {
    const results = await emit(`
      import "@typespec/http";
      import "@massivescale/tsp-flurl-client";
      using Http;
      using MassiveScale.TspFlurlClient;

      @service(#{ title: "Test API" })
      namespace TestApi;

      model Widget { id: string; }

      @route("/widgets")
      interface Widgets {
        @clientName("fetch") @get read(@path id: string): Widget;
      }
    `);

    const iface = fileContent(results, "WidgetsRequestBuilders.g.cs");
    ok(iface.includes("FetchAsync(CancellationToken"));
    ok(iface.includes("FetchAsync<TResult>(CancellationToken"));
  });
});

describe("request body parameters", () => {
  it("takes a collection of models as a covariant IEnumerable", async () => {
    const results = await emit(`${PREAMBLE}
      model Widget { id: string; }

      @route("/widgets")
      interface Widgets {
        @route("bulk") @post createMany(@body body: Widget[]): Widget[];
      }
    `);

    ok(
      fileContent(results, "WidgetsRequestBuilders.g.cs").includes(
        "CreateManyAsync(IEnumerable<Widget> body,",
      ),
    );
  });

  it("takes a dictionary of models as a covariant IReadOnlyDictionary", async () => {
    const results = await emit(`${PREAMBLE}
      model Widget { id: string; }

      @route("/widgets")
      interface Widgets {
        @route("bulk") @post createMany(@body body: Record<Widget>): void;
      }
    `);

    ok(
      fileContent(results, "WidgetsRequestBuilders.g.cs").includes(
        "CreateManyAsync(IReadOnlyDictionary<string, Widget> body,",
      ),
    );
  });

  it("loosens nested collections of models all the way down", async () => {
    const results = await emit(`${PREAMBLE}
      model Widget { id: string; }

      @route("/widgets")
      interface Widgets {
        @route("grid") @post createGrid(@body body: Widget[][]): void;
      }
    `);

    ok(
      fileContent(results, "WidgetsRequestBuilders.g.cs").includes(
        "CreateGridAsync(IEnumerable<IEnumerable<Widget>> body,",
      ),
    );
  });

  it("leaves a collection of scalars as a List", async () => {
    const results = await emit(`${PREAMBLE}
      @route("/tags")
      interface Tags {
        @post add(@body body: string[]): void;
      }
    `);

    ok(
      fileContent(results, "TagsRequestBuilders.g.cs").includes(
        "AddAsync(List<string> body,",
      ),
    );
  });

  it("takes a single model as the model itself, which already accepts derived types", async () => {
    const results = await emit(`${PREAMBLE}
      model Widget { id: string; }

      @route("/widgets")
      interface Widgets {
        @put replace(@path id: string, @body body: Widget): Widget;
      }
    `);

    ok(
      fileContent(results, "WidgetsRequestBuilders.g.cs").includes(
        "ReplaceAsync(Widget body,",
      ),
    );
  });

  it("takes a merge patch as the covariant IMergePatch", async () => {
    const results = await emit(`${PREAMBLE}
      model Widget { id: string; name: string; }

      @route("/widgets")
      interface Widgets {
        @patch update(@path id: string, @body body: MergePatchUpdate<Widget>): Widget;
      }
    `);

    const iface = fileContent(results, "WidgetsRequestBuilders.g.cs");
    ok(iface.includes("UpdateAsync(IMergePatch<Widget> body,"));
    ok(
      !iface.includes("(MergePatch<"),
      "Expected the interface, not the class",
    );
  });
});

describe("derived models and records", () => {
  it("emits records that can be derived from", async () => {
    const results = await emit(`${PREAMBLE}
      model Widget { id: string; }

      @route("/widgets")
      interface Widgets {
        @get read(): Widget;
      }
    `);

    const widget = fileContent(results, "Widget.g.cs");
    ok(widget.includes("public record Widget"));
    doesNotMatch(widget, /sealed/);
  });

  it("emits request records that can be derived from", async () => {
    const results = await emit(`${PREAMBLE}
      model Widget {
        @visibility(Lifecycle.Read) id: string;
        name: string;
      }

      @route("/widgets")
      interface Widgets {
        @post create(@body body: Widget): Widget;
      }
    `);

    const iface = fileContent(results, "WidgetsRequestBuilders.g.cs");
    ok(iface.includes("CreateAsync(WidgetCreateRequest body,"));
    ok(
      iface.includes(
        "Task<TResult> CreateAsync<TResult>(WidgetCreateRequest body,",
      ),
    );
    match(iface, /where TResult : Widget$/m);
    match(
      fileContent(results, "WidgetCreateRequest.g.cs"),
      /public record WidgetCreateRequest/,
    );
  });

  it("registers discriminated subtypes so they round-trip through the base", async () => {
    const results = await emit(`${PREAMBLE}
      @discriminator("kind")
      model Pet { kind: string; name: string; }
      model Dog extends Pet { kind: "dog"; }
      model Cat extends Pet { kind: "cat"; }

      @route("/pets")
      interface Pets {
        @get read(): Pet;
      }
    `);

    const pet = fileContent(results, "Pet.g.cs");
    ok(pet.includes('[JsonDerivedType(typeof(Dog), "dog")]'));
    ok(pet.includes('[JsonDerivedType(typeof(Cat), "cat")]'));
    strictEqual(
      Object.keys(results).filter((k) => /\/(Dog|Cat)\.g\.cs$/.test(k)).length,
      2,
    );
  });

  it("makes a subtype polymorphic, so a property declared as one keeps its discriminator", async () => {
    const results = await emit(`${PREAMBLE}
      @discriminator("kind")
      model Pet { kind: string; name: string; }
      model Dog extends Pet { kind: "dog"; }
      model Kennel { resident: Dog; }

      @route("/kennels")
      interface Kennels {
        @post create(@body body: Kennel): Kennel;
      }
    `);

    const runtime = fileContent(results, "ClientRuntime.g.cs");
    ok(
      runtime.includes("InheritPolymorphism(typeInfo, models);"),
      "CustomizeContract must hand a generated subtype to InheritPolymorphism",
    );
    ok(
      runtime.includes(
        "private static void InheritPolymorphism(JsonTypeInfo typeInfo, ModelMap models)",
      ),
    );
    ok(
      runtime.includes(
        "models.TryGetCustomType(derived.DerivedType, out var custom) ? custom : derived.DerivedType",
      ),
      "A mapped custom model replaces the subtype it maps, as it does under the base",
    );
  });
});
