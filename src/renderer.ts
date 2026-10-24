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
import { encodeExpression, type WireEncoding } from "./encoding.js";
import { csDeclarationName, escapeCsString } from "./utils.js";
import { fx, qualifyTemplate, type FrameworkUse } from "./framework.js";

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
  /**
   * `true` for a required property whose type allows null (`note: string | null`);
   * adds `[JsonIgnore(Condition = JsonIgnoreCondition.Never)]`, so a null is sent as
   * `"note": null` instead of being left out the way an optional property is.
   */
  writeNull?: boolean;
  /**
   * The `[JsonConverter]` type for a property with an `@encode` the runtime
   * implements, e.g. `ClientRuntime.UnixSecondsConverter`.
   */
  converter?: string;
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
  /**
   * Whether reading the member's wire value gives this member: the first member
   * declared with that value. A later member with the same value (an alias) still
   * writes it, but is never read.
   */
  reads: boolean;
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

/**
 * How a request or response payload travels on the wire: JSON, raw bytes, plain
 * text, or (for a response declared as both JSON and text) whichever the server's
 * `Content-Type` says arrived.
 */
export type PayloadKind = "json" | "bytes" | "text" | "negotiated";

/** The request body of an endpoint method. */
export interface BodyView {
  /** Name of the C# parameter carrying the body. */
  variable: string;
  /** Wire encoding: JSON-serialized, raw bytes, or raw text. */
  kind: PayloadKind;
  /** Media type to send for `bytes` / `text` bodies. */
  contentType: string;
  /** `true` for `@body body?: T`: a `null` argument sends no body at all. */
  optional?: boolean;
  /** The runtime format of a plain-text body with an `@encode`, e.g. `UnixSeconds`. */
  encoding?: WireEncoding;
}

/** The success response body of an endpoint method. */
export interface ResponseView {
  /** Wire encoding: JSON-deserialized, raw bytes, or raw text. */
  kind: PayloadKind;
  /**
   * C# condition on `flurlResponse.StatusCode` that the response is a bodyless
   * success (`Widget | void`), for which the method returns `null` without reading.
   */
  emptyWhen?: string;
  /** The runtime format of a plain-text response with an `@encode`, e.g. `UnixSeconds`. */
  encoding?: WireEncoding;
  /**
   * C# type the body is read as, e.g. `"Widget"` or `"List<Widget>"`; nullable when
   * another success response has no body. A `text` body is parsed into it, and it is
   * ignored for `bytes`.
   */
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
   * The C# expression written for the parameter when its `@encode` needs the runtime
   * encoder (`ClientRuntime.Encode(at, ClientRuntime.WireEncoding.UnixSeconds)`);
   * otherwise the variable itself is written.
   */
  value?: string;
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
  /**
   * `true` when the parameter can be null, so the header or cookie is only added
   * when it has a value; a required value type cannot be null and is always added.
   */
  guard?: boolean;
  /**
   * The C# expression written for the parameter when its `@encode` needs the runtime
   * encoder (`ClientRuntime.Encode(at, ClientRuntime.WireEncoding.UnixSeconds)`);
   * otherwise the variable itself is written.
   */
  value?: string;
}

/** A header bound to a C# method parameter. */
export interface HeaderParamView {
  /** Header name on the wire. */
  name: string;
  /** C# parameter that supplies the value. */
  variable: string;
  /**
   * `true` when the parameter can be null, so the header or cookie is only added
   * when it has a value; a required value type cannot be null and is always added.
   */
  guard?: boolean;
  /**
   * The C# expression written for the parameter when its `@encode` needs the runtime
   * encoder (`ClientRuntime.Encode(at, ClientRuntime.WireEncoding.UnixSeconds)`);
   * otherwise the variable itself is written.
   */
  value?: string;
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
  /** Present when the body holds a dictionary of models, which callers can substitute. */
  bodyGeneric?: BodyGenericView;
  /** Present when this operation is `@list` and resolves to a supported paging strategy; drives the sibling `IAsyncEnumerable<T>` wrapper method. */
  paging?: PagingMethodView;
}

