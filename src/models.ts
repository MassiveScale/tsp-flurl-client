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
  isTemplateDeclaration,
  resolveEncodedName,
  type Discriminator,
} from "@typespec/compiler";
import { isVisible, type Visibility } from "@typespec/http";
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
import { checkName, reportInvalidName, MemberScope } from "./names.js";
import { toCsIdentifier } from "./identifiers.js";
import { checkEncoding, converterType } from "./encoding.js";
import { createDiagnostic, reportOnce } from "./lib.js";
import {
  mapPropertyType,
  escapeXml,
  sortUsings,
  toCsPropName,
  escapeCsString,
  isInVersion,
  declarationKey,
  type UsedHelpers,
} from "./utils.js";

/**
 * Names a C# record already uses for its own members, each with what uses it. A
 * property cannot share its record's name (CS0542), and the others are members the
 * compiler synthesizes or inherits from `object`.
 *
 * @param recordName - The record's C# name.
 * @returns `[name, description]` pairs to reserve in the record's member scope.
 */
function recordReservedMembers(recordName: string): [string, string][] {
  return [
    [recordName, "the record itself, whose name a member cannot share"],
    ["EqualityContract", "the record's generated EqualityContract"],
    ["PrintMembers", "the record's generated PrintMembers"],
    ["Deconstruct", "a method C# records can generate"],
    ["Equals", "System.Object.Equals"],
    ["GetHashCode", "System.Object.GetHashCode"],
    ["ToString", "System.Object.ToString"],
    ["GetType", "System.Object.GetType"],
  ];
}

/**
 * Builds the renderer property views for a set of model properties: C# type,
 * nullability, PascalCase name, JSON wire name, and non-nullable default.
 *
 * @param props - The `[name, property]` pairs to render, in emission order.
 * @param program - The compiler program (for docs, client names, type mapping).
 * @param models - Accumulator for referenced named models (see {@link mapType}).
 * @param enums - Accumulator for referenced named enums (see {@link mapType}).
 * @param usedHelpers - Accumulator for required helper classes (see {@link mapType}).
 * @param recordName - The C# record the properties belong to.
 * @param inherited - The properties the record inherits from its base record, keyed
 *   by C# name with their TypeSpec name. A property with another TypeSpec name
 *   that becomes one of these C# names is a collision (C# would hide the inherited
 *   member, `CS0108`); a property with the same TypeSpec name is an override that
 *   narrows the inherited one, which the inherited member already carries, so it is
 *   left out.
 * @returns One {@link PropertyView} per input property.
 */
function buildPropertyViews(
  props: Iterable<[string, ModelProperty]>,
  program: Program,
  models: Map<string, Model>,
  enums: Map<string, Enum>,
  usedHelpers: UsedHelpers,
  recordName: string,
  inherited: Map<string, string> = new Map(),
): PropertyView[] {
  const result: PropertyView[] = [];
  const scope = new MemberScope(program, "property", `record ${recordName}`, [
    ...recordReservedMembers(recordName),
    ...[...inherited].map(
      ([csName, name]) =>
        [csName, `the inherited property "${name}"`] as [string, string],
    ),
  ]);
  for (const [, prop] of props) {
    const propDoc = getDoc(program, prop);
    const csType = mapPropertyType(prop, program, models, enums, usedHelpers);
    const nullable = prop.optional && !csType.endsWith("?") ? "?" : "";
    const declaredName = getClientName(program, prop) ?? prop.name;
    // A property whose name is not a valid C# identifier is reported and left out.
    if (!checkName(program, "property", declaredName, prop)) continue;
    const propName = toCsPropName(declaredName);
    if (inherited.get(propName) === prop.name) continue;
    // Two properties can become the same C# name (`foo` and `Foo`), and a property
    // cannot share its record's name or a member the record generates.
    if (!scope.claim(propName, `"${prop.name}"`, prop)) continue;
    const encoding = checkEncoding(program, prop, "property");
    const defaultVal = prop.optional
      ? undefined
      : defaultForProperty(prop, csType);
    result.push({
      doc: propDoc ? escapeXml(propDoc) : undefined,
      docName: escapeXml(prop.name),
      type: `${csType}${nullable}`,
      name: propName,
      jsonPropertyName: escapeCsString(jsonName(program, prop)),
      defaultValue: defaultVal,
      numberAsString: encoding.support === "number-as-string",
      converter: encoding.wire
        ? converterType(encoding.wire, `${csType}${nullable}`)
        : undefined,
      writeNull: !prop.optional && csType.endsWith("?"),
    });
  }
  return result;
}

