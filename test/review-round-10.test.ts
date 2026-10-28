import { ok } from "node:assert";
import { describe, it } from "node:test";
import { emit, fileContent, has } from "./host.js";

const PREAMBLE = `
  import "@typespec/http";
  using Http;

  @service(#{ title: "Test API" })
  namespace TestApi;
`;

describe("bulk request bodies", () => {
  const WIDGET = `${PREAMBLE}
    model Widget { @visibility(Lifecycle.Read) id: string; name: string; }
  `;

  it("filters a list body through to its items", async () => {
    const results = await emit(`${WIDGET}
      @route("/w") interface Widgets { @post createMany(@body body: Widget[]): Widget[]; }
    `);

    ok(
      fileContent(results, "WidgetsRequestBuilders.g.cs").includes(
        "CreateManyAsync(IEnumerable<WidgetCreateRequest> body,",
      ),
    );
    ok(!fileContent(results, "WidgetCreateRequest.g.cs").includes("Id"));
  });

  it("filters a dictionary body and a nested list body", async () => {
    const results = await emit(`${WIDGET}
      @route("/w") interface Widgets {
        @put replaceAll(@body body: Record<Widget>): void;
        @route("grid") @post grid(@body body: Widget[][]): void;
      }
    `);

    const iface = fileContent(results, "WidgetsRequestBuilders.g.cs");
    ok(
      iface.includes(
        "ReplaceAllAsync(IReadOnlyDictionary<string, WidgetReplaceRequest> body,",
      ),
    );
    ok(
      iface.includes(
        "GridAsync(IEnumerable<IEnumerable<WidgetCreateRequest>> body,",
      ),
    );
  });

  it("keeps the model for a list of a model that hides nothing", async () => {
    const results = await emit(`${PREAMBLE}
      model Owner { name: string; }
      @route("/o") interface Owners { @post createMany(@body body: Owner[]): void; }
    `);

    ok(
      fileContent(results, "OwnersRequestBuilders.g.cs").includes(
        "CreateManyAsync(IEnumerable<Owner> body,",
      ),
    );
    ok(!has(results, "OwnerCreateRequest.g.cs"));
  });

  it("filters a list of a discriminated model as a hierarchy", async () => {
    const results = await emit(`${PREAMBLE}
      @discriminator("kind")
      model Pet { @visibility(Lifecycle.Read) id: string; kind: string; }
      model Dog extends Pet { kind: "dog"; }
      @route("/p") interface Pets { @post createMany(@body body: Pet[]): void; }
    `);

    ok(
      fileContent(results, "PetsRequestBuilders.g.cs").includes(
        "CreateManyAsync(IEnumerable<PetCreateRequest> body,",
      ),
    );
    ok(
      fileContent(results, "PetCreateRequest.g.cs").includes(
        "typeof(DogCreateRequest)",
      ),
    );
  });
});

describe("empty text", () => {
  it("reads empty text as an empty string, and as null only for other types", async () => {
    const results = await emit(`${PREAMBLE}
      @route("/t") interface Texts { @get read(): int32; }
    `);

    const runtime = fileContent(results, "ClientRuntime.g.cs");
    const fromText = runtime.slice(
      runtime.indexOf("internal static T FromText<T>"),
    );
    const stringCheck = fromText.indexOf(
      "if (typeof(T) == typeof(string)) return (T)(object)text;",
    );
    ok(stringCheck > -1);
    ok(
      stringCheck < fromText.indexOf("if (text.Length == 0"),
      "string is handled before empty text becomes null",
    );
  });
});
