/**
 * The cases of the compile matrix: every type shape in every position, every
 * `@encode` in every position, every media type, awkward names, visibility, and
 * discriminators. Each case is a few declarations and operations; a case TypeSpec
 * itself rejects is pruned by `run.mjs`, so the matrix is "everything TypeSpec
 * accepts".
 */

import { FRAMEWORK_TYPES } from "../dist/src/framework.js";

/**
 * @typedef {object} Case
 * @property {string} id - Unique, a valid identifier, and the operation's route.
 * @property {string} group - The interface its operations are declared in.
 * @property {string[]} decls - Declarations at namespace level.
 * @property {string[]} ops - Operation declarations, one per line.
 */

/** Declarations every case may use. */
export const SHARED = `
model Item { id: string; name: string; }
model Other { code: int32; }
model ReadOnlyItem { @visibility(Lifecycle.Read) id: string; name: string; }
model Wrapper { @visibility(Lifecycle.Read) id: string; child: ReadOnlyItem; children: ReadOnlyItem[]; maybe: ReadOnlyItem | null; }
@discriminator("kind") model Pet { kind: string; name: string; }
model Dog extends Pet { kind: "dog"; bark: boolean; }
model Cat extends Pet { kind: "cat"; @visibility(Lifecycle.Read) lives: int32; }
model Page<T> { items: T[]; next?: url; }
model Keyed<class> { key: string; value: class; }
model Tagged<T, U> { value: T; }
model Node { name: string; children: Node[]; }
enum Color { red, blue, \`dark-green\` }
enum Level { low: 1, high: 2 }
enum Ratio { half: 0.5, whole: 1.0 }
enum MixedEnum { a: "a", one: 1 }
union Shade { "light", "dark" }
scalar Sku extends string;
scalar Count extends int32;
@error model Problem { code: int32; message: string; }
`;

/** Type shapes, as `[id, TypeSpec type]`. */
const TYPES = [
  ["string", "string"],
  ["boolean", "boolean"],
  ["int8", "int8"],
  ["int16", "int16"],
  ["int32", "int32"],
  ["int64", "int64"],
  ["uint8", "uint8"],
  ["uint16", "uint16"],
  ["uint32", "uint32"],
  ["uint64", "uint64"],
  ["safeint", "safeint"],
  ["float32", "float32"],
  ["float64", "float64"],
  ["decimal", "decimal"],
  ["decimal128", "decimal128"],
  ["numeric", "numeric"],
  ["integer", "integer"],
  ["float", "float"],
  ["utcDateTime", "utcDateTime"],
  ["offsetDateTime", "offsetDateTime"],
  ["plainDate", "plainDate"],
  ["plainTime", "plainTime"],
  ["duration", "duration"],
  ["bytes", "bytes"],
  ["url", "url"],
  ["sku", "Sku"],
  ["count", "Count"],
  ["color", "Color"],
  ["level", "Level"],
  ["ratio", "Ratio"],
  ["mixedEnum", "MixedEnum"],
  ["shade", "Shade"],
  ["stringLiteral", `"lit"`],
  ["numberLiteral", "42"],
  ["booleanLiteral", "true"],
  ["stringUnion", `"a" | "b"`],
  ["scalarUnion", "string | int32"],
  ["modelUnion", "Item | Other"],
  ["nullableItem", "Item | null"],
  ["nullableString", "string | null"],
  ["nullableInt", "int32 | null"],
  ["item", "Item"],
  ["readOnlyItem", "ReadOnlyItem"],
  ["wrapper", "Wrapper"],
  ["pet", "Pet"],
  ["dog", "Dog"],
  ["pageOfItems", "Page<Item>"],
  ["pageOfStrings", "Page<string>"],
  ["keyed", "Keyed<Item>"],
  ["tagged", `Tagged<Item, "x">`],
  ["node", "Node"],
  ["anonymous", "{ a: string; b: int32 }"],
  ["recordOfStrings", "Record<string>"],
  ["recordOfItems", "Record<Item>"],
  ["items", "Item[]"],
  ["strings", "string[]"],
  ["ints", "int32[]"],
  ["nestedItems", "Item[][]"],
  ["nullableItems", "(Item | null)[]"],
  ["recordOfLists", "Record<Item[]>"],
  ["pets", "Pet[]"],
  ["dates", "utcDateTime[]"],
  ["colors", "Color[]"],
  ["unknown", "unknown"],
];

