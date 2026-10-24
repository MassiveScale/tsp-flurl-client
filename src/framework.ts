// The framework types the generated C# names, and how each is written so a
// generated type of the same name cannot hide it. This module is a leaf: it
// imports nothing, so any other module can depend on it.

/**
 * Every framework type the generated C# names without its namespace, with that
 * namespace. A generated type with one of these names (a model called `Type`,
 * `Uri`, or `CancellationToken`) would hide it in the namespace the generated code
 * shares with it, so every reference is written through {@link fx}, which
 * qualifies it there.
 *
 * The compile matrix (`npm run matrix`) lists the framework types the generated
 * code actually names and fails when one is missing here, and it declares a model
 * named after each one to prove the qualification works.
 */
export const FRAMEWORK_TYPES: Readonly<Record<string, string>> = {
  Action: "System",
  Activator: "System",
  ArgumentException: "System",
  ArgumentNullException: "System",
  BindingFlags: "System.Reflection",
  ByteArrayContent: "System.Net.Http",
  CancellationToken: "System.Threading",
  CodePagesEncodingProvider: "System.Text",
  Convert: "System",
  CultureInfo: "System.Globalization",
  DateOnly: "System",
  DateTime: "System",
  DateTimeOffset: "System",
  DateTimeStyles: "System.Globalization",
  DefaultJsonSerializer: "Flurl.Http.Configuration",
  DefaultJsonTypeInfoResolver: "System.Text.Json.Serialization.Metadata",
  Dictionary: "System.Collections.Generic",
  Encoding: "System.Text",
  Enum: "System",
  EnumMemberAttribute: "System.Runtime.Serialization",
  EnumeratorCancellationAttribute: "System.Runtime.CompilerServices",
  ExcludeFromCodeCoverageAttribute: "System.Diagnostics.CodeAnalysis",
  Expression: "System.Linq.Expressions",
  FlurlClient: "Flurl.Http",
  FlurlRequest: "Flurl.Http",
  FlurlResponse: "Flurl.Http",
  FormatException: "System",
  Func: "System",
  Guid: "System",
  Half: "System",
  HttpClient: "System.Net.Http",
  HttpClientHandler: "System.Net.Http",
  HttpContent: "System.Net.Http",
  HttpMethod: "System.Net.Http",
  IEnumerable: "System.Collections",
  IFlurlClient: "Flurl.Http",
  IFlurlRequest: "Flurl.Http",
  IFlurlResponse: "Flurl.Http",
  IAsyncEnumerable: "System.Collections.Generic",
  IFormattable: "System",
  IHttpClientBuilder: "Microsoft.Extensions.DependencyInjection",
  IHttpClientFactory: "System.Net.Http",
  IReadOnlyDictionary: "System.Collections.Generic",
  IServiceCollection: "Microsoft.Extensions.DependencyInjection",
  IServiceProvider: "System",
  InvalidOperationException: "System",
  JsonConverter: "System.Text.Json.Serialization",
  JsonConverterAttribute: "System.Text.Json.Serialization",
  JsonConverterFactory: "System.Text.Json.Serialization",
  JsonDerivedType: "System.Text.Json.Serialization.Metadata",
  JsonDerivedTypeAttribute: "System.Text.Json.Serialization",
  JsonDocument: "System.Text.Json",
  JsonElement: "System.Text.Json",
  JsonException: "System.Text.Json",
  JsonExtensionDataAttribute: "System.Text.Json.Serialization",
  JsonIgnoreAttribute: "System.Text.Json.Serialization",
  JsonIgnoreCondition: "System.Text.Json.Serialization",
  JsonNumberHandling: "System.Text.Json.Serialization",
  JsonNumberHandlingAttribute: "System.Text.Json.Serialization",
  JsonPolymorphicAttribute: "System.Text.Json.Serialization",
  JsonPolymorphismOptions: "System.Text.Json.Serialization.Metadata",
  JsonPropertyNameAttribute: "System.Text.Json.Serialization",
  JsonSerializer: "System.Text.Json",
  JsonSerializerDefaults: "System.Text.Json",
  JsonSerializerOptions: "System.Text.Json",
  JsonTokenType: "System.Text.Json",
  JsonTypeInfo: "System.Text.Json.Serialization.Metadata",
  JsonTypeInfoKind: "System.Text.Json.Serialization.Metadata",
  JsonValueKind: "System.Text.Json",
  List: "System.Collections.Generic",
  MediaTypeHeaderValue: "System.Net.Http.Headers",
  MemberExpression: "System.Linq.Expressions",
  NotSupportedException: "System",
  Nullable: "System",
  NumberStyles: "System.Globalization",
  Object: "System",
  PropertyInfo: "System.Reflection",
  String: "System",
  StringComparer: "System",
  StringComparison: "System",
  Task: "System.Threading.Tasks",
  TimeOnly: "System",
  TimeSpan: "System",
  Type: "System",
  UnaryExpression: "System.Linq.Expressions",
  Uri: "System",
  UriComponents: "System",
  UriFormat: "System",
  UriKind: "System",
  UriPartial: "System",
  Utf8JsonReader: "System.Text.Json",
  Utf8JsonWriter: "System.Text.Json",
  XmlConvert: "System.Xml",
};

