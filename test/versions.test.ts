import { ok, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import { emit, emitWithDiagnostics, fileContent, has } from "./host.js";

/** A versioned service wrapped around the given declarations. */
const VERSIONED = (body: string) => `
  import "@typespec/http";
  import "@typespec/versioning";
  using Http;
  using Versioning;

  @service(#{ title: "Test API" })
  @versioned(Versions)
  namespace TestApi;

  enum Versions { v1: "v1.0", v2: "v2.0", v3: "v3.0" }

  ${body}
`;

describe("per-version output when all versions are emitted", () => {
  const all = { "all-versions": true };

  it("writes each version's models, enums and request records into its own folder and namespace", async () => {
    const results = await emit(
      VERSIONED(`
        enum Color { red }
        model Widget {
          @visibility(Lifecycle.Read) id: string;
          name: string;
          color?: Color;
        }

        @route("/widgets")
        interface Widgets { @post create(@body body: Widget): Widget; }
      `),
      all,
    );

    for (const [folder, ns] of [
      ["v1.0", "V1_0"],
      ["v2.0", "V2_0"],
      ["v3.0", "V3_0"],
    ]) {
      for (const file of ["Widget", "Color", "WidgetCreateRequest"]) {
        const content = fileContent(results, `${folder}/Models/${file}.g.cs`);
        ok(
          content.includes(`namespace TestApi.Client.${ns};`),
          `${folder}/Models/${file}.g.cs belongs in ${ns}`,
        );
      }
      ok(
        fileContent(
          results,
          `${folder}/Endpoints/WidgetsRequestBuilders.g.cs`,
        ).includes(`namespace TestApi.Client.${ns};`),
      );
    }
    ok(
      !Object.keys(results).some(
        (k) =>
          /(^|\/)Models\/(Widget|Color|WidgetCreateRequest)\.g\.cs$/.test(k) &&
          !/v\d\.0\//.test(k),
      ),
      "No unversioned copy of a versioned model is written",
    );
  });

  it("does not report a collision when versions reuse a name", async () => {
    const [, diagnostics] = await emitWithDiagnostics(
      VERSIONED(`
        model Widget { id: string; }
        @route("/widgets") interface Widgets { @get read(): Widget; }
      `),
      all,
    );

    strictEqual(
      diagnostics.filter((d) => d.code.endsWith("output-name-collision"))
        .length,
      0,
    );
  });

  it("projects model properties onto each version", async () => {
    const results = await emit(
      VERSIONED(`
        model Widget {
          id: string;
          @added(Versions.v2) color?: string;
          @removed(Versions.v3) legacy?: string;
          @added(Versions.v2) @removed(Versions.v3) transitional?: string;
        }
        @route("/widgets") interface Widgets { @get read(): Widget; }
      `),
      all,
    );

    const props = (folder: string): string[] =>
      [
        ...fileContent(results, `${folder}/Models/Widget.g.cs`).matchAll(
          /public \S+ (\w+) \{/g,
        ),
      ].map((m) => m[1]);
    strictEqual(props("v1.0").join(), "Id,Legacy");
    strictEqual(props("v2.0").join(), "Id,Color,Legacy,Transitional");
    strictEqual(props("v3.0").join(), "Id,Color");
  });

  it("emits a model only in the versions that have it", async () => {
    const results = await emit(
      VERSIONED(`
        model Always { id: string; }
        @added(Versions.v2) model Later { id: string; }
        @removed(Versions.v2) model Earlier { id: string; }

        @route("/a") interface A {
          @route("always") @get always(): Always;
          @route("later") @added(Versions.v2) @get later(): Later;
          @route("earlier") @removed(Versions.v2) @get earlier(): Earlier;
        }
      `),
      all,
    );

    ok(has(results, "v1.0/Models/Always.g.cs"));
    ok(has(results, "v1.0/Models/Earlier.g.cs"));
    ok(!has(results, "v1.0/Models/Later.g.cs"));
    ok(has(results, "v2.0/Models/Always.g.cs"));
    ok(has(results, "v2.0/Models/Later.g.cs"));
    ok(!has(results, "v2.0/Models/Earlier.g.cs"));
  });

  it("emits an enum only in the versions that have it, with only the members that exist", async () => {
    const results = await emit(
      VERSIONED(`
        enum Status { active, @added(Versions.v2) archived, @removed(Versions.v2) legacy }
        @added(Versions.v2) enum Tier { gold }
        model Widget { status: Status; @added(Versions.v2) tier?: Tier; }

        @route("/widgets") interface Widgets { @get read(): Widget; }
      `),
      all,
    );

    const members = (folder: string): string[] =>
      [
        ...fileContent(results, `${folder}/Models/Status.g.cs`).matchAll(
          /^\s+(\w+),$/gm,
        ),
      ].map((m) => m[1]);
    strictEqual(members("v1.0").join(), "Active,Legacy");
    strictEqual(members("v2.0").join(), "Active,Archived");

    const v1Converter = fileContent(results, "v1.0/Models/Status.g.cs");
    ok(v1Converter.includes('"legacy" => Status.Legacy,'));
    ok(!v1Converter.includes("Archived"));
    ok(!has(results, "v1.0/Models/Tier.g.cs"));
    ok(has(results, "v2.0/Models/Tier.g.cs"));
  });

  it("registers only the discriminated subtypes that exist in the version", async () => {
    const results = await emit(
      VERSIONED(`
        @discriminator("kind") model Pet { kind: string; name: string; }
        model Dog extends Pet { kind: "dog"; }
        @added(Versions.v2) model Cat extends Pet { kind: "cat"; }
        @removed(Versions.v3) model Fish extends Pet { kind: "fish"; }

        @route("/pets") interface Pets { @get list(): Pet[]; }
      `),
      all,
    );

    const pet = (folder: string): string =>
      fileContent(results, `${folder}/Models/Pet.g.cs`);
    ok(pet("v1.0").includes('typeof(Dog), "dog"'));
    ok(pet("v1.0").includes('typeof(Fish), "fish"'));
    ok(!pet("v1.0").includes("Cat"));
    ok(pet("v2.0").includes('typeof(Cat), "cat"'));
    ok(pet("v3.0").includes('typeof(Cat), "cat"'));
    ok(!pet("v3.0").includes("Fish"));

    ok(!has(results, "v1.0/Models/Cat.g.cs"));
    ok(has(results, "v2.0/Models/Cat.g.cs"));
    ok(has(results, "v1.0/Models/Fish.g.cs"));
    ok(!has(results, "v3.0/Models/Fish.g.cs"));
  });

  it("builds each version's request record from that version's properties", async () => {
    const results = await emit(
      VERSIONED(`
        model Widget {
          @visibility(Lifecycle.Read) id: string;
          name: string;
          @added(Versions.v2) color?: string;
        }
        @route("/widgets") interface Widgets { @post create(@body body: Widget): Widget; }
      `),
      all,
    );

    ok(
      !fileContent(results, "v1.0/Models/WidgetCreateRequest.g.cs").includes(
        "Color",
      ),
    );
    ok(
      fileContent(results, "v2.0/Models/WidgetCreateRequest.g.cs").includes(
        "Color",
      ),
    );
  });

  it("writes the shared helpers once, in the root namespace", async () => {
    const results = await emit(
      VERSIONED(`
        model Widget { id: string; name: string; }
        @route("/widgets")
        interface Widgets {
          @patch update(@path id: string, @body body: MergePatchUpdate<Widget>): Widget;
        }
      `),
      all,
    );

    for (const helper of ["ModelMap", "ClientRuntime", "MergePatch"]) {
      strictEqual(
        Object.keys(results).filter((k) => k.endsWith(`/${helper}.g.cs`))
          .length,
        1,
        `Expected one ${helper}`,
      );
      ok(
        fileContent(results, `${helper}.g.cs`).includes(
          "namespace TestApi.Client;",
        ),
      );
    }
    ok(
      fileContent(
        results,
        "v2.0/Endpoints/WidgetsRequestBuilders.g.cs",
      ).includes("IMergePatch<Widget> body"),
    );
  });

  it("reports a model whose name collides with a helper in any version", async () => {
    const [, diagnostics] = await emitWithDiagnostics(
      VERSIONED(`
        model ModelMap { id: string; }
        @route("/maps") interface Maps { @get read(): ModelMap; }
      `),
      all,
    );

    ok(
      diagnostics.some(
        (d) =>
          d.code.endsWith("output-name-collision") &&
          d.message.includes("ModelMap"),
      ),
    );
  });

  it("keeps the request record collision check within a version", async () => {
    const [, diagnostics] = await emitWithDiagnostics(
      VERSIONED(`
        model Widget { @visibility(Lifecycle.Read) id: string; name: string; }
        model WidgetCreateRequest { reason: string; }

        @route("/widgets")
        interface Widgets {
          @post create(@body body: Widget): Widget;
          @route("audit") @get audit(): WidgetCreateRequest;
        }
      `),
      all,
    );

    ok(diagnostics.some((d) => d.code.endsWith("output-name-collision")));
  });

  it("uses the version in the route of each client", async () => {
    const results = await emit(
      VERSIONED(`
        model Widget { id: string; }
        @route("/widgets") interface Widgets { @get read(): Widget; }
      `),
      all,
    );

    ok(
      fileContent(
        results,
        "v1.0/Endpoints/WidgetsRequestBuilders.g.cs",
      ).includes('AppendPathSegment($"api/v1.0/widgets")'),
    );
    ok(
      fileContent(
        results,
        "v3.0/Endpoints/WidgetsRequestBuilders.g.cs",
      ).includes('AppendPathSegment($"api/v3.0/widgets")'),
    );
  });

  it("omits an interface from versions where none of its operations exist", async () => {
    const results = await emit(
      VERSIONED(`
        @route("/old") interface Old { @removed(Versions.v2) @get read(): string; }
        @route("/new") interface Fresh { @added(Versions.v2) @get read(): string; }
      `),
      all,
    );

    ok(has(results, "v1.0/Endpoints/OldRequestBuilders.g.cs"));
    ok(!has(results, "v2.0/Endpoints/OldRequestBuilders.g.cs"));
    ok(!has(results, "v1.0/Endpoints/FreshRequestBuilders.g.cs"));
    ok(has(results, "v2.0/Endpoints/FreshRequestBuilders.g.cs"));
  });
});

describe("a single emitted version", () => {
  const spec = VERSIONED(`
    enum Status { active, @added(Versions.v2) archived }
    model Widget {
      id: string;
      @added(Versions.v2) color?: string;
      @removed(Versions.v2) legacy?: string;
      status: Status;
    }
    @added(Versions.v2) model Label { text: string; }

    @discriminator("kind") model Pet { kind: string; name: string; }
    model Dog extends Pet { kind: "dog"; }
    @added(Versions.v2) model Cat extends Pet { kind: "cat"; }

    @route("/widgets")
    interface Widgets {
      @get read(): Widget;
      @route("labels") @added(Versions.v2) @get labels(): Label[];
      @route("pets") @get pets(): Pet[];
    }
  `);

  it("projects models, enum members and subtypes onto the targeted version", async () => {
    const v1 = await emit(spec, { "target-version": "v1.0" });

    ok(!fileContent(v1, "Widget.g.cs").includes("Color"));
    ok(fileContent(v1, "Widget.g.cs").includes("Legacy"));
    ok(!fileContent(v1, "Status.g.cs").includes("Archived"));
    ok(!has(v1, "Label.g.cs"));
    ok(!has(v1, "Cat.g.cs"));
    ok(!fileContent(v1, "Pet.g.cs").includes("Cat"));

    const v2 = await emit(spec, { "target-version": "v2.0" });
    ok(fileContent(v2, "Widget.g.cs").includes("Color"));
    ok(!fileContent(v2, "Widget.g.cs").includes("Legacy"));
    ok(fileContent(v2, "Status.g.cs").includes("Archived"));
    ok(has(v2, "Label.g.cs"));
    ok(has(v2, "Cat.g.cs"));
    ok(fileContent(v2, "Pet.g.cs").includes('typeof(Cat), "cat"'));
  });

  it("defaults to the latest version", async () => {
    const results = await emit(spec);

    ok(fileContent(results, "Widget.g.cs").includes("Color"));
    ok(has(results, "Label.g.cs"));
  });

  it("keeps models in the root namespace while version-in-namespace moves the endpoints", async () => {
    const results = await emit(spec, {
      "target-version": "v2.0",
      "version-in-namespace": true,
    });

    ok(
      fileContent(results, "Widget.g.cs").includes("namespace TestApi.Client;"),
    );
    ok(
      fileContent(results, "WidgetsRequestBuilders.g.cs").includes(
        "namespace TestApi.Client.V2_0;",
      ),
    );
  });

  it("writes no per-version folders", async () => {
    const results = await emit(spec, { "target-version": "v2.0" });

    ok(!Object.keys(results).some((k) => /\/v\d\.0\//.test(k)));
    ok(has(results, "Models/Widget.g.cs"));
  });
});

describe("an unversioned API", () => {
  it("emits everything unfiltered", async () => {
    const results = await emit(`
      import "@typespec/http";
      using Http;

      @service(#{ title: "Test API" })
      namespace TestApi;

      enum Status { active, archived }
      model Widget { id: string; status: Status; }

      @route("/widgets") interface Widgets { @get read(): Widget; }
    `);

    ok(fileContent(results, "Status.g.cs").includes("Archived"));
    ok(fileContent(results, "Widget.g.cs").includes("Status"));
  });
});
