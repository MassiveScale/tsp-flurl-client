// C# model generation: `record` types (including `@discriminator` polymorphic
// hierarchies and visibility-filtered request records), `enum` types, and the
// namespace-based emission filters that decide which models/enums belong to the
// service being emitted.

import { fx } from "./framework.js";
import {
  Model,
  ModelProperty,
  Enum,
  Type,
  Program,
  getNamespaceFullName,
  getDiscriminator,
  getDiscriminatedUnionFromInheritance,
  isTemplateDeclaration,
  resolveEncodedName,
  type Discriminator,
} from "@typespec/compiler";
import {
  SyntaxKind,
  type TemplateParameterDeclarationNode as TemplateParameterNode,
} from "@typespec/compiler/ast";
import { isVisible, type Visibility } from "@typespec/http";
import { getMergePatchSource } from "@typespec/http/experimental/merge-patch";
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
  docText,
  mapPropertyType,
  escapeXml,
  sortUsings,
  toCsPropName,
  escapeCsString,
  isInVersion,
  declarationKey,
  csTemplateParameterName,
  type TypeSubstitute,
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
 * @param inherited - The names the record already uses, from its base record and
 *   its hierarchy's discriminator (see {@link InheritedNames}).
 * @param substitute - For a request record, the request records its property types
 *   write in place of models (see {@link mapType}).
 * @param typeParameters - The record's C# type parameters, which no property can
 *   share a name with (`CS0102`).
 * @returns One {@link PropertyView} per input property.
 */
