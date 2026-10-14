import { ok, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import { emit, emitWithDiagnostics, fileContent, messagesFor } from "./host.js";

const PREAMBLE = `
  import "@typespec/http";
  using Http;

  @service(#{ title: "Test API" })
  namespace TestApi;
`;

describe("encoded JSON names", () => {
  it("uses @encodedName for JSON and ignores one for another media type", async () => {
    const results = await emit(`${PREAMBLE}
      model Item {
        @encodedName("application/json", "item_name") name: string;
        @encodedName("application/xml", "Other") other: string;
        plain: string;
      }
      @route("/i") interface Items { @get read(): Item; @post create(@body body: Item): void; }
    `);

    const item = fileContent(results, "Item.g.cs");
    ok(item.includes('[JsonPropertyName("item_name")]'));
    ok(item.includes("public string Name"));
    ok(item.includes('[JsonPropertyName("other")]'));
    ok(item.includes('[JsonPropertyName("plain")]'));
  });

  it("uses the encoded name in a request record too", async () => {
    const results = await emit(`${PREAMBLE}
      model Item {
        @visibility(Lifecycle.Read) id: string;
        @encodedName("application/json", "item_name") name: string;
      }
      @route("/i") interface Items { @post create(@body body: Item): void; }
    `);

    ok(
      fileContent(results, "ItemCreateRequest.g.cs").includes(
        '[JsonPropertyName("item_name")]',
      ),
    );
  });

  it("uses the encoded name of the discriminator property", async () => {
    const results = await emit(`${PREAMBLE}
      @discriminator("kind")
      model Pet { @encodedName("application/json", "pet_kind") kind: string; name: string; }
      model Dog extends Pet { kind: "dog"; }
      @route("/p") interface Pets { @get list(): Pet[]; }
    `);

    ok(
      fileContent(results, "Pet.g.cs").includes(
        '[JsonPolymorphic(TypeDiscriminatorPropertyName = "pet_kind")]',
      ),
    );
  });
});

describe("generic discriminated models", () => {
  it("reports a template model carrying @discriminator, once", async () => {
    const [, diagnostics] = await emitWithDiagnostics(`${PREAMBLE}
      @discriminator("kind") model Shape<T> { kind: string; data: T; }
      model Circle extends Shape<string> { kind: "circle"; r: int32; }
      @route("/s") interface Shapes {
        @get read(): Shape<string>;
        @route("c") @get circle(): Circle;
      }
    `);

    const messages = messagesFor(
      diagnostics,
      "unsupported-generic-discriminator",
    );
    strictEqual(messages.length, 1, messages.join("; "));
    ok(messages[0].includes('"Shape"'));
  });

  it("does not report a generic model without a discriminator", async () => {
    const [, diagnostics] = await emitWithDiagnostics(`${PREAMBLE}
      model Page<T> { items: T[]; }
      @route("/p") interface Pages { @get read(): Page<string>; }
    `);

    strictEqual(
      messagesFor(diagnostics, "unsupported-generic-discriminator").length,
      0,
    );
  });
});

describe("properties whose only value is null", () => {
  it("writes a required null-only property and leaves out an optional one", async () => {
    const results = await emit(`${PREAMBLE}
      model Holder { always: null; maybe?: null; }
      @route("/h") interface Holders { @post create(@body body: Holder): void; }
    `);

    const holder = fileContent(results, "Holder.g.cs");
    ok(holder.includes("public object? Always { get; init; }"));
    ok(holder.includes("public object? Maybe { get; init; }"));
    const always = holder.indexOf("public object? Always");
    ok(
      holder
        .slice(holder.lastIndexOf("[JsonPropertyName", always), always)
        .includes("JsonIgnoreCondition.Never"),
    );
    const maybe = holder.indexOf("public object? Maybe");
    ok(
      !holder
        .slice(holder.lastIndexOf("[JsonPropertyName", maybe), maybe)
        .includes("JsonIgnoreCondition.Never"),
    );
  });
});