/**
 * The overloads added to a method whose body holds a dictionary of models. A
 * dictionary is not covariant in its values, so these are generic in the item type
 * instead: `ReplaceAsync<TBody>(..., IReadOnlyDictionary<string, TBody> body)`
 * accepts a `Dictionary<string, MyWidget>`.
 */
export interface BodyGenericView {
  /** C# type the items must derive from, e.g. `"WidgetReplaceRequest"`. */
  constraint: string;
  /** The parameter list with the body typed by `TBody`. */
  paramsText: string;
  /**
   * Whether to add the overload generic in the items alone, beside the one generic
   * in both the response and the items. It is left out where it would be ambiguous
   * with the response overload.
   */
  itemsOnly: boolean;
}

/**
 * Which forward-iteration signal an auto-paginating wrapper method follows.
 * Priority when a page model exposes more than one is `nextLink` >
 * `continuationToken` > `offset`/`pageIndex`.
 */
export type PagingStrategy =
  "nextLink" | "continuationToken" | "offset" | "pageIndex";

/**
 * View model for a single generated `IAsyncEnumerable<T>` auto-paginating wrapper
 * method, declared on the endpoint interface and implemented on the endpoint
 * client beside the raw single-page method it wraps. Unlike {@link MethodView},
 * this does not describe one HTTP request: it describes a loop that calls the raw
 * method (and, for `nextLink`, follows a URL directly through `_client`) until no
 * further pages remain.
 */
export interface PagingMethodView {
  /** Optional XML doc text (pre-escaped), carried over from the TypeSpec operation. */
  doc?: string;
  /** Which forward-iteration signal this method follows. */
  strategy: PagingStrategy;
  /** Wrapper method name, e.g. `"ListAllAsync"`. */
  methodName: string;
  /** The raw single-page method this wrapper calls, e.g. `"ListAsync"`. */
  rawMethodName: string;
  /** C# type of a single page item, e.g. `"Store"`. */
  itemType: string;
  /** C# type of the page response model, e.g. `"PagedResult<Store>"`. Used only by the `nextLink` strategy, to type the page fetched directly through `_client`. */
  pageType: string;
  /** PascalCase name of the page model's items-array property, e.g. `"Items"`. */
  itemsPropertyName: string;
  /**
   * Pre-joined parameter declaration list matching the raw method's own
   * parameters, but without a trailing `CancellationToken` — the interface
   * declaration and the client implementation each append their own form of it
   * (see {@link renderPagingInterfaceMethod} / {@link renderPagingClientMethod}),
   * since only the implementation is itself an iterator method.
   */
  paramsText: string;
  /** Pre-joined argument list to call {@link rawMethodName} with; the paging input parameter (if any) is already substituted for its loop-local variable name. */
  argsText: string;
  /**
   * Collision-free local variable name for the first page (every strategy),
   * e.g. `"page"` — or `"page2"` when the operation already has a parameter
   * named `page`.
   */
  pageVarName: string;
  /** Collision-free local variable name for the `foreach` loop item (every strategy), e.g. `"item"`. */
  itemVarName: string;
  /** Whether the raw method can return `null` instead of a page (a declared bodyless success), so the loop must stop on it rather than read its items. */
  pageNullable: boolean;
  /** `nextLink` strategy only: PascalCase name of the page model's next-link property, e.g. `"Next"`. */
  nextLinkPropertyName?: string;
  /** `nextLink` strategy only: whether the next-link property is a `string` (`@nextLink next?: string`) rather than a `Uri`, so an empty string also ends the loop. */
  nextLinkIsString?: boolean;
  /** `nextLink` strategy only: collision-free local variable name for the current next-link value. */
  nextLinkVarName?: string;
  /** `nextLink` strategy only: collision-free local variable name for the client's base URL, the origin every next link must stay on. */
  baseUriVarName?: string;
  /** `nextLink` strategy only: collision-free local variable name for the next link resolved against the base URL. */
  nextUriVarName?: string;
  /** `nextLink` strategy only: collision-free local variable name for the Flurl request built against that URL. */
  nextRequestVarName?: string;
  /** `nextLink` strategy only: collision-free local variable name for the deserialized continuation page. */
  nextPageVarName?: string;
  /**
   * `nextLink` strategy only: the raw method's header bindings, replayed on
   * every continuation request — it goes through `_client` directly, not the
   * raw method, so none of its own bindings would otherwise reach page two
   * onward (a tenant or authentication header, for instance). A next link to a
   * different origin than the client's base URL is refused before anything is
   * sent, so neither these nor the client's own default credentials can leak
   * to another host.
   */
  headerParams?: HeaderParamView[];
  /** `nextLink` strategy only: the raw method's cookie bindings, replayed the same way as {@link headerParams}. */
  cookieParams?: CookieParamView[];
  /** `continuationToken` strategy only: PascalCase name of the page model's continuation-token output property, e.g. `"ContinuationToken"`. */
  continuationTokenPropertyName?: string;
  /** `continuationToken` strategy only: expression seeding the local token variable, e.g. `"continuationToken"`. */
  continuationTokenSeedExpression?: string;
  /** `continuationToken` strategy only: collision-free local variable name for the token. */
  tokenVarName?: string;
  /** `offset` / `pageIndex` strategy only: collision-free local loop variable name, e.g. `"currentOffset"`. */
  counterVarName?: string;
  /** `offset` / `pageIndex` strategy only: expression seeding the local counter variable, e.g. `"offset ?? 0"` or `"pageIndex"` (no fallback needed when the parameter is required). */
  counterSeedExpression?: string;
  /** `offset` / `pageIndex` strategy only: collision-free local variable name for the per-page item count. */
  countVarName?: string;
  /** `offset` / `pageIndex` strategy only: the counter's own mapped C# type (e.g. `"ulong"`), used to cast the (always-`int`) per-page item count before adding it — C# has no built-in `+=` between an unrelated integer type and a non-constant `int`. */
  counterCsType?: string;
}

