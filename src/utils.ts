// Shared, dependency-light helpers: C# type mapping (TypeSpec type → C# type
// string) and the small name / formatting utilities used across the emitter.
// This module is a leaf — it depends only on the compiler, `@typespec/http`,
// and decorators, never on the other codegen modules — so it can be imported
// freely without cycles.

import {
  Model,
  ModelProperty,
  Scalar,
  Enum,
  Type,
  Program,
  getEncode,
  getFormat,
  isArrayModelType,
  isRecordModelType,
  isNullType,
  isVoidType,
  isNeverType,
  isErrorModel,
} from "@typespec/compiler";
import { getMergePatchSource } from "@typespec/http/experimental/merge-patch";
import { getClientName } from "./decorators.js";
import {
  getAvailabilityMap,
  Availability,
  type Version,
} from "@typespec/versioning";
import { isCsKeyword } from "./identifiers.js";

/** C# name of the generic merge-patch helper class emitted alongside the models. */
export const MERGE_PATCH_HELPER_NAME = "MergePatch";

/**
 * C# name of the covariant interface implemented by the merge-patch helper.
 * Endpoint methods accept the interface so a `MergePatch<MyWidget>` can be sent to
 * an operation declared against `MergePatch<Widget>`.
 */
export const MERGE_PATCH_INTERFACE_NAME = "IMergePatch";

/** C# name of the model-substitution registry emitted once per namespace. */
export const MODEL_MAP_HELPER_NAME = "ModelMap";

/** C# name of the internal serializer/wire-format helper emitted once per namespace. */
export const CLIENT_RUNTIME_HELPER_NAME = "ClientRuntime";

/**
 * Accumulator recording which hand-written helper classes the mapped types depend
 * on, so the emitter knows which helper files it has to write. Threaded alongside
 * the `models` / `enums` accumulators.
 *
 * This is a semantic signal raised by {@link mapType} at the point it rewrites a
 * merge-patch body, not a scan of the rendered C#: a user model that happens to be
 * named `MergePatch<T>` produces the same text but must not pull in the helper.
 */
export type UsedHelpers = Set<string>;

/**
 * Maps a TypeSpec type to its C# type expression (e.g. `int32` → `int`,
 * `Widget[]` → `List<Widget>`, `Record<string>` → `Dictionary<string, string>`).
 *
 * As a side effect, any named model or enum encountered is registered into
 * `models` / `enums` so the caller emits a corresponding record/enum file, and any
 * helper class the mapping depends on is registered into `usedHelpers`.
 *
 * @param type - The TypeSpec type to map.
 * @param program - The compiler program, used for scalar formats and client names.
 * @param models - Accumulator that collects referenced named models by name.
 * @param enums - Accumulator that collects referenced named enums by name.
 * @param usedHelpers - Accumulator that collects required helper class names.
 * @returns The C# type expression as a string (`"object"` for unmappable types).
 */
