/**
 * @module renderer
 *
 * Handlebars-based template renderer for C# Flurl client code generation.
 *
 * Provides view-model types that carry structured data from the emitter to the
 * templates, and a factory (`createRenderer`) that compiles all templates once
 * and returns a stateless {@link Renderer}.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Handlebars from "handlebars";
import { escapeCsString } from "./utils.js";

/** Absolute path to the bundled default templates directory. */
const TEMPLATES_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../templates",
);

/**
 * Names of the built-in Handlebars templates.
 * Each name maps to a `<name>.hbs` file inside {@link TEMPLATES_DIR}.
 */
export type TemplateName =
  | "file"
  | "record"
  | "enum"
  | "endpoint-interface"
  | "endpoint-client"
  | "csproj"
  | "extensions"
  | "merge-patch"
  | "model-map"
  | "client-runtime";

/**
 * Partial map of template names to absolute file paths used to override the
 * built-in defaults. Any template not listed falls back to its bundled counterpart.
 */
export type TemplateOverrides = Partial<Record<TemplateName, string>>;

/** View model for a single C# property declaration inside a record. */
export interface PropertyView {
  /** Optional XML doc text (pre-escaped). Rendered as `/// <summary>...</summary>`. */
  doc?: string;
  /** The wire name, XML-escaped, used for the generated summary when {@link doc} is absent. */
  docName: string;
  /** Full C# type including optional `?`, e.g. `"string"`, `"int?"`, `"List<Pet>"`. */
  type: string;
  /** PascalCase property name. */
  name: string;
  /** JSON wire name written to `[JsonPropertyName("...")]`, e.g. `"firstName"`. Always the original TypeSpec property name. */
  jsonPropertyName: string;
  /** Default initializer expression (without `= ` and `;`), e.g. `"default!"`, `"[]"`. */
  defaultValue?: string;
  /** `true` for a number that travels as a JSON string (`@encode("string")`); adds `[JsonNumberHandling(...)]`. */
  numberAsString?: boolean;
}

/** One derived-type entry for a `[JsonDerivedType(typeof(...), "...")]` attribute. */
export interface DerivedTypeView {
  /** C# record name of the derived type, e.g. `"Dog"`. */
  typeName: string;
  /** Wire discriminator value, e.g. `"dog"`. */
  value: string;
}

/** View model describing `@discriminator` polymorphism for a base record. */
export interface DiscriminatorView {
  /** JSON wire name of the discriminator property, e.g. `"petKind"`. */
  propertyName: string;
  /** Ordered list of known derived types, keyed by their discriminator value. */
  derivedTypes: DerivedTypeView[];
}

/** View model for a C# `public record` declaration. */
export interface RecordView {
  /** Optional XML doc text (pre-escaped). */
  doc?: string;
  /** PascalCase record name, e.g. `"Widget"` or `"PetCreateRequest"`. */
  recordName: string;
  /** Generic parameter string, e.g. `"<T>"` or `""` for non-generic records. */
  genericSuffix: string;
  /** Ordered list of property view models. */
  properties: PropertyView[];
  /** C# access modifier: `"public"` (default) or `"internal"`. */
  access: string;
  /** C# record name to inherit from (`: {baseRecordName}`), when this record is part of a `@discriminator` hierarchy. */
  baseRecordName?: string;
  /** Present when the decorated model declares `@discriminator`; drives `[JsonPolymorphic]` / `[JsonDerivedType]` attributes. */
  discriminator?: DiscriminatorView;
  /** When true, emits the `abstract` modifier — set for `@discriminator` hierarchy members with no concrete wire shape of their own. */
  isAbstract?: boolean;
}

/** View model for a single C# enum member. */
export interface EnumMemberView {
  /** Optional XML doc text (pre-escaped). */
  doc?: string;
  /** The declared value in text form, XML-escaped, used for the generated summary when {@link doc} is absent. */
  docValue: string;
  /** PascalCase member name. */
  name: string;
  /**
   * Text form of the declared value, for `[EnumMember(Value = "...")]` and, for a
   * string member, the wire string. Escaped for a C# string literal.
   */
  memberValue: string;
  /**
   * The C# numeric literal (`"1L"`, `"1.5D"`) when the member was declared with a
   * number, so it travels as a JSON number. Absent for a string member.
   */
  numberLiteral?: string;
}

