import { ok } from "node:assert";
import { describe, it } from "node:test";
import { emit } from "./host.js";

describe("endpoints", () => {
  it("emits a GET request builder for a simple HTTP service", async () => {
    const results = await emit(`
      import "@typespec/http";
      using Http;

      @service(#{ title: "Test API" })
      namespace TestApi;

      @route("/items")
      interface Items {
        @get list(): string[];
      }
    `);

    const ifaceFile = Object.keys(results).find((k) =>
      k.endsWith("ItemsRequestBuilders.g.cs"),
    );
    ok(ifaceFile, "Expected ItemsRequestBuilders.g.cs to be emitted");
    const content = results[ifaceFile];
    ok(
      content.includes(
        "public sealed class ItemsRequestBuilder : RequestBuilder<ItemsRequestBuilder>",
      ),
      "Expected request builder class declaration",
    );
    ok(
      content.includes("Task<List<string>>"),
      "Expected Task<List<string>> return type",
    );

    const clientFile = Object.keys(results).find((k) =>
      k.endsWith("ItemsRequestBuilders.g.cs"),
    );
    ok(clientFile, "Expected ItemsRequestBuilders.g.cs to be emitted");
    ok(
      results[clientFile].includes('AppendPathSegment($"api/items")'),
      "Expected the default route prefix in the request path",
    );
    ok(
      results[clientFile].includes("HttpMethod.Get"),
      "Expected a GET request",
    );
    ok(content.includes("ListAsync("), "Expected ListAsync method");
  });

  it("emits POST, PATCH, DELETE operations", async () => {
    const results = await emit(`
      import "@typespec/http";
      using Http;

      @service(#{ title: "Test API" })
      namespace TestApi;

      model Item { id: string; name: string; }

      @route("/items")
      interface Items {
        @post create(@body body: Item): Item;
        @patch update(@path id: string, @body body: Item): Item;
        @delete remove(@path id: string): void;
      }
    `);

    const ifaceFile = Object.keys(results).find((k) =>
      k.endsWith("ItemsRequestBuilders.g.cs"),
    );
    ok(ifaceFile, "Expected ItemsRequestBuilders.g.cs");
    const content = results[ifaceFile];
    ok(
      content.includes('AppendPathSegment($"api/items")') &&
        results[ifaceFile].includes("HttpMethod.Post"),
      "Expected Post attribute with default route prefix",
    );
    ok(
      content.includes(
        'AppendPathSegment($"api/items/{ClientRuntime.EscapePathSegment(this._id)}")',
      ) && results[ifaceFile].includes("HttpMethod.Patch"),
      "Expected Patch attribute with default route prefix",
    );
    ok(
      content.includes(
        'AppendPathSegment($"api/items/{ClientRuntime.EscapePathSegment(this._id)}")',
      ) && results[ifaceFile].includes("HttpMethod.Delete"),
      "Expected Delete attribute with default route prefix",
    );
    ok(content.includes("CreateAsync("), "Expected CreateAsync");
    ok(content.includes("UpdateAsync("), "Expected UpdateAsync");
    ok(content.includes("RemoveAsync("), "Expected RemoveAsync");
  });

  it("emits a void Task for operations with no success body", async () => {
    const results = await emit(`
      import "@typespec/http";
      using Http;

      @service(#{ title: "Test API" })
      namespace TestApi;

      @route("/items")
      interface Items {
        @delete remove(@path id: string): void;
      }
    `);

    const ifaceFile = Object.keys(results).find((k) =>
      k.endsWith("ItemsRequestBuilders.g.cs"),
    );
    ok(ifaceFile);
    ok(
      results[ifaceFile].includes("Task RemoveAsync("),
      "Expected bare Task return",
    );
  });

  it("emits path parameters correctly", async () => {
    const results = await emit(`
      import "@typespec/http";
      using Http;

      @service(#{ title: "Test API" })
      namespace TestApi;

      model Widget { id: string; }

      @route("/widgets")
      interface Widgets {
        @get read(@path id: string): Widget;
      }
    `);

    const ifaceFile = Object.keys(results).find((k) =>
      k.endsWith("WidgetsRequestBuilders.g.cs"),
    );
    ok(ifaceFile);
    const content = results[ifaceFile];
    ok(
      content.includes(
        "internal WidgetsItemRequestBuilder(IFlurlClient flurlClient, string id)",
      ),
      "Expected the item builder to take the string id path parameter",
    );
    ok(
      content.includes("private readonly string _id;"),
      "Expected the path parameter to be held in a field",
    );
    ok(
      content.includes(
        "ReadAsync(CancellationToken cancellationToken = default)",
      ),
      "Expected the path parameter not to be a method parameter",
    );
    ok(
      content.includes(
        'AppendPathSegment($"api/widgets/{ClientRuntime.EscapePathSegment(this._id)}")',
      ) && results[ifaceFile].includes("HttpMethod.Get"),
      "Expected path in attribute with default route prefix",
    );
  });

  it("default route-prefix substitutes version value for {version} in versioned APIs", async () => {
    const results = await emit(`
      import "@typespec/http";
      import "@typespec/versioning";
      using Http;
      using Versioning;

      @service(#{ title: "Test API" })
      @versioned(Versions)
      namespace TestApi;

      enum Versions { v1: "v1.0" }

      @route("/items")
      interface Items {
        @get list(): string[];
      }
    `);

    const ifaceFile = Object.keys(results).find((k) =>
      k.endsWith("ItemsRequestBuilders.g.cs"),
    );
    ok(ifaceFile, "Expected ItemsRequestBuilders.g.cs");
    ok(
      results[ifaceFile].includes('AppendPathSegment($"api/v1.0/items")') &&
        results[ifaceFile].includes("HttpMethod.Get"),
      "Expected {version} replaced with v1.0",
    );
  });

  it("default route-prefix strips {version} for unversioned APIs", async () => {
    const results = await emit(`
      import "@typespec/http";
      using Http;

      @service(#{ title: "Test API" })
      namespace TestApi;

      @route("/items")
      interface Items {
        @get list(): string[];
      }
    `);

    const ifaceFile = Object.keys(results).find((k) =>
      k.endsWith("ItemsRequestBuilders.g.cs"),
    );
    ok(ifaceFile, "Expected ItemsRequestBuilders.g.cs");
    ok(
      results[ifaceFile].includes('AppendPathSegment($"api/items")') &&
        results[ifaceFile].includes("HttpMethod.Get"),
      "Expected bare api/ prefix for unversioned API",
    );
  });

  it("custom route-prefix is used verbatim without version substitution when no version token", async () => {
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
      { "route-prefix": "v1/api" },
    );

    const ifaceFile = Object.keys(results).find((k) =>
      k.endsWith("ItemsRequestBuilders.g.cs"),
    );
    ok(ifaceFile, "Expected ItemsRequestBuilders.g.cs");
    ok(
      results[ifaceFile].includes('AppendPathSegment($"v1/api/items")') &&
        results[ifaceFile].includes("HttpMethod.Get"),
      "Expected custom prefix",
    );
  });

  it("trailing slash on route-prefix is normalized — no double slash in emitted path", async () => {
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
      { "route-prefix": "api/" },
    );

    const ifaceFile = Object.keys(results).find((k) =>
      k.endsWith("ItemsRequestBuilders.g.cs"),
    );
    ok(ifaceFile, "Expected ItemsRequestBuilders.g.cs");
    ok(
      results[ifaceFile].includes('AppendPathSegment($"api/items")') &&
        results[ifaceFile].includes("HttpMethod.Get"),
      "Expected single slash between prefix and path",
    );
    ok(
      !results[ifaceFile].includes("api//items"),
      "Should not produce double slash",
    );
  });

  it("empty route-prefix emits paths as-is", async () => {
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
      { "route-prefix": "" },
    );

    const ifaceFile = Object.keys(results).find((k) =>
      k.endsWith("ItemsRequestBuilders.g.cs"),
    );
    ok(ifaceFile, "Expected ItemsRequestBuilders.g.cs");
    ok(
      results[ifaceFile].includes('AppendPathSegment($"items")') &&
        results[ifaceFile].includes("HttpMethod.Get"),
      "Expected original path without prefix",
    );
  });

  it("emits all lines of a multi-line operation doc with /// prefix", async () => {
    const results = await emit(`
      import "@typespec/http";
      using Http;

      @service(#{ title: "Test API" })
      namespace TestApi;

      @route("/items")
      interface Items {
        @doc("Op first.\\nOp second.")
        @get list(): string[];
      }
    `);

    const ifaceFile = Object.keys(results).find((k) =>
      k.endsWith("ItemsRequestBuilders.g.cs"),
    );
    ok(ifaceFile, "Expected ItemsRequestBuilders.g.cs");
    const content = results[ifaceFile];
    ok(content.includes("/// Op first."), "Expected first op doc line");
    ok(content.includes("/// Op second."), "Expected second op doc line");
  });

  it("emits optional query params as nullable with default null", async () => {
    const results = await emit(`
      import "@typespec/http";
      using Http;

      @service(#{ title: "Test API" })
      namespace TestApi;

      @route("/items")
      interface Items {
        @get list(@query skip?: int32, @query take?: int32): string[];
      }
    `);

    const ifaceFile = Object.keys(results).find((k) =>
      k.endsWith("ItemsRequestBuilders.g.cs"),
    );
    ok(ifaceFile, "Expected ItemsRequestBuilders.g.cs");
    const content = results[ifaceFile];
    ok(
      content.includes("int? skip = null"),
      "Expected optional skip as int? with default null",
    );
    ok(
      content.includes("int? take = null"),
      "Expected optional take as int? with default null",
    );
  });

  it("emits required query params without nullable suffix", async () => {
    const results = await emit(`
      import "@typespec/http";
      using Http;

      @service(#{ title: "Test API" })
      namespace TestApi;

      @route("/items")
      interface Items {
        @get list(@query filter: string): string[];
      }
    `);

    const ifaceFile = Object.keys(results).find((k) =>
      k.endsWith("ItemsRequestBuilders.g.cs"),
    );
    ok(ifaceFile, "Expected ItemsRequestBuilders.g.cs");
    const content = results[ifaceFile];
    ok(
      content.includes("string filter"),
      "Expected required filter as plain string",
    );
    ok(
      !content.includes("string? filter"),
      "Required param should not be nullable",
    );
    ok(
      !content.includes("string filter = null"),
      "Required param should not have null default",
    );
  });

  it("places optional params after required ones when mixed", async () => {
    const results = await emit(`
      import "@typespec/http";
      using Http;

      @service(#{ title: "Test API" })
      namespace TestApi;

      model Item { name: string; }

      @route("/stores/{storeId}/items")
      interface Items {
        @post create(@path storeId: string, @query dryRun?: boolean, @body body: Item): Item;
      }
    `);

    const ifaceFile = Object.keys(results).find((k) =>
      k.endsWith("ItemsRequestBuilders.g.cs"),
    );
    ok(ifaceFile, "Expected ItemsRequestBuilders.g.cs");
    const content = results[ifaceFile];
    ok(
      content.includes(
        "internal ItemsItemRequestBuilder(IFlurlClient flurlClient, string storeId)",
      ),
      "Required path param storeId must be taken by the item builder",
    );
    const methodLine = content
      .split("\n")
      .find((l) => l.includes("CreateAsync("));
    ok(methodLine, "Expected CreateAsync method");
    ok(
      !methodLine!.includes("storeId"),
      "Path param storeId must not be a method parameter",
    );
    const bodyIdx = methodLine!.indexOf("Item body");
    const dryRunIdx = methodLine!.indexOf("dryRun");
    ok(bodyIdx >= 0, "Expected the required body parameter");
    ok(bodyIdx < dryRunIdx, "Required body must come before optional dryRun");
    ok(
      content.includes("bool? dryRun = null"),
      "Expected dryRun as bool? with default null",
    );
  });

  it("@clientName on an interface overrides the C# request builder name", async () => {
    const results = await emit(`
      import "@typespec/http";
      import "@massivescale/tsp-flurl-client";
      using Http;
      using MassiveScale.TspFlurlClient;

      @service(#{ title: "Test API" })
      namespace TestApi;

      @clientName("Widgets")
      @route("/things")
      interface Things {
        @get list(): string[];
      }
    `);

    const ifaceFile = Object.keys(results).find((k) =>
      k.endsWith("WidgetsRequestBuilders.g.cs"),
    );
    ok(ifaceFile, "Expected WidgetsRequestBuilders.g.cs (clientName override)");
    ok(
      results[ifaceFile].includes("public sealed class WidgetsRequestBuilder"),
      "Expected request builder named WidgetsRequestBuilder",
    );
    ok(
      !results[ifaceFile].includes("ThingsRequestBuilder"),
      "Expected no builder named after the TypeSpec interface",
    );
    const thingsFile = Object.keys(results).find((k) =>
      k.endsWith("ThingsRequestBuilders.g.cs"),
    );
    ok(
      !thingsFile,
      "ThingsRequestBuilders.g.cs should not exist when clientName is Widgets",
    );
  });

  it("@clientName on an operation overrides the C# method name", async () => {
    const results = await emit(`
      import "@typespec/http";
      import "@massivescale/tsp-flurl-client";
      using Http;
      using MassiveScale.TspFlurlClient;

      @service(#{ title: "Test API" })
      namespace TestApi;

      @route("/items")
      interface Items {
        @clientName("search")
        @get list(): string[];
      }
    `);

    const ifaceFile = Object.keys(results).find((k) =>
      k.endsWith("ItemsRequestBuilders.g.cs"),
    );
    ok(ifaceFile, "Expected ItemsRequestBuilders.g.cs");
    const content = results[ifaceFile];
    ok(content.includes("SearchAsync("), "Expected SearchAsync method name");
    ok(!content.includes("ListAsync("), "ListAsync should not appear");
  });

  it("@access(Access.internal) on an interface emits an internal request builder", async () => {
    const results = await emit(`
      import "@typespec/http";
      import "@massivescale/tsp-flurl-client";
      using Http;
      using MassiveScale.TspFlurlClient;

      @service(#{ title: "Test API" })
      namespace TestApi;

      @access(Access.internal)
      @route("/items")
      interface Items {
        @get list(): string[];
      }
    `);

    const ifaceFile = Object.keys(results).find((k) =>
      k.endsWith("ItemsRequestBuilders.g.cs"),
    );
    ok(ifaceFile, "Expected ItemsRequestBuilders.g.cs");
    ok(
      results[ifaceFile].includes("internal sealed class ItemsRequestBuilder"),
      "Expected internal request builder",
    );
    ok(
      !results[ifaceFile].includes("public sealed class ItemsRequestBuilder"),
      "Should not contain a public request builder",
    );
  });

  it("ends every generated method with the cancellation token and no additionalQueryParameters", async () => {
    const results = await emit(`
      import "@typespec/http";
      using Http;

      @service(#{ title: "Test API" })
      namespace TestApi;

      model Item { id: string; name: string; }

      @route("/items")
      interface Items {
        @get list(@query skip?: int32): Item[];
        @post create(@body body: Item): Item;
        @delete remove(@path id: string): void;
      }
    `);

    const ifaceFile = Object.keys(results).find((k) =>
      k.endsWith("ItemsRequestBuilders.g.cs"),
    );
    ok(ifaceFile, "Expected ItemsRequestBuilders.g.cs");
    const content = results[ifaceFile];
    ok(
      content.includes(
        "ListAsync(int? skip = null, CancellationToken cancellationToken = default)",
      ),
      "Expected the cancellation token straight after ListAsync's optional params",
    );
    ok(
      content.includes(
        "CreateAsync(Item body, CancellationToken cancellationToken = default)",
      ),
      "Expected the cancellation token straight after CreateAsync's body",
    );
    ok(
      content.includes(
        "RemoveAsync(CancellationToken cancellationToken = default)",
      ),
      "Expected RemoveAsync, a DELETE with no body, to take only the cancellation token",
    );
    ok(
      !content.includes("additionalQueryParameters"),
      "Extra query parameters are added on the builder, not per method",
    );
    ok(
      (content.match(/ApplyModifiers\(flurlRequest\);/g) ?? []).length === 3,
      "Expected every request to apply the builder's modifiers",
    );
  });

  it("redirects MergePatchUpdate<T> to the MergePatch<T> helper instead of its literal synthesized name", async () => {
    const results = await emit(`
      import "@typespec/http";
      using Http;

      @service(#{ title: "Test API" })
      namespace TestApi;

      model Widget { id: string; name: string; }

      @route("/widgets")
      interface Widgets {
        @patch update(@path id: string, @body body: MergePatchUpdate<Widget>): Widget;
      }
    `);

    const ifaceFile = Object.keys(results).find((k) =>
      k.endsWith("WidgetsRequestBuilders.g.cs"),
    );
    ok(ifaceFile, "Expected WidgetsRequestBuilders.g.cs");
    const content = results[ifaceFile];
    ok(
      content.includes("IMergePatch<Widget> body"),
      "Expected the body parameter to be typed as MergePatch<Widget>, not the synthesized WidgetMergePatchUpdate name",
    );
    ok(
      !content.includes("WidgetMergePatchUpdate"),
      "Did not expect the synthesized model's literal name to leak into the interface",
    );

    const phantomFile = Object.keys(results).find((k) =>
      k.includes("WidgetMergePatchUpdate"),
    );
    ok(
      !phantomFile,
      "Did not expect a model file to be emitted for the synthesized WidgetMergePatchUpdate model",
    );

    const widgetFile = Object.keys(results).find((k) =>
      k.endsWith("Widget.g.cs"),
    );
    ok(
      widgetFile,
      "Expected the real Widget model to still be emitted (referenced via MergePatch<Widget>)",
    );
  });
});
