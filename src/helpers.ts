// Helper files: hand-written C# that every generated client depends on but that
// has no TypeSpec counterpart. They are emitted once per C# namespace, so a
// generated project stays self-contained and needs no extra runtime package.

import { Renderer, FileView } from "./renderer.js";
import {
  CLIENT_RUNTIME_HELPER_NAME,
  MERGE_PATCH_HELPER_NAME,
  MODEL_MAP_HELPER_NAME,
  sortUsings,
} from "./utils.js";

/** Names of the helper types the emitter can write. Also the base name of each helper's file. */
export type HelperName =
  | typeof MERGE_PATCH_HELPER_NAME
  | typeof MODEL_MAP_HELPER_NAME
  | typeof CLIENT_RUNTIME_HELPER_NAME;

/** Every helper, in the order they are written. */
export const ALL_HELPERS: readonly HelperName[] = [
  MODEL_MAP_HELPER_NAME,
  CLIENT_RUNTIME_HELPER_NAME,
  MERGE_PATCH_HELPER_NAME,
];

/** The helpers every service needs, as opposed to the ones raised by type mapping. */
export const ALWAYS_EMITTED_HELPERS: readonly HelperName[] = [
  MODEL_MAP_HELPER_NAME,
  CLIENT_RUNTIME_HELPER_NAME,
];

/** `using` directives each helper's body requires. */
const HELPER_USINGS: Record<HelperName, string[]> = {
  [MERGE_PATCH_HELPER_NAME]: [
    "System",
    "System.Collections.Generic",
    "System.Diagnostics.CodeAnalysis",
    "System.Linq",
    "System.Linq.Expressions",
    "System.Reflection",
    "System.Text.Json",
    "System.Text.Json.Serialization",
  ],
  [MODEL_MAP_HELPER_NAME]: [
    "System",
    "System.Collections.Generic",
    "System.Text.Json.Serialization",
  ],
  [CLIENT_RUNTIME_HELPER_NAME]: [
    "Flurl.Http",
    "Flurl.Http.Configuration",
    "System",
    "System.Collections",
    "System.Collections.Generic",
    "System.Globalization",
    "System.Linq",
    "System.Net.Http",
    "System.Net.Http.Headers",
    "System.Reflection",
    "System.Runtime.Serialization",
    "System.Text",
    "System.Text.Json",
    "System.Text.Json.Serialization",
    "System.Text.Json.Serialization.Metadata",
    "System.Threading.Tasks",
    "System.Xml",
  ],
};

/**
 * The folder, under the output directory, a helper's file is written to.
 *
 * @param name - The helper.
 * @returns `Models` for the merge-patch builder (a request model), `Infrastructure` otherwise.
 */
export function helperFolder(name: HelperName): string {
  return name === MERGE_PATCH_HELPER_NAME ? "Models" : "Infrastructure";
}

/**
 * Renders the body of a helper through its template.
 *
 * @param name - The helper.
 * @param renderer - Handlebars renderer used to produce the file contents.
 * @returns The rendered class source, without the file wrapper.
 */
function renderHelperBody(name: HelperName, renderer: Renderer): string {
  switch (name) {
    case MERGE_PATCH_HELPER_NAME:
      return renderer.renderMergePatch();
    case MODEL_MAP_HELPER_NAME:
      return renderer.renderModelMap();
    case CLIENT_RUNTIME_HELPER_NAME:
      return renderer.renderClientRuntime();
  }
}

/**
 * Renders a helper file. The helper is emitted into the same namespace as the
 * records so that endpoint classes in a nested per-version namespace resolve it
 * too.
 *
 * @param name - The helper to render.
 * @param csNs - C# namespace the helper is emitted into (the root model namespace).
 * @param renderer - Handlebars renderer used to produce the file contents.
 * @param additionalUsings - Extra `using` directives from the `additional-usings` option.
 * @returns The full C# source of the helper file.
 */
export function buildHelper(
  name: HelperName,
  csNs: string,
  renderer: Renderer,
  additionalUsings: Set<string>,
): string {
  const fileView: FileView = {
    namespace: csNs,
    usings: sortUsings([...HELPER_USINGS[name], ...additionalUsings]),
    body: renderHelperBody(name, renderer),
    fileName: `${name}.g.cs`,
  };
  return renderer.renderFile(fileView);
}
