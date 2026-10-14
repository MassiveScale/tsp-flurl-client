import { ok } from "node:assert";
import { describe, it } from "node:test";
import { emit } from "./host.js";

describe("client", () => {
  it("uses client-name for extensions class and method name", async () => {
    const results = await emit(
      `
      import "@typespec/http";
      using Http;

      @service(#{ title: "Test API" })
      namespace TestApi;

      @route("/items")
      interface Items {
        @get list(): string[];
      }
    `,
      { "client-name": "PetStore" },
    );

    const extFile = Object.keys(results).find((k) =>
      k.endsWith("PetStoreExtensions.g.cs"),
    );
    ok(extFile, "Expected PetStoreExtensions.g.cs");
    const extContent = results[extFile];
    ok(
      extContent.includes("class PetStore"),
      "Expected PetStore aggregate class",
    );
    ok(
      extContent.includes("class PetStoreExtensions"),
      "Expected PetStoreExtensions class",
    );
    ok(extContent.includes("AddPetStore"), "Expected AddPetStore method");

    const defaultExt = Object.keys(results).find((k) =>
      k.endsWith("TestApiClientExtensions.g.cs"),
    );
    ok(
      !defaultExt,
      "Default extensions file should not be emitted when client-name is set",
    );
  });

  it("emits an aggregate client class with one property per interface", async () => {
    const results = await emit(`
      import "@typespec/http";
      using Http;

      @service(#{ title: "Test API" })
      namespace TestApi;

      model Pet { name: string; }
      model Store { name: string; }

      @route("/pets")
      interface Pets {
        @get list(): Pet[];
      }

      @route("/stores")
      interface Stores {
        @get list(): Store[];
      }
    `);

    const extFile = Object.keys(results).find((k) =>
      k.endsWith("TestApiClientExtensions.g.cs"),
    );
    ok(extFile, "Expected TestApiClientExtensions.g.cs");
    const content = results[extFile];

    ok(
      content.includes("public class TestApiClient"),
      "Expected aggregate class declaration",
    );
    ok(
      content.includes("public IPets Pets { get; }"),
      "Expected Pets property",
    );
    ok(
      content.includes("public IStores Stores { get; }"),
      "Expected Stores property",
    );
    ok(content.includes("IPets pets"), "Expected pets constructor param");
    ok(content.includes("IStores stores"), "Expected stores constructor param");
    ok(
      content.includes(
        "Pets = pets ?? throw new ArgumentNullException(nameof(pets));",
      ),
      "Expected Pets assignment in constructor",
    );
    ok(
      content.includes(
        "Stores = stores ?? throw new ArgumentNullException(nameof(stores));",
      ),
      "Expected Stores assignment in constructor",
    );
    ok(
      content.includes("AddTransient<TestApiClient>("),
      "Expected aggregate client registered as transient",
    );
    ok(content.includes("AddTransient<IPets>"), "Expected IPets registered");
    ok(
      content.includes("AddTransient<IStores>"),
      "Expected IStores registered",
    );
  });
});