/** View model for an endpoint interface (`IWidgets`). */
export interface EndpointInterfaceView {
  /** C# interface name, e.g. `"IWidgets"`. */
  interfaceName: string;
  /** Optional XML doc text (pre-escaped). */
  doc?: string;
  /** Ordered list of method view models. */
  methods: MethodView[];
  /** Auto-paginating wrapper methods declared alongside the raw methods above. */
  pagingMethods: PagingMethodView[];
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
  /** Auto-paginating wrapper methods implemented alongside the raw methods above. */
  pagingMethods: PagingMethodView[];
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
  /** Constructor parameter name as written in C#, verbatim-escaped when needed, e.g. `"stores"` or `"@params"`. */
  paramName: string;
  /** The parameter name in its XML documentation, never escaped, e.g. `"params"`. */
  docParamName: string;
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

  env.registerHelper("fx", (name: unknown, use: unknown) =>
    fx(String(name), typeof use === "string" ? (use as FrameworkUse) : "type"),
  );

  env.registerHelper("declaredName", (name: unknown) =>
    typeof name === "string" ? csDeclarationName(name) : name,
  );

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
  // Every framework type the C# names goes through the fx helper, so a generated
  // type of the same name cannot hide it. The project file is XML, not C#.
  return compileTemplate(
    env,
    name === "csproj" ? source : qualifyTemplate(source),
  );
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
 * The generated summary of a method whose operation has no documentation, so every
 * public member still carries XML documentation.
 *
 * @param m - The method view.
 * @returns The summary text (XML-safe: it names only identifiers and a verb).
 */
function methodSummary(m: MethodView): string {
  return `Sends the <c>${m.httpMethod.toUpperCase()}</c> request of the <c>${m.methodName}</c> operation.`;
}

/** A type parameter a method overload can take: the response type, or the body's item type. */
type OverloadParameter = "TResult" | "TBody";

/**
 * The overloads of a method, each by the type parameters it takes: the declared
 * one with none; `<TResult>` when the response holds a model the caller can
 * substitute; and `<TBody>` and `<TResult, TBody>` when the body holds a
 * dictionary of models. The last one lists every type parameter the method has,
 * and carries the implementation that the others forward to.
 *
 * @param m - The method view.
 * @returns The overloads, the most general last.
 */
function overloadsOf(m: MethodView): OverloadParameter[][] {
  const overloads: OverloadParameter[][] = [[]];
  if (m.generic) overloads.push(["TResult"]);
  if (m.bodyGeneric) {
    if (m.bodyGeneric.itemsOnly) overloads.push(["TBody"]);
    if (m.generic) overloads.push(["TResult", "TBody"]);
  }
  return overloads;
}

/**
 * The signature of one overload of a method, without its access or body.
 *
 * @param m - The method view.
 * @param parameters - The overload's type parameters.
 * @param modifiers - What comes before the return type, e.g. `"public async "`.
 * @returns The signature line and its `where` clauses.
 */
function overloadSignature(
  m: MethodView,
  parameters: OverloadParameter[],
  modifiers: string,
): string[] {
  const returnType = parameters.includes("TResult")
    ? m.generic!.returnType
    : m.returnType;
  const paramsText = parameters.includes("TBody")
    ? m.bodyGeneric!.paramsText
    : m.paramsText;
  const typeParameters = parameters.length ? `<${parameters.join(", ")}>` : "";
  return [
    `    ${modifiers}${returnType} ${m.methodName}${typeParameters}(${paramsText})`,
    ...parameters.map(
      (p) =>
        `        where ${p} : ${p === "TResult" ? m.generic!.constraint : m.bodyGeneric!.constraint}`,
    ),
  ];
}

/**
 * The `<typeparam>` doc lines for an overload's type parameters.
 *
 * @param m - The method view.
 * @param parameters - The overload's type parameters.
 * @returns The XML doc lines (without the `///` prefix).
 */
function typeParamDocs(
  m: MethodView,
  parameters: OverloadParameter[],
): string[] {
  const escape = (t: string): string =>
    t.replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return parameters.map((p) =>
    p === "TResult"
      ? `<typeparam name="TResult">A custom type deriving from <c>${escape(m.generic!.constraint)}</c> to deserialize the response into.</typeparam>`
      : `<typeparam name="TBody">A custom type deriving from <c>${escape(m.bodyGeneric!.constraint)}</c> that the body's items are.</typeparam>`,
  );
}

/**
 * Renders the interface members for one method: one per overload (see
 * {@link overloadsOf}).
 *
 * @param m - The method view.
 * @returns The rendered members, indented for placement inside an interface.
 */
function renderInterfaceMethod(m: MethodView): string {
  return overloadsOf(m)
    .map((parameters) => {
      const signature = overloadSignature(m, parameters, "");
      signature[signature.length - 1] += ";";
      return [
        ...renderDocLines(
          m.doc,
          typeParamDocs(m, parameters),
          methodSummary(m),
        ),
        ...signature,
      ].join("\n");
    })
    .join("\n\n");
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
      `${pad}flurlRequest.SetQueryParam("${escapeCsString(q.name)}", ${convert}(${q.value ?? q.variable}));`,
    );
  }
  for (const h of m.headerParams) {
    lines.push(
      `${pad}${h.guard ? `if (${h.variable} is not null) ` : ""}flurlRequest.WithHeader("${escapeCsString(h.name)}", ClientRuntime.ToWireString(${h.value ?? h.variable}));`,
    );
  }
  for (const c of m.cookieParams) {
    lines.push(
      `${pad}${c.guard ? `if (${c.variable} is not null) ` : ""}flurlRequest.WithCookie("${escapeCsString(c.name)}", ClientRuntime.ToWireString(${c.value ?? c.variable}));`,
    );
  }
  lines.push(
    `${pad}ClientRuntime.AddQueryParameters(flurlRequest, additionalQueryParameters);`,
  );

  const verb = `${fx("HttpMethod")}.${m.httpMethod}`;
  let send: string;
  if (!m.body) {
    send = `await flurlRequest.SendAsync(${verb}, cancellationToken: cancellationToken)`;
  } else if (
    m.body.kind === "json" &&
    m.body.contentType.toLowerCase() === "application/json"
  ) {
    send = `await flurlRequest.SendJsonAsync(${verb}, ${m.body.variable}, cancellationToken: cancellationToken)`;
  } else if (m.body.kind === "json") {
    // Flurl's SendJsonAsync always sends application/json.
    send = `await flurlRequest.SendAsync(${verb}, ClientRuntime.JsonContent(flurlRequest, ${m.body.variable}, "${escapeCsString(m.body.contentType)}"), cancellationToken: cancellationToken)`;
  } else if (m.body.kind === "bytes") {
    send = `await flurlRequest.SendAsync(${verb}, ClientRuntime.BytesContent(${m.body.variable}, "${escapeCsString(m.body.contentType)}"), cancellationToken: cancellationToken)`;
  } else {
    const text = m.body.encoding
      ? encodeExpression(m.body.variable, m.body.encoding)
      : m.body.variable;
    send = `await flurlRequest.SendAsync(${verb}, ClientRuntime.TextContent(ClientRuntime.ToWireString(${text}), "${escapeCsString(m.body.contentType)}"), cancellationToken: cancellationToken)`;
  }
  if (m.body?.optional) {
    // An omitted optional body sends no content, rather than a JSON `null`.
    send = `${m.body.variable} is null ? await flurlRequest.SendAsync(${verb}, cancellationToken: cancellationToken).ConfigureAwait(false) : ${send}`;
  }
  lines.push(`${pad}using var flurlResponse = ${send}.ConfigureAwait(false);`);

  if (m.response?.emptyWhen) {
    lines.push(`${pad}if (${m.response.emptyWhen}) return default;`);
  }
  if (m.response?.kind === "json") {
    lines.push(
      `${pad}return (await flurlResponse.GetJsonAsync<${responseType}>().ConfigureAwait(false))!;`,
    );
  } else if (m.response?.kind === "bytes") {
    lines.push(
      `${pad}return await flurlResponse.GetBytesAsync().ConfigureAwait(false);`,
    );
  } else if (m.response?.kind === "text" && responseType === "string") {
    lines.push(
      `${pad}return await flurlResponse.GetStringAsync().ConfigureAwait(false);`,
    );
  } else if (m.response?.kind === "text") {
    lines.push(
      `${pad}return ClientRuntime.FromText<${responseType}>(await flurlResponse.GetStringAsync().ConfigureAwait(false)${m.response.encoding ? `, ClientRuntime.WireEncoding.${m.response.encoding}` : ""});`,
    );
  } else if (m.response?.kind === "negotiated") {
    lines.push(
      `${pad}return await ClientRuntime.ReadJsonOrTextAsync<${responseType}>(flurlResponse).ConfigureAwait(false);`,
    );
  }
  return lines;
}

