import { strictEqual } from "node:assert";
import { describe, it } from "node:test";
import { BaseTester } from "./host.js";

/**
 * An exhaustive check that the `internal-access-leak` rule and the emitter agree.
 *
 * Every place a type can appear in a spec is tried with an internal type in it. For
 * each case, three answers must match:
 *
 * - the rule: does it report the case?
 * - the output: does a public generated C# type name the internal type outside an
 *   attribute? That is exactly what makes C# fail with CS0053 or CS0060, so it is
 *   the ground truth, worked out from the files rather than from the rule's logic.
 * - the expectation written beside the case.
 *
 * A case the rule misses would ship code that does not compile; a case it reports
 * wrongly would push a user to change a spec that was fine.
 */

const PREAMBLE = `
  import "@typespec/http";
  import "@massivescale/tsp-flurl-client";
  using Http;
  using MassiveScale.TspFlurlClient;

  @service(#{ title: "Audit" })
  namespace Audit;

  @access(Access.internal) model Secret { value: string; }
  @access(Access.internal) enum Hidden { a, b }
  @access(Access.internal) model Vault<T> { item: T; }
  @access(Access.internal) @discriminator("kind") model InternalBase { kind: string; }
  @access(Access.internal) model PlainBase { value: string; }
  model Open { id: string; }
  model Page<T> { items: T[]; }
  @error model Problem { code: int32; }
`;

/** Internal type names, and the request records generated from them. */
const INTERNAL =
  /\b(Secret|Hidden|Vault|InternalBase)(CreateRequest|UpdateRequest|ReplaceRequest)?\b/;

/** A public operation or model, and whether a public C# signature then names an internal type. */
type Case = [name: string, spec: string, exposed: boolean];

/** A public interface holding one operation, so only the operation can leak. */
const op = (signature: string): string =>
  `@route("/ops") interface Ops { ${signature} }`;

/** A public model that only an internal interface returns, so only the model can leak. */
const holder = (body: string): string => `
  model Holder ${body}
  @access(Access.internal) @route("/hidden") interface InternalOps { @get read(): Holder; }
`;

const CASES: Case[] = [
  [
    "a query parameter of an internal enum",
    op(`@get q(@query h: Hidden): void;`),
    true,
  ],
  [
    "a header parameter of an internal enum",
    op(`@get h(@header h: Hidden): void;`),
    true,
  ],
  [
    "a path parameter of an internal enum",
    op(`@get p(@path h: Hidden): void;`),
    true,
  ],
  [
    "a cookie parameter of an internal enum",
    op(`@get c(@cookie h: Hidden): void;`),
    true,
  ],
  [
    "a body of an internal model",
    op(`@post b(@body body: Secret): void;`),
    true,
  ],
  [
    "a list body of an internal model",
    op(`@post b(@body body: Secret[]): void;`),
    true,
  ],
  [
    "a dictionary body of an internal model",
    op(`@post b(@body body: Record<Secret>): void;`),
    true,
  ],
  [
    "an optional body of an internal model",
    op(`@post b(@body body?: Secret): void;`),
    true,
  ],
  [
    "a nullable body of an internal model",
    op(`@post b(@body body: Secret | null): void;`),
    true,
  ],
  [
    "a merge-patch body of an internal model",
    op(`@patch b(@body body: MergePatchUpdate<Secret>): void;`),
    true,
  ],
  [
    "a body of a public template with an internal argument",
    op(`@post b(@body body: Page<Secret>): void;`),
    true,
  ],
  [
    "a body of an internal template with a public argument",
    op(`@post b(@body body: Vault<Open>): void;`),
    true,
  ],
  [
    "spread parameters of an internal model",
    op(`@post s(...Secret): void;`),
    false,
  ],
  ["a return of an internal model", op(`@get r(): Secret;`), true],
  ["a list return of an internal model", op(`@get r(): Secret[];`), true],
  [
    "a dictionary return of an internal model",
    op(`@get r(): Record<Secret>;`),
    true,
  ],
  ["a return of an internal enum", op(`@get r(): Hidden;`), true],
  [
    "a return of an internal model or nothing",
    op(`@get r(): Secret | void;`),
    true,
  ],
  [
    "a return of an internal model beside an @error model",
    op(`@get r(): Secret | Problem;`),
    true,
  ],
  [
    "a return of an internal model in a response wrapper",
    op(`@get r(): { @body b: Secret };`),
    true,
  ],
  ["a return of an internal template", op(`@get r(): Vault<string>;`), true],
  [
    "a return of a public template with an internal argument",
    op(`@get r(): Page<Secret>;`),
    true,
  ],
  [
    "a return union of two models under one status",
    op(`@get r(): { @body b: Secret | Open };`),
    false,
  ],
  [
    "different success bodies, returned as a JsonElement",
    op(
      `@get r(): { @statusCode _: 200; @body b: Secret } | { @statusCode _: 201; @body b: Open };`,
    ),
    false,
  ],
  [
    "only an @error response of an internal model",
    op(`@get r(): void | { @statusCode _: 404; @body b: Secret };`),
    false,
  ],
  [
    "a response header of an internal enum",
    op(`@get r(): { @header h: Hidden };`),
    false,
  ],
  [
    "an operation in an internal interface",
    `@access(Access.internal) @route("/i") interface Hid { @get r(): Secret; }`,
    false,
  ],
  [
    "a namespace-level operation returning an internal model",
    `@route("/n") @get op standalone(): Secret;`,
    true,
  ],
  ["a property of an internal model", holder(`{ s: Secret; }`), true],
  ["a list property of an internal model", holder(`{ s: Secret[]; }`), true],
  [
    "a dictionary property of an internal model",
    holder(`{ s: Record<Secret>; }`),
    true,
  ],
  [
    "an optional property of an internal model",
    holder(`{ s?: Secret; }`),
    true,
  ],
  [
    "a nullable property of an internal model",
    holder(`{ s: Secret | null; }`),
    true,
  ],
  ["a property of an internal enum", holder(`{ h: Hidden; }`), true],
  [
    "a property of a public template with an internal argument",
    holder(`{ p: Page<Secret>; }`),
    true,
  ],
  [
    "a read-only property of an internal model",
    holder(`{ @visibility(Lifecycle.Read) s: Secret; }`),
    true,
  ],
  [
    "a union property of two models, held as a JsonElement",
    holder(`{ u: Secret | Open; }`),
    false,
  ],
  [
    "a subtype of an internal discriminated base",
    holder(`extends InternalBase { kind: "holder"; }`),
    true,
  ],
  [
    "a model extending an internal base without a discriminator",
    holder(`extends PlainBase { extra: string; }`),
    false,
  ],
  [
    "an internal model with an internal property",
    `@access(Access.internal) model Inner { s: Secret; } ${holder(`{ id: string; }`)}`,
    false,
  ],
];

