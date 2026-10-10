import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ok, strictEqual, deepStrictEqual } from "node:assert";
import { after, describe, it } from "node:test";
import {
  ALL_HELPERS,
  ALWAYS_EMITTED_HELPERS,
  buildHelper,
  helperFolder,
} from "../src/helpers.js";
import { createRenderer } from "../src/renderer.js";
import { emit, emitWithDiagnostics, fileContent } from "./host.js";

const SIMPLE = `
  import "@typespec/http";
  using Http;

  @service(#{ title: "Test API" })
  namespace TestApi;

  @route("/items")
  interface Items {
    @get list(): string[];
  }
`;

const WITH_MERGE_PATCH = `
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

describe("helper files", () => {
  it("always emits ModelMap and ClientRuntime under Infrastructure", async () => {
    const results = await emit(SIMPLE);

    ok(
      Object.keys(results).some((k) =>
        k.endsWith("Infrastructure/ModelMap.g.cs"),
      ),
    );
    ok(
      Object.keys(results).some((k) =>
        k.endsWith("Infrastructure/ClientRuntime.g.cs"),
      ),
    );
  });

  it("emits MergePatch only when a merge-patch body is used", async () => {
    const without = await emit(SIMPLE);
    ok(!Object.keys(without).some((k) => k.endsWith("MergePatch.g.cs")));

    const withPatch = await emit(WITH_MERGE_PATCH);
    ok(
      Object.keys(withPatch).some((k) => k.endsWith("Models/MergePatch.g.cs")),
    );
    const helper = fileContent(withPatch, "MergePatch.g.cs");
    ok(helper.includes("public interface IMergePatch<out T>"));
    ok(helper.includes("public class MergePatch<T> : IMergePatch<T>"));
  });

  it("emits the helpers into the same namespace as the models", async () => {
    const results = await emit(SIMPLE);

    for (const file of ["ModelMap.g.cs", "ClientRuntime.g.cs"]) {
      ok(
        fileContent(results, file).includes("namespace TestApi.Client;"),
        `Expected ${file} in the root namespace`,
      );
    }
  });

  it("describes the registry for custom models", async () => {
    const results = await emit(SIMPLE);

    const map = fileContent(results, "ModelMap.g.cs");
    ok(map.includes("public sealed class ModelMap"));
    ok(
      map.includes(
        "public ModelMap Map<TModel, TCustom>() where TCustom : TModel",
      ),
    );
    ok(map.includes("@discriminator"));
  });

  it("keeps the runtime helper internal", async () => {
    const results = await emit(SIMPLE);

    const runtime = fileContent(results, "ClientRuntime.g.cs");
    ok(runtime.includes("internal static class ClientRuntime"));
    ok(runtime.includes("DefaultJsonSerializer"));
  });

  it("emits the helpers once, in the root namespace, for every version", async () => {
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
      { "all-versions": true },
    );

    const helperFiles = Object.keys(results).filter((k) =>
      k.endsWith("ModelMap.g.cs"),
    );
    strictEqual(helperFiles.length, 1);
    ok(
      fileContent(results, "ModelMap.g.cs").includes(
        "namespace TestApi.Client;",
      ),
    );
    ok(
      fileContent(results, "v1.0/Endpoints/ItemsClient.g.cs").includes(
        "namespace TestApi.Client.V1_0;",
      ),
    );
  });

  it("gives a second service its own namespace-qualified copy", async () => {
    const results = await emit(`
      import "@typespec/http";
      using Http;

      @service(#{ title: "A" })
      namespace A {
        @route("/a") interface AItems { @get list(): string[]; }
      }

      @service(#{ title: "B" })
      namespace B {
        @route("/b") interface BItems { @get list(): string[]; }
      }
    `);

    const maps = Object.keys(results)
      .filter((k) => /ModelMap(\..+)?\.g\.cs$/.test(k))
      .map((k) => k.split("/").pop());
    deepStrictEqual(maps.sort(), ["ModelMap.B.Client.g.cs", "ModelMap.g.cs"]);
    ok(fileContent(results, "ModelMap.g.cs").includes("namespace A.Client;"));
    ok(
      fileContent(results, "ModelMap.B.Client.g.cs").includes(
        "namespace B.Client;",
      ),
    );
  });

  it("applies additional-usings to the helpers", async () => {
    const results = await emit(SIMPLE, {
      "additional-usings": ["Acme.Shared"],
    });

    ok(fileContent(results, "ModelMap.g.cs").includes("using Acme.Shared;"));
    ok(
      fileContent(results, "ClientRuntime.g.cs").includes("using Acme.Shared;"),
    );
  });

  it("reports a collision when a model claims a helper's name", async () => {
    const [results, diagnostics] = await emitWithDiagnostics(`
      import "@typespec/http";
      using Http;

      @service(#{ title: "Test API" })
      namespace TestApi;

      model ModelMap { id: string; }

      @route("/maps")
      interface Maps {
        @get read(): ModelMap;
      }
    `);

    ok(
      diagnostics.some(
        (d) =>
          d.code === "@massivescale/tsp-flurl-client/output-name-collision" &&
          d.message.includes("ModelMap"),
      ),
      "Expected an output-name-collision diagnostic for ModelMap",
    );
    ok(
      !Object.keys(results).some((k) =>
        k.endsWith("Infrastructure/ModelMap.g.cs"),
      ),
      "The helper must not overwrite the user's model",
    );
  });
});

describe("helpers module", () => {
  it("lists every helper, with the runtime pair always emitted", () => {
    deepStrictEqual([...ALL_HELPERS].sort(), [
      "ClientRuntime",
      "MergePatch",
      "ModelMap",
    ]);
    deepStrictEqual([...ALWAYS_EMITTED_HELPERS].sort(), [
      "ClientRuntime",
      "ModelMap",
    ]);
  });

  it("puts the merge-patch builder with the models and the rest under Infrastructure", () => {
    strictEqual(helperFolder("MergePatch"), "Models");
    strictEqual(helperFolder("ModelMap"), "Infrastructure");
    strictEqual(helperFolder("ClientRuntime"), "Infrastructure");
  });

  it("sorts and de-duplicates the usings it writes", () => {
    const source = buildHelper(
      "ModelMap",
      "Acme",
      createRenderer(),
      new Set(["System", "Acme.Shared"]),
    );

    const usings = source.split("\n").filter((l) => l.startsWith("using "));
    deepStrictEqual(usings, [
      "using System;",
      "using System.Collections.Generic;",
      "using System.Text.Json.Serialization;",
      "using Acme.Shared;",
    ]);
  });
});

describe("template overrides for the Flurl templates", () => {
  const dir = mkdtempSync(join(tmpdir(), "flurl-templates-"));
  after(() => rmSync(dir, { recursive: true, force: true }));

  const override = (name: string, content: string): string => {
    const path = join(dir, `${name}.hbs`);
    writeFileSync(path, content);
    return path;
  };

  it("replaces the endpoint interface and client templates", async () => {
    const results = await emit(SIMPLE, {
      templates: {
        "endpoint-interface": override(
          "iface",
          "{{access}} interface {{interfaceName}} { /* custom interface */ }",
        ),
        "endpoint-client": override(
          "client",
          "internal sealed class {{className}} : {{interfaceName}} { /* custom client */ }",
        ),
      },
    });

    ok(fileContent(results, "IItems.g.cs").includes("/* custom interface */"));
    ok(
      fileContent(results, "ItemsClient.g.cs").includes("/* custom client */"),
    );
  });

  it("replaces the helper templates", async () => {
    const results = await emit(SIMPLE, {
      templates: {
        "model-map": override(
          "map",
          "public sealed class ModelMap { /* custom map */ }",
        ),
        "client-runtime": override(
          "runtime",
          "internal static class ClientRuntime { /* custom runtime */ }",
        ),
      },
    });

    ok(fileContent(results, "ModelMap.g.cs").includes("/* custom map */"));
    ok(
      fileContent(results, "ClientRuntime.g.cs").includes(
        "/* custom runtime */",
      ),
    );
  });

  it("replaces the merge-patch template", async () => {
    const results = await emit(WITH_MERGE_PATCH, {
      templates: {
        "merge-patch": override(
          "patch",
          "public class MergePatch<T> { /* custom patch */ }",
        ),
      },
    });

    ok(fileContent(results, "MergePatch.g.cs").includes("/* custom patch */"));
  });
});