/**
 * Renders the class members for one method. The overload with every type parameter
 * the method has carries the implementation, and each other overload forwards to
 * it, filling in the declared types for the type parameters it does not take.
 *
 * @param m - The method view.
 * @returns The rendered members, indented for placement inside a class.
 */
function renderClientMethod(m: MethodView): string {
  const inherit = "    /// <inheritdoc />";
  const overloads = overloadsOf(m);
  const full = overloads[overloads.length - 1];
  const declared = (p: OverloadParameter): string =>
    p === "TResult" ? m.generic!.constraint : m.bodyGeneric!.constraint;
  const members = overloads.slice(0, -1).map((parameters) => {
    const signature = overloadSignature(m, parameters, "public ");
    const typeArguments = full.map((p) =>
      parameters.includes(p) ? p : declared(p),
    );
    return [
      inherit,
      ...signature.slice(0, -1),
      `${signature[signature.length - 1]} =>`,
      `        ${m.methodName}<${typeArguments.join(", ")}>(${m.argsText});`,
    ].join("\n");
  });
  members.push(
    [
      inherit,
      ...overloadSignature(m, full, "public async "),
      "    {",
      ...renderRequestBody(
        m,
        full.includes("TResult")
          ? m.generic!.responseType
          : (m.response?.type ?? ""),
      ),
      "    }",
    ].join("\n"),
  );
  return members.join("\n\n");
}