/**
 * Whether any public generated C# type names an internal type. Attributes are left
 * out, since `[JsonDerivedType(typeof(InternalSubtype))]` on a public type is
 * allowed; so are comments.
 */
function exposesInternalType(outputs: Record<string, string>): string[] {
  const leaks: string[] = [];
  for (const [path, content] of Object.entries(outputs)) {
    if (!path.endsWith(".cs")) continue;
    const declaration =
      /^(public|internal)\s+(?:sealed\s+|abstract\s+|static\s+|partial\s+)*(?:record|class|interface|enum)\b/m.exec(
        content,
      );
    if (declaration?.[1] !== "public") continue;
    const code = content
      .split("\n")
      .filter((line) => !/^\s*(\/\/|\[|#)/.test(line))
      .join("\n");
    if (INTERNAL.test(code)) leaks.push(path);
  }
  return leaks;
}

describe("internal-access-leak agrees with the generated C#, in every position", () => {
  const tester = BaseTester.emit("@massivescale/tsp-flurl-client", {
    "dotnet-format": false,
  });

  for (const [name, spec, exposed] of CASES) {
    it(`${exposed ? "reports" : "accepts"} ${name}`, async () => {
      const [{ outputs }, diagnostics] = await tester.compileAndDiagnose(
        `${PREAMBLE}\n${spec}`,
        {
          compilerOptions: {
            linterRuleSet: {
              enable: {
                "@massivescale/tsp-flurl-client/internal-access-leak": true,
              },
            },
          },
        },
      );

      const errors = diagnostics.filter((d) => d.severity === "error");
      strictEqual(errors.length, 0, errors.map((d) => d.message).join("; "));
      const reported = diagnostics.some((d) =>
        d.code.endsWith("internal-access-leak"),
      );
      const leaks = exposesInternalType(outputs);

      strictEqual(
        leaks.length > 0,
        exposed,
        `generated C#: ${leaks.join(", ") || "no public type names an internal type"}`,
      );
      strictEqual(
        reported,
        exposed,
        `rule: ${diagnostics.map((d) => d.message).join("; ") || "nothing reported"}`,
      );
    });
  }
});
