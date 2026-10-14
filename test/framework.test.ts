import { ok, strictEqual } from "node:assert";
import { afterEach, describe, it } from "node:test";
import {
  FRAMEWORK_TYPES,
  fx,
  qualifyTemplate,
  setGeneratedTypeNames,
} from "../src/framework.js";
import { emit, fileContent } from "./host.js";

const PREAMBLE = `
  import "@typespec/http";
  using Http;

  @service(#{ title: "Test API" })
  namespace TestApi;
`;

describe("fx", () => {
  afterEach(() => setGeneratedTypeNames([]));

  it("writes a framework type by its simple name when nothing hides it", () => {
    setGeneratedTypeNames(["Widget"]);

    strictEqual(fx("CancellationToken"), "CancellationToken");
  });

  it("writes it in full from the global namespace when a generated type hides it", () => {
    setGeneratedTypeNames(["CancellationToken"]);

    strictEqual(
      fx("CancellationToken"),
      "global::System.Threading.CancellationToken",
    );
  });

  it("picks the generic namespace for a type used with type arguments", () => {
    setGeneratedTypeNames(["IEnumerable"]);

    strictEqual(
      fx("IEnumerable", "generic"),
      "global::System.Collections.Generic.IEnumerable",
    );
    strictEqual(fx("IEnumerable"), "global::System.Collections.IEnumerable");
  });

  it("qualifies an attribute hidden by either of its names", () => {
    for (const hidden of ["JsonPropertyName", "JsonPropertyNameAttribute"]) {
      setGeneratedTypeNames([hidden]);

      strictEqual(
        fx("JsonPropertyName", "attribute"),
        "global::System.Text.Json.Serialization.JsonPropertyName",
        hidden,
      );
    }
  });

  it("qualifies a root namespace a generated type hides", () => {
    setGeneratedTypeNames(["System"]);

    strictEqual(fx("System"), "global::System");
  });

  it("returns a name it does not know as it is", () => {
    setGeneratedTypeNames(["Widget"]);

    strictEqual(fx("Widget"), "Widget");
  });
});

describe("qualifyTemplate", () => {
  const q = (source: string): string => qualifyTemplate(source);

  it("routes a framework type in code through the helper", () => {
    strictEqual(
      q("public Type Get(CancellationToken token);"),
      'public {{fx "Type"}} Get({{fx "CancellationToken"}} token);',
    );
  });

  it("marks a type used with type arguments, and an attribute", () => {
    strictEqual(
      q('[JsonPropertyName("x")] public List<int> Items { get; }'),
      '[{{fx "JsonPropertyName" "attribute"}}("x")] public {{fx "List" "generic"}}<int> Items { get; }',
    );
  });

  it("leaves members, qualified names, and larger identifiers alone", () => {
    for (const source of [
      "value.Type",
      "global::System.Type",
      "MyType x;",
      "{{enumName}}JsonConverter",
      "JsonConverter{{suffix}}",
    ]) {
      strictEqual(q(source), source, source);
    }
  });

  it("leaves a member being declared or assigned alone", () => {
    strictEqual(
      q("public IFlurlClient FlurlClient { get; }"),
      'public {{fx "IFlurlClient"}} FlurlClient { get; }',
    );
    strictEqual(q("FlurlClient = client;"), "FlurlClient = client;");
  });

  it("still treats a type in a base list or after new as a type", () => {
    strictEqual(
      q("class F : JsonConverterFactory\n{"),
      'class F : {{fx "JsonConverterFactory"}}\n{',
    );
    strictEqual(
      q("var c = new HttpClient { };"),
      'var c = new {{fx "HttpClient"}} { };',
    );
    strictEqual(
      q("var m = e as MemberExpression;"),
      'var m = e as {{fx "MemberExpression"}};',
    );
  });

  it("leaves strings, comments, and Handlebars alone, but not a cref or an interpolation hole", () => {
    strictEqual(q('var s = "Type";'), 'var s = "Type";');
    strictEqual(q('var s = @"Type ""x""";'), 'var s = @"Type ""x""";');
    strictEqual(q("// a Type here\n"), "// a Type here\n");
    strictEqual(q("{{!-- a Type --}}"), "{{!-- a Type --}}");
    strictEqual(q("{{#if Type}}"), "{{#if Type}}");
    strictEqual(
      q('/// See <see cref="FlurlClient.Dispose"/>.\n'),
      '/// See <see cref="{{fx "FlurlClient"}}.Dispose"/>.\n',
    );
    strictEqual(
      q('var s = $"{typeof(Type).Name} {{name}}";'),
      'var s = $"{typeof({{fx "Type"}}).Name} {{name}}";',
    );
  });

  it("knows every name it writes", () => {
    const out = q(
      Object.keys(FRAMEWORK_TYPES)
        .map((name) => `${name} x;`)
        .join("\n"),
    );
    strictEqual(
      (out.match(/\{\{fx /g) ?? []).length,
      Object.keys(FRAMEWORK_TYPES).length,
    );
  });
});

describe("models named after framework types", () => {
  it("leave the generated code alone when no name is taken", async () => {
    const results = await emit(`${PREAMBLE}
      model Widget { id: string; at: utcDateTime; }
      @route("/w") interface Widgets { @get read(): Widget; }
    `);

    ok(!Object.values(results).some((c) => c.includes("global::")));
  });

  it("qualify each framework type a model hides, everywhere it is used", async () => {
    const results = await emit(`${PREAMBLE}
      model \`Type\` { v: string; }
      model \`CancellationToken\` { v: string; }
      model \`Uri\` { v: string; }
      model Widget { link: url; kind: \`Type\`; }
      @route("/w") interface Widgets { @get read(): Widget; @delete remove(): void; }
    `);

    const iface = fileContent(results, "IWidgets.g.cs");
    ok(
      iface.includes(
        "global::System.Threading.CancellationToken cancellationToken = default",
      ),
      iface,
    );
    const widget = fileContent(results, "/Widget.g.cs");
    ok(widget.includes("public global::System.Uri Link"), widget);
    ok(widget.includes("public Type Kind"), widget);
    ok(
      fileContent(results, "ClientRuntime.g.cs").includes(
        "global::System.Type",
      ),
    );
  });
});
