// Shared, dependency-light helpers: C# type mapping (TypeSpec type → C# type
// string) and the small name / formatting utilities used across the emitter.
// This module is a leaf — it depends only on the compiler, `@typespec/http`,
// and decorators, never on the other codegen modules — so it can be imported
// freely without cycles.

import { fx } from "./framework.js";
import {
  getDoc,
  Model,
  ModelProperty,
  Scalar,
  Enum,
  Type,
  Union,
  Program,
  getEncode,
  getFormat,
  isArrayModelType,
  isRecordModelType,
  isNullType,
  isVoidType,
  isNeverType,
  isErrorModel,
  getNamespaceFullName,
  type Namespace,
} from "@typespec/compiler";
import {
  SyntaxKind,
  type TemplateParameterDeclarationNode,
} from "@typespec/compiler/ast";
import { getMergePatchSource } from "@typespec/http/experimental/merge-patch";
import { getClientName } from "./decorators.js";
import {
  getAvailabilityMap,
  Availability,
  type Version,
} from "@typespec/versioning";
import {
  isCsIdentifier,
  needsVerbatimEscape,
  toCsIdentifier,
} from "./identifiers.js";

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

/** What wraps the element of a type: a list, a dictionary, or `| null`. */
export type TypeWrapper = "array" | "record" | "nullable";

/**
 * Gives the C# type to write in place of a named model, or `undefined` to map
 * the model as usual (see {@link mapType}).
 */
export type TypeSubstitute = (model: Model) => string | undefined;

/**
 * The key a model or enum is collected under: its fully qualified name. Keying by
 * simple name would let `A.Widget` and `B.Widget`, which are flattened into one C#
 * namespace, silently replace each other before any collision could be reported.
 * Keeping both lets the output-name reservation report the clash.
 *
 * @param declaration - The model or enum.
 * @returns A key that is unique per declaration.
 */
export function declarationKey(declaration: Model | Enum): string {
  const ns = declaration.namespace
    ? getNamespaceFullName(declaration.namespace)
    : "";
  return ns ? `${ns}.${declaration.name}` : `${declaration.name}`;
}

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
 * @param substitute - Gives the C# type to write in place of a named model, or
 *   `undefined` to map it as usual. A request record uses it to write the request
 *   record of a nested model (`ChildCreateRequest`) instead of the model.
 * @returns The C# type expression as a string (`"object"` for unmappable types).
 */
