import { deepStrictEqual, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import {
  buildPathTree,
  firstItem,
  nestInterfaces,
  parseRoute,
  placeholderNames,
  splitSegments,
  stepName,
  type InterfaceBuilder,
  type PathItem,
  type StepParam,
  type TreeNode,
  type TypeRules,
} from "../src/tree.js";

/** Compares types with a trailing `?` ignored, and keeps the `?` of either. */
const RULES: TypeRules = {
  identity: (t) => t.replace(/\?$/, ""),
  union: (a, b) => (a.endsWith("?") ? a : b),
};

/**
 * A path parameter as the tree carries it.
 *
 * @param name - Its route-template name.
 * @param csType - Its C# type.
 * @returns The parameter.
 */
function param(name: string, csType = "string"): StepParam {
  return { name, csType, csParam: name, docName: name, doc: undefined };
}

/**
 * An operation for {@link buildPathTree}, carrying its route as its value.
 *
 * @param path - The route template.
 * @param types - The C# type of each path parameter that is not `string`.
 * @param fallback - Its interface's name.
 * @returns The item.
 */
function item(
  path: string,
  types: Record<string, string> = {},
  fallback = "Group",
): PathItem<string> {
  const route = parseRoute(path);
  const held = [...route.leading, ...route.steps.flatMap((s) => s.params)];
  return {
    value: path,
    route,
    fallback,
    params: new Map(held.map((n) => [n, param(n, types[n])])),
  };
}

/**
 * A tree as nested plain objects, so a test can compare it whole.
 *
 * @param nodes - The nodes of a level.
 * @returns Each node's step, class, parameter types, operations, and children.
 */
function shape(nodes: TreeNode<string>[]): unknown[] {
  return nodes.map((n) => ({
    step: n.indexer ? "[]" : n.step,
    className: n.className,
    params: n.params.map((p) => `${p.csType} ${p.name}`),
    items: n.items,
    children: shape(n.children),
  }));
}

describe("splitSegments", () => {
  it("splits on slashes and drops empty segments", () =>
    deepStrictEqual(splitSegments("//pets//{id}/"), ["pets", "{id}"]));

  it("does not split on a slash inside an expression", () =>
    deepStrictEqual(splitSegments("/files{/name}/x"), ["files{/name}", "x"]));

  it("returns nothing for the root route", () =>
    deepStrictEqual(splitSegments("/"), []));

  it("still splits after a stray closing brace", () =>
    deepStrictEqual(splitSegments("/a}/b"), ["a}", "b"]));
});

describe("placeholderNames", () => {
  it("lists every expression's name in order, operators and explode removed", () =>
    deepStrictEqual(placeholderNames("/a/{x}/{+path}/{y*}.json{?q}"), [
      "x",
      "path",
      "y",
      "q",
    ]));
});

describe("stepName", () => {
  it("capitalizes a single word", () => strictEqual(stepName("pets"), "Pets"));

  it("keeps the inner casing of a camel-case word", () =>
    strictEqual(stepName("wholeSeconds"), "WholeSeconds"));

  it("joins words separated by hyphens, underscores, dots and spaces", () => {
    strictEqual(stepName("encoded-params"), "EncodedParams");
    strictEqual(stepName("snake_case"), "SnakeCase");
    strictEqual(stepName("v1.0"), "V10");
    strictEqual(stepName("two words"), "TwoWords");
  });

  it("refuses a segment holding an expression", () => {
    strictEqual(stepName("{id}"), undefined);
    strictEqual(stepName("report{id}"), undefined);
  });

  it("refuses a segment that does not make a C# name", () => {
    strictEqual(stepName("$count"), undefined);
    strictEqual(stepName("2fa"), undefined);
    strictEqual(stepName("-"), undefined);
  });
});

describe("parseRoute", () => {
  it("makes each literal segment a step with the parameters after it", () =>
    deepStrictEqual(parseRoute("/communities/{key}/configuration/rewards"), {
      leading: [],
      leadingPath: "",
      steps: [
        { name: "Communities", params: ["key"], path: "/communities/{key}" },
        {
          name: "Configuration",
          params: [],
          path: "/communities/{key}/configuration",
        },
        {
          name: "Rewards",
          params: [],
          path: "/communities/{key}/configuration/rewards",
        },
      ],
      args: [],
    }));

  it("gives one step every parameter segment that follows it", () =>
    deepStrictEqual(parseRoute("/lookup/{kind}/{id}").steps, [
      { name: "Lookup", params: ["kind", "id"], path: "/lookup/{kind}/{id}" },
    ]));

  it("holds a reserved-expansion parameter as a step parameter", () =>
    deepStrictEqual(
      parseRoute("/reserved/{+path}/items/{id}").steps.map((s) => s.params),
      [["path"], ["id"]],
    ));

  it("keeps the parameters before the first literal segment apart", () => {
    const route = parseRoute("/{tenant}/{storeId}/pets");
    deepStrictEqual(route.leading, ["tenant", "storeId"]);
    strictEqual(route.leadingPath, "/{tenant}/{storeId}");
    deepStrictEqual(route.steps, [
      { name: "Pets", params: [], path: "/{tenant}/{storeId}/pets" },
    ]);
  });

  it("stops at a mixed segment and makes every later parameter an argument", () => {
    const route = parseRoute("/pets/{petId}/{from}-{to}/x/{id}");
    deepStrictEqual(
      route.steps.map((s) => s.name),
      ["Pets"],
    );
    deepStrictEqual(route.args, ["from", "to", "id"]);
  });

  it("stops at a literal segment that is not a C# name", () => {
    const route = parseRoute("/items/$count/{x}");
    deepStrictEqual(
      route.steps.map((s) => s.name),
      ["Items"],
    );
    deepStrictEqual(route.args, ["x"]);
  });

  it("has no steps for the root route or one starting with a mixed segment", () => {
    deepStrictEqual(parseRoute("/"), {
      leading: [],
      leadingPath: "",
      steps: [],
      args: [],
    });
    deepStrictEqual(parseRoute("/{from}-{to}/report").args, ["from", "to"]);
    deepStrictEqual(parseRoute("/{from}-{to}/report").steps, []);
  });

  it("does not treat an expression with an operator as a parameter segment", () =>
    deepStrictEqual(parseRoute("/files/{/name}").args, ["name"]));
});

describe("firstItem", () => {
  it("finds the first operation of a builder, or of the first builder below it that has one", () => {
    const [a] = buildPathTree([item("/a/b/c"), item("/a/b/d")], RULES);
    strictEqual(firstItem(a), "/a/b/c");
    strictEqual(firstItem({ ...a, items: [], children: [] }), undefined);
  });
});

describe("buildPathTree", () => {
  it("merges the steps routes share and names each class after its chain", () =>
    deepStrictEqual(
      shape(
        buildPathTree(
          [
            item("/communities/{key}/configuration"),
            item("/communities/{key}/configuration/rewards"),
            item("/communities"),
          ],
          RULES,
        ),
      ),
      [
        {
          step: "Communities",
          className: "CommunitiesRequestBuilder",
          params: [],
          items: ["/communities"],
          children: [],
        },
        {
          step: "Communities",
          className: "CommunitiesItemRequestBuilder",
          params: ["string key"],
          items: [],
          children: [
            {
              step: "Configuration",
              className: "CommunitiesItemConfigurationRequestBuilder",
              params: [],
              items: ["/communities/{key}/configuration"],
              children: [
                {
                  step: "Rewards",
                  className:
                    "CommunitiesItemConfigurationRewardsRequestBuilder",
                  params: [],
                  items: ["/communities/{key}/configuration/rewards"],
                  children: [],
                },
              ],
            },
          ],
        },
      ],
    ));

  it("merges steps whose parameters differ only in name, keeping the first name", () => {
    const [pets] = buildPathTree(
      [item("/pets/{id}"), item("/pets/{petId}/toys")],
      RULES,
    );
    deepStrictEqual(
      pets.params.map((p) => p.name),
      ["id"],
    );
    deepStrictEqual(pets.items, ["/pets/{id}"]);
    deepStrictEqual(
      pets.children.map((c) => c.items),
      [["/pets/{petId}/toys"]],
    );
  });

  it("keeps steps whose parameters have different types apart, numbering their classes", () =>
    deepStrictEqual(
      buildPathTree(
        [item("/pets/{id}", { id: "int" }), item("/pets/{name}")],
        RULES,
      ).map((n) => n.className),
      ["PetsItemRequestBuilder", "PetsItem2RequestBuilder"],
    ));

  it("merges steps whose types differ only in nullability, allowing null", () => {
    const [pets] = buildPathTree(
      [item("/pets/{id}"), item("/pets/{id}/toys", { id: "string?" })],
      RULES,
    );
    strictEqual(pets.params[0].csType, "string?");
  });

  it("orders a level by first appearance, the indexer first and fewer parameters first", () =>
    deepStrictEqual(
      buildPathTree(
        [
          item("/stores/{id}"),
          item("/pets"),
          item("/{tenant}/x"),
          item("/stores"),
        ],
        RULES,
      ).map((n) => n.className),
      [
        "ItemRequestBuilder",
        "StoresRequestBuilder",
        "StoresItemRequestBuilder",
        "PetsRequestBuilder",
      ],
    ));

  it("reaches the parameters before the first literal through an indexer", () =>
    deepStrictEqual(shape(buildPathTree([item("/{storeId}/pets")], RULES)), [
      {
        step: "[]",
        className: "ItemRequestBuilder",
        params: ["string storeId"],
        items: [],
        children: [
          {
            step: "Pets",
            className: "ItemPetsRequestBuilder",
            params: [],
            items: ["/{storeId}/pets"],
            children: [],
          },
        ],
      },
    ]));

  it("numbers indexers whose parameters have different types", () =>
    deepStrictEqual(
      buildPathTree([item("/{a}/x"), item("/{b}/y", { b: "int" })], RULES).map(
        (n) => n.className,
      ),
      ["ItemRequestBuilder", "Item2RequestBuilder"],
    ));

  it("sends an operation whose route has only leading parameters from the indexer", () => {
    const [indexer] = buildPathTree([item("/{a}/{b}-{c}")], RULES);
    strictEqual(indexer.indexer, true);
    deepStrictEqual(indexer.items, ["/{a}/{b}-{c}"]);
  });

  it("reaches an operation whose route has no step by its interface's name", () => {
    const [health] = buildPathTree(
      [item("/", {}, "Health"), item("/{from}-{to}/report", {}, "Health")],
      RULES,
    );
    strictEqual(health.step, "Health");
    strictEqual(health.group, "Health");
    strictEqual(health.path, undefined);
    deepStrictEqual(health.items, ["/", "/{from}-{to}/report"]);
  });

  it("merges a step named like an interface fallback into it", () =>
    deepStrictEqual(
      buildPathTree([item("/", {}, "Health"), item("/health")], RULES).map(
        (n) => n.items,
      ),
      [["/", "/health"]],
    ));
});

/**
 * A builder for {@link nestInterfaces}, carrying its routes as its items.
 *
 * @param group - The interface's name.
 * @param routes - Its operations' routes.
 * @param params - Its path parameters' types, in route order.
 * @returns The builder.
 */
function builder(
  group: string,
  routes: string[],
  params: string[] = [],
): InterfaceBuilder<string> {
  return {
    group,
    params: params.map((t, i) => param(`p${i}`, t)),
    routes,
    items: routes,
  };
}

describe("nestInterfaces", () => {
  it("hangs an interface under the builder whose route its routes start with", () =>
    deepStrictEqual(
      shape(
        nestInterfaces(
          [
            builder(
              "Community",
              ["/communities/{key}/configuration"],
              ["string"],
            ),
            builder(
              "Rewards",
              ["/communities/{communityKey}/configuration/rewards"],
              ["string"],
            ),
          ],
          RULES,
        ),
      ),
      [
        {
          step: "Community",
          className: "CommunityItemRequestBuilder",
          params: ["string p0"],
          items: ["/communities/{key}/configuration"],
          children: [
            {
              step: "Rewards",
              className: "CommunityItemRewardsRequestBuilder",
              params: [],
              items: ["/communities/{communityKey}/configuration/rewards"],
              children: [],
            },
          ],
        },
      ],
    ));

  it("passes on only the parameters the parent's route does not hold", () => {
    const [pets] = nestInterfaces(
      [
        builder("Pets", ["/pets/{id}"], ["string"]),
        builder("Toys", ["/pets/{petId}/toys/{toyId}"], ["string", "int"]),
      ],
      RULES,
    );
    deepStrictEqual(
      pets.children[0].params.map((p) => `${p.csType} ${p.name}`),
      ["int p1"],
    );
  });

  it("picks the longest route the interface's routes start with", () => {
    const roots = nestInterfaces(
      [
        builder("A", ["/a"]),
        builder("B", ["/a/b"]),
        builder("C", ["/a/b/c", "/a/b/c/d"]),
      ],
      RULES,
    );
    deepStrictEqual(
      shape(roots).map((r) => JSON.stringify(r)),
      [
        JSON.stringify({
          step: "A",
          className: "ARequestBuilder",
          params: [],
          items: ["/a"],
          children: [
            {
              step: "B",
              className: "ABRequestBuilder",
              params: [],
              items: ["/a/b"],
              children: [
                {
                  step: "C",
                  className: "ABCRequestBuilder",
                  params: [],
                  items: ["/a/b/c", "/a/b/c/d"],
                  children: [],
                },
              ],
            },
          ],
        }),
      ],
    );
  });

  it("does not nest under a route the interface's base route only equals", () =>
    deepStrictEqual(
      nestInterfaces([builder("A", ["/x"]), builder("B", ["/x"])], RULES).map(
        (n) => n.step,
      ),
      ["A", "B"],
    ));

  it("never nests under the root route", () =>
    deepStrictEqual(
      nestInterfaces(
        [builder("Health", ["/"]), builder("Pets", ["/pets"])],
        RULES,
      ).map((n) => n.step),
      ["Health", "Pets"],
    ));

  it("does not nest when the shared parameters have different types", () =>
    deepStrictEqual(
      nestInterfaces(
        [
          builder("Pets", ["/pets/{id}"], ["int"]),
          builder("Toys", ["/pets/{petId}/toys"], ["string"]),
        ],
        RULES,
      ).map((n) => n.step),
      ["Pets", "Toys"],
    ));

  it("does not nest under a builder of the same interface", () =>
    deepStrictEqual(
      nestInterfaces(
        [
          builder("Pets", ["/pets"]),
          builder("Pets", ["/pets/{id}/toys"], ["string"]),
        ],
        RULES,
      ).map((n) => n.className),
      ["PetsRequestBuilder", "PetsItemRequestBuilder"],
    ));

  it("does not nest under a builder that holds more parameters", () =>
    deepStrictEqual(
      nestInterfaces(
        [
          builder("Wide", ["/x/{a}/{b}"], ["string", "string"]),
          builder("Narrow", ["/x/{a}/{b}/y"], ["string"]),
        ],
        RULES,
      ).map((n) => n.step),
      ["Wide", "Narrow"],
    ));

  it("compares a literal segment by its text and a parameter by its place", () => {
    const roots = nestInterfaces(
      [
        builder("A", ["/a/{x}"], ["string"]),
        builder("B", ["/b/{x}/c"], ["string"]),
        builder("C", ["/a/c"]),
        builder("D", ["/a/{y}/d"], ["string"]),
      ],
      RULES,
    );
    deepStrictEqual(
      roots.map((n) => [n.step, n.children.map((c) => c.step)]),
      [
        ["A", ["D"]],
        ["B", []],
        ["C", []],
      ],
    );
  });
});
