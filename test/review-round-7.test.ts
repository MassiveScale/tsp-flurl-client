import { ok, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import { emit, emitWithDiagnostics, fileContent } from "./host.js";

const PREAMBLE = `
  import "@typespec/http";
  using Http;

  @service(#{ title: "Test API" })
  namespace TestApi;
`;

const VERSIONED = `
  import "@typespec/http";
  import "@typespec/versioning";
  using Http;
  using Versioning;

  @service(#{ title: "Test API" })
  @versioned(Versions)
  namespace TestApi;

  enum Versions { v1: "1.0", v2: "2.0" }

  @renamedFrom(Versions.v2, "Gadget")
  model Gizmo {
    @renamedFrom(Versions.v2, "title") name: string;
    @typeChangedFrom(Versions.v2, int32) size: string;
    @madeOptional(Versions.v2) note?: string;
  }

  model Page<T> { items: T[]; }
`;

const messagesFor = (
  diagnostics: readonly { code: string; message: string }[],
  suffix: string,
): string[] =>
  diagnostics.filter((d) => d.code.endsWith(suffix)).map((d) => d.message);

const has = (results: Record<string, string>, suffix: string): boolean =>
  Object.keys(results).some((k) => k.endsWith(suffix));

describe("version projection", () => {
  it("emits an older version with its original names, types, and optionality", async () => {
    const results = await emit(
      `${VERSIONED}
      @route("/g") interface Gizmos {
        @get read(@query @renamedFrom(Versions.v2, "q") search: string): Gizmo;
        @returnTypeChangedFrom(Versions.v2, int32) @route("n") @get count(): string;
      }
    `,
      { "target-version": "1.0" },
    );

    const gadget = fileContent(results, "Gadget.g.cs");
    ok(gadget.includes("public string Title"));
    ok(gadget.includes("public int Size"));
    ok(
      gadget.includes("public string Note { get; init; } = default!;"),
      "note is required in v1",
    );
    ok(!has(results, "/Gizmo.g.cs"));

    const iface = fileContent(results, "IGizmos.g.cs");
    ok(iface.includes("Task<Gadget> ReadAsync(string q,"));
    ok(iface.includes("Task<int> CountAsync("));
  });

  it("emits the latest version with the current shape", async () => {
    const results = await emit(`${VERSIONED}
      @route("/g") interface Gizmos { @get read(@query @renamedFrom(Versions.v2, "q") search: string): Gizmo; }
    `);

    const gizmo = fileContent(results, "Gizmo.g.cs");
    ok(gizmo.includes("public string Name"));
    ok(gizmo.includes("public string Size"));
    ok(gizmo.includes("public string? Note"));
    ok(
      fileContent(results, "IGizmos.g.cs").includes("ReadAsync(string search,"),
    );
  });

  it("projects the source of a merge-patch body, which TypeSpec records unprojected", async () => {
    const results = await emit(
      `${VERSIONED}
      @route("/g") interface Gizmos { @patch update(@body body: MergePatchUpdate<Gizmo>): Gizmo; }
    `,
      { "target-version": "1.0" },
    );

    ok(
      fileContent(results, "IGizmos.g.cs").includes("IMergePatch<Gadget> body"),
    );
    ok(has(results, "/Gadget.g.cs"));
    ok(
      !has(results, "/Gizmo.g.cs"),
      "the unprojected model must not leak into v1",
    );
  });

  it("projects the arguments of a template instance, which TypeSpec records unprojected", async () => {
    const results = await emit(
      `${VERSIONED}
      @route("/g") interface Gizmos { @get list(): Page<Gizmo>; }
    `,
      { "target-version": "1.0" },
    );

    ok(
      fileContent(results, "IGizmos.g.cs").includes(
        "Task<Page<Gadget>> ListAsync(",
      ),
    );
    ok(!has(results, "/Gizmo.g.cs"));
  });

  it("gives every version its own shape with all-versions", async () => {
    const results = await emit(
      `${VERSIONED}
      @route("/g") interface Gizmos {
        @get list(): Page<Gizmo>;
        @patch update(@body body: MergePatchUpdate<Gizmo>): Gizmo;
      }
    `,
      { "all-versions": true },
    );

    ok(has(results, "1.0/Models/Gadget.g.cs"));
    ok(!has(results, "1.0/Models/Gizmo.g.cs"));
    ok(has(results, "2.0/Models/Gizmo.g.cs"));
    ok(!has(results, "2.0/Models/Gadget.g.cs"));
  });
});

describe("file names that differ only in case", () => {
  it("reports two models whose files would be the same on Windows and macOS", async () => {
    const [, diagnostics] = await emitWithDiagnostics(`${PREAMBLE}
      model Widget { a: string; }
      model widget { b: string; }

      @route("/w") interface Widgets {
        @get one(): Widget;
        @route("two") @get two(): widget;
      }
    `);

    const messages = messagesFor(diagnostics, "output-name-collision");
    strictEqual(messages.length, 1, messages.join("; "));
    ok(
      messages[0].includes(
        '"Widget.g.cs" and "widget.g.cs" differ only in case',
      ),
    );
  });

  it("reports an interface and a model whose files differ only in case", async () => {
    const [, diagnostics] = await emitWithDiagnostics(`${PREAMBLE}
      model iwidgets { a: string; }

      @route("/w") interface Widgets { @get one(): iwidgets; }
    `);

    ok(messagesFor(diagnostics, "output-name-collision").length >= 1);
  });
});

describe("optional request bodies", () => {
  it("makes an optional body an optional parameter that sends nothing when omitted", async () => {
    const results = await emit(`${PREAMBLE}
      model Item { name: string; }

      @route("/i") interface Items {
        @post create(@query q: string, @body body?: Item, @query tag?: string): void;
        @route("t") @post note(@body body?: string): void;
      }
    `);

    const iface = fileContent(results, "IItems.g.cs");
    ok(
      iface.includes(
        "CreateAsync(string q, Item? body = null, string? tag = null,",
      ),
    );
    ok(iface.includes("NoteAsync(string? body = null,"));
    const client = fileContent(results, "ItemsEndpoint.g.cs");
    ok(
      client.includes(
        "body is null ? await flurlRequest.SendAsync(HttpMethod.Post, cancellationToken: cancellationToken).ConfigureAwait(false) : await flurlRequest.SendJsonAsync(HttpMethod.Post, body,",
      ),
    );
  });

  it("keeps a required body required", async () => {
    const results = await emit(`${PREAMBLE}
      model Item { name: string; }
      @route("/i") interface Items { @post create(@body body: Item): void; }
    `);

    ok(fileContent(results, "IItems.g.cs").includes("CreateAsync(Item body,"));
    ok(!fileContent(results, "ItemsEndpoint.g.cs").includes("body is null"));
  });
});

describe("success response shapes", () => {
  it("treats a body and the same body or null as one nullable shape", async () => {
    const results = await emit(`${PREAMBLE}
      model Item { name: string; }
      @route("/i") interface Items {
        @get read(): { @statusCode s: 200; @body b: Item } | { @statusCode s: 201; @body b: Item | null };
      }
    `);

    const iface = fileContent(results, "IItems.g.cs");
    ok(iface.includes("Task<Item?> ReadAsync("));
    ok(iface.includes("Task<TResult?> ReadAsync<TResult>("));
  });

  it("treats two identical anonymous shapes as one", async () => {
    const results = await emit(`${PREAMBLE}
      @route("/i") interface Items {
        @get read(): { @statusCode s: 200; @body b: string[] } | { @statusCode s: 201; @body b: string[] };
      }
    `);

    ok(
      fileContent(results, "IItems.g.cs").includes(
        "Task<List<string>> ReadAsync(",
      ),
    );
  });
});

describe("request records for a discriminated body", () => {
  const PETS = `${PREAMBLE}
    @discriminator("kind")
    model Pet {
      @visibility(Lifecycle.Read) id: string;
      @visibility(Lifecycle.Create) secret: string;
      @visibility(Lifecycle.Update) note: string;
      kind: string;
      name: string;
    }

    model Dog extends Pet {
      kind: "dog";
      @visibility(Lifecycle.Read) chip: string;
      barks: boolean;
    }

    model Cat extends Pet { kind: "cat"; }
  `;

  it("filters the whole hierarchy so every subtype can be sent with its discriminator", async () => {
    const results = await emit(`${PETS}
      @route("/pets") interface Pets {
        @post create(@body body: Pet): Pet;
        @route("dogs") @post createDog(@body body: Dog): Dog;
      }
    `);

    const base = fileContent(results, "PetCreateRequest.g.cs");
    ok(
      base.includes(
        '[JsonPolymorphic(TypeDiscriminatorPropertyName = "kind")]',
      ),
    );
    ok(base.includes('[JsonDerivedType(typeof(DogCreateRequest), "dog")]'));
    ok(base.includes('[JsonDerivedType(typeof(CatCreateRequest), "cat")]'));
    ok(base.includes("public abstract record PetCreateRequest"));
    ok(!base.includes("Id"), "a read-only property is left out");

    const dog = fileContent(results, "DogCreateRequest.g.cs");
    ok(dog.includes("public record DogCreateRequest : PetCreateRequest"));
    ok(dog.includes("public bool Barks"));
    ok(!dog.includes("Chip"));
    ok(
      fileContent(results, "CatCreateRequest.g.cs").includes(
        ": PetCreateRequest",
      ),
    );

    const iface = fileContent(results, "IPets.g.cs");
    ok(iface.includes("CreateAsync(PetCreateRequest body,"));
    ok(iface.includes("CreateDogAsync(DogCreateRequest body,"));
  });

  it("uses the models themselves when no member of the hierarchy hides a property", async () => {
    const results = await emit(`${PREAMBLE}
      @discriminator("kind") model Pet { kind: string; name: string; }
      model Dog extends Pet { kind: "dog"; }
      @route("/pets") interface Pets { @post create(@body body: Pet): Pet; }
    `);

    ok(fileContent(results, "IPets.g.cs").includes("CreateAsync(Pet body,"));
    ok(!has(results, "PetCreateRequest.g.cs"));
  });

  it("gives a hierarchy filtered differently by another operation its own suffix", async () => {
    const results = await emit(`${PETS}
      @route("/pets") interface Pets {
        @post create(@body body: Pet): Pet;
        @parameterVisibility(Lifecycle.Update)
        @route("drafts") @post createDraft(@body body: Pet): Pet;
      }
    `);

    ok(
      fileContent(results, "IPets.g.cs").includes(
        "CreateDraftAsync(PetCreateDraftRequest body,",
      ),
    );
    ok(
      fileContent(results, "DogCreateDraftRequest.g.cs").includes(
        ": PetCreateDraftRequest",
      ),
    );
    ok(
      fileContent(results, "PetCreateDraftRequest.g.cs").includes(
        "typeof(DogCreateDraftRequest)",
      ),
    );
  });

  it("reports a collision when every suffix is taken by a differently filtered hierarchy", async () => {
    const [, diagnostics] = await emitWithDiagnostics(`${PETS}
      @route("/a") interface A { @post create(@body body: Pet): Pet; }
      @route("/x") interface X {
        @parameterVisibility(Lifecycle.Update) @post create(@body body: Pet): Pet;
      }
      @route("/z") interface Z {
        @parameterVisibility(Lifecycle.Read) @post xCreate(@body body: Pet): Pet;
      }
      @route("/zx") interface ZX {
        @parameterVisibility(Lifecycle.Delete) @post create(@body body: Pet): Pet;
      }
    `);

    const messages = messagesFor(diagnostics, "name-collision");
    strictEqual(messages.length, 1, messages.join("; "));
    ok(messages[0].includes("request record"));
  });
});

describe("template parameters", () => {
  it("declares every template parameter, including one no property uses", async () => {
    const results = await emit(`${PREAMBLE}
      model Item { n: string; }
      model Tagged<T, U> { value: T; }
      @route("/x") interface X { @get read(): Tagged<Item, string>; }
    `);

    ok(
      fileContent(results, "Tagged.g.cs").includes(
        "public record Tagged<T, U>",
      ),
    );
    ok(
      fileContent(results, "IX.g.cs").includes(
        "Task<Tagged<Item, string>> ReadAsync(",
      ),
    );
  });

  it("binds a projected argument used inside a union or an anonymous model", async () => {
    const results = await emit(
      `${VERSIONED}
      model Holder<T> { either: T | null; nested: { inner: T }; }
      @route("/h") interface Holders { @get read(): Holder<Gizmo>; }
    `,
      { "target-version": "1.0" },
    );

    ok(
      fileContent(results, "IHolders.g.cs").includes(
        "Task<Holder<Gadget>> ReadAsync(",
      ),
    );
    ok(!has(results, "/Gizmo.g.cs"));
  });

  it("projects a merge-patch source declared in a child namespace", async () => {
    const results = await emit(
      `${VERSIONED}
      namespace Parts {
        @renamedFrom(Versions.v2, "OldPart") model Part { name: string; }
      }
      @route("/p") interface Parts2 { @patch update(@body body: MergePatchUpdate<Parts.Part>): void; }
    `,
      { "target-version": "1.0" },
    );

    ok(
      fileContent(results, "IParts2.g.cs").includes(
        "IMergePatch<OldPart> body",
      ),
    );
    ok(!has(results, "/Part.g.cs"));
  });
});
