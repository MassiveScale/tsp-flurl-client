// The request-builder trees of the `path` and `interface` client shapes: which
// builder each operation is sent from, the steps that lead to it from the client,
// and what each builder is called. It works on route templates and C# type
// spellings only, so it depends on nothing but the identifier rules.

import { isCsTypeName } from "./identifiers.js";

/** How a client chains its request builders, from the `client-shape` option. */
export type ClientShape = "flat" | "path" | "interface";

/** One step of a parsed route: a literal segment, and the parameter segments right after it. */
export interface RouteStep {
  /** The C# name of the step, e.g. `EncodedParams` for `encoded-params`. */
  name: string;
  /** The wire names of the parameters the step takes, in path order. */
  params: string[];
  /** The route template up to and including the step, e.g. `/communities/{communityKey}`. */
  path: string;
}

/** A route template split into the steps a `path` client reaches it by. */
export interface ParsedRoute {
  /** The wire names of the parameters before the first literal segment, which the client takes through an indexer. */
  leading: string[];
  /** The route template up to the last leading parameter, e.g. `/{storeId}`. Empty without leading parameters. */
  leadingPath: string;
  /** The steps, in path order, up to the first segment that cannot be one. */
  steps: RouteStep[];
  /**
   * The wire names of the path parameters after the last step, in path order. The
   * operation's method takes them as arguments, since no step can hold them.
   */
  args: string[];
}

/** A path parameter a step takes. */
export interface StepParam {
  /** The parameter's name in the route template. */
  name: string;
  /** C# type, nullable when the parameter is optional. */
  csType: string;
  /** C# parameter name, verbatim-escaped when needed, e.g. `"@await"`. */
  csParam: string;
  /** The same name, never escaped, e.g. `"await"`. */
  docName: string;
  /** The parameter's documentation (pre-escaped), if any. */
  doc: string | undefined;
}

/**
 * A request builder of a tree: the operations sent from it, the path parameters
 * it adds to those of the builders before it, and the builders reached from it.
 */
export interface TreeNode<T> {
  /** The name of the method that creates it, e.g. `Rewards`; empty for an indexer. */
  step: string;
  /** Whether the client creates it through an indexer (`client[storeId]`). */
  indexer: boolean;
  /** The path parameters the step takes, in path order; the builder holds these after its ancestors'. */
  params: StepParam[];
  /** The C# class name, e.g. `CommunitiesItemConfigurationRequestBuilder`. */
  className: string;
  /** The route template the builder stands for, e.g. `/communities/{communityKey}`, when it stands for one. */
  path?: string;
  /** The interface the builder is named after, when it is named after one. */
  group?: string;
  /** The operations sent from the builder, in declaration order. */
  items: T[];
  /** The builders reached from it. */
  children: TreeNode<T>[];
}

/** How the tree compares and combines the C# types of path parameters. */
export interface TypeRules {
  /** The type as the CLR sees it, so two spellings that make the same overload compare equal. */
  identity(csType: string): string;
  /** The spelling of two equal types that allows null wherever either does. */
  union(a: string, b: string): string;
}

/** An operation placed into a `path` tree. */
export interface PathItem<T> {
  /** What the tree carries for the operation. */
  value: T;
  /** The operation's parsed route (see {@link parseRoute}). */
  route: ParsedRoute;
  /** The step the operation is reached by when its route has no step or leading parameter: its interface's name. */
  fallback: string;
  /** The path parameters held by builders (every one but {@link ParsedRoute.args}), by wire name. */
  params: ReadonlyMap<string, StepParam>;
}

/** A request builder of one interface, as the `flat` shape groups them, for nesting by {@link nestInterfaces}. */
export interface InterfaceBuilder<T> {
  /** The interface's name, which is the step that reaches the builder. */
  group: string;
  /** The path parameters the builder holds, in path order. */
  params: StepParam[];
  /** The route template of each of its operations. */
  routes: string[];
  /** What the tree carries for each of its operations. */
  items: T[];
}

