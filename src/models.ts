// C# model generation: `record` types (including `@discriminator` polymorphic
// hierarchies and visibility-filtered request records), `enum` types, and the
// namespace-based emission filters that decide which models/enums belong to the
// service being emitted.

import {
  Model,
  ModelProperty,
  Enum,
  Type,
  Program,
  getDoc,
  getNamespaceFullName,
  getDiscriminator,
  getDiscriminatedUnionFromInheritance,
  type Discriminator,
} from "@typespec/compiler";
import type { Version } from "@typespec/versioning";
import {
  Renderer,
  RecordView,
  PropertyView,
  EnumView,
  EnumMemberView,
  FileView,
  DiscriminatorView,
} from "./renderer.js";
import { getClientName, getAccess } from "./decorators.js";
import {
  mapPropertyType,
  escapeXml,
  sortUsings,
  toCsPropName,
  escapeCsString,
  isInVersion,
  type UsedHelpers,
} from "./utils.js";

/**
 * Builds the renderer property views for a set of model properties: C# type,
 * nullability, PascalCase name, JSON wire name, and non-nullable default.
 *
 * @param props - The `[name, property]` pairs to render, in emission order.
 * @param program - The compiler program (for docs, client names, type mapping).
 * @param models - Accumulator for referenced named models (see {@link mapType}).
 * @param enums - Accumulator for referenced named enums (see {@link mapType}).
 * @param usedHelpers - Accumulator for required helper classes (see {@link mapType}).
 * @returns One {@link PropertyView} per input property.
 */
function buildPropertyViews(
  props: Iterable<[string, ModelProperty]>,
  program: Program,
  models: Map<string, Model>,
  enums: Map<string, Enum>,
  usedHelpers: UsedHelpers,
): PropertyView[] {
  const result: PropertyView[] = [];
  for (const [, prop] of props) {
    const propDoc = getDoc(program, prop);
    const csType = mapPropertyType(prop, program, models, enums, usedHelpers);
    const nullable = prop.optional ? "?" : "";
    const propName = toCsPropName(getClientName(program, prop) ?? prop.name);
    const defaultVal = prop.optional
      ? undefined
      : defaultForProperty(prop, csType);
    result.push({
      doc: propDoc ? escapeXml(propDoc) : undefined,
      type: `${csType}${nullable}`,
      name: propName,
      jsonPropertyName: escapeCsString(prop.name),
      defaultValue: defaultVal,
    });
  }
  return result;
}

/**
 * Drops the properties that do not exist in an API version.
 *
 * @param props - The `[name, property]` pairs to filter.
 * @param program - The compiler program.
 * @param version - The API version being emitted, or `undefined` to keep every property.
 * @returns The properties that are part of the version.
 */
function versionProps(
  props: Map<string, ModelProperty>,
  program: Program,
  version: Version | undefined,
): Map<string, ModelProperty> {
  if (!version) return props;
  return new Map(
    [...props].filter(([, prop]) => isInVersion(program, prop, version)),
  );
}

/**
 * Renders the C# `record` file for a model, including generic type parameters,
 * base-record inheritance, and `@discriminator` polymorphism. Models with a
 * discriminated ancestor inherit from that ancestor rather than flattening its
 * properties; the discriminator property itself is emitted only as
 * `[JsonPolymorphic]` metadata, never as a member.
 *
 * @param model - The model to render.
 * @param csNs - C# namespace the record is emitted into.
 * @param program - The compiler program.
 * @param models - Accumulator for referenced named models (see {@link mapType}).
 * @param enums - Accumulator for referenced named enums (see {@link mapType}).
 * @param usedHelpers - Accumulator for required helper classes (see {@link mapType}).
 * @param renderer - Handlebars renderer used to produce the file contents.
 * @param abstractDiscriminatedBase - When `true`, models with no concrete wire
 *   shape (the discriminated base and pass-through grouping models) are emitted
 *   as `abstract record`.
 * @param additionalUsings - Extra `using` directives from the `additional-usings`
 *   option, appended to every emitted file regardless of whether this particular
 *   file references anything from them (see `EmitterOptions["additional-usings"]`).
 * @param version - The single API version being emitted; properties that do not
 *   exist in it (`@added` later, or `@removed`) are left out. Omit it when the API
 *   is unversioned or every version is emitted together, in which case the record
 *   carries the properties of all versions.
 * @returns The full C# source of the generated record file.
 */
