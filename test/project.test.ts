import { strictEqual, ok, match } from "node:assert";
import { describe, it } from "node:test";
import { emit } from "./host.js";
import { tryParseSemver, toCalVer } from "../src/project.js";

describe("project", () => {
  it("emits a .csproj file", async () => {
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

    const csproj = Object.keys(results).find((k) => k.endsWith(".csproj"));
    ok(csproj, "Expected .csproj file");
    const content = results[csproj];
    ok(
      content.includes('<PackageReference Include="Flurl.Http"'),
      "Expected Flurl.Http reference",
    );
    ok(
      content.includes("<TargetFramework>net8.0</TargetFramework>"),
      "Expected singular TargetFramework for default",
    );
  });

  it("emits TargetFrameworks (plural) when net-version contains multiple TFMs", async () => {
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
      { "net-version": "net8.0;net9.0" },
    );

    const csproj = Object.keys(results).find((k) => k.endsWith(".csproj"));
    ok(csproj, "Expected .csproj file");
    const content = results[csproj];
    ok(
      content.includes("<TargetFrameworks>net8.0;net9.0</TargetFrameworks>"),
      "Expected plural TargetFrameworks for multi-target",
    );
    ok(
      !content.includes("<TargetFramework>"),
      "Should not use singular TargetFramework in multi-target mode",
    );
  });

  it("trims whitespace around semicolons in net-version", async () => {
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
      { "net-version": "net8.0 ; net9.0" },
    );

    const csproj = Object.keys(results).find((k) => k.endsWith(".csproj"));
    ok(csproj, "Expected .csproj file");
    ok(
      results[csproj].includes(
        "<TargetFrameworks>net8.0;net9.0</TargetFrameworks>",
      ),
      "Expected whitespace trimmed from TFMs",
    );
  });

  it("uses project-name option for .csproj filename and extensions class", async () => {
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
      { "project-name": "MyAppClient" },
    );

    const csproj = Object.keys(results).find((k) =>
      k.endsWith("MyAppClient.csproj"),
    );
    ok(csproj, "Expected MyAppClient.csproj");

    const extFile = Object.keys(results).find((k) =>
      k.endsWith("MyAppClientExtensions.g.cs"),
    );
    ok(extFile, "Expected MyAppClientExtensions.g.cs");
    const extContent = results[extFile];
    ok(
      extContent.includes("class MyAppClient"),
      "Expected MyAppClient aggregate class",
    );
    ok(
      extContent.includes("class MyAppClientExtensions"),
      "Expected MyAppClientExtensions class",
    );
    ok(extContent.includes("AddMyAppClient"), "Expected AddMyAppClient method");

    const defaultCsproj = Object.keys(results).find((k) =>
      k.endsWith("TestApiClient.csproj"),
    );
    ok(!defaultCsproj, "Default TestApiClient.csproj should not be emitted");
  });

  it("uses client-name as default NuGet title", async () => {
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

    const csproj = Object.keys(results).find((k) => k.endsWith(".csproj"));
    ok(csproj, "Expected .csproj");
    ok(
      results[csproj].includes("<Title>PetStore</Title>"),
      "Expected NuGet title from client-name",
    );
  });

  it("nuget-title overrides client-name as NuGet title", async () => {
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
      { "client-name": "PetStore", "nuget-title": "My Pet Store Client" },
    );

    const csproj = Object.keys(results).find((k) => k.endsWith(".csproj"));
    ok(csproj, "Expected .csproj");
    ok(
      results[csproj].includes("<Title>My Pet Store Client</Title>"),
      "Expected explicit nuget-title",
    );
    ok(
      !results[csproj].includes("<Title>PetStore</Title>"),
      "client-name should not appear as title",
    );
  });

  it("emits NuGet package properties when provided", async () => {
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
      {
        "nuget-package-id": "Acme.PetStore.Client",
        "nuget-version": "2.0.0",
        "nuget-authors": "Acme Corp",
        "nuget-description": "Client library for the Acme Pet Store API.",
        "nuget-tags": "refit petstore api",
      },
    );

    const csproj = Object.keys(results).find((k) => k.endsWith(".csproj"));
    ok(csproj, "Expected .csproj");
    const content = results[csproj];
    ok(
      content.includes("<PackageId>Acme.PetStore.Client</PackageId>"),
      "Expected PackageId",
    );
    ok(content.includes("<Version>2.0.0</Version>"), "Expected Version");
    ok(content.includes("<Authors>Acme Corp</Authors>"), "Expected Authors");
    ok(
      content.includes(
        "<Description>Client library for the Acme Pet Store API.</Description>",
      ),
      "Expected Description",
    );
    ok(
      content.includes("<PackageTags>refit petstore api</PackageTags>"),
      "Expected PackageTags",
    );
  });

  it("emits </PropertyGroup> at 2-space indent matching <PropertyGroup>", async () => {
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
      { "nuget-version": "1.0.0" },
    );

    const csproj = Object.keys(results).find((k) => k.endsWith(".csproj"));
    ok(csproj, "Expected .csproj");
    const content = results[csproj];
    ok(
      content.includes("  </PropertyGroup>"),
      "Expected 2-space-indented </PropertyGroup>",
    );
    ok(
      !content.includes("    </PropertyGroup>"),
      "Should not have 4-space-indented </PropertyGroup>",
    );
  });

  it("does not emit NuGet title when neither client-name nor nuget-title is set", async () => {
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

    const csproj = Object.keys(results).find((k) => k.endsWith(".csproj"));
    ok(csproj, "Expected .csproj");
    ok(
      !results[csproj].includes("<Title>"),
      "Title should not be emitted by default",
    );
  });

  describe("tryParseSemver", () => {
    it("parses two-part version", () =>
      strictEqual(tryParseSemver("1.2"), "1.2.0"));
    it("parses three-part version", () =>
      strictEqual(tryParseSemver("1.2.3"), "1.2.3"));
    it("strips leading v", () => strictEqual(tryParseSemver("v2.1"), "2.1.0"));
    it("strips leading V", () =>
      strictEqual(tryParseSemver("V3.0.1"), "3.0.1"));
    it("preserves pre-release suffix", () =>
      strictEqual(tryParseSemver("v2.0-preview"), "2.0.0-preview"));
    it("preserves rc suffix", () =>
      strictEqual(tryParseSemver("1.0.0-rc.1"), "1.0.0-rc.1"));
    it("returns undefined for single-digit", () =>
      strictEqual(tryParseSemver("v1"), undefined));
    it("returns undefined for date-style string", () =>
      strictEqual(tryParseSemver("2022-10-15"), undefined));
    it("returns undefined for plain label", () =>
      strictEqual(tryParseSemver("preview"), undefined));
  });

  describe("toCalVer", () => {
    it("formats as YYYY.MM.DD", () => {
      strictEqual(toCalVer(new Date(2026, 4, 21)), "2026.05.21");
    });
    it("zero-pads month and day", () => {
      strictEqual(toCalVer(new Date(2026, 0, 3)), "2026.01.03");
    });
  });

  it("uses semver parsed from TypeSpec API version as NuGet version", async () => {
    const results = await emit(`
      import "@typespec/http";
      import "@typespec/versioning";
      using Http;
      using Versioning;

      @versioned(Versions)
      @service(#{ title: "Test API" })
      namespace TestApi;

      enum Versions { v2_1: "v2.1" }

      @route("/items")
      interface Items {
        @get list(): string[];
      }
    `);

    const csproj = Object.keys(results).find((k) => k.endsWith(".csproj"));
    ok(csproj, "Expected .csproj");
    ok(
      results[csproj].includes("<Version>2.1.0</Version>"),
      "Expected semver derived from TypeSpec version",
    );
  });

  it("falls back to CalVer when TypeSpec version is not semver-parseable", async () => {
    const results = await emit(`
      import "@typespec/http";
      import "@typespec/versioning";
      using Http;
      using Versioning;

      @versioned(Versions)
      @service(#{ title: "Test API" })
      namespace TestApi;

      enum Versions { sprint42: "sprint-42" }

      @route("/items")
      interface Items {
        @get list(): string[];
      }
    `);

    const csproj = Object.keys(results).find((k) => k.endsWith(".csproj"));
    ok(csproj, "Expected .csproj");
    match(
      results[csproj],
      /<Version>\d{4}\.\d{2}\.\d{2}<\/Version>/,
      "Expected CalVer fallback",
    );
  });

  it("falls back to CalVer for unversioned API", async () => {
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

    const csproj = Object.keys(results).find((k) => k.endsWith(".csproj"));
    ok(csproj, "Expected .csproj");
    match(
      results[csproj],
      /<Version>\d{4}\.\d{2}\.\d{2}<\/Version>/,
      "Expected CalVer for unversioned API",
    );
  });

  it("uses target-version semver when target-version is specified", async () => {
    const results = await emit(
      `
      import "@typespec/http";
      import "@typespec/versioning";
      using Http;
      using Versioning;

      @versioned(Versions)
      @service(#{ title: "Test API" })
      namespace TestApi;

      enum Versions { v1_0: "v1.0", v2_0: "v2.0" }

      @route("/items")
      interface Items {
        @get list(): string[];
      }
    `,
      { "target-version": "v1.0" },
    );

    const csproj = Object.keys(results).find((k) => k.endsWith(".csproj"));
    ok(csproj, "Expected .csproj");
    ok(
      results[csproj].includes("<Version>1.0.0</Version>"),
      "Expected version from target-version",
    );
    ok(
      !results[csproj].includes("<Version>2.0.0</Version>"),
      "Should not use latest when target-version is set",
    );
  });

  it("uses latest version semver when all-versions is true", async () => {
    const results = await emit(
      `
      import "@typespec/http";
      import "@typespec/versioning";
      using Http;
      using Versioning;

      @versioned(Versions)
      @service(#{ title: "Test API" })
      namespace TestApi;

      enum Versions { v1_0: "v1.0", v3_2: "v3.2" }

      @route("/items")
      interface Items {
        @get list(): string[];
      }
    `,
      { "all-versions": true },
    );

    const csproj = Object.keys(results).find((k) => k.endsWith(".csproj"));
    ok(csproj, "Expected .csproj");
    ok(
      results[csproj].includes("<Version>3.2.0</Version>"),
      "Expected latest version semver with all-versions",
    );
  });
});
