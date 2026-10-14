// Endpoint generation: turns each TypeSpec operation container into a C# endpoint
// `interface` plus a Flurl-backed implementation class, resolves route paths and
// parameter bindings, derives the generic overloads that let callers choose a
// custom response model, and collects the visibility-filtered request payload
// types referenced by write operations (rendered as records by ./models.ts).

import {
  Model,
  ModelProperty,
  Enum,
  Type,
  Program,
  getDoc,
  isArrayModelType,
  isRecordModelType,
} from "@typespec/compiler";
import {
  HttpOperation,
  HttpOperationResponse,
  HttpPayloadBody,
  Visibility,
  isVisible,
  resolveRequestVisibility,
} from "@typespec/http";
import type { Version } from "@typespec/versioning";
import {
  Renderer,
  EndpointInterfaceView,
  EndpointClientView,
  MethodView,
  BodyView,
  ResponseView,
  GenericOverloadView,
  QueryParamView,
  HeaderParamView,
  CookieParamView,
  PayloadKind,
  FileView,
} from "./renderer.js";
import { getClientName, getAccess } from "./decorators.js";
import { checkName, MemberScope } from "./names.js";
import {
  checkEncoding,
  classifyEncoding,
  reportUnsupportedEncoding,
} from "./encoding.js";
import { createDiagnostic, reportOnce } from "./lib.js";
import {
  mapType,
  mapPropertyType,
  builtinScalarName,
  findModelSlot,
  capitalize,
  toCsMethodName,
  toCsParamName,
  escapeCsIdentifier,
  escapeXml,
  sortUsings,
  isInVersion,
  MERGE_PATCH_HELPER_NAME,
  MERGE_PATCH_INTERFACE_NAME,
  type UsedHelpers,
} from "./utils.js";
import {
  findDiscriminatedRoot,
  flattenProperties,
  hierarchyOf,
} from "./models.js";

/**
 * A visibility-filtered request payload synthesized for a write operation whose
 * body model has properties hidden in the request context. Collected while
 * building methods and rendered as a record by `buildFilteredRecord`.
 */
export interface RequestType {
  /** C# record name for the synthesized request type (e.g. `WidgetCreateRequest`). */
  name: string;
  /** Doc comment carried over from the source body model, if any. */
  doc: string | undefined;
  /** The properties visible in the request context, keyed by property name. */
  props: Map<string, ModelProperty>;
  /**
   * C# access modifier of the record: that of the source body model, so a record
   * built from an internal model can still reference other internal types.
   */
  access: string;
  /**
   * Set when the body is part of a `@discriminator` hierarchy: the record is one of
   * a set of request records mirroring that hierarchy (`PetCreateRequest`,
   * `DogCreateRequest`, ...), rendered from `model` so it keeps its base record and
   * `[JsonDerivedType]` list, and so still writes the discriminator.
   */
  hierarchy?: {
    /** The model this record mirrors. */
    model: Model;
    /** The operation's request visibility. */
    visibility: Visibility;
    /** What every record of the hierarchy appends to its model's name, e.g. `CreateRequest`. */
    suffix: string;
  };
}

/** The two C# source files generated for one operation container. */
export interface EndpointSources {
  /** Source of the endpoint interface file (e.g. `IWidgets.g.cs`). */
  interfaceSource: string;
  /** Source of the endpoint implementation file (e.g. `WidgetsEndpoint.g.cs`). */
  clientSource: string;
}

/**
 * Maps an HTTP verb to the request-type name suffix: `post` → `Create`,
 * `patch` → `Update`, `put` → `Replace`; any other verb is Capitalized as-is.
 *
 * @param verb - The lowercase HTTP verb.
 * @returns The suffix inserted before `Request` in the synthesized type name.
 */
function requestTypeSuffix(verb: string): string {
  switch (verb) {
    case "post":
      return "Create";
    case "patch":
      return "Update";
    case "put":
      return "Replace";
    default:
      return capitalize(verb);
  }
}

/**
 * Selects the properties of a body model that are visible in a given request
 * context, honouring both `@visibility` and per-version availability.
 *
 * @param model - The request body model.
 * @param visibility - The resolved request visibility for the operation.
 * @param version - The API version being emitted, or `undefined` when unversioned.
 * @param program - The compiler program.
 * @returns The visible `[name, property]` pairs, keyed by property name.
 */
function filterPropsForRequest(
  model: Model,
  visibility: Visibility,
  version: Version | undefined,
  program: Program,
): Map<string, ModelProperty> {
  const result = new Map<string, ModelProperty>();
  for (const [name, prop] of flattenProperties(model)) {
    if (!isInVersion(program, prop, version)) continue;
    if (!isVisible(program, prop, visibility)) continue;
    result.set(name, prop);
  }
  return result;
}

/**
 * Looks through arrays and records to the type they hold: `Widget[][]` is `Widget`
 * inside two arrays.
 *
 * @param type - A body type.
 * @returns The innermost element, and the collections around it from the outside in.
 */
function unwrapCollections(type: Type): {
  element: Type;
  wrappers: ("array" | "record")[];
} {
  const wrappers: ("array" | "record")[] = [];
  let element = type;
  while (
    element.kind === "Model" &&
    element.indexer &&
    (isArrayModelType(element) || isRecordModelType(element))
  ) {
    wrappers.push(isArrayModelType(element) ? "array" : "record");
    element = element.indexer.value;
  }
  return { element, wrappers };
}

/**
 * Puts a C# element type back inside the collections a body declared, as the
 * covariant interfaces a body parameter takes (see `resolveBodyParamType`), so a
 * `List<MyWidgetCreateRequest>` is still accepted.
 *
 * @param csType - The element's C# type.
 * @param wrappers - The collections around it, from the outside in.
 * @returns The C# body parameter type.
 */
