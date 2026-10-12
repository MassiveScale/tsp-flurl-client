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
  const files: string[] =
    pack.status === 0
      ? (JSON.parse(pack.stdout)[0].files as { path: string }[]).map(
          (f) => f.path,
        )
      : [];

  it("can be packed", () => {
    strictEqual(pack.status, 0, pack.stderr);
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

  it("declares where the code lives", () => {
    ok(manifest.repository.url.includes("MassiveScale/tsp-flurl-client"));
    ok(manifest.license);
    ok(manifest.keywords.includes("typespec"));
  });
});