/**
 * The namespace of a framework type used with type arguments, where it differs
 * from the namespace of the type of the same name without them: `IEnumerable<T>`
 * is `System.Collections.Generic`, `IEnumerable` is `System.Collections`.
 */
const GENERIC_NAMESPACES: Readonly<Record<string, string>> = {
  IEnumerable: "System.Collections.Generic",
};

/**
 * The root namespaces the generated C# names directly (`System.Type`), which a
 * generated type called `System` would hide.
 */
const ROOT_NAMESPACES = new Set(["System", "Flurl", "Microsoft"]);

/** How a framework name is used: as a type, with type arguments, or as an attribute. */
export type FrameworkUse = "type" | "generic" | "attribute";

/** The names of the types the emitter is generating, which hide framework types of the same name. */
let generatedNames = new Set<string>();

/**
 * Sets the names of the types the emitter generates for one service: its models,
 * enums, endpoint types, client, and the type parameters of its generic models.
 * Until the next call, {@link fx} qualifies every framework type one of them hides.
 *
 * @param names - The generated C# type names.
 */
export function setGeneratedTypeNames(names: Iterable<string>): void {
  generatedNames = new Set(names);
}

/**
 * Writes a framework type the generated code uses: by its simple name, as the
 * code reads best, unless a generated type of the same name would hide it, in
 * which case it is written in full from the global namespace
 * (`global::System.Threading.CancellationToken`). A name the registry does not
 * know is returned as it is.
 *
 * @param name - The simple name: `Uri`, `List`, `JsonPropertyName` for an attribute,
 *   or a root namespace such as `System`.
 * @param use - How it is used, which picks the namespace for a name that has more
 *   than one, and which names hide an attribute (`X` and `XAttribute`).
 * @returns The name to write.
 */
export function fx(name: string, use: FrameworkUse = "type"): string {
  if (ROOT_NAMESPACES.has(name)) {
    return generatedNames.has(name) ? `global::${name}` : name;
  }
  const namespace =
    use === "attribute"
      ? FRAMEWORK_TYPES[`${name}Attribute`]
      : use === "generic"
        ? (GENERIC_NAMESPACES[name] ?? FRAMEWORK_TYPES[name])
        : FRAMEWORK_TYPES[name];
  if (namespace === undefined) return name;
  const hidden =
    generatedNames.has(name) ||
    (use === "attribute" && generatedNames.has(`${name}Attribute`));
  return hidden ? `global::${namespace}.${name}` : name;
}

/**
 * Rewrites the C# in a template so every framework type it names goes through
 * {@link fx}: `CancellationToken` becomes `{{fx "CancellationToken"}}`. Comments,
 * string literals (but not the holes of interpolated strings), and Handlebars
 * expressions are left as they are, and so is a name after `.` or `::` (a member,
 * or a name already qualified).
 *
 * @param source - The template source.
 * @returns The template source with framework names routed through the `fx` helper.
 */