/** View model for a C# `public enum` declaration. */
export interface EnumView {
  /** Optional XML doc text (pre-escaped). */
  doc?: string;
  /** PascalCase enum name. */
  enumName: string;
  /** Ordered list of enum member view models. */
  members: EnumMemberView[];
  /** C# access modifier: `"public"` (default) or `"internal"`. */
  access: string;
  /** Whether any member is declared as a string. */
  hasStringMembers: boolean;
  /** Whether any member is declared as a number. */
  hasNumberMembers: boolean;
  /** What a reader may find for this enum, for the error message: `"a string"`, `"a number"`, or both. */
  expectedToken: string;
}

/** How a request or response payload travels on the wire. */
export type PayloadKind = "json" | "bytes" | "text";

/** The request body of an endpoint method. */
export interface BodyView {
  /** Name of the C# parameter carrying the body. */
  variable: string;
  /** Wire encoding: JSON-serialized, raw bytes, or raw text. */
  kind: PayloadKind;
  /** Media type to send for `bytes` / `text` bodies. */
  contentType: string;
}

/** The success response body of an endpoint method. */
export interface ResponseView {
  /** Wire encoding: JSON-deserialized, raw bytes, or raw text. */
  kind: PayloadKind;
  /** C# type the body is read as, e.g. `"Widget"` or `"List<Widget>"`. Ignored for `bytes` and `text`. */
  type: string;
}

/**
 * The generic overload added to a method whose response contains a customizable
 * model. It lets the caller name a derived type, e.g. `ReadAsync<MyWidget>(id)`.
 */
export interface GenericOverloadView {
  /** C# type the type argument must derive from, e.g. `"Widget"`. */
  constraint: string;
  /** Full return type of the overload, e.g. `"Task<List<TResult>>"`. */
  returnType: string;
  /** Type the body is read as, e.g. `"List<TResult>"`. */
  responseType: string;
}

/** A query-string parameter bound to a C# method parameter. */
export interface QueryParamView {
  /** Name on the wire. */
  name: string;
  /** C# parameter that supplies the value. */
  variable: string;
  /**
   * `true` for an array sent as one comma-separated value (`tags=a,b`), which is what
   * TypeSpec means by `explode: false`. Otherwise an array is repeated (`tags=a&tags=b`).
   */
  delimited?: boolean;
}

/** A cookie bound to a C# method parameter. */
export interface CookieParamView {
  /** Cookie name. */
  name: string;
  /** C# parameter that supplies the value. */
  variable: string;
}

/** A header bound to a C# method parameter. */
export interface HeaderParamView {
  /** Header name on the wire. */
  name: string;
  /** C# parameter that supplies the value. */
  variable: string;
}

/** View model for a single endpoint method, used by both the interface and the client class. */
export interface MethodView {
  /** Optional XML doc text (pre-escaped). */
  doc?: string;
  /** Method name, e.g. `"ListAsync"`. */
  methodName: string;
  /** C# return type of the declared (non-generic) method, e.g. `"Task<Widget>"` or `"Task"`. */
  returnType: string;
  /** Pre-rendered comma-separated parameter declaration list. */
  paramsText: string;
  /** Comma-separated parameter names, used to forward the call to the generic overload. */
  argsText: string;
  /** PascalCase `HttpMethod` member name, e.g. `"Get"`, `"Post"`. */
  httpMethod: string;
  /** Content of the C# interpolated string that builds the request path. */
  route: string;
  /** Query-string parameters in declaration order. */
  queryParams: QueryParamView[];
  /** Header parameters in declaration order. */
  headerParams: HeaderParamView[];
  /** Cookie parameters in declaration order. */
  cookieParams: CookieParamView[];
  /** The request body, when the operation takes one. */
  body?: BodyView;
  /** The success response body, when the operation returns one. */
  response?: ResponseView;
  /** Present when the response contains a model callers can substitute. */
  generic?: GenericOverloadView;
}