/**
 * Renders the interface declaration of a paging wrapper method.
 *
 * @param m - The paging method view.
 * @returns The rendered member, indented for placement inside an interface.
 */
function renderPagingInterfaceMethod(m: PagingMethodView): string {
  const params = `${m.paramsText}, ${fx("CancellationToken")} cancellationToken = default`;
  const remarks =
    m.strategy === "nextLink"
      ? [
          "<remarks>",
          "Follows each page's next link until none remains. A next link must stay on the",
          "origin (scheme, host, and port) of the client's base URL: one that points anywhere",
          `else throws <see cref="${fx("InvalidOperationException")}"/> before any request is sent,`,
          "so neither the operation's headers nor the client's own credentials reach another host.",
          "</remarks>",
        ]
      : [];
  return [
    ...renderDocLines(
      m.doc,
      remarks,
      // Plain code text, not `<see cref="...">`: the raw method can have a
      // second, generic overload (any response holding a named model gets
      // one — see endpoint-interface.hbs), which makes a bare, unqualified
      // cref to its name ambiguous (CS0419) once XML docs are generated.
      `Retrieves every item across all pages of <c>${m.rawMethodName}</c>.`,
    ),
    `    ${fx("IAsyncEnumerable", "generic")}<${m.itemType}> ${m.methodName}(${params});`,
  ].join("\n");
}