export function qualifyTemplate(source: string): string {
  let out = "";
  let i = 0;
  const n = source.length;
  const copyUntil = (end: string, from: number): number => {
    const at = source.indexOf(end, from);
    const stop = at < 0 ? n : at + end.length;
    out += source.slice(i, stop);
    return stop;
  };

  /**
   * Copies a string literal starting at `i`, processing the holes of an
   * interpolated one as code.
   */
  const copyString = (interpolated: boolean, verbatim: boolean): void => {
    out += source[i++];
    while (i < n) {
      const c = source[i];
      if (source.startsWith("{{", i)) {
        i = copyUntil("}}", i);
        continue;
      }
      if (!verbatim && c === "\\") {
        out += source.slice(i, i + 2);
        i += 2;
        continue;
      }
      if (c === '"') {
        if (verbatim && source[i + 1] === '"') {
          out += '""';
          i += 2;
          continue;
        }
        out += c;
        i++;
        return;
      }
      if (interpolated && c === "{") {
        out += c;
        i++;
        code("}");
        continue;
      }
      out += c;
      i++;
    }
  };

  /** Processes code until `close` (a hole's `}`), or to the end. */
  const code = (close?: string): void => {
    let depth = 0;
    while (i < n) {
      const c = source[i];
      if (source.startsWith("{{!--", i)) {
        i = copyUntil("--}}", i);
        continue;
      }
      if (source.startsWith("{{", i)) {
        i = copyUntil(source.startsWith("{{{", i) ? "}}}" : "}}", i);
        continue;
      }
      if (close && c === "{") depth++;
      if (close && c === "}") {
        if (depth === 0) {
          out += c;
          i++;
          return;
        }
        depth--;
      }
      if (source.startsWith("//", i)) {
        // A comment is left as it is, except the type a `cref` starts with, which a
        // generated type of the same name would otherwise take over.
        const end = source.indexOf("\n", i);
        const comment = source.slice(i, end < 0 ? n : end + 1);
        out += comment.replace(
          /cref="([A-Za-z_]\w*)/g,
          (match: string, name: string) =>
            name in FRAMEWORK_TYPES || ROOT_NAMESPACES.has(name)
              ? `cref="{{fx "${name}"}}`
              : match,
        );
        i += comment.length;
        continue;
      }
      if (source.startsWith("/*", i)) {
        i = copyUntil("*/", i);
        continue;
      }
      if (source.startsWith('$@"', i) || source.startsWith('@$"', i)) {
        out += source.slice(i, i + 2);
        i += 2;
        copyString(true, true);
        continue;
      }
      if (source.startsWith('$"', i)) {
        out += c;
        i++;
        copyString(true, false);
        continue;
      }
      if (source.startsWith('@"', i)) {
        out += c;
        i++;
        copyString(false, true);
        continue;
      }
      if (c === '"') {
        copyString(false, false);
        continue;
      }
      if (c === "'") {
        const end = source[i + 1] === "\\" ? i + 3 : i + 2;
        out += source.slice(i, end + 1);
        i = end + 1;
        continue;
      }
      const word = /^[A-Za-z_]\w*/.exec(source.slice(i, i + 64));
      if (word) {
        const name = word[0];
        const before = out.trimEnd();
        const next = source.slice(i + name.length).trimStart();
        // A name glued to a Handlebars expression (`{{enumName}}JsonConverter`) is
        // part of a larger identifier, not a framework type.
        const glued =
          out.endsWith("}}") || source.startsWith("{{", i + name.length);
        // A name being declared or assigned (`IFlurlClient FlurlClient { get; }`,
        // `FlurlClient = client;`) is a member, not a type. A declared property
        // follows its type; a type followed by `{` follows `new` or a base list
        // (`: JsonConverterFactory {`).
        const declared =
          (next.startsWith("{") &&
            !next.startsWith("{{") &&
            // The type before it may already be an `{{fx ...}}` expression.
            /([\w>?\]]|\}\})$/.test(before) &&
            !/\bnew$/.test(before)) ||
          /^=(?!=)/.test(next);
        const afterMember =
          glued ||
          declared ||
          before.endsWith(".") ||
          before.endsWith("::") ||
          /\w$/.test(out);
        const use: FrameworkUse = before.endsWith("[")
          ? "attribute"
          : next.startsWith("<")
            ? "generic"
            : "type";
        const known =
          use === "attribute"
            ? `${name}Attribute` in FRAMEWORK_TYPES
            : name in FRAMEWORK_TYPES || ROOT_NAMESPACES.has(name);
        out +=
          !afterMember && known
            ? `{{fx "${name}"${use === "type" ? "" : ` "${use}"`}}}`
            : name;
        i += name.length;
        continue;
      }
      out += c;
      i++;
    }
  };

  code();
  return out;
}