function wrapCollections(
  csType: string,
  wrappers: ("array" | "record")[],
): string {
  return wrappers.reduceRight(
    (inner, wrapper) =>
      wrapper === "array"
        ? `IEnumerable<${inner}>`
        : `IReadOnlyDictionary<string, ${inner}>`,
    csType,
  );
}

/**
 * Whether two request records carry exactly the same properties, so one record
 * can serve both operations.
 *
 * @param a - One record.
 * @param b - The other record.
 * @returns `true` when both list the same properties in the same order.
 */
function sameRequestShape(a: RequestType, b: RequestType): boolean {
  const left = [...a.props];
  const right = [...b.props];
  return (
    left.length === right.length &&
    left.every(
      ([name, prop], i) => right[i][0] === name && right[i][1] === prop,
    )
  );
}

/**
 * Names and registers the request records for an operation's body: one record for
 * a plain model, or one for every model of a `@discriminator` hierarchy. All of
 * them share one suffix, so `Pet`, `Dog` and `Cat` become `PetCreateRequest`,
 * `DogCreateRequest` and `CatCreateRequest`.
 *
 * Visibility is resolved per operation (`@parameterVisibility` can differ between
 * two creates of the same model), so a record is shared only when its properties
 * match. The suffixes tried, in order, are `{Verb}Request` (`CreateRequest`),
 * `{Operation}Request` (`CreateDraftRequest`), and `{Container}{Operation}Request`.
 * A suffix is used only when every record it names is free or already identical.
 * When none is, a `name-collision` is reported.
 *
 * @param program - The compiler program, used to report diagnostics.
 * @param op - The operation the records are for.
 * @param operationName - The operation's effective (client) name.
 * @param records - The records to register, each with its model and properties.
 * @param requestTypes - The records registered so far for this unit.
 * @returns The suffix used, or `undefined` after reporting a collision.
 */
function claimRequestTypes(
  program: Program,
  op: HttpOperation,
  operationName: string,
  records: { model: Model; requestType: RequestType }[],
  requestTypes: Map<string, RequestType>,
): string | undefined {
  const container = op.container;
  const containerName =
    container.kind === "Interface"
      ? (getClientName(program, container) ?? container.name)
      : container.name;
  const operation = capitalize(operationName);
  const suffixes = [
    ...new Set([
      `${requestTypeSuffix(op.verb)}Request`,
      `${operation}Request`,
      `${capitalize(containerName)}${operation}Request`,
    ]),
  ];
  // Named after each model's effective (client) name, so renaming `Widget` to
  // `Product` gives `ProductCreateRequest`, and two same-named models with
  // different client names get different records.
  const nameOf = (model: Model, suffix: string): string =>
    `${getClientName(program, model) ?? model.name}${suffix}`;

  for (const suffix of suffixes) {
    const usable = records.every(({ model, requestType }) => {
      const existing = requestTypes.get(nameOf(model, suffix));
      return !existing || sameRequestShape(existing, requestType);
    });
    if (!usable) continue;
    for (const { model, requestType } of records) {
      const name = nameOf(model, suffix);
      if (requestTypes.has(name)) continue;
      requestTypes.set(name, {
        ...requestType,
        name,
        hierarchy: requestType.hierarchy && {
          ...requestType.hierarchy,
          suffix,
        },
      });
    }
    return suffix;
  }

  reportOnce(
    program,
    createDiagnostic({
      code: "name-collision",
      target: op.operation,
      format: {
        kind: "request record",
        name: nameOf(records[0].model, suffixes[suffixes.length - 1]),
        scope: "the generated models",
        first:
          "another operation whose request has different visible properties",
        second: `operation "${operationName}"`,
      },
    }),
  );
  return undefined;
}

/**
 * Stable name suffixes produced by TypeSpec HTTP's `applyMergePatchTransform`.
 * Models with these suffixes are already purpose-built request payloads and must
 * not be visibility-filtered again.
 */
const MERGE_PATCH_SUFFIXES = [
  "MergePatchUpdate",
  "MergePatchUpdateReplaceOnly",
  "MergePatchCreateOrUpdate",
];

/**
 * Whether a model is a synthesized merge-patch payload (see
 * {@link MERGE_PATCH_SUFFIXES}), which should be passed through unfiltered.
 *
 * @param model - The candidate body model.
 * @returns `true` if the model's name matches a merge-patch suffix.
 */
function isSynthesizedMergePatchModel(model: Model): boolean {
  return model.name
    ? MERGE_PATCH_SUFFIXES.some((s) => model.name!.endsWith(s))
    : false;
}

/**
 * Whether a body model has at least one property hidden in the given request
 * context — i.e. a dedicated request type is needed instead of the full model.
 *
 * @param model - The request body model.
 * @param visibility - The resolved request visibility for the operation.
 * @param program - The compiler program.
 * @returns `true` if any (flattened) property is not visible.
 */
function hasHiddenProperties(
  model: Model,
  visibility: Visibility,
  program: Program,
): boolean {
  for (const [, prop] of flattenProperties(model)) {
    if (!isVisible(program, prop, visibility)) return true;
  }
  return false;
}

/**
 * Resolves the configured route prefix for a version: substitutes the
 * `{version}` token with the version value (or removes it when unversioned) and
 * collapses duplicate/trailing slashes.
 *
 * @param prefix - The raw `route-prefix` option value.
 * @param version - The API version being emitted, or `undefined` when unversioned.
 * @returns The normalized route prefix (no leading/trailing slash artifacts).
 */