/**
 * Renders the statements that replay the raw method's header and cookie
 * bindings onto a manually-built Flurl request — needed only for a `nextLink`
 * continuation request, which goes through `_client` directly rather than the
 * raw method, so none of its own bindings (auth, tenant, API-version, ...)
 * would otherwise reach page two onward.
 *
 * @param m - The paging method view.
 * @param requestVar - The local variable holding the Flurl request to apply them to.
 * @returns The statements, indented for placement inside the wrapper method body.
 */
function renderReplayedHeadersAndCookies(
  m: PagingMethodView,
  requestVar: string,
): string[] {
  const lines: string[] = [];
  for (const h of m.headerParams ?? []) {
    lines.push(
      `            ${h.guard ? `if (${h.variable} is not null) ` : ""}${requestVar}.WithHeader("${escapeCsString(h.name)}", ClientRuntime.ToWireString(${h.value ?? h.variable}));`,
    );
  }
  for (const c of m.cookieParams ?? []) {
    lines.push(
      `            ${c.guard ? `if (${c.variable} is not null) ` : ""}${requestVar}.WithCookie("${escapeCsString(c.name)}", ClientRuntime.ToWireString(${c.value ?? c.variable}));`,
    );
  }
  return lines;
}

/**
 * Renders the statement that ends the loop on a `null` page, which the raw method
 * returns for a declared bodyless success (`PagedResult<Store> | void`) — reading
 * its items would throw. Nothing is rendered when the raw method never returns `null`.
 *
 * @param m - The paging method view.
 * @param pageVar - The local variable holding the page.
 * @param indent - The indentation of the surrounding statements.
 * @returns The statement, or nothing.
 */
function renderNullPageGuard(
  m: PagingMethodView,
  pageVar: string,
  indent: string,
): string[] {
  return m.pageNullable
    ? [`${indent}if (${pageVar} is null) yield break;`]
    : [];
}