export function buildRecord(
  model: Model,
  csNs: string,
  program: Program,
  models: Map<string, Model>,
  enums: Map<string, Enum>,
  usedHelpers: UsedHelpers,
  renderer: Renderer,
  abstractDiscriminatedBase: boolean,
  additionalUsings: Set<string>,
  version?: Version,
): string {
  const typeParams = collectTypeParams(model);
  const genericSuffix =
    typeParams.length > 0 ? `<${typeParams.join(", ")}>` : "";
  const doc = getDoc(program, model);
  const recordName = getClientName(program, model) ?? model.name!;

  // Models with a discriminated ancestor inherit from that ancestor's record in
  // C# (rather than flattening its properties) so `[JsonDerivedType]` on the
  // base type can actually resolve to a compatible runtime type.
  const parentDiscriminated = model.baseModel
    ? findDiscriminatedRoot(program, model.baseModel)
    : undefined;
  const baseRecordName = parentDiscriminated
    ? (getClientName(program, model.baseModel!) ?? model.baseModel!.name)
    : undefined;
  const propsSource = parentDiscriminated
    ? ownProperties(model, parentDiscriminated.discriminator.propertyName)
    : flattenProperties(model);

  const selfDiscriminator = getDiscriminator(program, model);
  // The discriminator property is emitted purely as [JsonPolymorphic] metadata,
  // never as a real member — declaring it as a property too makes
  // System.Text.Json throw ("conflicts with an existing metadata property name")
  // on the very first (de)serialization of the hierarchy.
  if (selfDiscriminator) {
    propsSource.delete(selfDiscriminator.propertyName);
  }
  let discriminator: DiscriminatorView | undefined;
  let isAbstract = false;
  if (selfDiscriminator) {
    const [union] = getDiscriminatedUnionFromInheritance(
      model,
      selfDiscriminator,
    );
    discriminator = {
      propertyName: escapeCsString(selfDiscriminator.propertyName),
      derivedTypes: [...union.variants.entries()]
        .filter(([, derivedModel]) =>
          isInVersion(program, derivedModel, version),
        )
        .map(([value, derivedModel]) => ({
          typeName: getClientName(program, derivedModel) ?? derivedModel.name!,
          value: escapeCsString(value),
        }))
        .sort((a, b) => a.value.localeCompare(b.value)),
    };
    // The model carrying `@discriminator` is never itself one of its resolved
    // variants — only derived models have a concrete wire shape.
    isAbstract = abstractDiscriminatedBase;
  } else if (parentDiscriminated) {
    const [union] = getDiscriminatedUnionFromInheritance(
      parentDiscriminated.root,
      parentDiscriminated.discriminator,
    );
    const isResolvedVariant = [...union.variants.values()].includes(model);
    // A pass-through grouping model (e.g. `Dog extends Pet {}` with no
    // discriminator value of its own) never resolves to a concrete variant
    // either — only its leaf descendants (e.g. `Labrador`/`Poodle`) do.
    isAbstract = abstractDiscriminatedBase && !isResolvedVariant;
  }

  const recordView: RecordView = {
    doc: doc ? escapeXml(doc) : undefined,
    recordName,
    genericSuffix,
    access: getAccess(program, model) ?? "public",
    properties: buildPropertyViews(
      versionProps(propsSource, program, version),
      program,
      models,
      enums,
      usedHelpers,
    ),
    baseRecordName,
    discriminator,
    isAbstract,
  };

  const body = renderer.renderRecord(recordView);
  const fileView: FileView = {
    namespace: csNs,
    usings: sortUsings([
      ...new Set([
        "System",
        "System.Collections.Generic",
        "System.Text.Json.Serialization",
        ...additionalUsings,
      ]),
    ]),
    body,
    fileName: `${recordName}.g.cs`,
  };
  return renderer.renderFile(fileView);
}