/** Positions a type can appear in, each building the operation for a case. */
const POSITIONS = {
  path: (id, t) => `@route("/${id}/{v}") @get ${id}(@path v: ${t}): void;`,
  query: (id, t) => `@route("/${id}") @get ${id}(@query v: ${t}): void;`,
  optionalQuery: (id, t) =>
    `@route("/${id}") @get ${id}(@query v?: ${t}): void;`,
  explodedQuery: (id, t) =>
    `@route("/${id}") @get ${id}(@query(#{ explode: true }) v: ${t}): void;`,
  header: (id, t) =>
    `@route("/${id}") @get ${id}(@header("x-v") v: ${t}): void;`,
  optionalHeader: (id, t) =>
    `@route("/${id}") @get ${id}(@header("x-v") v?: ${t}): void;`,
  cookie: (id, t) => `@route("/${id}") @get ${id}(@cookie v: ${t}): void;`,
  body: (id, t) => `@route("/${id}") @post ${id}(@body body: ${t}): void;`,
  optionalBody: (id, t) =>
    `@route("/${id}") @post ${id}(@body body?: ${t}): void;`,
  replaceBody: (id, t) =>
    `@route("/${id}") @put ${id}(@body body: ${t}): void;`,
  textBody: (id, t) =>
    `@route("/${id}") @post ${id}(@header contentType: "text/plain", @body body: ${t}): void;`,
  octetBody: (id, t) =>
    `@route("/${id}") @post ${id}(@header contentType: "application/octet-stream", @body body: ${t}): void;`,
  spreadBody: (id, t) => `@route("/${id}") @post ${id}(v: ${t}): void;`,
  response: (id, t) => `@route("/${id}") @get ${id}(): ${t};`,
  bodyResponse: (id, t) =>
    `@route("/${id}") @get ${id}(): { @body body: ${t} };`,
  textResponse: (id, t) =>
    `@route("/${id}") @get ${id}(): { @header contentType: "text/plain"; @body body: ${t} };`,
  octetResponse: (id, t) =>
    `@route("/${id}") @get ${id}(): { @header contentType: "application/octet-stream"; @body body: ${t} };`,
  responseOrNothing: (id, t) =>
    `@route("/${id}") @get ${id}(): { @body body: ${t} } | void;`,
  twoStatuses: (id, t) =>
    `@route("/${id}") @get ${id}(): { @statusCode _: 200; @body body: ${t} } | { @statusCode _: 201; @body body: ${t} };`,
  responseOrError: (id, t) => `@route("/${id}") @get ${id}(): ${t} | Problem;`,
  responseHeader: (id, t) =>
    `@route("/${id}") @get ${id}(): { @header("x-v") v: ${t} };`,
};