export function mapType(
  type: Type,
  program: Program,
  models: Map<string, Model>,
  enums: Map<string, Enum>,
  usedHelpers: UsedHelpers,
): string {
  switch (type.kind) {
    case "Scalar":
      return mapScalar(type as Scalar, program);

    case "Model": {
      const m = type as Model;
      if (isArrayModelType(m)) {
        return `List<${mapType(m.indexer!.value, program, models, enums, usedHelpers)}>`;
      }
      if (isRecordModelType(m)) {
        return `Dictionary<string, ${mapType(m.indexer!.value, program, models, enums, usedHelpers)}>`;
      }
      if (isErrorModel(program, m)) {
        // Still emit, just note it
      }
      if (!m.name) return "object";

      // `MergePatchUpdate<T>` (and its `ReplaceOnly`/`CreateOrUpdate` siblings) synthesize a
      // distinct, flattened, all-optional Model rather than a template instance of `T` — so the
      // `templateMapper` branch below never fires for them. `@typespec/http` tracks the original
      // resource model (`T`) for every such synthesized model; redirect the reference to the
      // generic `MergePatch<T>` helper instead of emitting the synthesized model's own
      // (unbacked) literal name as a phantom C# type, and record that the helper class now has
      // to be emitted. This is the only place that signal is raised, so a user model that is
      // itself named `MergePatch<T>` never drags the helper in.
      const mergePatchSource = getMergePatchSource(program, m);
      if (mergePatchSource) {
        if (mergePatchSource.name) {
          models.set(mergePatchSource.name, mergePatchSource);
        }

        const targetCsType = mergePatchSource.name
          ? (getClientName(program, mergePatchSource) ?? mergePatchSource.name)
          : mapType(mergePatchSource, program, models, enums, usedHelpers);

        usedHelpers.add(MERGE_PATCH_HELPER_NAME);
        return `${MERGE_PATCH_HELPER_NAME}<${targetCsType}>`;
      }

      // Template instance
      if (m.templateMapper?.args) {
        const args = m.templateMapper.args
          .filter(
            (a): a is Type =>
              (a as { entityKind?: string }).entityKind === "Type",
          )
          .map((a) => mapType(a, program, models, enums, usedHelpers));
        // Array<T> represented as a template instance (unresolved element type) → List<T>
        if (m.name === "Array" && args.length === 1) {
          return `List<${args[0]}>`;
        }
        const decl = m.namespace?.models.get(m.name);
        if (decl) models.set(m.name, decl);
        else models.set(m.name, m);
        const csName = getClientName(program, decl ?? m) ?? m.name;
        return args.length > 0 ? `${csName}<${args.join(", ")}>` : csName;
      }

      models.set(m.name, m);
      return getClientName(program, m) ?? m.name;
    }

    case "Enum": {
      const e = type as Enum;
      if (e.name) enums.set(e.name, e);
      return e.name ? (getClientName(program, e) ?? e.name) : "string";
    }

    case "Union":
      return "string";

    case "Intrinsic":
      if (isVoidType(type)) return "void";
      if (isNullType(type)) return "object";
      if (isNeverType(type)) return "object";
      return "object";

    case "TemplateParameter":
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (type as any).node?.id?.sv ?? "T";

    default:
      return "object";
  }
}

/**
 * Maps a model property to its C# type, taking `@encode` into account before
 * delegating to {@link mapType}. A `boolean` property carrying `@encode("string")`
 * travels on the wire as a JSON string (`"true"`/`"false"`), so it is emitted as
 * C# `string` rather than `bool`; all other properties map by their declared type.
 *
 * @param prop - The model property to map (source of both the type and `@encode`).
 * @param program - The compiler program, used to read `@encode` and scalar formats.
 * @param models - Accumulator that collects referenced named models by name.
 * @param enums - Accumulator that collects referenced named enums by name.
 * @param usedHelpers - Accumulator that collects required helper class names.
 * @returns The C# type expression as a string.
 */
export function mapPropertyType(
  prop: ModelProperty,
  program: Program,
  models: Map<string, Model>,
  enums: Map<string, Enum>,
  usedHelpers: UsedHelpers,
): string {
  const encode = getEncode(program, prop);
  const encodesAsString =
    encode !== undefined &&
    (encode.encoding === "string" ||
      (encode.type !== undefined &&
        builtinScalarName(encode.type) === "string"));
  if (
    encodesAsString &&
    prop.type.kind === "Scalar" &&
    builtinScalarName(prop.type as Scalar) === "boolean"
  ) {
    return "string";
  }
  return mapType(prop.type, program, models, enums, usedHelpers);
}

/**
 * Maps a TypeSpec scalar to its C# type, honouring `@format` (`uuid` → `Guid`,
 * `uri`/`url` → `Uri`) and walking the scalar's base chain to resolve custom
 * scalars down to a known built-in.
 *
 * @param scalar - The scalar type to map.
 * @param program - The compiler program, used to read the scalar's `@format`.
 * @returns The C# type name (defaults to `"string"` for unrecognized scalars).
 */
function mapScalar(scalar: Scalar, program: Program): string {
  const fmt = getFormat(program, scalar);
  if (fmt === "uuid") return "Guid";
  if (fmt === "uri" || fmt === "url") return "Uri";

  const builtin = builtinScalarName(scalar);
  switch (builtin) {
    case "string":
      return "string";
    case "int8":
      return "sbyte";
    case "int16":
      return "short";
    case "int32":
      return "int";
    case "int64":
      return "long";
    case "uint8":
      return "byte";
    case "uint16":
      return "ushort";
    case "uint32":
      return "uint";
    case "uint64":
      return "ulong";
    case "safeint":
      return "long";
    case "float32":
      return "float";
    case "float64":
      return "double";
    case "decimal":
    case "decimal128":
      return "decimal";
    case "boolean":
      return "bool";
    case "bytes":
      return "byte[]";
    case "utcDateTime":
    case "offsetDateTime":
      return "DateTimeOffset";
    case "plainDate":
      return "DateOnly";
    case "plainTime":
      return "TimeOnly";
    case "duration":
      return "TimeSpan";
    case "url":
      return "Uri";
    case "numeric":
    case "integer":
    case "float":
      return "double";
    default:
      return "string";
  }
}