export function mapType(
  type: Type,
  program: Program,
  models: Map<string, Model>,
  enums: Map<string, Enum>,
  usedHelpers: UsedHelpers,
  substitute?: TypeSubstitute,
): string {
  switch (type.kind) {
    case "Scalar":
      return mapScalar(type as Scalar, program);

    case "Model": {
      const m = type as Model;
      if (isArrayModelType(m)) {
        return `${fx("List", "generic")}<${mapType(m.indexer!.value, program, models, enums, usedHelpers, substitute)}>`;
      }
      if (isRecordModelType(m)) {
        return `${fx("Dictionary", "generic")}<string, ${mapType(m.indexer!.value, program, models, enums, usedHelpers, substitute)}>`;
      }
      if (isErrorModel(program, m)) {
        // Still emit, just note it
      }
      if (!m.name) return "object";
      const substituted = substitute?.(m);
      if (substituted) return substituted;

      // `MergePatchUpdate<T>` (and its `ReplaceOnly`/`CreateOrUpdate` siblings) synthesize a
      // distinct, flattened, all-optional Model rather than a template instance of `T` — so the
      // `templateMapper` branch below never fires for them. `@typespec/http` tracks the original
      // resource model (`T`) for every such synthesized model; redirect the reference to the
      // generic `MergePatch<T>` helper instead of emitting the synthesized model's own
      // (unbacked) literal name as a phantom C# type, and record that the helper class now has
      // to be emitted. This is the only place that signal is raised, so a user model that is
      // itself named `MergePatch<T>` never drags the helper in.
      const recordedSource = getMergePatchSource(program, m);
      const mergePatchSource =
        recordedSource && atVersion(program, recordedSource);
      if (mergePatchSource) {
        if (mergePatchSource.name) {
          models.set(declarationKey(mergePatchSource), mergePatchSource);
        }

        const targetCsType = mergePatchSource.name
          ? (getClientName(program, mergePatchSource) ?? mergePatchSource.name)
          : mapType(mergePatchSource, program, models, enums, usedHelpers);

        usedHelpers.add(MERGE_PATCH_HELPER_NAME);
        return `${MERGE_PATCH_HELPER_NAME}<${targetCsType}>`;
      }

      // Template instance
      if (m.templateMapper?.args) {
        const decl = m.namespace?.models.get(m.name);
        const args = templateArguments(program, m, decl).map((a) =>
          a ? mapType(a, program, models, enums, usedHelpers) : "object",
        );
        // Array<T> represented as a template instance (unresolved element type) → List<T>
        if (m.name === "Array" && args.length === 1) {
          return `${fx("List", "generic")}<${args[0]}>`;
        }
        models.set(declarationKey(decl ?? m), decl ?? m);
        const csName = getClientName(program, decl ?? m) ?? m.name;
        return args.length > 0 ? `${csName}<${args.join(", ")}>` : csName;
      }

      models.set(declarationKey(m), m);
      return getClientName(program, m) ?? m.name;
    }

    case "Enum": {
      const e = type as Enum;
      if (e.name) enums.set(declarationKey(e), e);
      return e.name ? (getClientName(program, e) ?? e.name) : "string";
    }

    case "Union":
      return mapUnion(
        type as Union,
        program,
        models,
        enums,
        usedHelpers,
        substitute,
      );

    case "String":
      return "string";

    case "Boolean":
      return "bool";

    case "Number":
      return Number.isSafeInteger(type.value)
        ? Math.abs(type.value) <= 2147483647
          ? "int"
          : "long"
        : "double";

    case "Intrinsic":
      if (isVoidType(type)) return "void";
      // A property whose only value is null is still a property that is sent.
      if (isNullType(type)) return "object?";
      if (isNeverType(type)) return "object";
      return "object";

    case "TemplateParameter":
      return csTemplateParameterName(
        type.node as TemplateParameterDeclarationNode | undefined,
      );

    default:
      return "object";
  }
}

/** The service namespace each program is currently emitting, original and projected. */
const projections = new WeakMap<
  Program,
  { original: Namespace; projected: Namespace }
>();

/**
 * Sets (or, with `undefined`, clears) the version projection the emitter is
 * working in. TypeSpec's versioning mutators copy a service onto one API version,
 * but a few references recorded at check time still point at the original,
 * unprojected declarations: the source model of a synthesized `MergePatchUpdate<T>`,
 * and a template instance's recorded arguments. While a projection is set, those
 * are resolved to their projected copies (see {@link atVersion}).
 *
 * @param program - The compiler program.
 * @param projection - The original and projected service namespaces.
 */
export function setProjection(
  program: Program,
  projection: { original: Namespace; projected: Namespace } | undefined,
): void {
  if (projection && projection.original !== projection.projected) {
    projections.set(program, projection);
  } else {
    projections.delete(program);
  }
}

/**
 * Resolves a model declared in the service to its copy in the current version
 * projection, found by its namespace path and the declaration it was copied from. A model outside the service, or
 * already projected, or with no copy in this version, is returned as it is.
 *
 * @param program - The compiler program.
 * @param model - The model.
 * @returns The projected model, or `model`.
 */
export function atVersion(program: Program, model: Model): Model {
  const projection = projections.get(program);
  if (!projection || !model.name || model.templateMapper) return model;
  const path: string[] = [];
  let ns = model.namespace;
  while (ns && ns !== projection.original) {
    path.unshift(ns.name);
    ns = ns.namespace;
  }
  if (!ns) return model;
  let target: Namespace | undefined = projection.projected;
  for (const segment of path) target = target?.namespaces.get(segment);
  // Matched by the declaration it was copied from, not by name: `@renamedFrom`
  // gives the copy the name the model had in that version.
  for (const candidate of target?.models.values() ?? []) {
    if (candidate.node === model.node) return candidate;
  }
  return model;
}