/**
 * The properties a derived record inherits from its base record in a
 * `@discriminator` hierarchy, keyed by C# name with their TypeSpec name (see
 * `buildPropertyViews`). The discriminator itself is not a member, and a request
 * record inherits only the properties visible in the request.
 *
 * @param program - The compiler program.
 * @param model - The derived model.
 * @param parent - The discriminated root it derives from, or `undefined` when it does not.
 * @param version - The API version being emitted, or `undefined` when unversioned.
 * @param request - The request context, for a request record.
 * @returns The inherited names; empty for a model with no discriminated parent.
 */
function inheritedNames(
  program: Program,
  model: Model,
  parent: { discriminator: Discriminator } | undefined,
  version: Version | undefined,
  request: RequestRecordContext | undefined,
): Map<string, string> {
  const names = new Map<string, string>();
  if (!parent || !model.baseModel) return names;
  const base = versionProps(
    flattenProperties(model.baseModel),
    program,
    version,
  );
  for (const [name, prop] of base) {
    if (name === parent.discriminator.propertyName) continue;
    if (request && !isVisible(program, prop, request.visibility)) continue;
    names.set(toCsPropName(getClientName(program, prop) ?? prop.name), name);
  }
  return names;
}

/**
 * Whether a model is a template declaration carrying `@discriminator`, which the
 * declaration itself never runs (see `buildRecord`).
 *
 * @param model - The model.
 * @returns `true` for `@discriminator("kind") model Shape<T> { ... }`.
 */
function isGenericDiscriminated(model: Model): boolean {
  return (
    isTemplateDeclaration(model) &&
    model.decorators.some((d) => d.definition?.name === "@discriminator")
  );
}

/**
 * The name a property has in JSON: its `@encodedName("application/json", ...)` when
 * it has one, otherwise its TypeSpec name.
 *
 * @param program - The compiler program.
 * @param prop - The property.
 * @returns The JSON property name.
 */
function jsonName(program: Program, prop: ModelProperty): string {
  return resolveEncodedName(program, prop, "application/json");
}

/**
 * The JSON name of a hierarchy's discriminator, which `[JsonPolymorphic]` reads and
 * writes: the encoded name of the discriminator property when the root declares
 * one with `@encodedName`, otherwise the name `@discriminator` was given.
 *
 * @param program - The compiler program.
 * @param root - The model carrying `@discriminator`.
 * @param propertyName - The discriminator's property name.
 * @returns The JSON name of the discriminator.
 */