/** Every `@encode`, as `[id, decorator, type]`. */
const ENCODINGS = [
  ["rfc3339", "@encode(DateTimeKnownEncoding.rfc3339)", "utcDateTime"],
  ["rfc7231", "@encode(DateTimeKnownEncoding.rfc7231)", "utcDateTime"],
  ["rfc7231Offset", "@encode(DateTimeKnownEncoding.rfc7231)", "offsetDateTime"],
  [
    "unix64",
    "@encode(DateTimeKnownEncoding.unixTimestamp, int64)",
    "utcDateTime",
  ],
  [
    "unix32",
    "@encode(DateTimeKnownEncoding.unixTimestamp, int32)",
    "utcDateTime",
  ],
  ["iso8601", "@encode(DurationKnownEncoding.ISO8601)", "duration"],
  ["seconds32", "@encode(DurationKnownEncoding.seconds, int32)", "duration"],
  ["seconds64f", "@encode(DurationKnownEncoding.seconds, float64)", "duration"],
  [
    "millis64",
    "@encode(DurationKnownEncoding.milliseconds, int64)",
    "duration",
  ],
  [
    "millis32f",
    "@encode(DurationKnownEncoding.milliseconds, float32)",
    "duration",
  ],
  ["base64", "@encode(BytesKnownEncoding.base64)", "bytes"],
  ["base64url", "@encode(BytesKnownEncoding.base64url)", "bytes"],
  ["int64String", `@encode("string")`, "int64"],
  ["decimalString", `@encode("string")`, "decimal"],
  ["booleanString", `@encode("string")`, "boolean"],
  ["pipe", "@encode(ArrayEncoding.pipeDelimited)", "string[]"],
  ["space", "@encode(ArrayEncoding.spaceDelimited)", "string[]"],
  ["comma", "@encode(ArrayEncoding.commaDelimited)", "string[]"],
  ["newline", "@encode(ArrayEncoding.newlineDelimited)", "string[]"],
  ["pipeInts", "@encode(ArrayEncoding.pipeDelimited)", "int32[]"],
  ["custom", `@encode("custom")`, "string"],
];

/** Positions an encoded value can appear in. */
const ENCODED_POSITIONS = {
  property: (id, e, t) => ({
    decls: [
      `model ${id}Model { ${e} v: ${t}; ${e} o?: ${t}; ${e} n: ${t} | null; }`,
    ],
    ops: [
      `@route("/${id}/get") @get ${id}Get(): ${id}Model;`,
      `@route("/${id}/post") @post ${id}Post(@body body: ${id}Model): void;`,
      `@route("/${id}/patch") @patch ${id}Patch(@body body: MergePatchUpdate<${id}Model>): void;`,
    ],
  }),
  path: (id, e, t) => ({
    ops: [`@route("/${id}/{v}") @get ${id}(@path ${e} v: ${t}): void;`],
  }),
  query: (id, e, t) => ({
    ops: [`@route("/${id}") @get ${id}(@query ${e} v: ${t}): void;`],
  }),
  header: (id, e, t) => ({
    ops: [`@route("/${id}") @get ${id}(@header("x-v") ${e} v: ${t}): void;`],
  }),
  cookie: (id, e, t) => ({
    ops: [`@route("/${id}") @get ${id}(@cookie ${e} v: ${t}): void;`],
  }),
  textBody: (id, e, t) => ({
    ops: [
      `@route("/${id}") @post ${id}(@header contentType: "text/plain", @body ${e} body: ${t}): void;`,
    ],
  }),
  jsonBody: (id, e, t) => ({
    ops: [`@route("/${id}") @post ${id}(@body ${e} body: ${t}): void;`],
  }),
  textResponse: (id, e, t) => ({
    ops: [
      `@route("/${id}") @get ${id}(): { @header contentType: "text/plain"; @body ${e} body: ${t} };`,
    ],
  }),
  responseHeader: (id, e, t) => ({
    ops: [`@route("/${id}") @get ${id}(): { @header("x-v") ${e} v: ${t} };`],
  }),
};

/** Media types, crossed with payload types and directions. */
const MEDIA_TYPES = [
  ["json", "application/json"],
  ["vendorJson", "application/vnd.matrix+json"],
  ["mergePatch", "application/merge-patch+json"],
  ["text", "text/plain"],
  ["textUtf16", "text/plain; charset=utf-16"],
  ["csv", "text/csv"],
  ["octet", "application/octet-stream"],
  ["png", "image/png"],
  ["xml", "application/xml"],
  ["form", "application/x-www-form-urlencoded"],
  ["multipart", "multipart/form-data"],
  ["jsonOrXml", `"application/json" | "application/xml"`],
  ["jsonOrText", `"application/json" | "text/plain"`],
];

