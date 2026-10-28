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

  it("emits an aggregate client class with one method per request builder", async () => {
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
      content.includes(
        "public PetsRequestBuilder Pets() =>\n        new PetsRequestBuilder(this.FlurlClient);",
      ),
      "Expected Pets method",
    );
    ok(
      content.includes(
        "public StoresRequestBuilder Stores() =>\n        new StoresRequestBuilder(this.FlurlClient);",
      ),
      "Expected Stores method",
    );
    ok(
      content.includes("public TestApiClient(IFlurlClient flurlClient)"),
      "Expected the constructor to take only the Flurl client",
    );
    ok(
      !content.includes("IPets") && !content.includes("IStores"),
      "Expected no endpoint interfaces",
    );
    ok(
      content.includes("AddTransient<TestApiClient>("),
      "Expected aggregate client registered as transient",
    );
    ok(
      !content.includes("AddTransient<PetsRequestBuilder>") &&
        !content.includes("AddTransient<StoresRequestBuilder>"),
      "Expected the request builders not to be registered",
    );
  });
});
