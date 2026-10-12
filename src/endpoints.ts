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
import { checkEncoding } from "./encoding.js";
import { createDiagnostic } from "./lib.js";
import {
  mapType,
  mapPropertyType,
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
import { flattenProperties } from "./models.js";

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
  const unsupported = findUnsupportedPayload(op);
  if (unsupported) {
    program.reportDiagnostic(
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

    if (
      bodyInfo.bodyKind === "single" &&
      bodyInfo.type.kind === "Model" &&
      (op.verb === "post" || op.verb === "patch" || op.verb === "put")
    ) {
      const bodyModel = bodyInfo.type as Model;
      if (bodyModel.name && !isSynthesizedMergePatchModel(bodyModel)) {
        const visibility = resolveRequestVisibility(
          program,
          op.operation,
          op.verb,
        );
        if (hasHiddenProperties(bodyModel, visibility, program)) {
          const suffix = requestTypeSuffix(op.verb);
          // Named after the model's effective (client) name, so renaming `Widget` to
          // `Product` gives `ProductCreateRequest`, and two same-named models with
          // different client names get different records.
          const modelName = getClientName(program, bodyModel) ?? bodyModel.name;
          const requestTypeName = `${modelName}${suffix}Request`;
          if (!requestTypes.has(requestTypeName)) {
            requestTypes.set(requestTypeName, {
              name: requestTypeName,
              doc: getDoc(program, bodyModel),
              access: getAccess(program, bodyModel) ?? "public",
              props: filterPropsForRequest(
                bodyModel,
                visibility,
                version,
                program,
              ),
            });
          }
          bodyType = requestTypeName;
        }
      }
    }

    const contentTypes = bodyInfo.contentTypes;
    body = {
      variable: "body",
      kind: payloadKind(contentTypes, bodyType),
      contentType: contentTypes[0] ?? "application/json",
    };
    requiredParams.push({ decl: `${bodyType} body`, name: "body" });
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
 * Decides how a payload travels on the wire. A body is JSON unless it declares
 * only non-JSON media types and maps to raw bytes or text.
 *
 * @param contentTypes - The media types the payload declares; empty means unspecified.
 * @param csType - The C# type the payload maps to.
 * @returns `json`, `bytes`, or `text`.
 */
function payloadKind(contentTypes: string[], csType: string): PayloadKind {
  const isJson =
    contentTypes.length === 0 ||
    contentTypes.some((c) => c.toLowerCase().includes("json"));
  if (isJson) return "json";
  if (csType === "byte[]") return "bytes";
  if (csType === "string") return "text";
  return "json";
}

/** A resolved success response: its renderer view and, when customizable, its generic overload. */
interface ResolvedResponse {
  /** How the body is read. */
  view: ResponseView;
  /** The generic overload, present when the body contains a customizable model. */
  generic?: GenericOverloadView;
}

/**
 * Determines how an operation's result is read from its responses: the body of
 * the first success (2xx) response, together with the generic overload when that
 * body contains a model a caller can replace with a derived type.
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
  for (const resp of responses) {
    if (!isSuccessStatus(resp.statusCodes)) continue;

    for (const content of resp.responses) {
      if (!content.body) continue;
      const type = resolveBodyType(
        content.body,
        program,
        models,
        enums,
        usedHelpers,
      );
      if (type === "void") continue;

      const kind = payloadKind(content.body.contentTypes, type);
      const view: ResponseView = { kind, type };
      const slot =
        kind === "json" && content.body.bodyKind === "single"
          ? findModelSlot(
              content.body.type,
              program,
              models,
              enums,
              usedHelpers,
            )
          : undefined;
      if (!slot) return { view };

      const responseType = slot.wrap("TResult");
      return {
        view,
        generic: {
          constraint: slot.constraint,
          returnType: `Task<${responseType}>`,
          responseType,
        },
      };
    }
  }
  return undefined;
}

/**
 * Resolves the C# type of an HTTP payload body: the mapped type for a single
 * body, or `object` for multipart/other non-single bodies.
 *
 * @param body - The HTTP payload body.
 * @param program - The compiler program.
 * @param models - Accumulator for referenced named models (see {@link mapType}).
 * @param enums - Accumulator for referenced named enums (see {@link mapType}).
 * @param usedHelpers - Accumulator for required helper classes (see {@link mapType}).
 * @returns The C# type expression for the body.
 */
function resolveBodyType(
  body: HttpPayloadBody,
  program: Program,
  models: Map<string, Model>,
  enums: Map<string, Enum>,
  usedHelpers: UsedHelpers,
): string {
  if (body.bodyKind === "single") {
    return mapType(body.type, program, models, enums, usedHelpers);
  }
  return "object";
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
  const mapped = mapBodyParamType(
    body.type,
    program,
    models,
    enums,
    usedHelpers,
  );
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
 * correctly. A multipart body or a file (`Http.File`) body would otherwise be
 * written as JSON, which is not what the API expects, with no sign of it.
 *
 * @param op - The HTTP operation.
 * @returns A description of the unsupported feature, or `undefined` when all is supported.
 */
function findUnsupportedPayload(op: HttpOperation): string | undefined {
  const body = op.parameters.body;
  if (body && body.bodyKind !== "single") {
    return body.bodyKind === "multipart"
      ? "A multipart request body"
      : "A file request body (Http.File)";
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