/**
 * The type arguments of a template instance such as `Page<Widget>`, in the order
 * of the declaration's template parameters.
 *
 * They are read from the instance's properties wherever the declaration uses a
 * parameter (`items: T[]` against `items: Widget[]` binds `T` to `Widget`). When a
 * service is projected onto an API version, the instance's properties are that
 * version's types but its recorded `templateMapper` arguments are not, so mapping
 * those would bring a second copy of `Widget` into the same output. The recorded
 * argument is used only for a parameter no property mentions.
 *
 * @param program - The compiler program.
 * @param instance - The template instance.
 * @param decl - The template declaration, when found.
 * @returns The type arguments, `undefined` for a value argument.
 */
function templateArguments(
  program: Program,
  instance: Model,
  decl: Model | undefined,
): (Type | undefined)[] {
  // A literal argument (`Page<"a">`) is recorded as an indeterminate entity holding
  // its literal type. A value (`Sized<3>`) has no C# form; an operation that reaches
  // one is left out (see `valueTemplateParameter`), so it is only a placeholder here.
  const recorded = (instance.templateMapper?.args ?? []).map((a) => {
    const entity = a as { entityKind?: string; type?: Type };
    if (entity.entityKind === "Type") return a as Type;
    return entity.entityKind === "Indeterminate" ? entity.type : undefined;
  });
  const parameters = (
    decl?.node as { templateParameters?: { id: { sv: string } }[] } | undefined
  )?.templateParameters;
  if (!decl || !parameters) return recorded;

  const bound = new Map<string, Type>();
  const seen = new Set<Type>();
  const unify = (declared: Type, actual: Type): void => {
    if (declared.kind === "TemplateParameter") {
      const name = (declared.node as { id?: { sv: string } } | undefined)?.id
        ?.sv;
      if (name !== undefined && !bound.has(name)) bound.set(name, actual);
      return;
    }
    // Only structure that belongs to this instance is walked: arrays, records,
    // anonymous models, unions, and nested template instances such as `List<T>`.
    if (seen.has(declared)) return;
    seen.add(declared);
    if (declared.kind === "Model" && actual.kind === "Model") {
      if (declared.indexer && actual.indexer) {
        unify(declared.indexer.value, actual.indexer.value);
      }
      if (!declared.name || declared.templateMapper) {
        for (const [name, prop] of declared.properties) {
          const other = actual.properties.get(name);
          if (other) unify(prop.type, other.type);
        }
      }
    } else if (declared.kind === "Union" && actual.kind === "Union") {
      for (const [key, variant] of declared.variants) {
        const other = actual.variants.get(key);
        if (other) unify(variant.type, other.type);
      }
    }
  };
  for (const [name, prop] of decl.properties) {
    const other = instance.properties.get(name);
    if (other) unify(prop.type, other.type);
  }
  return parameters.map((p, i) => {
    const arg = bound.get(p.id.sv) ?? recorded[i];
    return arg?.kind === "Model" ? atVersion(program, arg) : arg;
  });
}

/**
 * The one type a union stands for when every other variant is `null`:
 * `Widget` for `Widget | null` (nullable) or for a one-variant union (not). This
 * is the single place that decides it, so the type mapping, the request filtering,
 * the generic overloads, the encodings, and the lint rule all agree.
 *
 * @param type - Any type.
 * @returns The variant and whether `null` is beside it, or `undefined` when the
 *   type is not such a union.
 */
export function soleVariant(
  type: Type,
): { type: Type; nullable: boolean } | undefined {
  if (type.kind !== "Union") return undefined;
  const variants = [...type.variants.values()].map((v) => v.type);
  const present = variants.filter((t) => !isNullType(t));
  return present.length === 1
    ? { type: present[0], nullable: present.length !== variants.length }
    : undefined;
}

/**
 * Looks through lists, dictionaries and `| null` to the type they hold, as the
 * type mapping writes them: `(Widget | null)[]` is `Widget`, nullable, inside a
 * list.
 *
 * @param type - Any type.
 * @returns The innermost element, and what wraps it from the outside in.
 */
