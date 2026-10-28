import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import {
  NoTarget,
  type EnumMember,
  type Program,
  type Type,
} from "@typespec/compiler";
import { buildExtensions } from "../src/client.js";
import {
  $access,
  $clientName,
  getAccess,
  getClientName,
} from "../src/decorators.js";
import {
  deleteGeneratedFiles,
  fileExists,
  type FileHost,
} from "../src/emitter.js";
import { checkName } from "../src/names.js";
import { createRenderer } from "../src/renderer.js";

/** A directory tree in memory: path to its entries, or `null` for a file. */
type Tree = Record<string, string[] | null>;

/**
 * An in-memory file host over a tree, which records what is removed and can fail
 * to read or stat chosen paths.
 */
const fakeHost = (
  tree: Tree,
  options: { unreadable?: string[]; unstatable?: string[] } = {},
) => {
  const removed: string[] = [];
  const host: FileHost = {
    readDir: async (dir: string) => {
      const entries = tree[dir];
      if (!entries || options.unreadable?.includes(dir)) {
        throw new Error(`cannot read ${dir}`);
      }
      return entries;
    },
    stat: async (path: string) => {
      if (options.unstatable?.includes(path) || !(path in tree)) {
        throw new Error(`cannot stat ${path}`);
      }
      const isDirectory = tree[path] !== null;
      return { isDirectory: () => isDirectory, isFile: () => !isDirectory };
    },
    rm: async (path: string) => {
      removed.push(path);
    },
  } as unknown as FileHost;
  return { host, removed };
};

describe("deleteGeneratedFiles", () => {
  const tree: Tree = {
    "/out": ["A.g.cs", "keep.cs", "Proj.csproj", "Models", "Stray.G.CS"],
    "/out/A.g.cs": null,
    "/out/keep.cs": null,
    "/out/Proj.csproj": null,
    "/out/Stray.G.CS": null,
    "/out/Models": ["B.g.cs", "Sub", "notes.txt"],
    "/out/Models/B.g.cs": null,
    "/out/Models/notes.txt": null,
    "/out/Models/Sub": ["C.g.cs", "D.cs"],
    "/out/Models/Sub/C.g.cs": null,
    "/out/Models/Sub/D.cs": null,
  };

  it("deletes generated files at every depth and leaves everything else", async () => {
    const { host, removed } = fakeHost(tree);

    await deleteGeneratedFiles(host, "/out");

    deepStrictEqual(removed.sort(), [
      "/out/A.g.cs",
      "/out/Models/B.g.cs",
      "/out/Models/Sub/C.g.cs",
    ]);
  });

  it("does nothing for a directory that does not exist", async () => {
    const { host, removed } = fakeHost({});

    await deleteGeneratedFiles(host, "/missing");

    strictEqual(removed.length, 0);
  });

  it("skips an entry it cannot inspect and carries on", async () => {
    const { host, removed } = fakeHost(tree, { unstatable: ["/out/A.g.cs"] });

    await deleteGeneratedFiles(host, "/out");

    deepStrictEqual(removed.sort(), [
      "/out/Models/B.g.cs",
      "/out/Models/Sub/C.g.cs",
    ]);
  });

  it("skips a subdirectory it cannot read and carries on", async () => {
    const { host, removed } = fakeHost(tree, {
      unreadable: ["/out/Models/Sub"],
    });

    await deleteGeneratedFiles(host, "/out");

    deepStrictEqual(removed.sort(), ["/out/A.g.cs", "/out/Models/B.g.cs"]);
  });
});

describe("fileExists", () => {
  const { host } = fakeHost({ "/out": ["a.csproj"], "/out/a.csproj": null });

  it("is true for a file", async () =>
    strictEqual(await fileExists(host, "/out/a.csproj"), true));

  it("is false for a directory", async () =>
    strictEqual(await fileExists(host, "/out"), false));

  it("is false for something that cannot be inspected", async () =>
    strictEqual(await fileExists(host, "/nowhere"), false));
});

describe("decorator state", () => {
  const harness = () => {
    const states = new Map<symbol, Map<Type, unknown>>();
    const reported: { code: string }[] = [];
    const program = {
      stateMap: (key: symbol) => {
        if (!states.has(key)) states.set(key, new Map());
        return states.get(key)!;
      },
      reportDiagnostic: (d: { code: string }) => reported.push(d),
    } as unknown as Program;
    return { program, reported, context: { program } as never };
  };

  const model = (name: string): Type =>
    ({ kind: "Model", name }) as unknown as Type;

  it("rejects an access value that is neither public nor internal", () => {
    const { program, reported, context } = harness();
    const target = model("Thing");

    $access(context, target, {
      name: "weird",
      value: "weird",
    } as unknown as EnumMember);

    strictEqual(reported.length, 1);
    ok(reported[0].code.endsWith("invalid-access-modifier"));
    strictEqual(getAccess(program, target), undefined);
  });

  it("stores a valid access value", () => {
    const { program, context } = harness();
    const target = model("Thing");

    $access(context, target, {
      name: "internal",
      value: "internal",
    } as unknown as EnumMember);
    strictEqual(getAccess(program, target), "internal");

    $access(context, target, { name: "public" } as unknown as EnumMember);
    strictEqual(getAccess(program, target), "public");
  });

  it("returns nothing for access that was never set", () => {
    const { program } = harness();

    strictEqual(getAccess(program, model("Thing")), undefined);
  });

  it("returns the client name that was set", () => {
    const { program, context } = harness();
    const target = model("Thing");

    $clientName(context, target, "  Renamed ");

    strictEqual(getClientName(program, target), "Renamed");
  });

  it("returns nothing for a type that was never renamed", () => {
    const { program } = harness();

    strictEqual(getClientName(program, model("Thing")), undefined);
  });

  it("keeps the @clientName of a user model whose name only looks like a merge patch", () => {
    const { program, context } = harness();
    for (const name of [
      "AuditMergePatchUpdate",
      "AuditMergePatchUpdateReplaceOnly",
      "AuditMergePatchCreateOrUpdate",
    ]) {
      const target = model(name);
      $clientName(context, target, "Renamed");
      strictEqual(getClientName(program, target), "Renamed", name);
    }
  });
});

describe("checkName", () => {
  const program = { reportDiagnostic: () => {} } as unknown as Program;

  it("accepts any enum member name, because members are sanitized instead", () =>
    strictEqual(
      checkName(program, "enum member", "my-member", NoTarget),
      true,
    ));
});

describe("client methods for a request builder", () => {
  it("names the method after the endpoint group and passes the path parameters on", () => {
    const source = buildExtensions(
      "Api",
      "Acme",
      [
        {
          groupName: "Pets",
          methodName: "Pets",
          className: "PetsItemRequestBuilder",
          access: "public",
          params: [
            {
              type: "string",
              field: "_id",
              param: "id",
              docParam: "id",
              doc: "The pet id.",
            },
          ],
        },
      ],
      createRenderer(),
    );

    ok(source.includes("public PetsItemRequestBuilder Pets(string id) =>"));
    ok(source.includes("new PetsItemRequestBuilder(this.FlurlClient, id);"));
    ok(source.includes('<param name="id">The pet id.</param>'));
  });
});