/**
 * The first operation sent from a builder or from any builder reached from it,
 * which a diagnostic about the builder can point at.
 *
 * @param node - The builder.
 * @returns The operation, or `undefined` when none is reached.
 */
export function firstItem<T>(node: TreeNode<T>): T | undefined {
  if (node.items.length > 0) return node.items[0];
  for (const child of node.children) {
    const found = firstItem(child);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** A parameter segment, `{name}` or `{+name}`. Any other expression is not a step's parameter. */
const PARAM_SEGMENT = /^\{\+?([^{}*,+#./;?&=]+)\}$/;

/** Every expression of a route template, with the parameter name it holds. */
const PLACEHOLDER = /\{[+#./;?&]?([^}*]+)\*?\}/g;

/**
 * Splits a route template into its segments, ignoring empty ones. A `/` inside an
 * expression (`{/name}`) does not split it.
 *
 * @param path - The route template.
 * @returns The segments, as written.
 */
export function splitSegments(path: string): string[] {
  const segments: string[] = [];
  let current = "";
  let depth = 0;
  for (const c of path) {
    if (c === "{") depth++;
    if (c === "}") depth = Math.max(0, depth - 1);
    if (c === "/" && depth === 0) {
      if (current) segments.push(current);
      current = "";
    } else {
      current += c;
    }
  }
  if (current) segments.push(current);
  return segments;
}

/**
 * The parameter names a piece of route template holds, in order.
 *
 * @param path - The route template, or a part of it.
 * @returns The names.
 */
export function placeholderNames(path: string): string[] {
  return [...path.matchAll(PLACEHOLDER)].map((m) => m[1]);
}

/**
 * The parameter a segment consists of, when it is nothing but one.
 *
 * @param segment - The segment.
 * @returns The parameter's wire name, or `undefined`.
 */
function paramOf(segment: string): string | undefined {
  return PARAM_SEGMENT.exec(segment)?.[1];
}

/**
 * The step name of a literal segment: each of its words capitalized, the words
 * being separated by `-`, `_`, `.` or spaces (`encoded-params` → `EncodedParams`).
 *
 * @param segment - The segment.
 * @returns The name, or `undefined` when the segment holds an expression or does
 *   not make a C# type name (`$count`, `2fa`).
 */
export function stepName(segment: string): string | undefined {
  if (segment.includes("{") || segment.includes("}")) return undefined;
  const name = segment
    .split(/[-_.\s]+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join("");
  return isCsTypeName(name) ? name : undefined;
}

/**
 * Splits a route template into the steps a `path` client reaches it by: the
 * parameters before the first literal segment, then each literal segment with the
 * parameter segments right after it. The tree ends at the first segment that can
 * be neither (`{name}.json`, `$count`); every parameter from there on is an
 * argument of the operation's method.
 *
 * @param path - The route template, without the route prefix.
 * @returns The parsed route.
 */
export function parseRoute(path: string): ParsedRoute {
  const segments = splitSegments(path);
  const leading: string[] = [];
  let i = 0;
  for (; i < segments.length && paramOf(segments[i]) !== undefined; i++) {
    leading.push(paramOf(segments[i])!);
  }
  const leadingPath = segments
    .slice(0, i)
    .map((s) => `/${s}`)
    .join("");
  let current = leadingPath;
  const steps: RouteStep[] = [];
  while (i < segments.length) {
    const name = stepName(segments[i]);
    if (name === undefined) break;
    current += `/${segments[i]}`;
    const params: string[] = [];
    for (i++; i < segments.length && paramOf(segments[i]) !== undefined; i++) {
      params.push(paramOf(segments[i])!);
      current += `/${segments[i]}`;
    }
    steps.push({ name, params, path: current });
  }
  return {
    leading,
    leadingPath,
    steps,
    args: segments.slice(i).flatMap(placeholderNames),
  };
}

/**
 * Finds the node of a level that a step reaches, or adds it. Two steps reach the
 * same node when they have the same name and their parameters the same CLR types,
 * since they would otherwise be the same overload; the node's types then allow
 * null wherever either does.
 *
 * @param level - The nodes of the level.
 * @param link - The step.
 * @param link.step - The step's name, empty for an indexer.
 * @param link.indexer - Whether the step is an indexer.
 * @param link.params - The step's parameters.
 * @param link.path - The route template the step stands for, if any.
 * @param link.group - The interface the step is named after, if any.
 * @param rules - How parameter types compare and combine.
 * @returns The node.
 */
function reach<T>(
  level: TreeNode<T>[],
  link: Pick<TreeNode<T>, "step" | "indexer" | "params" | "path" | "group">,
  rules: TypeRules,
): TreeNode<T> {
  const key = (params: StepParam[]): string =>
    JSON.stringify(params.map((p) => rules.identity(p.csType)));
  const wanted = key(link.params);
  const found = level.find(
    (node) =>
      node.step === link.step &&
      node.indexer === link.indexer &&
      key(node.params) === wanted,
  );
  if (found) {
    found.params = found.params.map((p, i) => ({
      ...p,
      csType: rules.union(p.csType, link.params[i].csType),
    }));
    return found;
  }
  const node: TreeNode<T> = {
    ...link,
    className: "",
    items: [],
    children: [],
  };
  level.push(node);
  return node;
}

/**
 * Orders every level of a tree and names its classes. On each level the steps
 * keep the order their names first appear in, the indexer first when there is
 * one, and the overloads of one name go by how many parameters they take. A class
 * is named after the steps that lead to it, with `Item`, `Item2`, ... after the
 * ones that take parameters, as `flat` names the builders of an interface:
 * `Communities(key).Configuration()` creates a `CommunitiesItemConfigurationRequestBuilder`.
 *
 * @param level - The nodes of a level.
 * @param prefix - The class name of the parent without `RequestBuilder`, empty at the root.
 */
function finish<T>(level: TreeNode<T>[], prefix: string): void {
  const first = new Map<string, number>();
  level.forEach((node, i) => {
    const key = node.indexer ? "" : node.step;
    if (!first.has(key)) first.set(key, node.indexer ? -1 : i);
  });
  const firstOf = (node: TreeNode<T>): number =>
    first.get(node.indexer ? "" : node.step)!;
  level.sort(
    (a, b) => firstOf(a) - firstOf(b) || a.params.length - b.params.length,
  );
  const items = new Map<string, number>();
  for (const node of level) {
    const base = `${prefix}${node.indexer ? "" : node.step}`;
    let suffix = "";
    if (node.params.length > 0) {
      const n = (items.get(base) ?? 0) + 1;
      items.set(base, n);
      suffix = n === 1 ? "Item" : `Item${n}`;
    }
    node.className = `${base}${suffix}RequestBuilder`;
    finish(node.children, `${base}${suffix}`);
  }
}

/**
 * Builds the `path` tree: every literal segment of a route is a step, which takes
 * the parameter segments right after it (`communities/{key}` → `Communities(key)`),
 * and the parameters before the first literal segment are an indexer of the client
 * (`client[storeId]`). An operation whose route has neither is reached by its
 * interface's name, with every path parameter an argument of its method.
 *
 * @param items - The operations, in declaration order.
 * @param rules - How parameter types compare and combine.
 * @returns The builders the client creates, each with the builders reached from it.
 */
export function buildPathTree<T>(
  items: PathItem<T>[],
  rules: TypeRules,
): TreeNode<T>[] {
  const roots: TreeNode<T>[] = [];
  for (const item of items) {
    const { leading, leadingPath, steps } = item.route;
    const bind = (names: string[]): StepParam[] =>
      names.map((name) => item.params.get(name)!);
    const chain: Pick<
      TreeNode<T>,
      "step" | "indexer" | "params" | "path" | "group"
    >[] =
      leading.length + steps.length === 0
        ? [
            {
              step: item.fallback,
              indexer: false,
              params: [],
              group: item.fallback,
            },
          ]
        : [
            ...(leading.length > 0
              ? [
                  {
                    step: "",
                    indexer: true,
                    params: bind(leading),
                    path: leadingPath,
                  },
                ]
              : []),
            ...steps.map((s) => ({
              step: s.name,
              indexer: false,
              params: bind(s.params),
              path: s.path,
            })),
          ];
    let level = roots;
    let node: TreeNode<T> | undefined;
    for (const link of chain) {
      node = reach(level, link, rules);
      level = node.children;
    }
    node!.items.push(item.value);
  }
  finish(roots, "");
  return roots;
}

/**
 * Whether one route template starts with another, segment by segment. A parameter
 * segment matches any parameter segment, since the names of one parameter can
 * differ between routes; any other segment must be the same text.
 *
 * @param prefix - The segments of the shorter route.
 * @param path - The segments of the longer route.
 * @returns `true` when `path` starts with `prefix`.
 */
function startsWith(prefix: string[], path: string[]): boolean {
  return prefix.every((segment, i) => {
    const a = paramOf(segment);
    const b = paramOf(path[i]);
    return a !== undefined || b !== undefined
      ? a !== undefined && b !== undefined
      : segment === path[i];
  });
}

/**
 * The longest run of segments every route starts with, comparing parameter
 * segments as {@link startsWith} does.
 *
 * @param routes - The segments of each route.
 * @returns The common segments, as the first route writes them.
 */
function commonPrefix(routes: string[][]): string[] {
  const [first, ...rest] = routes;
  let length = first.length;
  for (const route of rest) {
    let i = 0;
    while (
      i < Math.min(length, route.length) &&
      startsWith([first[i]], [route[i]])
    ) {
      i++;
    }
    length = i;
  }
  return first.slice(0, length);
}

/**
 * Builds the `interface` tree: each builder of an interface hangs under the
 * builder of another interface that sends an operation whose route the interface's
 * routes all start with, and takes only the path parameters that route does not
 * hold (`/pets/{petId}/toys/{toyId}` under `Pets(id)` is `.Toys(toyId)`). The
 * longest such route wins, and a route of `/` never does. The parameters the two share must have the same C#
 * types, since the parent passes its own on. A builder with no such parent stays
 * on the client, as in `flat`.
 *
 * @param builders - Every interface's builders, in the order `flat` emits them.
 * @param rules - How parameter types compare.
 * @returns The builders the client creates, each with the builders reached from it.
 */
export function nestInterfaces<T>(
  builders: InterfaceBuilder<T>[],
  rules: TypeRules,
): TreeNode<T>[] {
  const bases = new Map<string, string[]>();
  for (const group of new Set(builders.map((b) => b.group))) {
    bases.set(
      group,
      commonPrefix(
        builders
          .filter((b) => b.group === group)
          .flatMap((b) => b.routes.map(splitSegments)),
      ),
    );
  }
  const nodes = builders.map((b): TreeNode<T> => ({
    step: b.group,
    indexer: false,
    params: b.params,
    className: "",
    group: b.group,
    items: b.items,
    children: [],
  }));
  const roots: TreeNode<T>[] = [];
  builders.forEach((b, i) => {
    const base = bases.get(b.group)!;
    let parent: { index: number; length: number } | undefined;
    builders.forEach((c, j) => {
      if (c.group === b.group || c.params.length > b.params.length) return;
      const shared = c.params.every(
        (p, k) =>
          rules.identity(p.csType) === rules.identity(b.params[k].csType),
      );
      if (!shared) return;
      for (const route of c.routes) {
        const segments = splitSegments(route);
        // A route of `/` would be the start of every other one, which would put the
        // whole API under it.
        if (
          segments.length > 0 &&
          segments.length < base.length &&
          startsWith(segments, base) &&
          segments.length > (parent?.length ?? -1)
        ) {
          parent = { index: j, length: segments.length };
        }
      }
    });
    if (parent === undefined) {
      roots.push(nodes[i]);
      return;
    }
    const covered = builders[parent.index].params.length;
    nodes[i].params = b.params.slice(covered);
    nodes[parent.index].children.push(nodes[i]);
  });
  finish(roots, "");
  return roots;
}