/** Names of the TypeSpec built-in scalars that `mapScalar` knows how to map. */
const BUILTIN_SCALARS = new Set([
  "string",
  "int8",
  "int16",
  "int32",
  "int64",
  "uint8",
  "uint16",
  "uint32",
  "uint64",
  "safeint",
  "integer",
  "float",
  "float32",
  "float64",
  "decimal",
  "decimal128",
  "numeric",
  "boolean",
  "bytes",
  "utcDateTime",
  "offsetDateTime",
  "plainDate",
  "plainTime",
  "duration",
  "url",
]);

/**
 * Walks a scalar's `baseScalar` chain and returns the name of the first
 * ancestor (inclusive) that is a known built-in, so custom scalars resolve to
 * the built-in they ultimately derive from.
 *
 * @param scalar - The scalar to resolve.
 * @returns The built-in scalar name, or the scalar's own name if none is found.
 */
function builtinScalarName(scalar: Scalar): string {
  let current: Scalar | undefined = scalar;
  while (current) {
    if (BUILTIN_SCALARS.has(current.name)) return current.name;
    current = current.baseScalar;
  }
  return scalar.name;
}

/**
 * Turns an API version value into a C# namespace segment, e.g. `v2.0` → `V2_0`
 * (strips a leading `v`/`V`, prefixes `V`, and replaces every character that is
 * not a letter, digit, or underscore with an underscore, so `sprint-42` becomes
 * `Vsprint_42`).
 *
 * @param version - The raw TypeSpec version value.
 * @returns A namespace-safe version segment.
 */
export function sanitizeVersionForNs(version: string): string {
  return "V" + version.replace(/^v/i, "").replace(/[^A-Za-z0-9_]/g, "_");
}

/**
 * Upper-cases the first character of a string, leaving the rest unchanged.
 *
 * @param s - The string to capitalize.
 * @returns The capitalized string (empty input returns empty).
 */
export function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Derives the C# method name for an operation: PascalCase plus the `Async`
 * suffix (e.g. `list` → `ListAsync`).
 *
 * @param name - The TypeSpec operation name.
 * @returns The C# method name.
 */
export function toCsMethodName(name: string): string {
  return capitalize(name) + "Async";
}

/**
 * Derives the C# parameter name (camelCase) by lower-casing the first character.
 *
 * @param name - The source name.
 * @returns The camelCase parameter name.
 */
export function toCsParamName(name: string): string {
  return name.charAt(0).toLowerCase() + name.slice(1);
}

/**
 * Derives the C# property name (PascalCase) by upper-casing the first character.
 *
 * @param name - The source name.
 * @returns The PascalCase property name.
 */