export function unwrapType(type: Type): {
  element: Type;
  wrappers: TypeWrapper[];
} {
  const wrappers: TypeWrapper[] = [];
  let element = type;
  for (;;) {
    const sole = soleVariant(element);
    if (sole) {
      if (sole.nullable) wrappers.push("nullable");
      element = sole.type;
    } else if (
      element.kind === "Model" &&
      element.indexer &&
      (isArrayModelType(element) || isRecordModelType(element))
    ) {
      wrappers.push(isArrayModelType(element) ? "array" : "record");
      element = element.indexer.value;
    } else {
      return { element, wrappers };
    }
  }
}

/**
 * Maps a TypeSpec union, which C# cannot express directly:
 *
 * - `T | null` is `T?`.
 * - A union whose variants are all strings (string literals, `string`, or enums of
 *   strings) is `string`, which is exactly what is on the wire.
 * - Any other union (models, mixed scalars, numbers and strings) is `JsonElement`,
 *   which holds whatever the server sends and can be read with `Deserialize<T>`.
 *   Mapping these to `string`, as a union of models would otherwise get, fails at
 *   runtime because a JSON object or number cannot be read as a string.
 *
 * @param union - The union to map.
 * @param program - The compiler program.
 * @param models - Accumulator that collects referenced named models by name.
 * @param enums - Accumulator that collects referenced named enums by name.
 * @param usedHelpers - Accumulator that collects required helper class names.
 * @param substitute - See {@link mapType}. It applies to the type of `T | null`
 *   only: a `JsonElement` holds whatever the caller puts in it.
 * @returns The C# type expression.
 */
function mapUnion(
  union: Union,
  program: Program,
  models: Map<string, Model>,
  enums: Map<string, Enum>,
  usedHelpers: UsedHelpers,
  substitute?: TypeSubstitute,
): string {
  const variants = [...union.variants.values()].map((v) => v.type);
  const present = variants.filter((t) => !isNullType(t));
  const nullable = present.length !== variants.length;
  if (present.length === 0) return "object";

  const sole = soleVariant(union);
  let mapped: string;
  if (sole) {
    mapped = mapType(
      sole.type,
      program,
      models,
      enums,
      usedHelpers,
      substitute,
    );
  } else if (present.every(isStringLike)) {
    mapped = "string";
  } else {
    // The value is held as a JsonElement, but each variant's model and enum is still
    // generated, so a caller can read it with `Deserialize<Item>()`.
    for (const variant of present) {
      mapType(variant, program, models, enums, usedHelpers);
    }
    mapped = fx("JsonElement");
  }
  return nullable && !mapped.endsWith("?") ? `${mapped}?` : mapped;
}

/**
 * Whether a type is a string on the wire: a string literal, a `string` scalar, or
 * an enum whose members are all strings.
 *
 * @param type - The type to test.
 * @returns `true` when every value of the type is a JSON string.
 */
function isStringLike(type: Type): boolean {
  switch (type.kind) {
    case "String":
      return true;
    case "Scalar":
      return builtinScalarName(type as Scalar) === "string";
    case "Enum":
      return [...(type as Enum).members.values()].every(
        (m) => m.value === undefined || typeof m.value === "string",
      );
    case "Union":
      return [...(type as Union).variants.values()].every((v) =>
        isStringLike(v.type),
      );
    default:
      return false;
  }
}

/**
 * Maps a model property to its C# type, taking `@encode` and a property-level
 * `@format` into account before delegating to {@link mapType}.
 *
 * A `boolean` property carrying `@encode("string")` travels on the wire as a JSON
 * string (`"true"`/`"false"`), so it is emitted as C# `string` rather than `bool`.
 * A `string` property carrying `@format("uuid")` is a `Guid`, and one carrying
 * `@format("uri")` or `@format("url")` is a `Uri`. All other properties map by
 * their declared type.
 *
 * @param prop - The model property to map (source of both the type and `@encode`).
 * @param program - The compiler program, used to read `@encode` and scalar formats.
 * @param models - Accumulator that collects referenced named models by name.
 * @param enums - Accumulator that collects referenced named enums by name.
 * @param usedHelpers - Accumulator that collects required helper class names.
 * @param substitute - See {@link mapType}.
 * @returns The C# type expression as a string.
 */