/** View model for an endpoint interface (`IWidgets`). */
export interface EndpointInterfaceView {
  /** C# interface name, e.g. `"IWidgets"`. */
  interfaceName: string;
  /** Optional XML doc text (pre-escaped). */
  doc?: string;
  /** Ordered list of method view models. */
  methods: MethodView[];
  /** C# access modifier: `"public"` (default) or `"internal"`. */
  access: string;
}

/** View model for an endpoint client implementation (`WidgetsEndpoint`). */
export interface EndpointClientView {
  /** C# class name, e.g. `"WidgetsEndpoint"`. */
  className: string;
  /** Interface the class implements, e.g. `"IWidgets"`. */
  interfaceName: string;
  /** Ordered list of method view models. */
  methods: MethodView[];
}

/** View model passed to the `file` template — wraps any inner body with the file header. */
export interface FileView {
  /** Fully-qualified C# namespace string. */
  namespace: string;
  /** Sorted list of `using` directive namespaces (without the `using` keyword). */
  usings: string[];
  /** Pre-rendered inner declaration body. */
  body: string;
  /** Basename of the file being emitted, e.g. `"Widget.cs"`. */
  fileName: string;
}

/** One endpoint entry used in the aggregate client and DI registration. */
export interface InterfaceEntry {
  /** C# interface name, e.g. `"IStores"`. */
  name: string;
  /** C# implementation class name, e.g. `"StoresEndpoint"`. */
  clientName: string;
  /** Property name on the aggregate client class, e.g. `"Stores"`. */
  propertyName: string;
  /** Constructor parameter name, e.g. `"stores"`. */
  paramName: string;
  /** C# access modifier of the property: the interface's own, `"public"` or `"internal"`. */
  access: string;
}

/** View model for the generated aggregate client class and DI registration extension class. */
export interface ExtensionsView {
  /** Name of the static extensions class, e.g. `"ApiClientExtensions"`. */
  className: string;
  /** Name of the public extension method, e.g. `"AddApiClient"`. */
  methodName: string;
  /** Name of the aggregate client class, e.g. `"ApiClient"`. */
  clientClassName: string;
  /** Name used to register the underlying named `HttpClient`; unique per namespace and client. */
  httpClientName: string;
  /** C# access modifier of the aggregate client's constructor; `"internal"` when any endpoint is internal. */
  constructorAccess: string;
  /** Ordered list of endpoint entries. */
  interfaces: InterfaceEntry[];
}

/** View model for the generated `.csproj` project file. */
export interface CsprojView {
  /** C# root namespace. */
  rootNamespace: string;
  /**
   * Target framework moniker(s). Single: `"net8.0"`. Multi-target: `"net8.0;net9.0"`.
   * Use together with {@link isMultiTarget} to choose the correct MSBuild element.
   */
  netVersion: string;
  /** `true` when `netVersion` contains multiple TFMs; drives `<TargetFrameworks>` vs `<TargetFramework>`. */
  isMultiTarget: boolean;
  /** NuGet `<Description>`. Always present; defaults to a generated string when not supplied. */
  nugetDescription: string;
  /** NuGet `<PackageId>`. Omitted from the project file when undefined. */
  nugetPackageId?: string;
  /** NuGet `<Version>`. Always present; derived from the API version or CalVer when not supplied via option. */
  nugetVersion: string;
  /** NuGet `<Authors>`. Omitted when undefined. */
  nugetAuthors?: string;
  /** NuGet `<Title>`. Omitted when undefined. */
  nugetTitle?: string;
  /** NuGet `<PackageTags>`. Omitted when undefined. */
  nugetTags?: string;
}