/**
 * Renders a plain (non-polymorphic, non-generic) `record` file from an explicit
 * property set. Used for synthesized request payload types, whose properties
 * have already been visibility-filtered by the caller.
 *
 * @param name - The record (and file) name.
 * @param doc - Optional doc comment for the record.
 * @param props - The `[name, property]` pairs to emit.
 * @param csNs - C# namespace the record is emitted into.
 * @param program - The compiler program.
 * @param models - Accumulator for referenced named models (see {@link mapType}).
 * @param enums - Accumulator for referenced named enums (see {@link mapType}).
 * @param usedHelpers - Accumulator for required helper classes (see {@link mapType}).
 * @param renderer - Handlebars renderer used to produce the file contents.
 * @param additionalUsings - Extra `using` directives from the `additional-usings`
 *   option, appended to every emitted file regardless of whether this particular
 *   file references anything from them (see `EmitterOptions["additional-usings"]`).
 * @param access - C# access modifier of the record (`public` / `internal`).
 * @returns The full C# source of the generated record file.
 */
export function buildFilteredRecord(
  name: string,
  doc: string | undefined,
  props: Map<string, ModelProperty>,
  csNs: string,
  program: Program,
  models: Map<string, Model>,
  enums: Map<string, Enum>,
  usedHelpers: UsedHelpers,
  renderer: Renderer,
  additionalUsings: Set<string>,
  access: string = "public",
): string {
  const recordView: RecordView = {
    doc: doc ? escapeXml(doc) : undefined,
    recordName: name,
    genericSuffix: "",
    access,
    properties: buildPropertyViews(props, program, models, enums, usedHelpers),
  };

  const body = renderer.renderRecord(recordView);
  const fileView: FileView = {
    namespace: csNs,
    usings: sortUsings([
      ...new Set([
        "System",
        "System.Collections.Generic",
        "System.Text.Json.Serialization",
        ...additionalUsings,
      ]),
    ]),
    body,
    fileName: `${name}.g.cs`,
  };
  return renderer.renderFile(fileView);
}

/**
 * Collects a model's properties merged with all inherited base-model properties,
 * with derived properties overriding same-named base ones.
 *
 * @param model - The model whose full (flattened) property set is wanted.
 * @returns A map of property name to property, base-first then own.
 */
export function flattenProperties(model: Model): Map<string, ModelProperty> {
  const props = new Map<string, ModelProperty>();
  if (model.baseModel) {
    for (const [name, prop] of flattenProperties(model.baseModel)) {
      props.set(name, prop);
    }
  }
  for (const [name, prop] of model.properties) {
    props.set(name, prop);
  }
  return props;
}

/** C# types that are value types, which can never be null and so need no initializer. */
const CS_VALUE_TYPES = new Set([
  "bool",
  "sbyte",
  "byte",
  "short",
  "ushort",
  "int",
  "uint",
  "long",
  "ulong",
  "float",
  "double",
  "decimal",
  "Guid",
  "DateTimeOffset",
  "DateOnly",
  "TimeOnly",
  "TimeSpan",
]);

/**
 * Returns the C# initializer for a required property, so that a non-nullable
 * reference type compiles without nullable warnings (CS8618): collections get an
 * empty instance (`List<T>` → `[]`, `Dictionary<K, V>` → `new()`), and every other
 * reference type gets `default!`. Value types and enums need no initializer, so
 * `undefined` is returned for them.
 *
 * Anything that is not an enum or a known C# value type is treated as a reference
 * type: named models, `object`, `string`, `byte[]`, `Uri`, and generic type
 * parameters all qualify.
 *
 * @param prop - The model property being emitted.
 * @param csType - The C# type expression of the property.
 * @returns The initializer expression, or `undefined`.
 */
function defaultForProperty(
  prop: ModelProperty,
  csType: string,
): string | undefined {
  if (csType.startsWith("List<")) return "[]";
  if (csType.startsWith("Dictionary<")) return "new()";
  if (prop.type.kind === "Enum" || CS_VALUE_TYPES.has(csType)) return undefined;
  return "default!";
}