/**
 * Renders the loop body statements for the `nextLink` strategy: reads the raw
 * method's page, then follows the response's next-page link directly through
 * `_client` (bypassing the raw method, since `nextLink` is an opaque absolute URL
 * the raw method's own route cannot express) until none remains.
 *
 * @param m - The paging method view.
 * @returns The statements, indented for placement inside the wrapper method body.
 */
function renderNextLinkPagingBody(m: PagingMethodView): string[] {
  const page = m.pageVarName;
  const item = m.itemVarName;
  const nextLink = m.nextLinkVarName!;
  const baseUri = m.baseUriVarName!;
  const nextUri = m.nextUriVarName!;
  const nextRequest = m.nextRequestVarName!;
  const nextPage = m.nextPageVarName!;
  const uri = fx("Uri");
  const invalidOperation = fx("InvalidOperationException");
  return [
    `        var ${page} = await ${m.rawMethodName}(${m.argsText}).ConfigureAwait(false);`,
    ...renderNullPageGuard(m, page, "        "),
    `        foreach (var ${item} in ${page}.${m.itemsPropertyName})`,
    `        {`,
    `            cancellationToken.ThrowIfCancellationRequested();`,
    `            yield return ${item};`,
    `        }`,
    ``,
    `        var ${nextLink} = ${page}.${m.nextLinkPropertyName};`,
    `        while (${m.nextLinkIsString ? `!string.IsNullOrEmpty(${nextLink})` : `${nextLink} is not null`})`,
    `        {`,
    // The next link is server-controlled, and this client carries credentials of
    // its own (default headers, handlers) besides the operation's headers, so a
    // link to another origin is refused before anything is sent. `BaseUrl` is
    // the base in both the DI and the `Create(baseUrl)` paths; `HttpClient.BaseAddress`
    // is not set by the latter.
    `            var ${baseUri} = string.IsNullOrEmpty(_client.BaseUrl)`,
    `                ? throw new ${invalidOperation}("Cannot follow a next-page link without a base URL to check its origin against.")`,
    `                : new ${uri}(_client.BaseUrl, ${fx("UriKind")}.Absolute);`,
    `            var ${nextUri} = new ${uri}(${baseUri}, ${nextLink});`,
    `            if (${uri}.Compare(${nextUri}, ${baseUri}, ${fx("UriComponents")}.SchemeAndServer, ${fx("UriFormat")}.UriEscaped, ${fx("StringComparison")}.OrdinalIgnoreCase) != 0)`,
    `            {`,
    `                throw new ${invalidOperation}($"Refusing to follow a next-page link to {${nextUri}.GetLeftPart(${fx("UriPartial")}.Authority)}, a different origin than the client's base URL.");`,
    `            }`,
    `            var ${nextRequest} = _client.Request(${nextUri}.AbsoluteUri);`,
    // The raw method's own header/cookie bindings (auth, tenant, API-version,
    // ...) are replayed by hand, since following nextLink bypasses it entirely.
    ...renderReplayedHeadersAndCookies(m, nextRequest),
    `            var ${nextPage} = await ${nextRequest}.GetJsonAsync<${m.pageType}>(cancellationToken: cancellationToken).ConfigureAwait(false);`,
    `            if (${nextPage} is null) yield break;`,
    `            foreach (var ${item} in ${nextPage}.${m.itemsPropertyName})`,
    `            {`,
    `                cancellationToken.ThrowIfCancellationRequested();`,
    `                yield return ${item};`,
    `            }`,
    `            ${nextLink} = ${nextPage}.${m.nextLinkPropertyName};`,
    `        }`,
  ];
}

/**
 * Renders the loop body statements for the `continuationToken` strategy: an
 * ordinary request parameter, so the loop re-calls the raw method with the
 * previous response's token substituted in, stopping once the response's token
 * is empty.
 *
 * @param m - The paging method view.
 * @returns The statements, indented for placement inside the wrapper method body.
 */
