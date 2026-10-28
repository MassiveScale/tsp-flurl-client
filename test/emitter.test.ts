import { strictEqual, deepStrictEqual, ok } from "node:assert";
import { describe, it } from "node:test";
import { emit, emitWithDiagnostics } from "./host.js";

describe("emitter", () => {
  it("emits nothing for an operation with no HTTP service", async () => {
    const results = await emit(`op test(): void;`);
    strictEqual(Object.keys(results).length, 0);
  });

  it("defaults to emitting only the latest version for a versioned API", async () => {
    const results = await emit(`
      import "@typespec/http";
      import "@typespec/versioning";
      using Http;
      using Versioning;

      @service(#{ title: "Test API" })
      @versioned(Versions)
      namespace TestApi;

      enum Versions { v1: "v1.0", v2: "v2.0" }

      model Item { id: string; }

      @route("/items")
      interface Items {
        @get list(): Item[];
        @added(Versions.v2)
        @post create(@body body: Item): Item;
      }
    `);

    const v1File = Object.keys(results).find(
      (k) => k.includes("v1.0") && k.endsWith("ItemsRequestBuilders.g.cs"),
    );
    const iItemsFile = Object.keys(results).find((k) =>
      k.endsWith("ItemsRequestBuilders.g.cs"),
    );

    ok(!v1File, "v1.0 should not be emitted by default");
    ok(
      iItemsFile,
      "Expected ItemsRequestBuilders.g.cs at root (no version folder in single-version mode)",
    );
    ok(results[iItemsFile!].includes("ListAsync("), "v2 should have ListAsync");
    ok(
      results[iItemsFile!].includes("CreateAsync("),
      "v2 should have CreateAsync",
    );
  });

  it("emits a specific version when target-version is set", async () => {
    const results = await emit(
      `
      import "@typespec/http";
      import "@typespec/versioning";
      using Http;
      using Versioning;

      @service(#{ title: "Test API" })
      @versioned(Versions)
      namespace TestApi;

      enum Versions { v1: "v1.0", v2: "v2.0" }

      model Item { id: string; }

      @route("/items")
      interface Items {
        @get list(): Item[];
        @added(Versions.v2)
        @post create(@body body: Item): Item;
      }
    `,
      { "target-version": "v1.0" },
    );

    const v1File = Object.keys(results).find(
      (k) => k.includes("v1.0") && k.endsWith("ItemsRequestBuilders.g.cs"),
    );
    const v2File = Object.keys(results).find(
      (k) => k.includes("v2.0") && k.endsWith("ItemsRequestBuilders.g.cs"),
    );
    const iItemsFile = Object.keys(results).find((k) =>
      k.endsWith("ItemsRequestBuilders.g.cs"),
    );

    ok(!v1File, "No v1.0 folder in single-version mode");
    ok(!v2File, "v2.0 should not be emitted when target-version is v1.0");
    ok(iItemsFile, "Expected ItemsRequestBuilders.g.cs at root");
    ok(results[iItemsFile!].includes("ListAsync("), "v1 should have ListAsync");
    ok(
      !results[iItemsFile!].includes("CreateAsync("),
      "v1 should not have CreateAsync (added in v2)",
    );
  });

  it("emits all versions when all-versions is true", async () => {
    const results = await emit(
      `
      import "@typespec/http";
      import "@typespec/versioning";
      using Http;
      using Versioning;

      @service(#{ title: "Test API" })
      @versioned(Versions)
      namespace TestApi;

      enum Versions { v1: "v1.0", v2: "v2.0" }

      model Item { id: string; }

      @route("/items")
      interface Items {
        @get list(): Item[];
        @added(Versions.v2)
        @post create(@body body: Item): Item;
      }
    `,
      { "all-versions": true },
    );

    const v1File = Object.keys(results).find(
      (k) => k.includes("v1.0") && k.endsWith("ItemsRequestBuilders.g.cs"),
    );
    const v2File = Object.keys(results).find(
      (k) => k.includes("v2.0") && k.endsWith("ItemsRequestBuilders.g.cs"),
    );

    ok(v1File, "Expected v1.0/Endpoints/ItemsRequestBuilders.g.cs");
    ok(v2File, "Expected v2.0/Endpoints/ItemsRequestBuilders.g.cs");
    ok(results[v1File].includes("ListAsync("), "v1 should have ListAsync");
    ok(
      !results[v1File].includes("CreateAsync("),
      "v1 should not have CreateAsync",
    );
    ok(results[v2File].includes("ListAsync("), "v2 should have ListAsync");
    ok(results[v2File].includes("CreateAsync("), "v2 should have CreateAsync");
  });

  it("reports an error when target-version does not exist", async () => {
    const [, diags] = await emitWithDiagnostics(
      `
      import "@typespec/http";
      import "@typespec/versioning";
      using Http;
      using Versioning;

      @service(#{ title: "Test API" })
      @versioned(Versions)
      namespace TestApi;

      enum Versions { v1: "v1.0", v2: "v2.0" }

      @route("/items")
      interface Items {
        @get list(): string[];
      }
    `,
      { "target-version": "v9.0" },
    );
    ok(
      diags.some(
        (d) => d.code === "@massivescale/tsp-flurl-client/version-not-found",
      ),
      "Expected version-not-found diagnostic",
    );
  });

  it("appends version to namespace when version-in-namespace is true in single-version mode", async () => {
    const results = await emit(
      `
      import "@typespec/http";
      import "@typespec/versioning";
      using Http;
      using Versioning;

      @service(#{ title: "Test API" })
      @versioned(Versions)
      namespace TestApi;

      enum Versions { v1: "v1.0", v2: "v2.0" }

      @route("/items")
      interface Items {
        @get list(): string[];
      }
    `,
      { "version-in-namespace": true },
    );

    const ifaceFile = Object.keys(results).find((k) =>
      k.endsWith("ItemsRequestBuilders.g.cs"),
    );
    ok(ifaceFile, "Expected ItemsRequestBuilders.g.cs");
    ok(
      results[ifaceFile].includes("namespace TestApi.Client.V2_0"),
      "Expected version in namespace",
    );

    const vFolderFile = Object.keys(results).find(
      (k) => k.includes("v2.0") && k.endsWith("ItemsRequestBuilders.g.cs"),
    );
    ok(
      !vFolderFile,
      "Single-version mode should not create version subfolders",
    );
  });

  it("always appends version to namespace with all-versions regardless of version-in-namespace", async () => {
    const results = await emit(
      `
      import "@typespec/http";
      import "@typespec/versioning";
      using Http;
      using Versioning;

      @service(#{ title: "Test API" })
      @versioned(Versions)
      namespace TestApi;

      enum Versions { v1: "v1.0", v2: "v2.0" }

      @route("/items")
      interface Items {
        @get list(): string[];
      }
    `,
      { "all-versions": true, "version-in-namespace": false },
    );

    const v1File = Object.keys(results).find(
      (k) => k.includes("v1.0") && k.endsWith("ItemsRequestBuilders.g.cs"),
    );
    const v2File = Object.keys(results).find(
      (k) => k.includes("v2.0") && k.endsWith("ItemsRequestBuilders.g.cs"),
    );
    ok(v1File, "Expected v1.0/Endpoints/ItemsRequestBuilders.g.cs");
    ok(v2File, "Expected v2.0/Endpoints/ItemsRequestBuilders.g.cs");
    ok(
      results[v1File].includes("namespace TestApi.Client.V1_0"),
      "Expected version in v1 namespace",
    );
    ok(
      results[v2File].includes("namespace TestApi.Client.V2_0"),
      "Expected version in v2 namespace",
    );
  });

  it("clean-output-dir: false is accepted without diagnostics", async () => {
    const [, diags] = await emitWithDiagnostics(
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
      { "clean-output-dir": false },
    );
    strictEqual(diags.length, 0, "Expected no diagnostics");
  });

  it("clean-output-dir: true is accepted without diagnostics", async () => {
    const [, diags] = await emitWithDiagnostics(
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
      { "clean-output-dir": true },
    );
    strictEqual(diags.length, 0, "Expected no diagnostics");
  });

  it("additional-usings: appends the configured usings to every emitted file", async () => {
    const results = await emit(
      `
      import "@typespec/http";
      using Http;

      @service(#{ title: "Test API" })
      namespace TestApi;

      model Item { id: string; name: string; }

      @route("/items")
      interface Items {
        @get list(): Item[];
      }
    `,
      { "additional-usings": ["Shared.Models", "Shared.Helpers"] },
    );

    const ifaceFile = Object.keys(results).find((k) =>
      k.endsWith("ItemsRequestBuilders.g.cs"),
    );
    const modelFile = Object.keys(results).find((k) => k.endsWith("Item.g.cs"));
    ok(ifaceFile, "Expected ItemsRequestBuilders.g.cs");
    ok(modelFile, "Expected Item.g.cs");
    ok(
      results[ifaceFile].includes("using Shared.Helpers;") &&
        results[ifaceFile].includes("using Shared.Models;"),
      "Expected both additional usings on the interface file, regardless of whether it needs them",
    );
    ok(
      results[modelFile].includes("using Shared.Helpers;") &&
        results[modelFile].includes("using Shared.Models;"),
      "Expected both additional usings on the model file, regardless of whether it needs them",
    );
  });

  it("additional-usings: adds nothing beyond the default usings when unset", async () => {
    const results = await emit(`
      import "@typespec/http";
      using Http;

      @service(#{ title: "Test API" })
      namespace TestApi;

      model Item { id: string; name: string; }

      @route("/items")
      interface Items {
        @get list(): Item[];
      }
    `);

    const ifaceFile = Object.keys(results).find((k) =>
      k.endsWith("ItemsRequestBuilders.g.cs"),
    );
    ok(ifaceFile, "Expected ItemsRequestBuilders.g.cs");
    ok(
      !results[ifaceFile].includes("Shared."),
      "Expected no stray usings when additional-usings is not set",
    );
  });

  describe("MergePatch<T> helper", () => {
    const PATCH_API = `
      import "@typespec/http";
      using Http;

      @service(#{ title: "Test API" })
      namespace TestApi;

      model Widget { id: string; name: string; }

      @route("/widgets")
      interface Widgets {
        @patch update(@path id: string, @body body: MergePatchUpdate<Widget>): Widget;
      }
    `;

    const NO_PATCH_API = `
      import "@typespec/http";
      using Http;

      @service(#{ title: "Test API" })
      namespace TestApi;

      model Widget { id: string; name: string; }

      @route("/widgets")
      interface Widgets {
        @get list(): Widget[];
      }
    `;

    function findHelper(results: Record<string, string>): string | undefined {
      return Object.keys(results).find((k) => k.endsWith("MergePatch.g.cs"));
    }

    it("emits the helper into Models/ when a merge-patch body is used", async () => {
      const results = await emit(PATCH_API);

      const helperFile = findHelper(results);
      ok(helperFile, "Expected MergePatch.g.cs to be emitted");
      ok(
        helperFile.includes("Models/"),
        `Expected the helper under Models/, got ${helperFile}`,
      );

      const content = results[helperFile];
      ok(
        content.includes("public class MergePatch<T>"),
        "Expected the generic helper class declaration",
      );
      ok(
        content.includes("namespace TestApi.Client;"),
        "Expected the helper in the same namespace as the records",
      );
    });

    it("declares the usings the helper body needs", async () => {
      const results = await emit(PATCH_API);
      const content = results[findHelper(results)!];

      for (const using of [
        "using System;",
        "using System.Collections.Generic;",
        "using System.Diagnostics.CodeAnalysis;",
        "using System.Linq.Expressions;",
        "using System.Reflection;",
        "using System.Text.Json;",
        "using System.Text.Json.Serialization;",
      ]) {
        ok(content.includes(using), `Expected ${using} in the helper file`);
      }
    });

    it("emits a write-oriented builder API rather than the server's read-oriented one", async () => {
      const results = await emit(PATCH_API);
      const content = results[findHelper(results)!];

      ok(
        content.includes("[JsonExtensionData]") &&
          content.includes("Dictionary<string, JsonElement> Properties"),
        "Expected the extension-data payload bag",
      );
      for (const member of [
        "public MergePatch<T> Set<TValue>(",
        "public MergePatch<T> Clear<TValue>(",
        "public MergePatch<T> Clear(",
        "public MergePatch<T> Remove<TValue>(",
        "public MergePatch<T> Remove(",
        "public bool IsDefined(",
        "public bool IsNull(",
      ]) {
        ok(content.includes(member), `Expected member ${member}`);
      }
      ok(
        content.includes("Expression<Func<T, TValue>> property"),
        "Expected the expression-based overloads that resolve wire names",
      );
      ok(
        content.includes("GetCustomAttribute<JsonPropertyNameAttribute>()"),
        "Expected wire names resolved from [JsonPropertyName]",
      );
      ok(
        !content.includes("GetString(string propertyName)"),
        "Did not expect the server helper's typed readers on a client-side builder",
      );
    });

    it("does not emit the helper when nothing uses a merge-patch body", async () => {
      const results = await emit(NO_PATCH_API);
      strictEqual(
        findHelper(results),
        undefined,
        "Did not expect MergePatch.g.cs without a merge-patch body",
      );
    });

    it("appends additional-usings to the helper file", async () => {
      const results = await emit(PATCH_API, {
        "additional-usings": ["Shared.Models"],
      });
      ok(
        results[findHelper(results)!].includes("using Shared.Models;"),
        "Expected additional-usings in the helper file",
      );
    });

    it("emits the helper once, in the base namespace, when versions live in their own namespace", async () => {
      const results = await emit(
        `
        import "@typespec/http";
        import "@typespec/versioning";
        using Http;
        using Versioning;

        @service(#{ title: "Test API" })
        @versioned(Versions)
        namespace TestApi;

        enum Versions { v1: "v1.0" }

        model Widget { id: string; name: string; }

        @route("/widgets")
        interface Widgets {
          @patch update(@path id: string, @body body: MergePatchUpdate<Widget>): Widget;
        }
      `,
        { "version-in-namespace": true },
      );

      const helperFiles = Object.keys(results).filter((k) =>
        k.endsWith("MergePatch.g.cs"),
      );
      strictEqual(helperFiles.length, 1, "Expected exactly one helper file");
      ok(
        results[helperFiles[0]].includes("namespace TestApi.Client;"),
        "Expected the helper in the base namespace, which the per-version namespace nests under",
      );

      const ifaceFile = Object.keys(results).find((k) =>
        k.endsWith("WidgetsRequestBuilders.g.cs"),
      );
      ok(
        results[ifaceFile!].includes("namespace TestApi.Client.V1_0;"),
        "Expected the interface in the per-version namespace",
      );
    });

    it("reports a collision instead of overwriting a user type named MergePatch", async () => {
      const [results, diags] = await emitWithDiagnostics(`
        import "@typespec/http";
        using Http;

        @service(#{ title: "Test API" })
        namespace TestApi;

        model Widget { id: string; name: string; }
        model MergePatch { note: string; }

        @route("/widgets")
        interface Widgets {
          @patch update(@path id: string, @body body: MergePatchUpdate<Widget>): Widget;
          @post note(@body body: MergePatch): Widget;
        }
      `);

      ok(
        diags.some(
          (d) =>
            d.code === "@massivescale/tsp-flurl-client/output-name-collision",
        ),
        "Expected output-name-collision diagnostic",
      );
      // The helper keeps the name, since the endpoints take IMergePatch<T>; the
      // user's model is reported and not written over it.
      const helperFile = findHelper(results);
      ok(helperFile, "Expected MergePatch.g.cs");
      ok(
        results[helperFile].includes("public class MergePatch<T>"),
        "Expected the helper, not the user's model",
      );
    });

    it("does not pull in the helper for a user model that is merely named MergePatch", async () => {
      const [results, diags] = await emitWithDiagnostics(`
        import "@typespec/http";
        using Http;

        @service(#{ title: "Test API" })
        namespace TestApi;

        model Widget { id: string; }
        model MergePatch<T> { value: T; }

        @route("/widgets")
        interface Widgets {
          @post wrap(@body body: MergePatch<Widget>): Widget;
        }
      `);

      strictEqual(
        diags.filter(
          (d) =>
            d.code === "@massivescale/tsp-flurl-client/output-name-collision",
        ).length,
        0,
        "A user type named MergePatch must not collide with a helper nothing asked for",
      );

      const helperFile = findHelper(results);
      ok(helperFile, "Expected the user's own MergePatch.g.cs");
      ok(
        !results[helperFile].includes("public class MergePatch<T>"),
        "Expected the user's record, not the generated helper class",
      );
      ok(
        results[helperFile].includes("record MergePatch<T>"),
        "Expected the user's generic record to be emitted untouched",
      );
    });

    it("emits one helper per namespace when several services use merge-patch bodies", async () => {
      const results = await emit(`
        import "@typespec/http";
        using Http;

        @service(#{ title: "A" })
        namespace AlphaApi {
          model Widget { id: string; name: string; }
          @route("/widgets")
          interface Widgets {
            @patch update(@path id: string, @body body: MergePatchUpdate<Widget>): Widget;
          }
        }

        @service(#{ title: "B" })
        namespace BetaApi {
          model Gadget { id: string; label: string; }
          @route("/gadgets")
          interface Gadgets {
            @patch update(@path id: string, @body body: MergePatchUpdate<Gadget>): Gadget;
          }
        }
      `);

      const helperFiles = Object.keys(results).filter((k) =>
        k.includes("MergePatch"),
      );
      strictEqual(
        helperFiles.length,
        2,
        `Expected one helper per service namespace, got ${helperFiles.join(", ")}`,
      );

      const namespaces = helperFiles
        .map((f) =>
          results[f]
            .split("\n")
            .map((l) => l.trim())
            .find((l) => l.startsWith("namespace")),
        )
        .sort();
      deepStrictEqual(namespaces, [
        "namespace AlphaApi.Client;",
        "namespace BetaApi.Client;",
      ]);

      for (const f of helperFiles) {
        ok(
          results[f].includes("public class MergePatch<T>"),
          `Expected the helper class in ${f}`,
        );
      }
    });

    it("rejects a nested property selector instead of patching the wrong field", async () => {
      const results = await emit(PATCH_API);
      const content = results[findHelper(results)!];

      ok(
        content.includes("member.Expression != property.Parameters[0]"),
        "Expected the selector to be required to read directly off the lambda parameter",
      );
      ok(
        content.includes("declared directly on"),
        "Expected the error message to say the property must be declared on T",
      );
    });
  });
});