/**
 * Walks `model` and its `extends` ancestors (inclusive) looking for the nearest
 * one carrying `@discriminator`. Returns that model along with its discriminator,
 * or `undefined` when `model` is not part of a discriminated hierarchy.
 */
function findDiscriminatedRoot(
  program: Program,
  model: Model,
): { root: Model; discriminator: Discriminator } | undefined {
  let current: Model | undefined = model;
  while (current) {
    const discriminator = getDiscriminator(program, current);
    if (discriminator) return { root: current, discriminator };
    current = current.baseModel;
  }
  return undefined;
}

/** A model's own declared properties (no base-model flattening), excluding `propName`. */
function ownProperties(
  model: Model,
  excludePropName: string,
): Map<string, ModelProperty> {
  const result = new Map<string, ModelProperty>();
  for (const [name, prop] of model.properties) {
    if (name === excludePropName) continue;
    result.set(name, prop);
  }
  return result;
}

/**
 * Recursively adds every derived model reachable from a `@discriminator` model
 * already in `models` into that same map, so they are emitted even though
 * nothing in the service ever references them by name (they only ever appear
 * at runtime as a polymorphic instance of their base type).
 *
 * Uses `findDiscriminatedRoot` (self-or-ancestor) rather than `getDiscriminator`
 * (self-only) to decide whether to keep expanding: intermediate models in a
 * multi-level hierarchy commonly don't redeclare `@discriminator` themselves,
 * only the root does, so gating on the model's own decorator would stop the
 * walk after the first generation and silently drop deeper variants.
 *
 * @param program - The compiler program.
 * @param models - The accumulator the derived models are added to.
 * @param version - The API version being emitted; a derived model that does not
 *   exist in it (`@added` later, or `@removed`) is not collected.
 */
export function collectDerivedModels(
  program: Program,
  models: Map<string, Model>,
  version?: Version,
): void {
  const queue = [...models.values()];
  while (queue.length > 0) {
    const model = queue.pop()!;
    if (!findDiscriminatedRoot(program, model)) continue;
    for (const derived of model.derivedModels) {
      if (!derived.name || models.has(derived.name)) continue;
      if (!isInVersion(program, derived, version)) continue;
      models.set(derived.name, derived);
      queue.push(derived);
    }
  }
}

/**
 * Collects the distinct template parameter names referenced (directly or
 * transitively) by a model's own properties, used to build the record's generic
 * `<...>` suffix.
 *
 * @param model - The model to inspect.
 * @returns The unique template parameter names, in first-seen order.
 */
function collectTypeParams(model: Model): string[] {
  const params: string[] = [];
  const seen = new Set<Type>();
  for (const [, prop] of model.properties) {
    gatherTemplateParams(prop.type, params, seen);
  }
  return [...new Set(params)];
}

/**
 * Recursively collects template parameter names reachable from a type, walking
 * indexers, template arguments, and nested model properties. Guards against
 * cyclic model references via `seen` so a self- or mutually-referential model
 * cannot overflow the stack.
 *
 * @param type - The type to walk.
 * @param out - Accumulator that template parameter names are appended to.
 * @param seen - Set of already-visited models, used as the cycle guard.
 */
function gatherTemplateParams(
  type: Type,
  out: string[],
  seen: Set<Type>,
): void {
  if (type.kind === "TemplateParameter") {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    out.push((type as any).node?.id?.sv ?? "T");
  } else if (type.kind === "Model") {
    const m = type as Model;
    // Guard against cyclic model references (e.g. Pet.store -> Store.pets -> Pet)
    // which would otherwise recurse infinitely and overflow the stack.
    if (seen.has(m)) return;
    seen.add(m);
    if (m.indexer) gatherTemplateParams(m.indexer.value, out, seen);
    // When Array<T> is represented as a template instance (no indexer), recurse into args.
    if (m.templateMapper?.args) {
      for (const arg of m.templateMapper.args) {
        if ((arg as { entityKind?: string }).entityKind === "Type") {
          gatherTemplateParams(arg as Type, out, seen);
        }
      }
    }
    for (const [, p] of m.properties) gatherTemplateParams(p.type, out, seen);
  }
}

