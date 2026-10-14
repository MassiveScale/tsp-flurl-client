import { ok } from "node:assert";
import { describe, it } from "node:test";
import { emit, emitWithDiagnostics } from "./host.js";

describe("models", () => {
  const DISCRIMINATOR_SPEC = `
      import "@typespec/http";
      using Http;

      @service(#{ title: "Test API" })
      namespace TestApi;

      @discriminator("kind")
      model Pet {
        kind: string;
        name: string;
      }

      model Dog extends Pet {
        kind: "dog";
        isBarker: boolean;
      }

      model Cat extends Pet {
        kind: "cat";
        isPurrer: boolean;
      }

      @route("/pets")
      interface Pets {
        @get list(): Pet[];
      }
    `;

  it("emits a model record", async () => {
    const results = await emit(`
      import "@typespec/http";
      using Http;

      @service(#{ title: "Test API" })
      namespace TestApi;

      @doc("A widget.")
      model Widget {
        @doc("The name.")
        name: string;
        count: int32;
      }

      @route("/widgets")
      interface Widgets {
        @get list(): Widget[];
      }
    `);

    const modelFile = Object.keys(results).find((k) =>
      k.endsWith("Widget.g.cs"),
    );
    ok(modelFile, "Expected Widget.g.cs to be emitted");
    const content = results[modelFile];
    ok(content.includes("public record Widget"), "Expected record declaration");
    ok(
      content.includes('[JsonPropertyName("name")]'),
      "Expected JsonPropertyName for name",
    );
    ok(content.includes("public string Name"), "Expected Name property");
    ok(
      content.includes('[JsonPropertyName("count")]'),
      "Expected JsonPropertyName for count",
    );
    ok(content.includes("public int Count"), "Expected int Count property");
    ok(content.includes("/// <summary>"), "Expected opening summary tag");
    ok(content.includes("/// A widget."), "Expected doc comment text");
    ok(content.includes("/// </summary>"), "Expected closing summary tag");
    ok(
      content.includes("using System.Text.Json.Serialization"),
      "Expected System.Text.Json.Serialization using",
    );
  });

  it('maps a boolean with @encode("string") to C# string, leaving plain booleans as bool', async () => {
    const results = await emit(`
      import "@typespec/http";
      using Http;

      @service(#{ title: "Test API" })
      namespace TestApi;

      model Widget {
        @encode(string)
        active: boolean;
        enabled: boolean;
      }

      @route("/widgets")
      interface Widgets {
        @get list(): Widget[];
      }
    `);

    const modelFile = Object.keys(results).find((k) =>
      k.endsWith("Widget.g.cs"),
    );
    ok(modelFile, "Expected Widget.g.cs to be emitted");
    const content = results[modelFile];
    ok(
      content.includes("public string Active"),
      "Expected string-encoded boolean to map to C# string",
    );
    ok(
      content.includes("public bool Enabled"),
      "Expected a plain boolean to remain C# bool",
    );
  });

  it("emits mutually-referential models without overflowing the stack", async () => {
    // Regression test: Pet.store -> Store.pets -> Pet is a reference cycle.
    // gatherTemplateParams previously recursed through model properties with no
    // cycle guard, overflowing the stack with a RangeError on any such spec.
    const results = await emit(`
      import "@typespec/http";
      using Http;

      @service(#{ title: "Test API" })
      namespace TestApi;

      model Pet {
        name: string;
        store?: Store;
      }

      model Store {
        name: string;
        pets: Pet[];
      }

      @route("/pets")
      interface Pets {
        @get list(): Pet[];
      }
    `);

    const petFile = Object.keys(results).find((k) => k.endsWith("Pet.g.cs"));
    const storeFile = Object.keys(results).find((k) =>
      k.endsWith("Store.g.cs"),
    );
    ok(petFile, "Expected Pet.g.cs to be emitted");
    ok(storeFile, "Expected Store.g.cs to be emitted");
    ok(
      results[petFile].includes("public record Pet"),
      "Expected Pet record declaration",
    );
    ok(
      results[storeFile].includes("public record Store"),
      "Expected Store record declaration",
    );
  });

  it("emits an enum for TypeSpec enum types", async () => {
    const results = await emit(`
      import "@typespec/http";
      using Http;

      @service(#{ title: "Test API" })
      namespace TestApi;

      enum Color { Red: "red", Green: "green", Blue: "blue" }

      model Item { color: Color; }

      @route("/items")
      interface Items {
        @get list(): Item[];
      }
    `);

    const enumFile = Object.keys(results).find((k) => k.endsWith("Color.g.cs"));
    ok(enumFile, "Expected Color.cs");
    const content = results[enumFile];
    ok(content.includes("public enum Color"), "Expected enum declaration");
    ok(content.includes('[EnumMember(Value = "red")]'), "Expected red member");
  });

  it("generates a CreateRequest type excluding read-only properties for POST", async () => {
    const results = await emit(`
      import "@typespec/http";
      using Http;

      @service(#{ title: "Test API" })
      namespace TestApi;

      model Item {
        @visibility(TypeSpec.Lifecycle.Read)
        id: string;
        @visibility(TypeSpec.Lifecycle.Read)
        createdAt: utcDateTime;
        name: string;
        count: int32;
      }

      @route("/items")
      interface Items {
        @post create(@body body: Item): Item;
      }
    `);

    const requestFile = Object.keys(results).find((k) =>
      k.endsWith("ItemCreateRequest.g.cs"),
    );
    ok(requestFile, "Expected ItemCreateRequest.g.cs to be emitted");
    const content = results[requestFile];
    ok(
      content.includes("public record ItemCreateRequest"),
      "Expected record declaration",
    );
    ok(content.includes("public string Name"), "Expected Name property");
    ok(content.includes("public int Count"), "Expected Count property");
    ok(
      !content.includes("public string Id"),
      "Read-only Id should be excluded",
    );
    ok(
      !content.includes("CreatedAt"),
      "Read-only createdAt should be excluded",
    );

    const ifaceFile = Object.keys(results).find((k) =>
      k.endsWith("IItems.g.cs"),
    );
    ok(ifaceFile);
    ok(
      results[ifaceFile].includes("ItemCreateRequest body"),
      "Interface should reference ItemCreateRequest",
    );
  });

  it("generates an UpdateRequest type excluding read-only and create-only properties for PATCH", async () => {
    const results = await emit(`
      import "@typespec/http";
      using Http;

      @service(#{ title: "Test API" })
      namespace TestApi;

      model Item {
        @visibility(TypeSpec.Lifecycle.Read)
        id: string;
        @visibility(TypeSpec.Lifecycle.Read, TypeSpec.Lifecycle.Create)
        tenantId: string;
        name: string;
      }

      @route("/items")
      interface Items {
        @patch update(@path id: string, @body body: Item): Item;
      }
    `);

    const requestFile = Object.keys(results).find((k) =>
      k.endsWith("ItemUpdateRequest.g.cs"),
    );
    ok(requestFile, "Expected ItemUpdateRequest.g.cs to be emitted");
    const content = results[requestFile];
    ok(
      content.includes("public record ItemUpdateRequest"),
      "Expected record declaration",
    );
    ok(content.includes("public string Name"), "Expected Name property");
    ok(
      !content.includes("public string Id"),
      "Read-only Id should be excluded",
    );
    ok(
      !content.includes("TenantId"),
      "Create-only tenantId should be excluded from update",
    );

    const ifaceFile = Object.keys(results).find((k) =>
      k.endsWith("IItems.g.cs"),
    );
    ok(ifaceFile);
    ok(
      results[ifaceFile].includes("ItemUpdateRequest body"),
      "Interface should reference ItemUpdateRequest",
    );
  });

  it("emits generic records with correct type parameter and List<T> property type", async () => {
    const results = await emit(`
      import "@typespec/http";
      using Http;

      @service(#{ title: "Test API" })
      namespace TestApi;

      model Page<T> {
        items: T[];
        total?: int32;
      }

      model Widget { id: string; }

      @route("/widgets")
      interface Widgets {
        @get list(): Page<Widget>;
      }
    `);

    const pageFile = Object.keys(results).find((k) => k.endsWith("Page.g.cs"));
    ok(pageFile, "Expected Page.g.cs to be emitted");
    const content = results[pageFile];
    ok(
      content.includes("public record Page<T>"),
      "Expected generic record declaration",
    );
    ok(content.includes("public List<T>"), "Expected List<T> property type");
    ok(!content.includes("Array<T>"), "Should not emit Array<T>");
  });

  it("does not generate a request type when all properties are writable", async () => {
    const results = await emit(`
      import "@typespec/http";
      using Http;

      @service(#{ title: "Test API" })
      namespace TestApi;

      model Item { name: string; count: int32; }

      @route("/items")
      interface Items {
        @post create(@body body: Item): Item;
      }
    `);

    const requestFile = Object.keys(results).find((k) =>
      k.endsWith("ItemCreateRequest.g.cs"),
    );
    ok(
      !requestFile,
      "Should not emit ItemCreateRequest when all properties are writable",
    );

    const ifaceFile = Object.keys(results).find((k) =>
      k.endsWith("IItems.g.cs"),
    );
    ok(ifaceFile);
    ok(
      results[ifaceFile].includes("CreateAsync(Item body"),
      "Interface should use Item directly",
    );
  });

  it("emits all lines of a multi-line model doc with /// prefix", async () => {
    const results = await emit(`
      import "@typespec/http";
      using Http;

      @service(#{ title: "Test API" })
      namespace TestApi;

      @doc("First line.\\nSecond line.")
      model Widget {
        @doc("Prop first.\\nProp second.")
        name: string;
      }

      @route("/widgets")
      interface Widgets {
        @get list(): Widget[];
      }
    `);

    const modelFile = Object.keys(results).find((k) =>
      k.endsWith("Widget.g.cs"),
    );
    ok(modelFile, "Expected Widget.g.cs");
    const content = results[modelFile];
    ok(
      content.includes("/// First line."),
      "Expected first doc line on record",
    );
    ok(
      content.includes("/// Second line."),
      "Expected second doc line on record",
    );
    ok(
      !content.includes("Second line.") ||
        content.split("/// Second line.").length >= 2,
      "Second line must always start with ///",
    );
    ok(
      content.includes("/// Prop first."),
      "Expected first doc line on property",
    );
    ok(
      content.includes("/// Prop second."),
      "Expected second doc line on property",
    );
  });

  it("emits all lines of a multi-line enum doc with /// prefix", async () => {
    const results = await emit(`
      import "@typespec/http";
      using Http;

      @service(#{ title: "Test API" })
      namespace TestApi;

      @doc("Enum first.\\nEnum second.")
      enum Status {
        @doc("Member first.\\nMember second.")
        Active: "active",
      }

      model Item { status: Status; }

      @route("/items")
      interface Items {
        @get list(): Item[];
      }
    `);

    const enumFile = Object.keys(results).find((k) =>
      k.endsWith("Status.g.cs"),
    );
    ok(enumFile, "Expected Status.g.cs");
    const content = results[enumFile];
    ok(content.includes("/// Enum first."), "Expected first enum doc line");
    ok(content.includes("/// Enum second."), "Expected second enum doc line");
    ok(content.includes("/// Member first."), "Expected first member doc line");
    ok(
      content.includes("/// Member second."),
      "Expected second member doc line",
    );
  });

  it("@clientName on a model property uses the TypeSpec name as [JsonPropertyName]", async () => {
    const results = await emit(`
      import "@typespec/http";
      import "@massivescale/tsp-flurl-client";
      using Http;
      using MassiveScale.TspFlurlClient;

      @service(#{ title: "Test API" })
      namespace TestApi;

      model Widget {
        @clientName("CorrelationIdentifier")
        traceId: string;
      }

      @route("/widgets")
      interface Widgets {
        @get list(): Widget[];
      }
    `);

    const modelFile = Object.keys(results).find((k) =>
      k.endsWith("Widget.g.cs"),
    );
    ok(modelFile, "Expected Widget.g.cs");
    const content = results[modelFile];
    ok(
      content.includes('[JsonPropertyName("traceId")]'),
      "Expected JsonPropertyName to use original TypeSpec name",
    );
    ok(
      content.includes("public string CorrelationIdentifier"),
      "Expected C# property to use @clientName override",
    );
  });

  it("@clientName on a model overrides the emitted record name and file name", async () => {
    const results = await emit(`
      import "@typespec/http";
      import "@massivescale/tsp-flurl-client";
      using Http;
      using MassiveScale.TspFlurlClient;

      @service(#{ title: "Test API" })
      namespace TestApi;

      @clientName("Pet")
      model Animal { id: string; }

      @route("/animals")
      interface Animals {
        @get list(): Animal[];
      }
    `);

    const petFile = Object.keys(results).find((k) => k.endsWith("Pet.g.cs"));
    ok(petFile, "Expected Pet.g.cs (clientName override)");
    ok(
      results[petFile].includes("public record Pet"),
      "Expected record name Pet",
    );
    const animalFile = Object.keys(results).find((k) =>
      k.endsWith("Animal.g.cs"),
    );
    ok(!animalFile, "Animal.g.cs should not exist when clientName is Pet");

    const ifaceFile = Object.keys(results).find((k) =>
      k.endsWith("IAnimals.g.cs"),
    );
    ok(ifaceFile, "Expected IAnimals.g.cs");
    ok(
      results[ifaceFile].includes("Task<List<Pet>>"),
      "Expected Pet type reference in interface",
    );
  });

  it("@clientName on an enum overrides the emitted enum name and file name", async () => {
    const results = await emit(`
      import "@typespec/http";
      import "@massivescale/tsp-flurl-client";
      using Http;
      using MassiveScale.TspFlurlClient;

      @service(#{ title: "Test API" })
      namespace TestApi;

      @clientName("Color")
      enum Colour { red, green, blue }

      model Widget { color: Colour; }

      @route("/widgets")
      interface Widgets {
        @get list(): Widget[];
      }
    `);

    const colorFile = Object.keys(results).find((k) =>
      k.endsWith("Color.g.cs"),
    );
    ok(colorFile, "Expected Color.g.cs (clientName override)");
    ok(
      results[colorFile].includes("public enum Color"),
      "Expected enum name Color",
    );
    const colourFile = Object.keys(results).find((k) =>
      k.endsWith("Colour.g.cs"),
    );
    ok(!colourFile, "Colour.g.cs should not exist when clientName is Color");
  });

  it("reports an error for empty or whitespace @clientName values", async () => {
    const [, diags] = await emitWithDiagnostics(`
      import "@typespec/http";
      import "@massivescale/tsp-flurl-client";
      using Http;
      using MassiveScale.TspFlurlClient;

      @service(#{ title: "Test API" })
      namespace TestApi;

      @clientName("   ")
      model Widget { id: string; }

      @route("/widgets")
      interface Widgets {
        @get list(): Widget[];
      }
    `);

    ok(
      diags.some(
        (d) => d.code === "@massivescale/tsp-flurl-client/invalid-client-name",
      ),
      "Expected invalid-client-name diagnostic",
    );
  });

  it("reports an error when model and enum collide on output file name", async () => {
    const [, diags] = await emitWithDiagnostics(`
      import "@typespec/http";
      import "@massivescale/tsp-flurl-client";
      using Http;
      using MassiveScale.TspFlurlClient;

      @service(#{ title: "Test API" })
      namespace TestApi;

      @clientName("Shared")
      model Animal {
        id: string;
        color: Colour;
      }

      @clientName("Shared")
      enum Colour { red }

      @route("/animals")
      interface Animals {
        @get list(): Animal[];
      }
    `);

    ok(
      diags.some(
        (d) =>
          d.code === "@massivescale/tsp-flurl-client/output-name-collision",
      ),
      "Expected output-name-collision diagnostic",
    );
  });

  it("@access(Access.internal) on a model emits internal record", async () => {
    const results = await emit(`
      import "@typespec/http";
      import "@massivescale/tsp-flurl-client";
      using Http;
      using MassiveScale.TspFlurlClient;

      @service(#{ title: "Test API" })
      namespace TestApi;

      @access(Access.internal)
      model Widget { id: string; }

      @route("/widgets")
      interface Widgets {
        @get list(): Widget[];
      }
    `);

    const modelFile = Object.keys(results).find((k) =>
      k.endsWith("Widget.g.cs"),
    );
    ok(modelFile, "Expected Widget.g.cs");
    ok(
      results[modelFile].includes("internal record Widget"),
      "Expected internal record",
    );
    ok(
      !results[modelFile].includes("public record Widget"),
      "Should not contain public record",
    );
  });

  it("@access(Access.internal) on an enum emits internal enum", async () => {
    const results = await emit(`
      import "@typespec/http";
      import "@massivescale/tsp-flurl-client";
      using Http;
      using MassiveScale.TspFlurlClient;

      @service(#{ title: "Test API" })
      namespace TestApi;

      @access(Access.internal)
      enum Status { active, inactive }

      model Widget { status: Status; }

      @route("/widgets")
      interface Widgets {
        @get list(): Widget[];
      }
    `);

    const enumFile = Object.keys(results).find((k) =>
      k.endsWith("Status.g.cs"),
    );
    ok(enumFile, "Expected Status.g.cs");
    ok(
      results[enumFile].includes("internal enum Status"),
      "Expected internal enum",
    );
    ok(
      !results[enumFile].includes("public enum Status"),
      "Should not contain public enum",
    );
  });

  it("@access(Access.public) explicitly keeps public modifier", async () => {
    const results = await emit(`
      import "@typespec/http";
      import "@massivescale/tsp-flurl-client";
      using Http;
      using MassiveScale.TspFlurlClient;

      @service(#{ title: "Test API" })
      namespace TestApi;

      @access(Access.public)
      model Widget { id: string; }

      @route("/widgets")
      interface Widgets {
        @get list(): Widget[];
      }
    `);

    const modelFile = Object.keys(results).find((k) =>
      k.endsWith("Widget.g.cs"),
    );
    ok(modelFile, "Expected Widget.g.cs");
    ok(
      results[modelFile].includes("public record Widget"),
      "Expected public record when Access.public is explicit",
    );
  });

  it("emits [JsonPolymorphic] and one [JsonDerivedType] per derived model on the base record", async () => {
    const results = await emit(DISCRIMINATOR_SPEC);
    const petFile = Object.keys(results).find((k) => k.endsWith("Pet.g.cs"));
    ok(petFile, "Expected Pet.g.cs");
    const content = results[petFile];
    ok(
      content.includes(
        '[JsonPolymorphic(TypeDiscriminatorPropertyName = "kind")]',
      ),
      "Expected JsonPolymorphic attribute using the discriminator's wire name",
    );
    ok(
      content.includes('[JsonDerivedType(typeof(Dog), "dog")]'),
      "Expected JsonDerivedType for Dog",
    );
    ok(
      content.includes('[JsonDerivedType(typeof(Cat), "cat")]'),
      "Expected JsonDerivedType for Cat",
    );
  });

  it("emits the discriminated base record as abstract by default", async () => {
    const results = await emit(DISCRIMINATOR_SPEC);
    const petFile = Object.keys(results).find((k) => k.endsWith("Pet.g.cs"));
    ok(petFile, "Expected Pet.g.cs");
    ok(
      results[petFile].includes("public abstract record Pet"),
      "Expected Pet to be emitted as abstract, since a bare Pet has no valid JSON shape",
    );
  });

  it("emits leaf derived records as concrete (non-abstract) even with abstract-discriminated-base on", async () => {
    const results = await emit(DISCRIMINATOR_SPEC);
    const dogFile = Object.keys(results).find((k) => k.endsWith("Dog.g.cs"));
    ok(dogFile, "Expected Dog.g.cs");
    ok(
      results[dogFile].includes("public record Dog : Pet") &&
        !results[dogFile].includes("abstract"),
      "Expected Dog to remain a concrete, instantiable record since it's a resolved wire variant",
    );
  });

  it("keeps the discriminated base record concrete when abstract-discriminated-base is false", async () => {
    const results = await emit(DISCRIMINATOR_SPEC, {
      "abstract-discriminated-base": false,
    });
    const petFile = Object.keys(results).find((k) => k.endsWith("Pet.g.cs"));
    ok(petFile, "Expected Pet.g.cs");
    ok(
      results[petFile].includes("public record Pet") &&
        !results[petFile].includes("abstract"),
      "Expected Pet to remain concrete when the option is disabled",
    );
  });

  it("does not redeclare the discriminator property on the base record itself", async () => {
    // System.Text.Json throws InvalidOperationException at (de)serialization
    // time if a real property's [JsonPropertyName] collides with
    // TypeDiscriminatorPropertyName, so the base record must rely solely on
    // the [JsonPolymorphic]/[JsonDerivedType] attributes for it.
    const results = await emit(DISCRIMINATOR_SPEC);
    const petFile = Object.keys(results).find((k) => k.endsWith("Pet.g.cs"));
    ok(petFile, "Expected Pet.g.cs");
    const content = results[petFile];
    ok(
      !content.includes('[JsonPropertyName("kind")]'),
      "Discriminator property should not be redeclared as a member on the base record",
    );
    ok(
      content.includes('[JsonPropertyName("name")]'),
      "Expected Pet's own non-discriminator property to still be emitted",
    );
  });

  it("emits derived models as records inheriting the base record, without redeclaring the discriminator property", async () => {
    const results = await emit(DISCRIMINATOR_SPEC);
    const dogFile = Object.keys(results).find((k) => k.endsWith("Dog.g.cs"));
    ok(
      dogFile,
      "Expected Dog.g.cs to be emitted even though nothing references Dog directly",
    );
    const content = results[dogFile];
    ok(
      content.includes("public record Dog : Pet"),
      "Expected Dog to inherit from Pet in C#",
    );
    ok(
      !content.includes("Kind"),
      "Discriminator property should not be redeclared on the derived record",
    );
    ok(
      content.includes("public bool IsBarker"),
      "Expected Dog's own property to still be emitted",
    );
  });

  it("emits a sibling derived model (Cat) that is never referenced directly", async () => {
    const results = await emit(DISCRIMINATOR_SPEC);
    const catFile = Object.keys(results).find((k) => k.endsWith("Cat.g.cs"));
    ok(catFile, "Expected Cat.g.cs to be emitted");
    ok(
      results[catFile].includes("public record Cat : Pet"),
      "Expected Cat to inherit from Pet in C#",
    );
  });

  it("discovers grandchild variants through an intermediate model with no @discriminator of its own", async () => {
    const results = await emit(`
      import "@typespec/http";
      using Http;

      @service(#{ title: "Test API" })
      namespace TestApi;

      @discriminator("kind")
      model Pet {
        kind: string;
      }

      // Dog is a pass-through: no own discriminator value, just a grouping type.
      model Dog extends Pet {}

      model Labrador extends Dog {
        kind: "labrador";
        isGoodBoy: boolean;
      }

      model Poodle extends Dog {
        kind: "poodle";
        isFancy: boolean;
      }

      @route("/pets")
      interface Pets {
        @get list(): Pet[];
      }
    `);

    const dogFile = Object.keys(results).find((k) => k.endsWith("Dog.g.cs"));
    ok(dogFile, "Expected Dog.g.cs to be emitted");
    ok(
      results[dogFile].includes("public abstract record Dog : Pet"),
      "Expected Dog to inherit from Pet in C# and be abstract, since it never resolves to a concrete wire variant",
    );

    const labradorFile = Object.keys(results).find((k) =>
      k.endsWith("Labrador.g.cs"),
    );
    ok(
      labradorFile,
      "Expected Labrador.g.cs to be emitted despite Dog (its parent) lacking its own @discriminator",
    );
    ok(
      results[labradorFile].includes("public record Labrador : Dog") &&
        !results[labradorFile].includes("abstract"),
      "Expected Labrador to inherit from Dog in C# and be concrete, since it's a resolved wire variant",
    );

    const poodleFile = Object.keys(results).find((k) =>
      k.endsWith("Poodle.g.cs"),
    );
    ok(poodleFile, "Expected Poodle.g.cs to be emitted");

    const petFile = Object.keys(results).find((k) => k.endsWith("Pet.g.cs"));
    ok(petFile, "Expected Pet.g.cs");
    ok(
      results[petFile].includes(
        '[JsonDerivedType(typeof(Labrador), "labrador")]',
      ),
      "Expected JsonDerivedType for the grandchild Labrador on the root Pet record",
    );
    ok(
      results[petFile].includes('[JsonDerivedType(typeof(Poodle), "poodle")]'),
      "Expected JsonDerivedType for the grandchild Poodle on the root Pet record",
    );
  });
});