/** Stateless code renderer. Obtain an instance via {@link createRenderer}. */
export interface Renderer {
  /** Renders the full file: `// <auto-generated />`, usings, file-scoped namespace, body. */
  renderFile(view: FileView): string;
  /** Renders a `public record` declaration with its properties. */
  renderRecord(view: RecordView): string;
  /** Renders a `public enum` declaration with its members. */
  renderEnum(view: EnumView): string;
  /** Renders an endpoint `public interface` declaration with its methods. */
  renderEndpointInterface(view: EndpointInterfaceView): string;
  /** Renders an endpoint client implementation class with its methods. */
  renderEndpointClient(view: EndpointClientView): string;
  /** Renders the `.csproj` project file content. */
  renderCsproj(view: CsprojView): string;
  /** Renders the aggregate client and DI registration extension class bodies. */
  renderExtensions(view: ExtensionsView): string;
  /** Renders the `MergePatch<T>` helper class body. Takes no view model. */
  renderMergePatch(): string;
  /** Renders the `ModelMap` helper class body. Takes no view model. */
  renderModelMap(): string;
  /** Renders the internal `ClientRuntime` helper class body. Takes no view model. */
  renderClientRuntime(): string;
}

/**
 * Builds the Handlebars environment shared by every template, registering the
 * helpers documented at the top of each `.hbs` file.
 *
 * @returns An isolated Handlebars environment.
 */
function createHandlebarsEnv(): typeof Handlebars {
  const env = Handlebars.create();

  env.registerHelper("indent", (content: unknown) => {
    if (typeof content !== "string" || !content) return "";
    return content
      .split("\n")
      .map((line) => (line.length ? `    ${line}` : ""))
      .join("\n");
  });

  // Splits doc text on newlines and rejoins with `\n{prefix}` so that every
  // continuation line in a /// <summary> block gets the correct leading prefix.
  env.registerHelper("docLines", (doc: unknown, prefix: unknown) => {
    if (typeof doc !== "string" || !doc) return "";
    const sep = typeof prefix === "string" ? `\n${prefix}` : "\n/// ";
    return doc.split("\n").join(sep);
  });

  env.registerHelper("isDefined", (value: unknown) => value !== undefined);

  env.registerHelper("eq", (a: unknown, b: unknown) => a === b);

  return env;
}

/**
 * Compiles template source with HTML escaping disabled (the output is C#, not HTML).
 *
 * @param env - The Handlebars environment.
 * @param source - The template source text.
 * @returns The compiled template function.
 */
function compileTemplate(
  env: typeof Handlebars,
  source: string,
): HandlebarsTemplateDelegate {
  return env.compile(source, { noEscape: true });
}

/**
 * Loads and compiles a named template, preferring a user-supplied override path.
 *
 * @param env - The Handlebars environment.
 * @param name - The built-in template name.
 * @param override - Absolute path of a replacement template, if configured.
 * @returns The compiled template function.
 */
function loadTemplate(
  env: typeof Handlebars,
  name: TemplateName,
  override: string | undefined,
): HandlebarsTemplateDelegate {
  const path = override ?? resolve(TEMPLATES_DIR, `${name}.hbs`);
  // Line endings are part of the output. A template checked out with CRLF (Git's
  // autocrlf on Windows, or a user's own override) must not leak into the generated
  // C#, which is always written with LF.
  const source = readFileSync(path, "utf-8").replace(/\r\n/g, "\n");
  return compileTemplate(env, source);
}

/**
 * Renders an XML doc summary block at the given indentation.
 *
 * @param doc - Pre-escaped doc text; may be multi-line.
 * @param extraLines - Additional pre-formatted doc lines placed after the summary.
 * @param fallback - Summary text to use when `doc` is absent.
 * @returns The `///` lines, or an empty array when there is neither a doc nor a fallback.
 */
function renderDocLines(
  doc: string | undefined,
  extraLines: string[] = [],
  fallback?: string,
): string[] {
  const lines: string[] = [];
  const text = doc || fallback;
  if (text) {
    lines.push("    /// <summary>");
    for (const docLine of text.split("\n")) {
      lines.push(`    /// ${docLine}`);
    }
    lines.push("    /// </summary>");
  }
  for (const line of extraLines) lines.push(`    /// ${line}`);
  return lines;
}

/**
 * The `<typeparam>` doc line for a generic overload.
 *
 * @param constraint - The type the type argument derives from.
 * @returns The XML doc line (without the `///` prefix).
 */