/**
 * Formats a number as a C# numeric literal: `1` becomes `1L` (a `long`) and
 * `1.5` becomes `1.5D` (a `double`), so it selects the right
 * `Utf8JsonWriter.WriteNumberValue` overload and compares against the `double`
 * the reader produces.
 *
 * @param value - The declared numeric enum value.
 * @returns The C# literal.
 */
function csNumberLiteral(value: number): string {
  return Number.isInteger(value) ? `${value}L` : `${value}D`;
}

/**
 * Renders the C# `enum` file for a TypeSpec enum, mapping each member to a
 * PascalCase name with its original value preserved as the JSON wire string.
 *
 * @param e - The enum to render.
 * @param csNs - C# namespace the enum is emitted into.
 * @param program - The compiler program (for docs, client name, access).
 * @param renderer - Handlebars renderer used to produce the file contents.
 * @param version - The API version being emitted; members that do not exist in it
 *   (`@added` later, or `@removed`) are left out. Omit it for an unversioned API.
 * @returns The full C# source of the generated enum file.
 */
export function buildEnum(
  e: Enum,
  csNs: string,
  program: Program,
  renderer: Renderer,
  version?: Version,
): string {
  const doc = getDoc(program, e);
  const enumName = getClientName(program, e) ?? e.name;

  const members: EnumMemberView[] = [];
  for (const [, member] of e.members) {
    if (!isInVersion(program, member, version)) continue;
    const memberDoc = getDoc(program, member);
    const isNumber = typeof member.value === "number";
    const text =
      typeof member.value === "string"
        ? member.value
        : isNumber
          ? String(member.value)
          : member.name;
    members.push({
      doc: memberDoc ? escapeXml(memberDoc) : undefined,
      name: toCsPropName(member.name),
      memberValue: escapeCsString(text),
      numberLiteral: isNumber
        ? csNumberLiteral(member.value as number)
        : undefined,
    });
  }
  const hasNumberMembers = members.some((m) => m.numberLiteral !== undefined);
  const hasStringMembers = members.some((m) => m.numberLiteral === undefined);

  const enumView: EnumView = {
    doc: doc ? escapeXml(doc) : undefined,
    enumName,
    access: getAccess(program, e) ?? "public",
    members,
    hasStringMembers,
    hasNumberMembers,
    expectedToken:
      hasNumberMembers && hasStringMembers
        ? "a string or a number"
        : hasNumberMembers
          ? "a number"
          : "a string",
  };

  const body = renderer.renderEnum(enumView);
  const fileView: FileView = {
    namespace: csNs,
    usings: sortUsings([
      "System",
      "System.Runtime.Serialization",
      "System.Text.Json",
      "System.Text.Json.Serialization",
    ]),
    body,
    fileName: `${enumName}.g.cs`,
  };
  return renderer.renderFile(fileView);
}

/**
 * Whether a model should be emitted: it must be named and live in the service
 * namespace, a descendant namespace, or the global namespace (so built-in /
 * third-party library models are excluded).
 *
 * @param model - The candidate model.
 * @param serviceNsName - Full name of the service namespace being emitted.
 * @returns `true` if the model belongs to this service's output.
 */
export function isEmittable(model: Model, serviceNsName: string): boolean {
  if (!model.name) return false;
  const ns = model.namespace ? getNamespaceFullName(model.namespace) : "";
  return (
    ns === serviceNsName || ns.startsWith(`${serviceNsName}.`) || ns === ""
  );
}

/**
 * Whether an enum should be emitted, using the same namespace rule as
 * {@link isEmittable}.
 *
 * @param e - The candidate enum.
 * @param serviceNsName - Full name of the service namespace being emitted.
 * @returns `true` if the enum belongs to this service's output.
 */
export function isEmittableEnum(e: Enum, serviceNsName: string): boolean {
  if (!e.name) return false;
  const ns = e.namespace ? getNamespaceFullName(e.namespace) : "";
  return (
    ns === serviceNsName || ns.startsWith(`${serviceNsName}.`) || ns === ""
  );
}