function buildPropertyViews(
  props: Iterable<[string, ModelProperty]>,
  program: Program,
  models: Map<string, Model>,
  enums: Map<string, Enum>,
  usedHelpers: UsedHelpers,
  recordName: string,
  inherited: InheritedNames = { members: new Map(), json: new Map() },
  substitute?: TypeSubstitute,
  typeParameters: string[] = [],
): PropertyView[] {
  const result: PropertyView[] = [];
  const scope = new MemberScope(program, "property", `record ${recordName}`, [
    ...recordReservedMembers(recordName),
    ...typeParameters.map(
      (name) =>
        [name.replace(/^@/, ""), `the type parameter "${name}"`] as [
          string,
          string,
        ],
    ),
    ...[...inherited.members].map(
      ([csName, name]) =>
        [csName, `the inherited property "${name}"`] as [string, string],
    ),
  ]);
  const jsonOwners = new Map(inherited.json);
  for (const [, prop] of props) {
    const propDoc = docText(program, prop);
    const csType = mapPropertyType(
      prop,
      program,
      models,
      enums,
      usedHelpers,
      substitute,
    );
    const nullable = prop.optional && !csType.endsWith("?") ? "?" : "";
    const declaredName = getClientName(program, prop) ?? prop.name;
    // A property whose name is not a valid C# identifier is reported and left out.
    if (!checkName(program, "property", declaredName, prop)) continue;
    const propName = toCsPropName(declaredName);
    if (inherited.members.get(propName) === prop.name) continue;
    // Two properties can become the same C# name (`foo` and `Foo`), and a property
    // cannot share its record's name or a member the record generates.
    if (!scope.claim(propName, `"${prop.name}"`, prop)) continue;
    if (!claimJsonName(program, jsonOwners, recordName, prop)) continue;
    const encoding = checkEncoding(program, prop, "property");
    const defaultVal = prop.optional
      ? undefined
      : defaultForProperty(prop, csType);
    result.push({
      doc: propDoc,
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
 * The names a record already uses before its own properties are added.
 *
 * - `members`: the properties it inherits from its base record, keyed by C# name
 *   with their TypeSpec name. A property with another TypeSpec name that becomes
 *   one of these C# names is a collision (C# would hide the inherited member,
 *   `CS0108`); a property with the same TypeSpec name is an override that narrows
 *   the inherited one, which the inherited member already carries, so it is left out.
 * - `json`: the JSON names already written for the record, keyed in lower case
 *   (the client reads JSON without regard to case) with the name and what writes
 *   it: the inherited properties and the hierarchy's discriminator.
 */
interface InheritedNames {
  members: Map<string, string>;
  json: Map<string, { name: string; owner: string }>;
}

/**
 * The names a record in a `@discriminator` hierarchy already uses (see
 * {@link InheritedNames}). The discriminator itself is not a member, and a
 * request record inherits only the properties visible in the request.
 *
 * @param program - The compiler program.
 * @param model - The model being rendered.
 * @param hierarchy - The discriminated root it belongs to: its parent's for a
 *   derived model, its own for the root. `undefined` when it is in no hierarchy.
 * @param derived - Whether the model derives from `hierarchy.root`, and so inherits
 *   its base record's properties.
 * @param version - The API version being emitted, or `undefined` when unversioned.
 * @param request - The request context, for a request record.
 * @returns The names; empty for a model in no discriminated hierarchy.
 */
function inheritedNames(
  program: Program,
  model: Model,
  hierarchy: { root: Model; discriminator: Discriminator } | undefined,
  derived: boolean,
  version: Version | undefined,
  request: RequestRecordContext | undefined,
): InheritedNames {
  const names: InheritedNames = { members: new Map(), json: new Map() };
  if (!hierarchy) return names;
  const discriminator = discriminatorWireName(
    program,
    hierarchy.root,
    hierarchy.discriminator.propertyName,
  );
  names.json.set(discriminator.toLowerCase(), {
    name: discriminator,
    owner: `the discriminator "${discriminator}"`,
  });
  if (!derived || !model.baseModel) return names;
  const base = versionProps(
    flattenProperties(model.baseModel),
    program,
    version,
  );
  for (const [name, prop] of base) {
    if (name === hierarchy.discriminator.propertyName) continue;
    if (request && !isVisible(program, prop, request.visibility)) continue;
    names.members.set(
      toCsPropName(getClientName(program, prop) ?? prop.name),
      name,
    );
    const json = jsonName(program, prop);
    names.json.set(json.toLowerCase(), {
      name: json,
      owner: `the inherited property "${name}"`,
    });
  }
  return names;
}

/**
 * Claims a property's JSON name in a record, reporting a `name-collision` when
 * another property, or the discriminator, already writes that name. Names are
 * compared without regard to case, as the client reads them.
 *
 * @param program - The compiler program.
 * @param owners - The JSON names claimed so far, keyed in lower case.
 * @param recordName - The C# record, for the message.
 * @param prop - The property claiming its name.
 * @returns `true` when the name was free and is now claimed; `false` after reporting.
 */
function claimJsonName(
  program: Program,
  owners: Map<string, { name: string; owner: string }>,
  recordName: string,
  prop: ModelProperty,
): boolean {
  const name = jsonName(program, prop);
  const existing = owners.get(name.toLowerCase());
  if (existing) {
    reportOnce(
      program,
      createDiagnostic({
        code: "name-collision",
        messageId: "json",
        target: prop,
        format: {
          name,
          scope: `record ${recordName}`,
          first: existing.owner,
          second: `"${prop.name}"`,
        },
      }),
    );
    return false;
  }
  owners.set(name.toLowerCase(), { name, owner: `"${prop.name}"` });
  return true;
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
  const doc = docText(program, model);
  const nameOf = (m: Model): string =>
    request ? request.nameOf(m) : (getClientName(program, m) ?? m.name!);
  const recordName = nameOf(model);
  // A type parameter cannot share its record's name (CS0694) or another parameter's.
  const typeParamScope = new MemberScope(
    program,
    "type parameter",
    `record ${recordName}`,
    recordReservedMembers(recordName),
  );
  for (const name of typeParams) {
    typeParamScope.claim(name.replace(/^@/, ""), `"${name}"`, model);
  }

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
    doc,
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
      inheritedNames(
        program,
        model,
        parentDiscriminated ??
          (selfDiscriminator
            ? { root: model, discriminator: selfDiscriminator }
            : undefined),
        parentDiscriminated !== undefined,
        version,
        request,
      ),
      request?.substitute,
      typeParams,
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
 * @param substitute - The request records its property types write in place of
 *   models (see {@link mapType}).
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
  substitute?: TypeSubstitute,
): string {
  const recordView: RecordView = {
    doc,
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
      undefined,
      substitute,
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
  // Compared with how the type is written, so a model named `Guid` (written
  // `Guid` while the framework type is written in full) is not taken for one.
  return (
    type.kind === "Enum" ||
    [...CS_VALUE_TYPES].some((name) => fx(name) === csType)
  );
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
  if (csType.startsWith(`${fx("List", "generic")}<`)) return "[]";
  if (csType.startsWith(`${fx("Dictionary", "generic")}<`)) return "new()";
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
  /** The request records the property types write in place of models (see {@link mapType}). */
  substitute: TypeSubstitute;
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
 * Every model a payload can reach, which is everything its JSON can contain:
 * through properties, base models (whose properties are inherited), list and
 * dictionary items, union variants, template arguments, the source model of a
 * synthesized merge patch, and the subtypes of a discriminated model, which a
 * response can contain without naming them. The operation checks use this one
 * walk, so they agree on what a payload contains.
 *
 * @param program - The compiler program.
 * @param type - The payload type.
 * @returns The reachable models, each once.
 */
export function* reachableModels(
  program: Program,
  type: Type,
): Generator<Model> {
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

    yield current;
    if (current.indexer) queue.push(current.indexer.value);
    if (current.baseModel) queue.push(current.baseModel);
    for (const prop of current.properties.values()) queue.push(prop.type);
    for (const arg of current.templateMapper?.args ?? []) {
      if ((arg as { entityKind?: string }).entityKind === "Type") {
        queue.push(arg as Type);
      }
    }
    const mergePatchSource = getMergePatchSource(program, current);
    if (mergePatchSource) queue.push(mergePatchSource);
    if (findDiscriminatedRoot(program, current)) {
      queue.push(...current.derivedModels);
    }
  }
}

/**
 * The template parameter a model is given a value for (`model Sized<N extends
 * valueof int32>`, used as `Sized<3>`), which no C# generic type can carry. For a
 * template declaration, a parameter that only accepts values; for an instance, a
 * parameter that accepts values and was not given a type, since a literal passed to
 * one may be read as either.
 *
 * @param model - A template declaration or instance, or any other model.
 * @returns The parameter's name, or `undefined` when there is none.
 */
export function valueTemplateParameter(model: Model): string | undefined {
  const isDeclaration = isTemplateDeclaration(model);
  const declaration = isDeclaration
    ? model
    : model.templateMapper && model.name
      ? model.namespace?.models.get(model.name)
      : undefined;
  const parameters =
    (declaration?.node as { templateParameters?: TemplateParameterNode[] })
      ?.templateParameters ?? [];
  for (const [index, parameter] of parameters.entries()) {
    // Read from the syntax: asking the checker for the parameter's type makes it
    // report `value-in-type` against a parameter that is never used as a type.
    const constraint = parameter.constraint;
    const options =
      constraint?.kind === SyntaxKind.UnionExpression
        ? constraint.options
        : constraint
          ? [constraint]
          : [];
    const values = options.filter(
      (o) => o.kind === SyntaxKind.ValueOfExpression,
    ).length;
    if (values === 0) continue;
    const given = model.templateMapper?.args[index] as
      { entityKind?: string } | undefined;
    const valueOnly = values === options.length;
    if (isDeclaration ? valueOnly : given?.entityKind !== "Type") {
      return parameter.id.sv;
    }
  }
  return undefined;
}

/**
 * Reports a model given a value for a template parameter (see
 * {@link valueTemplateParameter}).
 *
 * @param program - The compiler program.
 * @param model - The model.
 * @param parameter - The parameter's name.
 */
export function reportValueTemplate(
  program: Program,
  model: Model,
  parameter: string,
): void {
  reportOnce(
    program,
    createDiagnostic({
      code: "unsupported-value-template",
      target: model,
      format: { name: model.name, parameter },
    }),
  );
}

/**
 * Finds a `@discriminator` model nested under another discriminated model anywhere
 * a payload can reach (see {@link reachableModels}). System.Text.Json resolves only
 * one discriminator per hierarchy, so such a payload would be read as the wrong
 * subtype.
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
  for (const model of reachableModels(program, type)) {
    const parent = model.baseModel
      ? findDiscriminatedRoot(program, model.baseModel)
      : undefined;
    if (parent && getDiscriminator(program, model)) {
      return { model, parent: parent.root };
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
    model.node as { templateParameters?: TemplateParameterNode[] } | undefined
  )?.templateParameters;
  if (declared && declared.length > 0) {
    return declared.map((p) => csTemplateParameterName(p));
  }

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
    out.push(
      csTemplateParameterName(type.node as TemplateParameterNode | undefined),
    );
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
  const doc = docText(program, e);
  const enumName = getClientName(program, e) ?? e.name;

  const members: EnumMemberView[] = [];
  const memberNames = new Set<string>();
  const wireValues = new Set<string>();
  for (const [, member] of e.members) {
    if (!isInVersion(program, member, version)) continue;
    const memberDoc = docText(program, member);
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
    // Two members may share a wire value (`first: "x", second: "x"`). Reading that
    // value can give only one of them, the first declared, since a switch cannot
    // match one value twice (CS8510); each still writes its own.
    const wireKey = isNumber ? `number:${member.value}` : `string:${text}`;
    members.push({
      doc: memberDoc,
      docValue: escapeXml(text),
      name: csMemberName,
      memberValue: escapeCsString(text),
      numberLiteral: isNumber
        ? csNumberLiteral(member.value as number)
        : undefined,
      reads: !wireValues.has(wireKey),
    });
    wireValues.add(wireKey);
  }
  const hasNumberMembers = members.some((m) => m.numberLiteral !== undefined);
  const hasStringMembers = members.some((m) => m.numberLiteral === undefined);

  const enumView: EnumView = {
    doc,
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
