// C# identifier rules shared by the decorators, the option validation, and the
// type mapping. This module is a leaf: it imports nothing from the emitter, so
// any other module can depend on it without creating a cycle.

/**
 * C# reserved keywords. A parameter named after one of these needs a leading `@`
 * to be a legal identifier, and none of them can be used as a type or namespace
 * name at all.
 */
const CS_KEYWORDS = new Set([
  "abstract",
  "as",
  "base",
  "bool",
  "break",
  "byte",
  "case",
  "catch",
  "char",
  "checked",
  "class",
  "const",
  "continue",
  "decimal",
  "default",
  "delegate",
  "do",
  "double",
  "else",
  "enum",
  "event",
  "explicit",
  "extern",
  "false",
  "finally",
  "fixed",
  "float",
  "for",
  "foreach",
  "goto",
  "if",
  "implicit",
  "in",
  "int",
  "interface",
  "internal",
  "is",
  "lock",
  "long",
  "namespace",
  "new",
  "null",
  "object",
  "operator",
  "out",
  "override",
  "params",
  "private",
  "protected",
  "public",
  "readonly",
  "ref",
  "return",
  "sbyte",
  "sealed",
  "short",
  "sizeof",
  "stackalloc",
  "static",
  "string",
  "struct",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "uint",
  "ulong",
  "unchecked",
  "unsafe",
  "ushort",
  "using",
  "virtual",
  "void",
  "volatile",
  "while",
]);

/**
 * Contextual keywords that cannot be used as an identifier where generated code
 * declares one: `await` is reserved inside an `async` method, which every endpoint
 * implementation is. Unlike a reserved keyword, it is still a legal type name. The
 * other contextual keywords (`var`, `nameof`, `value`, ...) compile as parameter
 * names in the generated methods.
 */
const CS_ASYNC_RESERVED = new Set(["await"]);

/**
 * A plain C# identifier: a letter or underscore followed by letters, digits, or
 * underscores.
 */
const CS_IDENTIFIER = /^[\p{L}_][\p{L}\p{Nd}_]*$/u;

/**
 * Whether a name is a C# reserved keyword.
 *
 * @param name - The candidate name.
 * @returns `true` for a reserved keyword such as `class` or `string`.
 */
export function isCsKeyword(name: string): boolean {
  return CS_KEYWORDS.has(name);
}

/**
 * Whether a parameter or local name needs a leading `@` to compile in a generated
 * method: a reserved keyword such as `class`, or `await`, which an `async` method
 * reserves.
 *
 * @param name - The candidate name.
 * @returns `true` when the name must be written verbatim-escaped.
 */
export function needsVerbatimEscape(name: string): boolean {
  return CS_KEYWORDS.has(name) || CS_ASYNC_RESERVED.has(name);
}

/**
 * Whether a name is a plain C# identifier: letters, digits and underscores, not
 * starting with a digit. Keywords pass this test; combine it with
 * {@link isCsKeyword} where a keyword would be invalid.
 *
 * @param name - The candidate name.
 * @returns `true` when the name is a plain identifier.
 */
export function isCsIdentifier(name: string): boolean {
  return CS_IDENTIFIER.test(name);
}

/**
 * Whether a name can be used as a type name: a plain identifier that is not a
 * reserved keyword.
 *
 * @param name - The candidate name.
 * @returns `true` when the name is a legal C# type name.
 */
export function isCsTypeName(name: string): boolean {
  return isCsIdentifier(name) && !isCsKeyword(name);
}

/**
 * Whether a name is a legal dotted C# namespace such as `Acme.Api.Client`: every
 * segment must be a type-name-safe identifier.
 *
 * @param name - The candidate namespace.
 * @returns `true` when every dot-separated segment is legal.
 */
export function isCsNamespace(name: string): boolean {
  return name.split(".").every(isCsTypeName);
}

/**
 * Turns arbitrary text into a legal C# identifier by replacing every character
 * that is not a letter, digit, or underscore with an underscore, and prefixing an
 * underscore when the result would start with a digit. Used for enum members,
 * whose wire value is carried separately and which have no `@clientName`.
 *
 * @param name - The raw name.
 * @returns A legal identifier (`_` for an empty name).
 */
export function toCsIdentifier(name: string): string {
  const replaced = name.replace(/[^\p{L}\p{Nd}_]/gu, "_");
  if (replaced.length === 0) return "_";
  return /^\p{Nd}/u.test(replaced) ? `_${replaced}` : replaced;
}