/** Payload types crossed with every media type. */
const MEDIA_PAYLOADS = [
  ["string", "string"],
  ["int32", "int32"],
  ["bytes", "bytes"],
  ["item", "Item"],
  ["items", "Item[]"],
];

/** Names that are awkward in C#: keywords, the generated code's own names, and non-identifiers. */
const AWKWARD_NAMES = [
  "class",
  "await",
  "var",
  "params",
  "event",
  "object",
  "string",
  "async",
  "value",
  "nameof",
  "namespace",
  "body",
  "cancellationToken",
  "additionalQueryParameters",
  "flurlRequest",
  "flurlResponse",
  "_client",
  "x-y",
  "café",
  "2fa",
  "v2",
  "EqualityContract",
  "ToString",
  "Equals",
  "GetType",
  "flurlClient",
  "Client",
  "ApplyModifiers",
  "AppendHeader",
  "ConfigureRequest",
];

/**
 * The framework types the generated code only ever uses with type arguments, and
 * how many: a generated type hides one only when it takes as many.
 */
const GENERIC_ONLY = { List: 1, Dictionary: 2, IReadOnlyDictionary: 2 };

/**
 * Every name a generated type could take that would hide a framework type the
 * generated code uses: each registered framework type, each attribute by its short
 * name, and the root namespaces, as `[name, type parameter count]`. All are
 * declared at once, so every one is hidden in the same build. The names of the
 * emitter's own types come last; those are reported rather than generated.
 */
const SHADOWING = [
  ...Object.keys(FRAMEWORK_TYPES).map((name) => [
    name,
    GENERIC_ONLY[name] ?? 0,
  ]),
  ...Object.keys(FRAMEWORK_TYPES)
    .filter((name) => name.endsWith("Attribute"))
    .map((name) => [name.slice(0, -"Attribute".length), 0])
    .filter(([name]) => !(name in FRAMEWORK_TYPES)),
  ["System", 0],
  ["Flurl", 0],
  ["Microsoft", 0],
  ["IMergePatch", 0],
  ["MergePatch", 0],
  ["ClientRuntime", 0],
  ["ModelMap", 0],
  ["RequestBuilder", 0],
  ["Matrix", 0],
  ["MatrixClient", 0],
];

/**
 * A case id from parts, as a valid identifier.
 *
 * @param {...string} parts - The parts, joined in camelCase.
 * @returns {string} The id.
 */
function idOf(...parts) {
  return parts
    .map((p, i) => {
      const clean = p.replace(/[^A-Za-z0-9]/g, "");
      return i === 0 ? clean : clean[0].toUpperCase() + clean.slice(1);
    })
    .join("");
}

/**
 * Builds every case of the matrix.
 *
 * @returns {Case[]} The cases.
 */