function typeParamDoc(constraint: string): string {
  const escaped = constraint.replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<typeparam name="TResult">A custom type deriving from <c>${escaped}</c> to deserialize the response into.</typeparam>`;
}

/**
 * The generated summary of a method whose operation has no documentation, so every
 * public member still carries XML documentation.
 *
 * @param m - The method view.
 * @returns The summary text (XML-safe: it names only identifiers and a verb).
 */
function methodSummary(m: MethodView): string {
  return `Sends the <c>${m.httpMethod.toUpperCase()}</c> request of the <c>${m.methodName}</c> operation.`;
}

/**
 * Renders the interface members for one method: the declared signature and, when
 * the response holds a customizable model, the generic overload.
 *
 * @param m - The method view.
 * @returns The rendered members, indented for placement inside an interface.
 */
function renderInterfaceMethod(m: MethodView): string {
  const lines = [
    ...renderDocLines(m.doc, [], methodSummary(m)),
    `    ${m.returnType} ${m.methodName}(${m.paramsText});`,
  ];
  if (m.generic) {
    lines.push(
      "",
      ...renderDocLines(
        m.doc,
        [typeParamDoc(m.generic.constraint)],
        methodSummary(m),
      ),
      `    ${m.generic.returnType} ${m.methodName}<TResult>(${m.paramsText})`,
      `        where TResult : ${m.generic.constraint};`,
    );
  }
  return lines.join("\n");
}

/**
 * Renders the statements that build and send the request, then read the response.
 *
 * @param m - The method view.
 * @param responseType - The C# type the JSON body is read as.
 * @returns The statements, indented for placement inside a method body.
 */
function renderRequestBody(m: MethodView, responseType: string): string[] {
  const pad = "        ";
  const lines = [
    `${pad}var flurlRequest = _client.Request().AppendPathSegment($"${m.route}");`,
  ];
  for (const q of m.queryParams) {
    const convert = q.delimited
      ? "ClientRuntime.ToDelimitedQueryValue"
      : "ClientRuntime.ToQueryValue";
    lines.push(
      `${pad}flurlRequest.SetQueryParam("${escapeCsString(q.name)}", ${convert}(${q.variable}));`,
    );
  }
  for (const h of m.headerParams) {
    lines.push(
      `${pad}if (${h.variable} is not null) flurlRequest.WithHeader("${escapeCsString(h.name)}", ClientRuntime.ToWireString(${h.variable}));`,
    );
  }
  for (const c of m.cookieParams) {
    lines.push(
      `${pad}if (${c.variable} is not null) flurlRequest.WithCookie("${escapeCsString(c.name)}", ClientRuntime.ToWireString(${c.variable}));`,
    );
  }
  lines.push(
    `${pad}ClientRuntime.AddQueryParameters(flurlRequest, additionalQueryParameters);`,
  );

  const verb = `HttpMethod.${m.httpMethod}`;
  let send: string;
  if (!m.body) {
    send = `await flurlRequest.SendAsync(${verb}, cancellationToken: cancellationToken)`;
  } else if (m.body.kind === "json") {
    send = `await flurlRequest.SendJsonAsync(${verb}, ${m.body.variable}, cancellationToken: cancellationToken)`;
  } else if (m.body.kind === "bytes") {
    send = `await flurlRequest.SendAsync(${verb}, ClientRuntime.BytesContent(${m.body.variable}, "${escapeCsString(m.body.contentType)}"), cancellationToken: cancellationToken)`;
  } else {
    send = `await flurlRequest.SendAsync(${verb}, ClientRuntime.TextContent(${m.body.variable}, "${escapeCsString(m.body.contentType)}"), cancellationToken: cancellationToken)`;
  }
  lines.push(`${pad}using var flurlResponse = ${send}.ConfigureAwait(false);`);

  if (m.response?.kind === "json") {
    lines.push(
      `${pad}return (await flurlResponse.GetJsonAsync<${responseType}>().ConfigureAwait(false))!;`,
    );
  } else if (m.response?.kind === "bytes") {
    lines.push(
      `${pad}return await flurlResponse.GetBytesAsync().ConfigureAwait(false);`,
    );
  } else if (m.response?.kind === "text") {
    lines.push(
      `${pad}return await flurlResponse.GetStringAsync().ConfigureAwait(false);`,
    );
  }
  return lines;
}

/**
 * Renders the class members for one method. A method with a generic overload gets
 * a thin declared-type wrapper that forwards to the generic implementation; any
 * other method carries the implementation itself.
 *
 * @param m - The method view.
 * @returns The rendered members, indented for placement inside a class.
 */
function renderClientMethod(m: MethodView): string {
  const inherit = "    /// <inheritdoc />";
  if (m.generic) {
    return [
      inherit,
      `    public ${m.returnType} ${m.methodName}(${m.paramsText}) =>`,
      `        ${m.methodName}<${m.generic.constraint}>(${m.argsText});`,
      "",
      inherit,
      `    public async ${m.generic.returnType} ${m.methodName}<TResult>(${m.paramsText})`,
      `        where TResult : ${m.generic.constraint}`,
      "    {",
      ...renderRequestBody(m, m.generic.responseType),
      "    }",
    ].join("\n");
  }

  return [
    inherit,
    `    public async ${m.returnType} ${m.methodName}(${m.paramsText})`,
    "    {",
    ...renderRequestBody(m, m.response?.type ?? ""),
    "    }",
  ].join("\n");
}

/**
 * Compiles all templates and returns a {@link Renderer} instance.
 *
 * Templates are compiled once; the returned renderer is cheap to call
 * repeatedly. Any template absent from `overrides` falls back to its bundled
 * `.hbs` file.
 *
 * @param overrides - Optional absolute paths replacing built-in templates.
 * @returns A ready-to-use renderer.
 * @throws If any template file (built-in or custom) cannot be read or parsed.
 */
export function createRenderer(overrides: TemplateOverrides = {}): Renderer {
  const env = createHandlebarsEnv();
  const fileTemplate = loadTemplate(env, "file", overrides.file);
  const recordTemplate = loadTemplate(env, "record", overrides.record);
  const enumTemplate = loadTemplate(env, "enum", overrides.enum);
  const interfaceTemplate = loadTemplate(
    env,
    "endpoint-interface",
    overrides["endpoint-interface"],
  );
  const clientTemplate = loadTemplate(
    env,
    "endpoint-client",
    overrides["endpoint-client"],
  );
  const csprojTemplate = loadTemplate(env, "csproj", overrides.csproj);
  const extensionsTemplate = loadTemplate(
    env,
    "extensions",
    overrides.extensions,
  );
  const mergePatchTemplate = loadTemplate(
    env,
    "merge-patch",
    overrides["merge-patch"],
  );
  const modelMapTemplate = loadTemplate(
    env,
    "model-map",
    overrides["model-map"],
  );
  const clientRuntimeTemplate = loadTemplate(
    env,
    "client-runtime",
    overrides["client-runtime"],
  );

  return {
    renderFile(view) {
      return fileTemplate(view);
    },

    renderRecord(view) {
      return recordTemplate(view);
    },

    renderEnum(view) {
      return enumTemplate(view);
    },

    renderEndpointInterface(view) {
      const methodBlocks = view.methods.map(renderInterfaceMethod);
      const methodsBlock =
        methodBlocks.length > 0 ? methodBlocks.join("\n\n") + "\n" : "";
      return interfaceTemplate({
        interfaceName: view.interfaceName,
        doc: view.doc,
        access: view.access,
        methodsBlock,
      });
    },

    renderEndpointClient(view) {
      const methodBlocks = view.methods.map(renderClientMethod);
      const methodsBlock =
        methodBlocks.length > 0 ? methodBlocks.join("\n\n") + "\n" : "";
      return clientTemplate({
        className: view.className,
        interfaceName: view.interfaceName,
        methodsBlock,
      });
    },

    renderCsproj(view) {
      return csprojTemplate(view);
    },

    renderExtensions(view) {
      return extensionsTemplate(view);
    },

    renderMergePatch() {
      return mergePatchTemplate({});
    },

    renderModelMap() {
      return modelMapTemplate({});
    },

    renderClientRuntime() {
      return clientRuntimeTemplate({});
    },
  };
}
