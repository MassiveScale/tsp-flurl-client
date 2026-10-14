import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deepStrictEqual, ok } from "node:assert";
import { describe, it } from "node:test";
import ts from "typescript";
import { $lib } from "../src/lib.js";

/**
 * The repository conventions in `.github/copilot-instructions.md` that a program
 * can check, checked on every test run so a reviewer never has to.
 */

const ROOT = resolve(fileURLToPath(import.meta.url), "../../..");

/** Directories never scanned: dependencies, build output, and generated code. */
const SKIPPED = new Set([
  "node_modules",
  "dist",
  "tsp-output",
  "bin",
  "obj",
  ".vs",
  ".git",
  "coverage",
]);

/**
 * Lists the files under a directory of the repository, recursively.
 *
 * @param dir - The directory, relative to the repository root.
 * @param extensions - The file extensions to keep, such as `.ts`.
 * @returns Absolute paths.
 */
function filesUnder(dir: string, extensions: string[]): string[] {
  const found: string[] = [];
  const walk = (path: string): void => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (SKIPPED.has(entry.name)) continue;
      const child = resolve(path, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (extensions.some((ext) => entry.name.endsWith(ext))) {
        found.push(child);
      }
    }
  };
  walk(resolve(ROOT, dir));
  return found;
}

/** A path relative to the repository root, for messages. */
const shown = (path: string): string =>
  relative(ROOT, path).replace(/\\/g, "/");

const SOURCES = filesUnder("src", [".ts"]);
const TESTS = filesUnder("test", [".ts"]);
const TEMPLATES = filesUnder("src/templates", [".hbs"]);
const HAND_WRITTEN = [
  ...SOURCES,
  ...TESTS,
  ...TEMPLATES,
  ...filesUnder("scripts", [".mjs", ".js", ".ts"]),
  ...filesUnder("e2e", [".cs"]),
  ...filesUnder("matrix", [".mjs", ".cs"]),
  ...filesUnder("example", [".tsp"]),
];

describe("ESM imports", () => {
  it("name every relative import with its .js extension", () => {
    const offenders: string[] = [];
    for (const file of [...SOURCES, ...TESTS]) {
      for (const match of readFileSync(file, "utf-8").matchAll(
        /\bfrom\s+"(\.{1,2}\/[^"]+)"/g,
      )) {
        if (!match[1].endsWith(".js")) {
          offenders.push(`${shown(file)}: ${match[1]}`);
        }
      }
    }
    deepStrictEqual(offenders, []);
  });
});