function renderContinuationTokenPagingBody(m: PagingMethodView): string[] {
  const page = m.pageVarName;
  const item = m.itemVarName;
  const token = m.tokenVarName!;
  return [
    // Declared as `string?` so a required token parameter (`string`) can still
    // take the response's nullable token without a nullable warning.
    `        string? ${token} = ${m.continuationTokenSeedExpression};`,
    `        do`,
    `        {`,
    `            var ${page} = await ${m.rawMethodName}(${m.argsText}).ConfigureAwait(false);`,
    ...renderNullPageGuard(m, page, "            "),
    `            foreach (var ${item} in ${page}.${m.itemsPropertyName})`,
    `            {`,
    `                cancellationToken.ThrowIfCancellationRequested();`,
    `                yield return ${item};`,
    `            }`,
    `            ${token} = ${page}.${m.continuationTokenPropertyName};`,
    `        } while (!string.IsNullOrEmpty(${token}));`,
  ];
}

/**
 * Renders the loop body statements for the `offset` / `pageIndex` strategy: also
 * an ordinary request parameter, so the loop re-calls the raw method with the
 * counter advanced (by received item count for `offset`, by one for `pageIndex`).
 * There is no total-count signal in the paging metadata, so an empty page is the
 * only reliable stop condition.
 *
 * @param m - The paging method view.
 * @returns The statements, indented for placement inside the wrapper method body.
 */
function renderCounterPagingBody(m: PagingMethodView): string[] {
  const page = m.pageVarName;
  const item = m.itemVarName;
  const count = m.countVarName!;
  // Checked, so a counter narrower than the position it must reach (a `uint8` offset
  // past 255) throws instead of wrapping around and reading earlier pages again.
  const advance =
    m.strategy === "pageIndex"
      ? `checked { ${m.counterVarName}++; }`
      : `checked { ${m.counterVarName} += (${m.counterCsType})${count}; }`;
  return [
    `        var ${m.counterVarName} = ${m.counterSeedExpression};`,
    `        while (true)`,
    `        {`,
    `            var ${page} = await ${m.rawMethodName}(${m.argsText}).ConfigureAwait(false);`,
    ...renderNullPageGuard(m, page, "            "),
    `            var ${count} = 0;`,
    `            foreach (var ${item} in ${page}.${m.itemsPropertyName})`,
    `            {`,
    `                cancellationToken.ThrowIfCancellationRequested();`,
    `                ${count}++;`,
    `                yield return ${item};`,
    `            }`,
    `            if (${count} == 0) yield break;`,
    `            ${advance}`,
    `        }`,
  ];
}

/**
 * Renders the client implementation of a paging wrapper method: its signature
 * (matching the interface declaration) and, dispatched on {@link PagingMethodView.strategy},
 * the loop body appropriate to that strategy.
 *
 * @param m - The paging method view.
 * @returns The rendered member, indented for placement inside the endpoint client class.
 */
function renderPagingClientMethod(m: PagingMethodView): string {
  const params = `${m.paramsText}, [${fx("EnumeratorCancellation", "attribute")}] ${fx("CancellationToken")} cancellationToken = default`;
  const lines = [
    "    /// <inheritdoc />",
    `    public async ${fx("IAsyncEnumerable", "generic")}<${m.itemType}> ${m.methodName}(${params})`,
    "    {",
  ];
  switch (m.strategy) {
    case "nextLink":
      lines.push(...renderNextLinkPagingBody(m));
      break;
    case "continuationToken":
      lines.push(...renderContinuationTokenPagingBody(m));
      break;
    case "offset":
    case "pageIndex":
      lines.push(...renderCounterPagingBody(m));
      break;
  }
  lines.push("    }");
  return lines.join("\n");
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
      const methodBlocks = [
        ...view.methods.map(renderInterfaceMethod),
        ...view.pagingMethods.map(renderPagingInterfaceMethod),
      ];
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
      const methodBlocks = [
        ...view.methods.map(renderClientMethod),
        ...view.pagingMethods.map(renderPagingClientMethod),
      ];
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