export function mapPropertyType(
  prop: ModelProperty,
  program: Program,
  models: Map<string, Model>,
  enums: Map<string, Enum>,
  usedHelpers: UsedHelpers,
  substitute?: TypeSubstitute,
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

  // `@format` applies to a property or parameter as well as to a scalar, so
  // `@format("uuid") id: string` is a `Guid` just like a `uuid` scalar would be.
  // It only means anything for a string.
  if (
    prop.type.kind === "Scalar" &&
    builtinScalarName(prop.type as Scalar) === "string"
  ) {
    const format = getFormat(program, prop);
    if (format === "uuid") return fx("Guid");
    if (format === "uri" || format === "url") return fx("Uri");
  }
  return mapType(prop.type, program, models, enums, usedHelpers, substitute);
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
  if (fmt === "uuid") return fx("Guid");
  if (fmt === "uri" || fmt === "url") return fx("Uri");

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
      return fx("DateTimeOffset");
    case "plainDate":
      return fx("DateOnly");
    case "plainTime":
      return fx("TimeOnly");
    case "duration":
      return fx("TimeSpan");
    case "url":
      return fx("Uri");
    case "integer":
      return "long";
    case "numeric":
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
export function builtinScalarName(scalar: Scalar): string {
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
 * Derives the C# method name for an auto-paginating wrapper: PascalCase plus the
 * `AllAsync` suffix (e.g. `list` → `ListAllAsync`), distinguishing it from the raw
 * single-page method's `Async` suffix.
 *
 * @param name - The TypeSpec operation name.
 * @returns The C# paging wrapper method name.
 */
export function toCsPagingMethodName(name: string): string {
  return capitalize(name) + "AllAsync";
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
 * Sorts C# `using` namespaces with `System` and its child namespaces first, then
 * the rest, each group in ordinal order. Accepts any iterable of strings, trims
 * and deduplicates them, and does not mutate the input.
 *
 * @param usings - The namespaces to sort (array, Set, or other iterable).
 * @returns A new, sorted array.
 */
export function sortUsings(usings: Iterable<string>): string[] {
  // Every namespace is either one the emitter writes or an `additional-usings`
  // entry already validated as a C# namespace, so it is only trimmed; rewriting it
  // would turn a valid `München.Models` into a different, missing namespace.
  const unique = new Set<string>();
  for (const u of usings) {
    const trimmed = u?.trim();
    if (trimmed) unique.add(trimmed);
  }
  const isSystem = (ns: string): boolean =>
    ns === "System" || ns.startsWith("System.");
  // Ordinal, so the output is the same on every machine whatever its locale.
  return [...unique].sort((a, b) => {
    if (isSystem(a) !== isSystem(b)) return isSystem(a) ? -1 : 1;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

/**
 * Reads a type's TypeSpec documentation as text ready for a generated XML doc
 * comment. Every doc the emitter writes is read here, so none can reach a
 * template unescaped: `A & B` or `<value>` in a doc would otherwise produce
 * malformed XML documentation, which fails a build with warnings as errors.
 *
 * @param program - The compiler program.
 * @param type - The documented declaration.
 * @returns The XML-escaped doc, or `undefined` when there is none.
 */
export function docText(program: Program, type: Type): string | undefined {
  const doc = getDoc(program, type);
  return doc ? escapeXml(doc) : undefined;
}

/**
 * Escapes text for use between the quotes of an ordinary C# string literal, so a
 * wire name or discriminator value containing a quote, backslash, or line break
 * cannot end the literal early or change the surrounding code. Every character C#
 * treats as a line break is escaped: carriage return, line feed, next line
 * (U+0085), line separator (U+2028), and paragraph separator (U+2029).
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
    .replace(/\t/g, "\\t")
    .replace(/\u0085/g, "\\u0085")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/**
 * The name a C# type is declared with. A name of only lower-case letters
 * (`thing`) is verbatim-escaped (`@thing`): C# warns about declaring one
 * (`CS8981`), which a project that treats warnings as errors cannot build, and
 * the escape names the same type, so references need no change.
 *
 * @param name - The type's C# name.
 * @returns The name to write in its declaration.
 */
export function csDeclarationName(name: string): string {
  return /^[a-z]+$/.test(name) ? `@${name}` : name;
}

/**
 * Members every C# record has, which a type parameter cannot share a name with
 * (`CS0102`).
 */
const RECORD_MEMBERS = new Set([
  "EqualityContract",
  "Equals",
  "GetHashCode",
  "ToString",
  "GetType",
  "Deconstruct",
  "PrintMembers",
  "MemberwiseClone",
  "Finalize",
  "ReferenceEquals",
]);

/**
 * The C# name of a template parameter, written the same way in a generic record's
 * declaration and in every use inside it, so it is worked out from the declaration
 * alone. Changing it is safe, because the name never reaches the wire or a caller:
 * a caller writes the type arguments, not the parameter names.
 *
 * - A backtick-quoted name that is not an identifier has its other characters
 *   replaced (`my-T` is `my_T`).
 * - A name the record already uses (a member every record has, the record's own
 *   name, or one of its properties) is prefixed with `T` (`Equals` is `TEquals`),
 *   since a type parameter cannot share it (`CS0102`, `CS0694`).
 * - A keyword, or a name of only lower-case letters, is verbatim-escaped (`class`
 *   is `@class`): the first is not an identifier, and the second draws warning
 *   `CS8981`, which a project that treats warnings as errors cannot build.
 *
 * @param parameter - The template parameter's declaration.
 * @returns The C# type parameter name.
 */
export function csTemplateParameterName(
  parameter: TemplateParameterDeclarationNode | undefined,
): string {
  const raw = parameter?.id.sv ?? "T";
  const name = isCsIdentifier(raw) ? raw : toCsIdentifier(raw);
  const taken = new Set(RECORD_MEMBERS);
  const declaration = parameter?.parent;
  if (declaration?.kind === SyntaxKind.ModelStatement) {
    taken.add(declaration.id.sv);
    for (const property of declaration.properties) {
      if (property.kind === SyntaxKind.ModelProperty) {
        taken.add(toCsPropName(property.id.sv));
      }
    }
  }
  if (taken.has(name)) return `T${capitalize(name)}`;
  return needsVerbatimEscape(name) || /^[a-z]+$/.test(name) ? `@${name}` : name;
}

/**
 * Prefixes a C# identifier with `@` when it collides with a reserved keyword, so a
 * TypeSpec parameter called `params` or `event` still produces compilable C#, or
 * with `await`, which the generated `async` methods reserve.
 *
 * @param name - The candidate identifier.
 * @returns The identifier, verbatim-escaped when it needs to be.
 */
export function escapeCsIdentifier(name: string): string {
  return needsVerbatimEscape(name) ? `@${name}` : name;
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
 * one. A nullable model (`Item | null`) has its model's slot. Scalars, enums, other
 * unions, anonymous models, and merge-patch payloads have no slot because nothing
 * can derive from them.
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
  // `Item | null` has the same slot as `Item`, and stays nullable around it, as
  // do the items of a list or dictionary.
  const { element, wrappers } = unwrapType(type);
  if (element.kind !== "Model") return undefined;
  const model = element;

  if (!model.name || model.name === "Array") return undefined;
  if (getMergePatchSource(program, model)) return undefined;

  return {
    constraint: mapType(model, program, models, enums, usedHelpers),
    wrap: (x) =>
      wrappers.reduceRight(
        (inner, wrapper) =>
          wrapper === "array"
            ? `${fx("List", "generic")}<${inner}>`
            : wrapper === "record"
              ? `${fx("Dictionary", "generic")}<string, ${inner}>`
              : inner.endsWith("?")
                ? inner
                : `${inner}?`,
        x,
      ),
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