function discriminatorWireName(
  program: Program,
  root: Model,
  propertyName: string,
): string {
  const prop = root.properties.get(propertyName);
  return prop ? jsonName(program, prop) : propertyName;
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
 * @param request - When set, renders the model as a request record of a
 *   discriminated hierarchy (see {@link RequestRecordContext}) instead of as the model.
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
  request?: RequestRecordContext,
): string {
  const typeParams = collectTypeParams(model);
  const genericSuffix =
    typeParams.length > 0 ? `<${typeParams.join(", ")}>` : "";
  const doc = getDoc(program, model);
  const nameOf = (m: Model): string =>
    request ? request.nameOf(m) : (getClientName(program, m) ?? m.name!);
  const recordName = nameOf(model);

  // Models with a discriminated ancestor inherit from that ancestor's record in
  // C# (rather than flattening its properties) so `[JsonDerivedType]` on the
  // base type can actually resolve to a compatible runtime type.
  const parentDiscriminated = model.baseModel
    ? findDiscriminatedRoot(program, model.baseModel)
    : undefined;
  const baseRecordName = parentDiscriminated
    ? nameOf(model.baseModel!)
    : undefined;
  const propsSource = parentDiscriminated
    ? ownProperties(model, parentDiscriminated.discriminator.propertyName)
    : flattenProperties(model);

  const selfDiscriminator = getDiscriminator(program, model);
  // TypeSpec runs `@discriminator` on each instance of a template but never on the
  // declaration the emitter generates, so a generic discriminated base would lose its
  // polymorphism without a sign; a subtype of one of its instances could not even
  // name its base. Both are reported instead.
  const genericRoot = isGenericDiscriminated(model)
    ? model
    : parentDiscriminated?.root.templateMapper
      ? parentDiscriminated.root
      : undefined;
  if (genericRoot && !request) {
    reportOnce(
      program,
      createDiagnostic({
        code: "unsupported-generic-discriminator",
        target: genericRoot,
        format: { name: genericRoot.name },
      }),
    );
  }
  // A model that is both a variant of a discriminated parent and the root of a
  // discriminator of its own would need two discriminators resolved, which
  // System.Text.Json cannot do. It is reported rather than generated into models
  // that read as the wrong subtype or throw when written.
  // A request record mirrors a model already checked when it was generated.
  if (selfDiscriminator && parentDiscriminated && !request) {
    reportOnce(
      program,
      createDiagnostic({
        code: "unsupported-nested-discriminator",
        target: model,
        format: {
          name: recordName,
          parent:
            getClientName(program, parentDiscriminated.root) ??
            parentDiscriminated.root.name,
        },
      }),
    );
  }
  // The discriminator property is emitted purely as [JsonPolymorphic] metadata,
  // never as a real member — declaring it as a property too makes
  // System.Text.Json throw ("conflicts with an existing metadata property name")
  // on the very first (de)serialization of the hierarchy.
  if (selfDiscriminator) {
    propsSource.delete(selfDiscriminator.propertyName);
  }
  if (request) {
    for (const [name, prop] of propsSource) {
      if (!isVisible(program, prop, request.visibility))
        propsSource.delete(name);
    }
  }
  let discriminator: DiscriminatorView | undefined;
  let isAbstract = false;
  if (selfDiscriminator) {
    const [union] = getDiscriminatedUnionFromInheritance(
      model,
      selfDiscriminator,
    );
    discriminator = {
      propertyName: escapeCsString(
        discriminatorWireName(program, model, selfDiscriminator.propertyName),
      ),
      derivedTypes: [...union.variants.entries()]
        .filter(([, derivedModel]) =>
          isInVersion(program, derivedModel, version),
        )
        .map(([value, derivedModel]) => ({
          typeName: nameOf(derivedModel),
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
      recordName,
      inheritedNames(program, model, parentDiscriminated, version, request),
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
        "System.Text.Json",
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
    properties: buildPropertyViews(
      props,
      program,
      models,
      enums,
      usedHelpers,
      name,
    ),
  };

  const body = renderer.renderRecord(recordView);
  const fileView: FileView = {
    namespace: csNs,
    usings: sortUsings([
      ...new Set([
        "System",
        "System.Collections.Generic",
        "System.Text.Json",
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

/**
 * Whether a C# type is a non-nullable value type, which can never be null: a
 * number, a boolean, a date, a duration, a `Guid`, a `JsonElement`, or an enum.
 *
 * @param csType - The C# type.
 * @param type - The TypeSpec type it maps from, to recognize an enum.
 * @returns `true` for a non-nullable value type.
 */
export function isCsValueType(csType: string, type: Type): boolean {
  return type.kind === "Enum" || CS_VALUE_TYPES.has(csType);
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
  "JsonElement",
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
  // A nullable type (`T | null`) can be left unset.
  if (csType.endsWith("?")) return undefined;
  if (csType.startsWith("List<")) return "[]";
  if (csType.startsWith("Dictionary<")) return "new()";
  if (isCsValueType(csType, prop.type)) return undefined;
  return "default!";
}

/**
 * How a model of a discriminated hierarchy is rendered as a request record: only
 * the properties visible in the request, under the request record's name. Every
 * model of the hierarchy is rendered this way, so the request records keep the C#
 * inheritance and `[JsonDerivedType]` list that write the discriminator.
 */
export interface RequestRecordContext {
  /** The operation's request visibility. */
  visibility: Visibility;
  /** The request record name of a model of the hierarchy, e.g. `Dog` to `DogCreateRequest`. */
  nameOf: (model: Model) => string;
}

/**
 * Lists a discriminated hierarchy: its root and every model derived from it,
 * however deep, that exists in the version being emitted.
 *
 * @param program - The compiler program.
 * @param root - The model carrying `@discriminator`.
 * @param version - The API version being emitted, or `undefined` when unversioned.
 * @returns The root followed by its descendants.
 */
export function hierarchyOf(
  program: Program,
  root: Model,
  version: Version | undefined,
): Model[] {
  const members: Model[] = [];
  const visit = (model: Model): void => {
    if (members.includes(model) || !isInVersion(program, model, version)) {
      return;
    }
    members.push(model);
    for (const derived of model.derivedModels) {
      if (derived.name) visit(derived);
    }
  };
  visit(root);
  return members;
}

/**
 * Finds a `@discriminator` model nested under another discriminated model anywhere
 * a payload can reach: through properties, list and dictionary items, union
 * variants, template arguments, and the subtypes of a discriminated model, which a
 * response can contain without naming them. System.Text.Json resolves only one
 * discriminator per hierarchy, so such a payload would be read as the wrong subtype.
 *
 * @param program - The compiler program.
 * @param type - The payload type.
 * @returns The nested model and the discriminated model it is nested under, or
 *   `undefined` when there is none.
 */
export function findNestedDiscriminator(
  program: Program,
  type: Type,
): { model: Model; parent: Model } | undefined {
  const seen = new Set<Type>();
  const queue: Type[] = [type];
  while (queue.length > 0) {
    const current = queue.pop()!;
    if (seen.has(current)) continue;
    seen.add(current);
    if (current.kind === "Union") {
      for (const variant of current.variants.values()) queue.push(variant.type);
      continue;
    }
    if (current.kind !== "Model") continue;

    const parent = current.baseModel
      ? findDiscriminatedRoot(program, current.baseModel)
      : undefined;
    if (parent && getDiscriminator(program, current)) {
      return { model: current, parent: parent.root };
    }
    if (current.indexer) queue.push(current.indexer.value);
    for (const prop of current.properties.values()) queue.push(prop.type);
    for (const arg of current.templateMapper?.args ?? []) {
      if ((arg as { entityKind?: string }).entityKind === "Type") {
        queue.push(arg as Type);
      }
    }
    if (findDiscriminatedRoot(program, current)) {
      queue.push(...current.derivedModels);
    }
  }
  return undefined;
}

/**
 * Walks `model` and its `extends` ancestors (inclusive) looking for the nearest
 * one carrying `@discriminator`. Returns that model along with its discriminator,
 * or `undefined` when `model` is not part of a discriminated hierarchy.
 */
export function findDiscriminatedRoot(
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
      if (!derived.name || models.has(declarationKey(derived))) continue;
      if (!isInVersion(program, derived, version)) continue;
      models.set(declarationKey(derived), derived);
      queue.push(derived);
    }
  }
}

/**
 * The type parameters of the record generated for a model, used to build its
 * generic `<...>` suffix.
 *
 * For a template declaration these are all of its template parameters, in
 * declaration order, including one no property uses: every reference to the
 * template passes one argument per parameter (`Tagged<Item, string>` for
 * `model Tagged<T, U>`), so the record must declare the same number. Otherwise they
 * are the distinct template parameters the model's properties reference.
 *
 * @param model - The model to inspect.
 * @returns The type parameter names, in order.
 */
function collectTypeParams(model: Model): string[] {
  const declared = (
    model.node as { templateParameters?: { id: { sv: string } }[] } | undefined
  )?.templateParameters;
  if (declared && declared.length > 0) return declared.map((p) => p.id.sv);

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
 * A number outside the safe integer range is a `double` literal too.
 *
 * @param value - The declared numeric enum value.
 * @returns The C# literal.
 */
function csNumberLiteral(value: number): string {
  // Only a safe integer is certain to fit a C# `long`; a larger one (or one JavaScript
  // prints in exponent form) would be an invalid `L` literal, so it stays a double,
  // which is how the converter reads numbers anyway.
  return Number.isSafeInteger(value) ? `${value}L` : `${value}D`;
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
  const memberNames = new Set<string>();
  for (const [, member] of e.members) {
    if (!isInVersion(program, member, version)) continue;
    const memberDoc = getDoc(program, member);
    // An enum member has no @clientName, and its wire value travels separately in
    // [EnumMember], so an odd name is sanitized rather than rejected.
    const csMemberName = toCsIdentifier(toCsPropName(member.name));
    if (memberNames.has(csMemberName)) {
      reportInvalidName(
        program,
        "enum member",
        member.name,
        `produces the C# member name "${csMemberName}", which another member of the enum already uses`,
        member,
      );
      continue;
    }
    memberNames.add(csMemberName);
    const isNumber = typeof member.value === "number";
    const text =
      typeof member.value === "string"
        ? member.value
        : isNumber
          ? String(member.value)
          : member.name;
    members.push({
      doc: memberDoc ? escapeXml(memberDoc) : undefined,
      docValue: escapeXml(text),
      name: csMemberName,
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