export function toCsPropName(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/**
 * Escapes the XML metacharacters `&`, `<`, and `>` (in that order, so `&` is not
 * double-escaped) for safe inclusion in XML doc comments.
 *
 * @param s - The raw text.
 * @returns The XML-escaped text.
 */
export function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Normalizes a single C# `using` namespace so it contains only code-safe
 * characters. Each namespace segment (separated by `.`) is sanitized by
 * replacing invalid characters with `_` and ensuring it doesn't start with a
 * digit.
 */
function normalizeUsing(u: string): string {
  const trimmed = (u ?? "").trim();
  const parts = trimmed.split(".");
  const sanitized = parts.map((seg) => {
    if (!seg) return "_";
    // Replace any char that's not letter/digit/underscore with '_'
    let s = seg.replace(/[^A-Za-z0-9_]/g, "_");
    // If segment starts with a digit, prefix with '_'
    if (/^[0-9]/.test(s)) s = `_${s}`;
    return s;
  });
  return sanitized.join(".");
}

/**
 * Sorts C# `using` namespaces with all `System*` namespaces first, then the rest,
 * each group ordered alphabetically. Accepts any iterable of strings and does
 * normalization and deduplication; does not mutate the input.
 *
 * @param usings - The namespaces to sort (array, Set, or other iterable).
 * @returns A new, sorted array.
 */
export function sortUsings(usings: Iterable<string>): string[] {
  const normalized = new Set<string>();
  for (const u of usings) {
    if (!u) continue;
    normalized.add(normalizeUsing(u));
  }
  return [...normalized].sort((a, b) => {
    const aSystem = a.startsWith("System");
    const bSystem = b.startsWith("System");
    if (aSystem && !bSystem) return -1;
    if (!aSystem && bSystem) return 1;
    return a.localeCompare(b);
  });
}

/**
 * Escapes text for use between the quotes of an ordinary C# string literal, so a
 * wire name or discriminator value containing a quote, backslash, or line break
 * cannot end the literal early or change the surrounding code.
 *
 * @param text - The raw text.
 * @returns The text, safe to place inside `"..."`.
 */
export function escapeCsString(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t");
}

/**
 * Prefixes a C# identifier with `@` when it collides with a reserved keyword, so a
 * TypeSpec parameter called `params` or `event` still produces compilable C#.
 *
 * @param name - The candidate identifier.
 * @returns The identifier, verbatim-escaped when it is a C# keyword.
 */
export function escapeCsIdentifier(name: string): string {
  return isCsKeyword(name) ? `@${name}` : name;
}

/**
 * The part of a response type that a caller may replace with a custom derived
 * model: the named model at the core of `Widget`, `Widget[]`, or
 * `Record<Widget>`.
 */
export interface ModelSlot {
  /** C# type the replacement must derive from, e.g. `Widget` or `Page<Widget>`. */
  constraint: string;
  /**
   * Rebuilds the full response type around a replacement, e.g. `TResult` becomes
   * `List<TResult>` for an array response.
   *
   * @param inner - The C# type expression to place at the core of the type.
   */
  wrap(inner: string): string;
}

/**
 * Finds the named model at the core of a type, looking through arrays and records.
 * That model is the "slot" generated clients expose as a generic parameter, so a
 * caller can ask for a derived type (`ReadAsync<MyWidget>`) instead of the declared
 * one. Scalars, enums, unions, anonymous models, and merge-patch payloads have no
 * slot because nothing can derive from them.
 *
 * As with {@link mapType}, any named model reached is registered into `models`.
 *
 * @param type - The TypeSpec type to inspect.
 * @param program - The compiler program.
 * @param models - Accumulator that collects referenced named models by name.
 * @param enums - Accumulator that collects referenced named enums by name.
 * @param usedHelpers - Accumulator that collects required helper class names.
 * @returns The slot, or `undefined` when the type has no customizable model.
 */
export function findModelSlot(
  type: Type,
  program: Program,
  models: Map<string, Model>,
  enums: Map<string, Enum>,
  usedHelpers: UsedHelpers,
): ModelSlot | undefined {
  if (type.kind !== "Model") return undefined;
  const model = type as Model;

  if (isArrayModelType(model)) {
    const inner = findModelSlot(
      model.indexer!.value,
      program,
      models,
      enums,
      usedHelpers,
    );
    return (
      inner && {
        constraint: inner.constraint,
        wrap: (x) => `List<${inner.wrap(x)}>`,
      }
    );
  }
  if (isRecordModelType(model)) {
    const inner = findModelSlot(
      model.indexer!.value,
      program,
      models,
      enums,
      usedHelpers,
    );
    return (
      inner && {
        constraint: inner.constraint,
        wrap: (x) => `Dictionary<string, ${inner.wrap(x)}>`,
      }
    );
  }

  if (!model.name || model.name === "Array") return undefined;
  if (getMergePatchSource(program, model)) return undefined;

  return {
    constraint: mapType(model, program, models, enums, usedHelpers),
    wrap: (x) => x,
  };
}

/**
 * Whether a type (a model property, a parameter, an operation) exists in an API
 * version, according to `@added` / `@removed`. A type with no versioning
 * decorators exists in every version, and so does everything when no version is
 * being emitted.
 *
 * @param program - The compiler program.
 * @param type - The type to test.
 * @param version - The API version being emitted, or `undefined` when unversioned
 *   or when every version is emitted together.
 * @returns `true` when the type is part of the version's API.
 */
export function isInVersion(
  program: Program,
  type: Type,
  version: Version | undefined,
): boolean {
  if (!version) return true;
  const availability = getAvailabilityMap(program, type);
  if (!availability) return true;
  const state = availability.get(version.name);
  return state === Availability.Added || state === Availability.Available;
}
