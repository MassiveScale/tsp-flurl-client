import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ok, strictEqual } from "node:assert";
import { describe, it } from "node:test";

const root = resolve(fileURLToPath(import.meta.url), "../../..");
const manifest = JSON.parse(
  readFileSync(resolve(root, "package.json"), "utf-8"),
);

describe("the published package", () => {
  const pack = spawnSync(
    "npm",
    ["pack", "--dry-run", "--json", "--ignore-scripts"],
    {
      cwd: root,
      encoding: "utf-8",
      shell: true,
    },
  );
  let parsed: { files: { path: string }[] }[] | undefined;
  let parseError: string | undefined;
  if (pack.status === 0) {
    try {
      const result: unknown = JSON.parse(pack.stdout);
      parsed = Array.isArray(result)
        ? (result as { files: { path: string }[] }[])
        : undefined;
    } catch (error) {
      parseError = (error as Error).message;
    }
  }
  const files: string[] = (parsed?.[0]?.files ?? []).map((f) => f.path);

  it("can be packed", () => {
    strictEqual(pack.status, 0, pack.stderr);
    ok(
      parsed?.length === 1,
      parseError ?? `Expected one packed entry, got: ${pack.stdout}`,
    );
    ok(files.length > 0);
  });

  it("contains the emitter, its templates, and its TypeSpec library", () => {
    for (const required of [
      "package.json",
      "README.md",
      "LICENSE",
      "CHANGELOG.md",
      "lib/main.tsp",
      "dist/src/index.js",
      "dist/src/index.d.ts",
      "dist/templates/record.hbs",
      "dist/templates/client-runtime.hbs",
    ]) {
      ok(files.includes(required), `Expected ${required} in the package`);
    }
  });

  it("has a template for every template name the renderer loads", () => {
    const shipped = files.filter((f) => f.startsWith("dist/templates/"));
    strictEqual(shipped.length, 10, shipped.join(", "));
  });

  it("does not ship tests, examples, the end-to-end project, or repository tooling", () => {
    const unwanted = files.filter(
      (f) =>
        /^(test|dist\/test|e2e|example|scripts|\.github|src)\//.test(f) ||
        /^(CLAUDE\.md|eslint\.config\.js|tsconfig\.json|\.prettierignore|\.gitattributes)$/.test(
          f,
        ),
    );
    strictEqual(unwanted.length, 0, `Unexpected files: ${unwanted.join(", ")}`);
  });

  it("points main, types, exports and tspMain at files that exist", () => {
    const targets = [
      manifest.main,
      manifest.tspMain,
      manifest.exports["."].types,
      manifest.exports["."].default,
      manifest.exports["."].typespec,
    ];
    for (const target of targets) {
      ok(
        existsSync(resolve(root, target)),
        `${target} must exist after a build`,
      );
      ok(
        files.includes(target.replace(/^\.\//, "")),
        `${target} must be packed`,
      );
    }
  });

  it("is published publicly, as a scoped package is private by default", () => {
    strictEqual(manifest.publishConfig?.access, "public");
  });

  it("requires a handlebars release without the 4.7.9 injection advisories", () => {
    const range: string = manifest.dependencies.handlebars;
    const floor = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(range);
    ok(floor, `Expected a caret range, got ${range}`);
    const [major, minor, patch] = floor.slice(1).map(Number);
    ok(
      major > 4 || (major === 4 && (minor > 7 || (minor === 7 && patch >= 10))),
      `handlebars ${range} still allows 4.7.9 (GHSA-xw65-4hp5-5hc7, GHSA-8r5x-fm3f-whwj, GHSA-p8wg-vrv2-v86f)`,
    );
    const lock = JSON.parse(
      readFileSync(resolve(root, "package-lock.json"), "utf-8"),
    );
    strictEqual(lock.packages[""].dependencies.handlebars, range);
  });

  it("declares where the code lives", () => {
    ok(manifest.repository.url.includes("MassiveScale/tsp-flurl-client"));
    ok(manifest.license);
    ok(manifest.keywords.includes("typespec"));
  });
});