describe("comments", () => {
  it("have no decorative section dividers", () => {
    const offenders: string[] = [];
    for (const file of HAND_WRITTEN) {
      readFileSync(file, "utf-8")
        .split("\n")
        .forEach((line, i) => {
          if (/─{3,}|═{3,}|^\s*(\/\/|#|\*)\s*[-=*]{8,}\s*$/.test(line)) {
            offenders.push(`${shown(file)}:${i + 1}`);
          }
        });
    }
    // The generated file header is framed by the conventional auto-generated banner.
    deepStrictEqual(
      offenders.filter((o) => !o.startsWith("src/templates/file.hbs:")),
      [],
    );
  });
});

describe("JSDoc", () => {
  /**
   * The declarations in a source file that must carry a JSDoc block: every
   * function, class, class member, interface, type alias, enum, and exported
   * constant, and a module-level constant holding a function. With
   * `everyConstant`, every module-level constant.
   */
  const undocumented = (file: string, everyConstant: boolean): string[] => {
    const source = ts.createSourceFile(
      file,
      readFileSync(file, "utf-8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const missing: string[] = [];
    const hasDoc = (node: ts.Node): boolean =>
      ts.getJSDocCommentsAndTags(node).length > 0;
    const report = (node: ts.Node, name: string): void => {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart());
      missing.push(`${shown(file)}:${line + 1} ${name}`);
    };
    const nameOf = (node: ts.Node): string =>
      (node as { name?: ts.Node }).name?.getText(source) ?? "(anonymous)";

    for (const statement of source.statements) {
      if (
        ts.isFunctionDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement) ||
        ts.isEnumDeclaration(statement)
      ) {
        if (!hasDoc(statement)) report(statement, nameOf(statement));
      } else if (ts.isClassDeclaration(statement)) {
        if (!hasDoc(statement)) report(statement, nameOf(statement));
        for (const member of statement.members) {
          if (
            (ts.isMethodDeclaration(member) ||
              ts.isPropertyDeclaration(member) ||
              ts.isConstructorDeclaration(member) ||
              ts.isGetAccessorDeclaration(member)) &&
            !hasDoc(member)
          ) {
            report(member, `${nameOf(statement)}.${nameOf(member)}`);
          }
        }
      } else if (ts.isVariableStatement(statement)) {
        // The JSDoc of a constant sits on its statement.
        if (hasDoc(statement)) continue;
        const exported = statement.modifiers?.some(
          (m) => m.kind === ts.SyntaxKind.ExportKeyword,
        );
        for (const declaration of statement.declarationList.declarations) {
          const initializer = declaration.initializer;
          const isFunction =
            initializer !== undefined &&
            (ts.isArrowFunction(initializer) ||
              ts.isFunctionExpression(initializer));
          if (everyConstant || exported || isFunction) {
            report(statement, declaration.name.getText(source));
          }
        }
      }
    }
    return missing;
  };

  it("documents every declaration in the emitter's sources", () => {
    deepStrictEqual(
      SOURCES.flatMap((file) => undocumented(file, true)),
      [],
    );
  });

  it("documents every function, type, and exported constant in the tests", () => {
    deepStrictEqual(
      TESTS.flatMap((file) => undocumented(file, false)),
      [],
    );
  });
});

describe("templates", () => {
  it("each open with a comment describing the template", () => {
    deepStrictEqual(
      TEMPLATES.filter(
        (file) => !readFileSync(file, "utf-8").startsWith("{{!--"),
      ).map(shown),
      [],
    );
  });

  it("never suppress the missing-documentation warning", () => {
    deepStrictEqual(
      TEMPLATES.filter((file) =>
        /#pragma\s+warning\s+disable[^\n]*CS1591/.test(
          readFileSync(file, "utf-8"),
        ),
      ).map(shown),
      [],
    );
  });
});

describe("line endings", () => {
  it("are LF in every hand-written file", () => {
    deepStrictEqual(
      HAND_WRITTEN.filter((file) =>
        readFileSync(file, "utf-8").includes("\r"),
      ).map(shown),
      [],
    );
  });
});

describe("diagnostics", () => {
  const codes = Object.keys($lib.diagnostics);
  const sources = SOURCES.filter((f) => !f.endsWith("lib.ts"))
    .map((f) => readFileSync(f, "utf-8"))
    .join("\n");
  const tests = TESTS.map((f) => readFileSync(f, "utf-8")).join("\n");

  it("are each reported somewhere in the emitter", () => {
    deepStrictEqual(
      codes.filter((code) => !sources.includes(`"${code}"`)),
      [],
    );
  });

  it("are each covered by a test", () => {
    deepStrictEqual(
      codes.filter((code) => !tests.includes(code)),
      [],
    );
  });

  it("that leave something out are each listed in the README under what is not supported", () => {
    const readme = readFileSync(resolve(ROOT, "README.md"), "utf-8");
    const start = readme.indexOf("### What is not supported");
    ok(start >= 0, 'README has a "What is not supported" section');
    const end = readme.indexOf("\n## ", start + 1);
    const section = readme.slice(start, end < 0 ? undefined : start + 1 + end);
    deepStrictEqual(
      codes
        .filter((code) => code.startsWith("unsupported-"))
        .filter((code) => code !== "unsupported-feature")
        .filter((code) => !section.includes(`\`${code}\``)),
      [],
    );
  });
});

describe("the changelog", () => {
  it("has a section for the version in package.json", () => {
    const { version } = JSON.parse(
      readFileSync(resolve(ROOT, "package.json"), "utf-8"),
    ) as { version: string };
    ok(
      readFileSync(resolve(ROOT, "CHANGELOG.md"), "utf-8").includes(
        `## [${version}]`,
      ),
      version,
    );
  });
});