function resolveRoutePrefix(
  prefix: string,
  version: Version | undefined,
): string {
  let resolved = prefix;
  if (version) {
    resolved = resolved.replace(/\{version\}/g, version.value);
  } else {
    resolved = resolved.replace(/\{version\}/g, "");
  }
  return resolved.replace(/\/+/g, "/").replace(/\/$/, "");
}

/**
 * Escapes literal text for use inside a C# interpolated string: backslashes and
 * quotes are escaped, and braces are doubled so they are not read as holes.
 *
 * @param text - The literal text.
 * @returns The text, safe to place between the quotes of `$"..."`.
 */
function escapeInterpolatedLiteral(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\{/g, "{{")
    .replace(/\}/g, "}}");
}

/**
 * Turns a route template such as `/widgets/{id}/analyze` into the body of a C#
 * interpolated string, where each path parameter becomes a hole that
 * percent-encodes the value, so `/` or `?` in a value cannot alter the URL.
 *
 * @param path - The route template, with `{name}` placeholders (RFC 6570 operators are tolerated).
 * @param pathParams - Map of wire parameter name to the C# parameter supplying it.
 * @returns The interpolated string content, without a leading slash.
 */
export function buildRouteExpression(
  path: string,
  pathParams: Map<string, string>,
): string {
  const trimmed = path.replace(/^\/+/, "");
  const placeholder = /\{[+#./;?&]?([^}*]+)\*?\}/g;
  let result = "";
  let cursor = 0;
  for (const match of trimmed.matchAll(placeholder)) {
    result += escapeInterpolatedLiteral(trimmed.slice(cursor, match.index));
    const variable = pathParams.get(match[1]);
    result += variable
      ? `{ClientRuntime.EscapePathSegment(${variable})}`
      : escapeInterpolatedLiteral(match[0]);
    cursor = match.index + match[0].length;
  }
  result += escapeInterpolatedLiteral(trimmed.slice(cursor));
  return result;
}

/**
 * Renders the endpoint interface and its Flurl implementation for one operation
 * container, turning each operation into a method.
 *
 * @param csName - Interface name (e.g. `IPets`).
 * @param csClientName - Implementation class name (e.g. `PetsEndpoint`).
 * @param csNs - C# namespace the files are emitted into.
 * @param ops - The HTTP operations to render as methods.
 * @param doc - Optional doc comment for the interface.
 * @param access - C# access modifier of the interface (`public` / `internal`).
 * @param program - The compiler program.
 * @param models - Accumulator for referenced named models (see {@link mapType}).
 * @param enums - Accumulator for referenced named enums (see {@link mapType}).
 * @param usedHelpers - Accumulator for required helper classes (see {@link mapType}).
 * @param version - The API version being emitted, or `undefined` when unversioned.
 * @param requestTypes - Accumulator that collects synthesized request payload
 *   types discovered while building methods.
 * @param renderer - Handlebars renderer used to produce the file contents.
 * @param rawRoutePrefix - The unresolved `route-prefix` option value.
 * @param additionalUsings - Extra `using` directives from the `additional-usings`
 *   option, appended to every emitted file regardless of whether this particular
 *   file references anything from them (see `EmitterOptions["additional-usings"]`).
 * @returns The C# source of the interface file and of the implementation file.
 */
export function buildEndpoint(
  csName: string,
  csClientName: string,
  csNs: string,
  ops: HttpOperation[],
  doc: string | undefined,
  access: string,
  program: Program,
  models: Map<string, Model>,
  enums: Map<string, Enum>,
  usedHelpers: UsedHelpers,
  version: Version | undefined,
  requestTypes: Map<string, RequestType>,
  renderer: Renderer,
  rawRoutePrefix: string,
  additionalUsings: Set<string>,
): EndpointSources {
  const routePrefix = resolveRoutePrefix(rawRoutePrefix, version);
  // `read` and `Read` both become `ReadAsync`, which C# would reject as a duplicate
  // member (or an ambiguous overload), so the second is reported and left out.
  const methodScope = new MemberScope(program, "method", `interface ${csName}`);
  const methods = ops.flatMap((op) => {
    // An operation whose name is not a valid C# identifier is reported and left
    // out, rather than rendered as a method that cannot compile.
    const declaredName =
      getClientName(program, op.operation) ?? op.operation.name;
    if (!checkName(program, "operation", declaredName, op.operation)) return [];
    const view = buildMethodView(
      op,
      program,
      models,
      enums,
      usedHelpers,
      version,
      requestTypes,
      routePrefix,
    );
    if (!view) return [];
    return methodScope.claim(
      view.methodName,
      `operation "${op.operation.name}"`,
      op.operation,
    )
      ? [view]
      : [];
  });

  const interfaceView: EndpointInterfaceView = {
    interfaceName: csName,
    doc,
    access,
    methods,
  };
  const interfaceFile: FileView = {
    namespace: csNs,
    usings: sortUsings([
      ...new Set([
        "System.Collections.Generic",
        "System.Text.Json",
        "System.Threading",
        "System.Threading.Tasks",
        ...additionalUsings,
      ]),
    ]),
    body: renderer.renderEndpointInterface(interfaceView),
    fileName: `${csName}.g.cs`,
  };

  const clientView: EndpointClientView = {
    className: csClientName,
    interfaceName: csName,
    methods,
  };
  const clientFile: FileView = {
    namespace: csNs,
    usings: sortUsings([
      ...new Set([
        "Flurl",
        "Flurl.Http",
        "System",
        "System.Collections.Generic",
        "System.Net.Http",
        "System.Text.Json",
        "System.Threading",
        "System.Threading.Tasks",
        ...additionalUsings,
      ]),
    ]),
    body: renderer.renderEndpointClient(clientView),
    fileName: `${csClientName}.g.cs`,
  };

  return {
    interfaceSource: renderer.renderFile(interfaceFile),
    clientSource: renderer.renderFile(clientFile),
  };
}

/**
 * Builds the renderer view for a single endpoint method: HTTP verb, route,
 * parameter bindings, body and response handling, and the generic overload when
 * the response holds a customizable model. Parameters are ordered required first,
 * then optional, then an `additionalQueryParameters` bag and a trailing
 * `CancellationToken`. A write body whose model has hidden properties is swapped
 * for a synthesized request type, which is registered into `requestTypes`.
 *
 * @param op - The HTTP operation to render.
 * @param program - The compiler program.
 * @param models - Accumulator for referenced named models (see {@link mapType}).
 * @param enums - Accumulator for referenced named enums (see {@link mapType}).
 * @param usedHelpers - Accumulator for required helper classes (see {@link mapType}).
 * @param version - The API version being emitted, or `undefined` when unversioned.
 * @param requestTypes - Accumulator for synthesized request payload types.
 * @param routePrefix - The already-resolved route prefix for this version.
 * @returns The {@link MethodView} for the operation, or `undefined` when the
 *   operation uses something this emitter cannot send or read correctly (it is
 *   reported, and left out, rather than generated with the wrong behaviour).
 */
function buildMethodView(
  op: HttpOperation,
  program: Program,
  models: Map<string, Model>,
  enums: Map<string, Enum>,
  usedHelpers: UsedHelpers,
  version: Version | undefined,
  requestTypes: Map<string, RequestType>,
  routePrefix: string,
): MethodView | undefined {
  const unsupported = findUnsupportedPayload(op, program);
  if (unsupported) {
    reportOnce(
      program,
      createDiagnostic({
        code: "unsupported-feature",
        target: op.operation,
        format: {
          feature: unsupported,
          operation: op.operation.name,
          hint: "Call the API with the IFlurlClient exposed as FlurlClient instead.",
        },
      }),
    );
    return undefined;
  }
  const rawPath = routePrefix
    ? `${routePrefix}/${op.path}`.replace(/\/+/g, "/").replace(/\/$/, "")
    : op.path;
  const baseMethodName =
    getClientName(program, op.operation) ?? op.operation.name;
  const methodName = toCsMethodName(baseMethodName);
  const doc = getDoc(program, op.operation);
  const response = resolveResponse(
    op.responses,
    program,
    models,
    enums,
    usedHelpers,
  );
  registerErrorModels(op.responses, program, models, enums, usedHelpers);

  const requiredParams: { decl: string; name: string }[] = [];
  const optionalParams: { decl: string; name: string }[] = [];
  const queryParams: QueryParamView[] = [];
  const headerParams: HeaderParamView[] = [];
  const cookieParams: CookieParamView[] = [];
  const pathParams = new Map<string, string>();

  // Parameter names must be unique, and must not collide with the parameters every
  // method adds or the locals and fields its generated body uses.
  const paramScope = new MemberScope(
    program,
    "parameter",
    `operation ${baseMethodName}`,
    [
      [
        "additionalQueryParameters",
        "the extra query parameters every method accepts",
      ],
      ["cancellationToken", "the cancellation token every method accepts"],
      ["flurlRequest", "a local variable of the generated method"],
      ["flurlResponse", "a local variable of the generated method"],
      ["_client", "the client field"],
      ...(op.parameters.body
        ? [["body", "the request body parameter"] as [string, string]]
        : []),
    ],
  );

  for (const param of op.parameters.parameters) {
    // The body's media type decides Content-Type; a caller-supplied value would
    // only be a second source of truth for it.
    if (
      param.type === "header" &&
      param.name.toLowerCase() === "content-type"
    ) {
      continue;
    }
    // A parameter added in a later version is not part of this version's API.
    if (!isInVersion(program, param.param, version)) continue;
    const csType = mapPropertyType(
      param.param,
      program,
      models,
      enums,
      usedHelpers,
    );
    const paramName = getClientName(program, param.param) ?? param.param.name;
    // A parameter whose name is not a valid C# identifier is reported and left out.
    if (!checkName(program, "parameter", paramName, param.param)) continue;
    if (
      !paramScope.claim(
        toCsParamName(paramName),
        `parameter "${param.param.name}"`,
        param.param,
      )
    ) {
      continue;
    }
    checkEncoding(program, param.param, "parameter");
    const csParam = escapeCsIdentifier(toCsParamName(paramName));
    const isOptional = param.param.optional;
    const nullableSuffix = isOptional && !csType.endsWith("?") ? "?" : "";
    const decl = `${csType}${nullableSuffix} ${csParam}${isOptional ? " = null" : ""}`;

    if (param.type === "query") {
      // An array without `explode` is one comma-separated value (`tags=a,b`), which
      // is TypeSpec's default; with `explode` it is repeated (`tags=a&tags=b`).
      const delimited =
        param.explode === false &&
        param.param.type.kind === "Model" &&
        isArrayModelType(param.param.type as Model);
      queryParams.push({ name: param.name, variable: csParam, delimited });
    } else if (param.type === "header") {
      headerParams.push({ name: param.name, variable: csParam });
    } else if (param.type === "cookie") {
      cookieParams.push({ name: param.name, variable: csParam });
    } else if (param.type === "path") {
      pathParams.set(param.name, csParam);
    }

    (isOptional ? optionalParams : requiredParams).push({
      decl,
      name: csParam,
    });
  }

  let body: BodyView | undefined;
  if (op.parameters.body) {
    const bodyInfo = op.parameters.body;
    let bodyType = resolveBodyParamType(
      bodyInfo,
      program,
      models,
      enums,
      usedHelpers,
    );

    // A bulk body (`Widget[]`, `Record<Widget>`) is filtered through to its element
    // model, so a property hidden from the request (a read-only `id`) is not sent for
    // each item either.
    const { element, wrappers } = unwrapCollections(bodyInfo.type);
    if (
      bodyInfo.bodyKind === "single" &&
      element.kind === "Model" &&
      (op.verb === "post" || op.verb === "patch" || op.verb === "put")
    ) {
      const bodyModel = element;
      if (bodyModel.name && !isSynthesizedMergePatchModel(bodyModel)) {
        const visibility = resolveRequestVisibility(
          program,
          op.operation,
          op.verb,
        );
        // A body in a `@discriminator` hierarchy is filtered as a whole hierarchy,
        // so the caller can still pass any subtype and its discriminator is written;
        // a single flat record would lose both.
        const discriminated = findDiscriminatedRoot(program, bodyModel);
        const members = discriminated
          ? hierarchyOf(program, discriminated.root, version)
          : [bodyModel];
        if (members.some((m) => hasHiddenProperties(m, visibility, program))) {
          const records = members.map((model) => ({
            model,
            requestType: {
              name: "",
              doc: getDoc(program, model),
              access: getAccess(program, model) ?? "public",
              props: filterPropsForRequest(model, visibility, version, program),
              hierarchy: discriminated
                ? { model, visibility, suffix: "" }
                : undefined,
            } satisfies RequestType,
          }));
          const suffix = claimRequestTypes(
            program,
            op,
            baseMethodName,
            records,
            requestTypes,
          );
          if (suffix === undefined) return undefined;
          bodyType = wrapCollections(
            `${getClientName(program, bodyModel) ?? bodyModel.name}${suffix}`,
            wrappers,
          );
        }
      }
    }

    const contentTypes = bodyInfo.contentTypes;
    // A request whose payload cannot be sent was reported by findUnsupportedPayload.
    const kind = classifyPayload(
      contentTypes,
      bodyInfo.type,
      "request",
    ) as PayloadKind;
    checkBodyEncoding(program, bodyInfo, kind);
    // `@body body?: Widget` may be left out, in which case no body is sent at all.
    const optionalBody = bodyInfo.property?.optional === true;
    body = {
      variable: "body",
      kind,
      contentType:
        kind === "json"
          ? jsonMediaType(contentTypes)
          : (contentTypes[0] ?? "application/octet-stream"),
      optional: optionalBody,
    };
    if (optionalBody) {
      const nullable = bodyType.endsWith("?") ? bodyType : `${bodyType}?`;
      optionalParams.unshift({ decl: `${nullable} body = null`, name: "body" });
    } else {
      requiredParams.push({ decl: `${bodyType} body`, name: "body" });
    }
  }

  const allParams = [
    ...requiredParams,
    ...optionalParams,
    {
      decl: "Dictionary<string, object>? additionalQueryParameters = null",
      name: "additionalQueryParameters",
    },
    {
      decl: "CancellationToken cancellationToken = default",
      name: "cancellationToken",
    },
  ];

  return {
    doc: doc ? escapeXml(doc) : undefined,
    methodName,
    returnType: response ? `Task<${response.view.type}>` : "Task",
    paramsText: allParams.map((p) => p.decl).join(", "),
    argsText: allParams.map((p) => p.name).join(", "),
    httpMethod: capitalize(op.verb),
    route: buildRouteExpression(rawPath, pathParams),
    queryParams,
    headerParams,
    cookieParams,
    body,
    response: response?.view,
    generic: response?.generic,
  };
}

/**
 * Whether a media type is JSON: `application/json`, `text/json`, or a structured
 * `+json` type such as `application/vnd.acme+json` or `application/problem+json`.
 * Line-delimited and sequence formats (`application/x-ndjson`,
 * `application/json-seq`) are not one JSON document, so they are not JSON here.
 *
 * @param mediaType - The declared media type, possibly with parameters.
 * @returns `true` when the payload is a single JSON document.
 */
function isJsonMediaType(mediaType: string): boolean {
  const type = mediaType.split(";")[0].trim().toLowerCase();
  return (
    type === "application/json" ||
    type === "text/json" ||
    type.endsWith("+json")
  );
}

/**
 * Picks the media type a JSON body is sent with: `application/json` when the
 * operation accepts it, otherwise the first JSON media type it declares, so an API
 * that only accepts `application/vnd.acme+json` gets exactly that.
 *
 * @param contentTypes - The media types the body declares; empty means unspecified.
 * @returns The `Content-Type` to send.
 */
function jsonMediaType(contentTypes: string[]): string {
  const json = contentTypes.filter(isJsonMediaType);
  return (
    json.find((c) => c.toLowerCase() === "application/json") ??
    json[0] ??
    "application/json"
  );
}

/**
 * Whether a payload can travel as plain text: a scalar (`int32`, `boolean`,
 * `utcDateTime`, `string`, ...), a literal, an enum, or a union of those. TypeSpec
 * sends a scalar body as `text/plain` unless told otherwise, so these are written
 * with their wire text and parsed back from it. A model, list, or dictionary has no
 * text form.
 *
 * @param type - The payload's TypeSpec type.
 * @returns `true` when the value has a plain-text form.
 */
function isTextual(type: Type): boolean {
  switch (type.kind) {
    case "Scalar":
    case "String":
    case "Number":
    case "Boolean":
    case "Enum":
    case "EnumMember":
      return true;
    case "Union":
      return [...type.variants.values()].every(
        (v) =>
          (v.type.kind === "Intrinsic" && v.type.name === "null") ||
          isTextual(v.type),
      );
    default:
      return false;
  }
}

/**
 * Whether a payload is raw bytes (the `bytes` scalar, or one derived from it).
 *
 * @param type - The payload's TypeSpec type.
 * @returns `true` for bytes.
 */
function isBytes(type: Type): boolean {
  return type.kind === "Scalar" && builtinScalarName(type) === "bytes";
}

/**
 * Decides how a payload travels, from its TypeSpec type and the media types it
 * declares.
 *
 * - Only JSON media types (or none): `json`.
 * - Only other media types: `bytes` for bytes, `text` for anything with a plain-text
 *   form (see {@link isTextual}), and `unsupported` for a model, list, or dictionary.
 * - Both: a request picks JSON, since the client chooses what it sends. A response is
 *   whatever the server chooses, so a textual value is `negotiated` (read by the
 *   `Content-Type` that arrives) and anything else is `unsupported`, because a model
 *   that may arrive as XML cannot be read as JSON.
 *
 * @param contentTypes - The media types the payload declares; empty means unspecified.
 * @param type - The payload's TypeSpec type.
 * @param direction - Whether the client sends or receives the payload.
 * @returns How the payload travels, or `unsupported`.
 */
function classifyPayload(
  contentTypes: string[],
  type: Type,
  direction: "request" | "response",
): PayloadKind | "unsupported" {
  const json = contentTypes.length === 0 || contentTypes.some(isJsonMediaType);
  const other = contentTypes.some((c) => !isJsonMediaType(c));
  if (json && (!other || direction === "request")) return "json";
  if (isBytes(type)) return json ? "unsupported" : "bytes";
  if (!isTextual(type)) return "unsupported";
  return json ? "negotiated" : "text";
}

/**
 * Reports a body whose `@encode` cannot be produced: one the client cannot write at
 * all, or a number encoded as a string outside plain text (a standalone body has no
 * property to carry `JsonNumberHandling`). As plain text a number is already a
 * string, so that case is fine.
 *
 * @param program - The compiler program, used to report diagnostics.
 * @param body - The request or response body.
 * @param kind - How the body travels.
 */
function checkBodyEncoding(
  program: Program,
  body: HttpPayloadBody,
  kind: PayloadKind,
): void {
  const prop = body.bodyKind === "single" ? body.property : undefined;
  if (!prop) return;
  const { support, encoding } = classifyEncoding(program, prop);
  if (
    support === "unsupported" ||
    (support === "number-as-string" && kind !== "text")
  ) {
    reportUnsupportedEncoding(program, prop, "body", encoding ?? "");
  }
}

/** A resolved success response: its renderer view and, when customizable, its generic overload. */
interface ResolvedResponse {
  /** How the body is read. */
  view: ResponseView;
  /** The generic overload, present when the body contains a customizable model. */
  generic?: GenericOverloadView;
}

/**
 * Determines how an operation's result is read from its success (2xx) responses,
 * together with the generic overload when the body contains a model a caller can
 * replace with a derived type.
 *
 * Every success response is considered, not just the first: when they carry
 * different bodies (a 200 `Item` and a 201 `CreatedItem`) the result is a
 * `JsonElement` holding whichever arrived, as for a union of models, rather than
 * every response being read as the first one's type. When some success response
 * has no body (`Widget | void`), the result is nullable. Combinations that cannot be
 * read correctly were reported by {@link findUnsupportedPayload}.
 *
 * @param responses - The operation's HTTP responses.
 * @param program - The compiler program.
 * @param models - Accumulator for referenced named models (see {@link mapType}).
 * @param enums - Accumulator for referenced named enums (see {@link mapType}).
 * @param usedHelpers - Accumulator for required helper classes (see {@link mapType}).
 * @returns The resolved response, or `undefined` when no success response carries a body.
 */
function resolveResponse(
  responses: HttpOperationResponse[],
  program: Program,
  models: Map<string, Model>,
  enums: Map<string, Enum>,
  usedHelpers: UsedHelpers,
): ResolvedResponse | undefined {
  const bodies = successBodies(responses);
  if (bodies.length === 0) return undefined;

  // `Widget | void` is a 200 with a body and a 204 without one, so the result is
  // absent whenever the server takes the empty path, and the C# type says so.
  const emptyResponses = responses.filter(
    (resp) =>
      isSuccessStatus(resp.statusCodes) &&
      (resp.responses.length === 0 || resp.responses.every((c) => !c.body)),
  );
  const mayBeEmpty = emptyResponses.length > 0;
  const emptyWhen = emptyStatusCondition(responses, emptyResponses);
  const optional = (csType: string): string =>
    mayBeEmpty && !csType.endsWith("?") ? `${csType}?` : csType;

  // Every body is mapped, so the models of each are generated and can be read from
  // the JsonElement with Deserialize<T>. Bodies are compared by the C# type they map
  // to, so `Item` and `Item | null` are one shape (`Item?`), as are two identical
  // anonymous shapes.
  const mapped = bodies.map((body) =>
    resolveBodyType(body, program, models, enums, usedHelpers),
  );
  // Each body is checked against how its own media types are read: a 201 whose
  // number is `@encode("string")` breaks reading even when the 200 beside it is a
  // plain number of the same C# type.
  for (const each of bodies) {
    const ownKind = classifyPayload(
      each.contentTypes,
      each.type,
      "response",
    ) as PayloadKind;
    checkBodyEncoding(program, each, ownKind);
  }
  if (new Set(mapped.map(withoutNullable)).size > 1) {
    return {
      view: { kind: "json", type: optional("JsonElement"), emptyWhen },
    };
  }
  const anyNullable = mapped.some((csType) => csType.endsWith("?"));

  const body = bodies[0];
  const kind = classifyPayload(
    bodies.flatMap((b) => b.contentTypes),
    body.type,
    "response",
  ) as PayloadKind;

  const resultType = anyNullable ? `${withoutNullable(mapped[0])}?` : mapped[0];
  const view: ResponseView = { kind, type: optional(resultType), emptyWhen };
  const slot =
    kind === "json"
      ? findModelSlot(body.type, program, models, enums, usedHelpers)
      : undefined;
  if (!slot) return { view };

  const wrapped = slot.wrap("TResult");
  const responseType = optional(anyNullable ? `${wrapped}?` : wrapped);
  return {
    view,
    generic: {
      constraint: slot.constraint,
      returnType: `Task<${responseType}>`,
      responseType,
    },
  };
}

/**
 * The C# condition, on `flurlResponse.StatusCode`, that a response is one of the
 * operation's bodyless success responses (`Widget | void` declares a 204), so the
 * method returns `null` for it instead of reading the content: `GetBytesAsync`
 * would otherwise return an empty array, and a genuinely empty string or array
 * sent with a 200 must stay a value. A status that also carries a body is left out.
 *
 * @param responses - All of the operation's responses.
 * @param emptyResponses - The success responses that carry no body.
 * @returns The condition, or `undefined` when there is no bodyless success response.
 */
function emptyStatusCondition(
  responses: HttpOperationResponse[],
  emptyResponses: HttpOperationResponse[],
): string | undefined {
  const withBody = new Set(
    responses
      .filter((r) => r.responses.some((c) => c.body))
      .map((r) => r.statusCodes),
  );
  const conditions = emptyResponses
    .filter((r) => !withBody.has(r.statusCodes))
    .map((r) =>
      typeof r.statusCodes === "number"
        ? `flurlResponse.StatusCode == ${r.statusCodes}`
        : `flurlResponse.StatusCode is >= ${(r.statusCodes as { start: number }).start} and <= ${(r.statusCodes as { end: number }).end}`,
    );
  return conditions.length > 0 ? conditions.join(" || ") : undefined;
}

/**
 * Removes a trailing nullable marker from a C# type.
 *
 * @param csType - A C# type such as `Widget?`.
 * @returns The type without its `?`.
 */
function withoutNullable(csType: string): string {
  return csType.endsWith("?") ? csType.slice(0, -1) : csType;
}

/**
 * The C# type a body maps to, ignoring nullability, used to tell whether two
 * success responses carry the same shape. Mapped with throwaway accumulators, since
 * this only compares and must not add anything to the output.
 *
 * @param body - The body.
 * @param program - The compiler program.
 * @returns The C# type without a trailing `?`.
 */
function bodyShape(body: SingleBody, program: Program): string {
  return withoutNullable(
    resolveBodyType(body, program, new Map(), new Map(), new Set()),
  );
}

/** A body that is a single payload, which is every body that reaches the mapping. */
type SingleBody = HttpPayloadBody & { bodyKind: "single" };

/**
 * Lists the bodies of an operation's success (2xx) responses, leaving out
 * responses with no body.
 *
 * @param responses - The operation's HTTP responses.
 * @returns The single-payload bodies, in declaration order.
 */
function successBodies(responses: HttpOperationResponse[]): SingleBody[] {
  const bodies: SingleBody[] = [];
  for (const resp of responses) {
    if (!isSuccessStatus(resp.statusCodes)) continue;
    for (const content of resp.responses) {
      const body = content.body;
      if (body?.bodyKind !== "single") continue;
      if (body.type.kind === "Intrinsic" && body.type.name === "void") continue;
      bodies.push(body);
    }
  }
  return bodies;
}

/**
 * Resolves the C# type of an HTTP payload body. A body declared by a property
 * (`@body @format("uuid") id: string`) is mapped through that property, so its
 * `@format` and `@encode` apply as they would to any other property.
 *
 * @param body - The HTTP payload body.
 * @param program - The compiler program.
 * @param models - Accumulator for referenced named models (see {@link mapType}).
 * @param enums - Accumulator for referenced named enums (see {@link mapType}).
 * @param usedHelpers - Accumulator for required helper classes (see {@link mapType}).
 * @returns The C# type expression for the body.
 */
function resolveBodyType(
  body: SingleBody,
  program: Program,
  models: Map<string, Model>,
  enums: Map<string, Enum>,
  usedHelpers: UsedHelpers,
): string {
  return body.property?.type === body.type
    ? mapPropertyType(body.property, program, models, enums, usedHelpers)
    : mapType(body.type, program, models, enums, usedHelpers);
}

/**
 * Resolves the C# type of a request body *parameter*. It is the body type, loosened
 * in two places so callers can pass custom (derived) models:
 *
 * - A collection of models is taken as `IEnumerable<T>` / `IReadOnlyDictionary<string, T>`,
 *   which are covariant, so a `List<MyWidget>` is accepted where `List<Widget>` was declared.
 * - A merge-patch body is taken as `IMergePatch<T>`, which is covariant, so a patch
 *   against `MyWidget` is accepted where a patch against `Widget` was declared.
 *
 * A derived model passed directly needs no loosening: it already is its base type.
 *
 * @param body - The HTTP payload body.
 * @param program - The compiler program.
 * @param models - Accumulator for referenced named models (see {@link mapType}).
 * @param enums - Accumulator for referenced named enums (see {@link mapType}).
 * @param usedHelpers - Accumulator for required helper classes (see {@link mapType}).
 * @returns The C# type expression for the body parameter.
 */
function resolveBodyParamType(
  body: HttpPayloadBody,
  program: Program,
  models: Map<string, Model>,
  enums: Map<string, Enum>,
  usedHelpers: UsedHelpers,
): string {
  if (body.bodyKind !== "single") return "object";
  // A scalar body declared by a property carries that property's `@format` and `@encode`.
  const mapped =
    body.type.kind === "Scalar" && body.property?.type === body.type
      ? mapPropertyType(body.property, program, models, enums, usedHelpers)
      : mapBodyParamType(body.type, program, models, enums, usedHelpers);
  const mergePatch = `${MERGE_PATCH_HELPER_NAME}<`;
  return mapped.startsWith(mergePatch)
    ? `${MERGE_PATCH_INTERFACE_NAME}<${mapped.slice(mergePatch.length)}`
    : mapped;
}

/**
 * Maps a request body type, loosening collections of models to their covariant
 * interfaces (see {@link resolveBodyParamType}); every other type maps as usual.
 *
 * @param type - The TypeSpec type to map.
 * @param program - The compiler program.
 * @param models - Accumulator for referenced named models (see {@link mapType}).
 * @param enums - Accumulator for referenced named enums (see {@link mapType}).
 * @param usedHelpers - Accumulator for required helper classes (see {@link mapType}).
 * @returns The C# type expression.
 */
function mapBodyParamType(
  type: Type,
  program: Program,
  models: Map<string, Model>,
  enums: Map<string, Enum>,
  usedHelpers: UsedHelpers,
): string {
  if (type.kind === "Model") {
    const model = type as Model;
    const isArray = isArrayModelType(model);
    if (
      (isArray || isRecordModelType(model)) &&
      findModelSlot(model.indexer!.value, program, models, enums, usedHelpers)
    ) {
      const inner = mapBodyParamType(
        model.indexer!.value,
        program,
        models,
        enums,
        usedHelpers,
      );
      return isArray
        ? `IEnumerable<${inner}>`
        : `IReadOnlyDictionary<string, ${inner}>`;
    }
  }
  return mapType(type, program, models, enums, usedHelpers);
}

/**
 * Whether a response status code is a success (2xx). A wildcard is not.
 *
 * @param statusCodes - The response's status code or range.
 * @returns `true` for a status code, or a range that lies within 200-299.
 */
function isSuccessStatus(
  statusCodes: HttpOperationResponse["statusCodes"],
): boolean {
  if (statusCodes === "*") return false;
  if (typeof statusCodes === "number") {
    return statusCodes >= 200 && statusCodes < 300;
  }
  return statusCodes.start >= 200 && statusCodes.end < 300;
}

/**
 * Finds a request or success-response body the client cannot send or read
 * correctly, which would otherwise be sent or read in the wrong format with no sign
 * of it:
 *
 * - A multipart or file (`Http.File`) body.
 * - A model, list, or dictionary declared only with non-JSON media types.
 * - A response that may arrive in a media type the client cannot read as its type,
 *   such as a model declared as `application/json` or `application/xml`.
 * - Success responses with different bodies that are not all JSON, since the result
 *   can only be held as a `JsonElement`.
 *
 * @param op - The HTTP operation.
 * @param program - The compiler program.
 * @returns A description of the unsupported feature, or `undefined` when all is supported.
 */
function findUnsupportedPayload(
  op: HttpOperation,
  program: Program,
): string | undefined {
  const body = op.parameters.body;
  if (body && body.bodyKind !== "single") {
    return body.bodyKind === "multipart"
      ? "A multipart request body"
      : "A file request body (Http.File)";
  }
  if (
    body &&
    classifyPayload(body.contentTypes, body.type, "request") === "unsupported"
  ) {
    return `A request body sent as ${body.contentTypes.join(", ")} that is not bytes or text`;
  }
  for (const response of op.responses) {
    if (!isSuccessStatus(response.statusCodes)) continue;
    for (const content of response.responses) {
      if (content.body && content.body.bodyKind !== "single") {
        return content.body.bodyKind === "multipart"
          ? "A multipart response body"
          : "A file response body (Http.File)";
      }
    }
  }

  const bodies = successBodies(op.responses);
  const kinds = bodies.map((b) =>
    classifyPayload(b.contentTypes, b.type, "response"),
  );
  const unreadable = bodies.find((_, i) => kinds[i] === "unsupported");
  if (unreadable) {
    return unreadable.contentTypes.some(isJsonMediaType)
      ? `A response body that may arrive as ${unreadable.contentTypes.join(" or ")}, which the client cannot read in every one of them`
      : `A response body sent as ${unreadable.contentTypes.join(", ")} that is not bytes or text`;
  }
  if (
    new Set(bodies.map((b) => bodyShape(b, program))).size > 1 &&
    kinds.some((kind) => kind !== "json")
  ) {
    return "Success responses with different bodies that are not all JSON";
  }
  return undefined;
}

/**
 * Registers the models used by error responses (`@error` models, or any non-success
 * body), so they are generated even though no method returns them. A caller reads
 * one from a failed call with `FlurlHttpException.GetResponseJsonAsync<T>()`.
 *
 * @param responses - The operation's HTTP responses.
 * @param program - The compiler program.
 * @param models - Accumulator for referenced named models (see {@link mapType}).
 * @param enums - Accumulator for referenced named enums (see {@link mapType}).
 * @param usedHelpers - Accumulator for required helper classes (see {@link mapType}).
 */
function registerErrorModels(
  responses: HttpOperationResponse[],
  program: Program,
  models: Map<string, Model>,
  enums: Map<string, Enum>,
  usedHelpers: UsedHelpers,
): void {
  for (const response of responses) {
    if (isSuccessStatus(response.statusCodes)) continue;
    for (const content of response.responses) {
      if (content.body?.bodyKind === "single") {
        mapType(content.body.type, program, models, enums, usedHelpers);
      }
    }
  }
}