export function buildCases() {
  /** @type {Case[]} */
  const cases = [];
  const add = (id, group, ops, decls = []) =>
    cases.push({ id, group, ops, decls });

  for (const [typeId, type] of TYPES) {
    for (const [position, op] of Object.entries(POSITIONS)) {
      const id = idOf(position, typeId);
      add(id, "Positions", [op(id, type)]);
    }
    const id = idOf("property", typeId);
    add(
      id,
      "Properties",
      [
        `@route("/${id}/get") @get ${id}Get(): ${id}Model;`,
        `@route("/${id}/post") @post ${id}Post(@body body: ${id}Model): void;`,
      ],
      [
        `model ${id}Model { v: ${type}; o?: ${type}; n: ${type} | null; l: ${type}[]; d: Record<${type}>; }`,
      ],
    );
  }

  for (const [encodingId, decorator, type] of ENCODINGS) {
    for (const [position, build] of Object.entries(ENCODED_POSITIONS)) {
      const id = idOf("encoded", encodingId, position);
      const { ops, decls = [] } = build(id, decorator, type);
      add(id, "Encodings", ops, decls);
    }
  }

  for (const [mediaId, media] of MEDIA_TYPES) {
    const contentType = media.includes('"') ? media : `"${media}"`;
    for (const [payloadId, payload] of MEDIA_PAYLOADS) {
      const send = idOf("send", mediaId, payloadId);
      add(send, "Media", [
        `@route("/${send}") @post ${send}(@header contentType: ${contentType}, @body body: ${payload}): void;`,
      ]);
      const read = idOf("read", mediaId, payloadId);
      add(read, "Media", [
        `@route("/${read}") @get ${read}(): { @header contentType: ${contentType}; @body body: ${payload} };`,
      ]);
    }
  }

  AWKWARD_NAMES.forEach((name, i) => {
    const quoted = `\`${name}\``;
    // One case per position, so TypeSpec rejecting one does not drop the others.
    for (const [position, decorator] of [
      ["path", "@path"],
      ["query", "@query"],
      ["header", "@header"],
      ["cookie", "@cookie"],
    ]) {
      const param = idOf(position, "parameter", String(i));
      // A route template names the parameter as it is, without TypeSpec's backticks.
      const route = position === "path" ? `/${param}/{${name}}` : `/${param}`;
      const optional = position === "path" ? "" : "?";
      add(param, "Names", [
        `@route("${route}") @get ${param}(${decorator} ${quoted}${optional}: string): void;`,
      ]);
    }
    const bodyParam = idOf("bodyParameter", String(i));
    add(bodyParam, "Names", [
      `@route("/${bodyParam}") @post ${bodyParam}(@query ${quoted}: string, @body body: Item): void;`,
    ]);
    const property = idOf("propertyName", String(i));
    add(
      property,
      "Names",
      [`@route("/${property}") @get ${property}(): ${property}Model;`],
      [`model ${property}Model { ${quoted}: string; }`],
    );
    const operation = idOf("operationName", String(i));
    add(operation, "Operations", [
      `@route("/${operation}") @get ${quoted}(): void;`,
    ]);
    const member = idOf("enumMember", String(i));
    add(
      member,
      "Names",
      [
        `@route("/${member}") @get ${member}(@query v: ${member}Enum): ${member}Enum;`,
      ],
      [`enum ${member}Enum { ${quoted}, other }`],
    );
    const parameter = idOf("templateParameter", String(i));
    add(
      parameter,
      "Names",
      [`@route("/${parameter}") @get ${parameter}(): ${parameter}Model<Item>;`],
      [`model ${parameter}Model<${quoted}> { value: ${quoted}; }`],
    );
  });

  for (const [name, arity] of SHADOWING) {
    const id = idOf("modelNamed", name);
    const parameters = Array.from({ length: arity }, (_, i) => `T${i}`);
    const quoted = `\`${name}\``;
    const declared = arity ? `${quoted}<${parameters.join(", ")}>` : quoted;
    const used = arity
      ? `${quoted}<${parameters.map(() => "Item").join(", ")}>`
      : quoted;
    const fields = parameters.map((p, i) => ` p${i}: ${p};`).join("");
    add(
      id,
      "Shadowing",
      [
        `@route("/${id}") @get ${id}(): ${used};`,
        `@route("/${id}/many") @get ${id}Many(): ${used}[];`,
        `@route("/${id}/send") @post ${id}Send(@body body: ${used}): ${used};`,
      ],
      [`model ${declared} { v: string; items: Item[];${fields} }`],
    );
  }

  add(
    "lowerCaseNames",
    "Names",
    [
      `@route("/lowerCaseNames") @get lowerCaseNames(@query color: lowerenum): lowermodel;`,
      `@route("/lowerCaseNames/generic") @get lowerCaseGeneric(): lowergeneric<lowermodel>;`,
      `@route("/lowerCaseNames/send") @post lowerCaseSend(@body body: lowermodel[]): void;`,
    ],
    [
      `model lowermodel { value: string; color: lowerenum; }`,
      `enum lowerenum { a, b }`,
      `model lowergeneric<T> { item: T; }`,
      `@discriminator("kind") model lowerbase { kind: string; }`,
      `model lowerderived extends lowerbase { kind: "d"; }`,
    ],
  );
  add("lowerCaseHierarchy", "Names", [
    `@route("/lowerCaseHierarchy") @post lowerCaseHierarchy(@body body: lowerbase): lowerbase;`,
  ]);

  add(
    "enumAliases",
    "Names",
    [
      `@route("/enumAliases/string") @get enumAliasesString(@query v: AliasedString): AliasedString[];`,
      `@route("/enumAliases/number") @get enumAliasesNumber(@query v: AliasedNumber): AliasedNumber[];`,
    ],
    [
      `enum AliasedString { first: "x", second: "x", third: "y" }`,
      `enum AliasedNumber { first: 1, second: 1, third: 2.5, fourth: 2.5 }`,
    ],
  );

  // Each interface is a method of the client, beside its `FlurlClient` property,
  // and names a request builder class, so these are names that need care there.
  for (const name of ["flurlClient", "Params", "Class", "Event", "Await"]) {
    const id = idOf("endpointNamed", name);
    add(id, name, [`@route("/${id}") @get ${id}(): void;`]);
  }

  const visibility = [
    ["nestedCreate", `@post nestedCreate(@body body: Wrapper): Wrapper;`],
    ["nestedReplace", `@put nestedReplace(@body body: Wrapper): Wrapper;`],
    [
      "nestedPatch",
      `@patch nestedPatch(@body body: MergePatchUpdate<Wrapper>): Wrapper;`,
    ],
    ["petCreate", `@post petCreate(@body body: Pet): Pet;`],
    ["petsCreate", `@post petsCreate(@body body: Pet[]): Pet[];`],
    ["catCreate", `@post catCreate(@body body: Cat): Cat;`],
    [
      "updateVisibility",
      `@parameterVisibility(Lifecycle.Update) @post updateVisibility(@body body: Wrapper): void;`,
    ],
    [
      "nullableWrapper",
      `@post nullableWrapper(@body body: Wrapper | null): void;`,
    ],
    [
      "pageOfWrappers",
      `@post pageOfWrappers(@body body: Page<Wrapper>): void;`,
    ],
  ];
  for (const [id, op] of visibility) {
    add(id, "Visibility", [`@route("/${id}") ${op}`]);
  }

  add(
    "nestedDiscriminator",
    "Discriminators",
    [`@route("/nestedDiscriminator") @get nestedDiscriminator(): Vehicle;`],
    [
      `@discriminator("kind") model Vehicle { kind: string; }`,
      `@discriminator("power") model Car extends Vehicle { kind: "car"; power: string; }`,
      `model Electric extends Car { power: "electric"; }`,
    ],
  );
  add(
    "genericDiscriminator",
    "Discriminators",
    [
      `@route("/genericDiscriminator") @get genericDiscriminator(): Shape<string>;`,
    ],
    [`@discriminator("kind") model Shape<T> { kind: string; value: T; }`],
  );
  add(
    "encodedDiscriminator",
    "Discriminators",
    [`@route("/encodedDiscriminator") @get encodedDiscriminator(): Animal[];`],
    [
      `@discriminator("kind") model Animal { @encodedName("application/json", "$type") kind: string; }`,
      `model Fish extends Animal { kind: "fish"; @encodedName("application/json", "fins") finCount: int32; }`,
    ],
  );
  add(
    "valueTemplate",
    "Discriminators",
    [`@route("/valueTemplate") @get valueTemplate(): Sized<3>;`],
    [`model Sized<N extends valueof int32> { x: string; }`],
  );

  return cases;
}
