// `@encode` changes how a value is written on the wire: a number as a JSON string,
// a date as a Unix timestamp, a duration as seconds, bytes as base64url, a list as
// one delimited string. This module maps each encoding TypeSpec defines to how the
// generated client produces and reads it, and reports the ones it cannot, so a
// value never travels in a format the API does not expect.

import {
  getEncode,
  type ModelProperty,
  type Program,
  type Scalar,
  type Type,
} from "@typespec/compiler";
import { createDiagnostic, reportOnce } from "./lib.js";
import { builtinScalarName, soleVariant } from "./utils.js";

/**
 * A wire format the generated runtime implements. Each name is a member of the
 * runtime's `ClientRuntime.WireEncoding` enum and, for JSON properties, the prefix
 * of its converter (`ClientRuntime.UnixSecondsConverter`).
 */
export type WireEncoding =
  /** `unixTimestamp`: whole seconds since 1970-01-01T00:00:00Z. */
  | "UnixSeconds"
  /** `rfc7231`: an HTTP date, `Tue, 15 Nov 1994 08:12:31 GMT`. */
  | "Rfc7231"
  /** `seconds` encoded as a floating-point number. */
  | "Seconds"
  /** `seconds` encoded as an integer. */
  | "WholeSeconds"
  /** `milliseconds` encoded as a floating-point number. */
  | "Milliseconds"
  /** `milliseconds` encoded as an integer. */
  | "WholeMilliseconds"
  /** `base64url`: URL-safe base64 without padding. */
  | "Base64Url"
  /** `ArrayEncoding.pipeDelimited`: `a|b`. */
  | "PipeDelimited"
  /** `ArrayEncoding.spaceDelimited`: `a b`. */
  | "SpaceDelimited"
  /** `ArrayEncoding.commaDelimited`: `a,b`. */
  | "CommaDelimited"
  /** `ArrayEncoding.newlineDelimited`: one item per line. */
  | "NewlineDelimited";

/** How the generated client treats a property or parameter's `@encode`. */
export type EncodingSupport =
  /** No `@encode`, or one that is the same as the default wire format. */
  | "default"
  /** A number written as a JSON string, handled with `JsonNumberHandling`. */
  | "number-as-string"
  /** A format the runtime implements; see {@link WireEncoding}. */
  | "wire"
  /** An encoding the client cannot produce or read. */
  | "unsupported";

/** The result of {@link classifyEncoding}. */
export interface EncodingClass {
  /** How the client treats the encoding. */
  support: EncodingSupport;
  /** The encoding's name as written, for messages. */
  encoding?: string;
  /** The runtime format, when `support` is `wire`. */
  wire?: WireEncoding;
}

/** Built-in scalars that are numbers on the wire. */
const NUMERIC_SCALARS = new Set([
  "int8",
  "int16",
  "int32",
  "int64",
  "uint8",
  "uint16",
  "uint32",
  "uint64",
  "safeint",
  "integer",
  "float",
  "float32",
  "float64",
  "decimal",
  "decimal128",
  "numeric",
]);

/** Built-in scalars whose values are whole numbers. */
const INTEGER_SCALARS = new Set([
  "int8",
  "int16",
  "int32",
  "int64",
  "uint8",
  "uint16",
  "uint32",
  "uint64",
  "safeint",
  "integer",
]);

/** `ArrayEncoding` members and the runtime format for each. */
const ARRAY_ENCODINGS: Record<string, WireEncoding> = {
  pipeDelimited: "PipeDelimited",
  spaceDelimited: "SpaceDelimited",
  commaDelimited: "CommaDelimited",
  newlineDelimited: "NewlineDelimited",
};

/**
 * Whether a list item can be written as delimited text: a scalar, an enum, or a
 * union of those, not a model.
 *
 * @param type - The list's item type.
 * @returns `true` when the item has a plain-text form.
 */
function isTextItem(type: Type): boolean {
  if (type.kind === "Scalar" || type.kind === "Enum") return true;
  if (type.kind === "Union") {
    return [...type.variants.values()].every((v) => isTextItem(v.type));
  }
  return type.kind === "String" || type.kind === "Number";
}

/**
 * The type a nullable union stands for: `T` for `T | null`, otherwise the type itself.
 *
 * @param type - A property or parameter type.
 * @returns The non-null type.
 */
function withoutNull(type: Type): Type {
  return soleVariant(type)?.type ?? type;
}

/**
 * Classifies the `@encode` of a model property or parameter.
 *
 * - The default wire formats (`rfc3339` for a date-time, `ISO8601` for a
 *   duration, `base64` for bytes) and `"string"` on a boolean or string need
 *   nothing; `"string"` on a number is `number-as-string`.
 * - `rfc7231` and `unixTimestamp` on a date-time, `seconds` and `milliseconds` on a
 *   duration (as an integer or a fraction, following the type it is encoded as),
 *   `base64url` on bytes, and an `ArrayEncoding` on a list of scalars are
 *   implemented by the runtime (`wire`).
 * - Anything else is unsupported.
 *
 * @param program - The compiler program, used to read `@encode`.
 * @param prop - The property or parameter.
 * @returns How the client treats its encoding.
 */
export function classifyEncoding(
  program: Program,
  prop: ModelProperty,
): EncodingClass {
  const encode = getEncode(program, prop);
  if (!encode?.encoding) return { support: "default" };

  const { encoding } = encode;
  // `at: utcDateTime | null` (or an optional property of a synthesized merge patch,
  // which is made nullable) is encoded as its non-null type.
  const type = withoutNull(prop.type);
  const scalar =
    type.kind === "Scalar" ? builtinScalarName(type as Scalar) : "";
  const wire = (format: WireEncoding): EncodingClass => ({
    support: "wire",
    encoding,
    wire: format,
  });
  const integer =
    encode.type !== undefined &&
    INTEGER_SCALARS.has(builtinScalarName(encode.type));

  if (encoding === "string") {
    if (scalar === "boolean" || scalar === "string") {
      return { support: "default", encoding };
    }
    if (NUMERIC_SCALARS.has(scalar)) {
      return { support: "number-as-string", encoding };
    }
    return { support: "unsupported", encoding };
  }

  if (scalar === "utcDateTime" || scalar === "offsetDateTime") {
    if (encoding === "rfc3339") return { support: "default", encoding };
    if (encoding === "rfc7231") return wire("Rfc7231");
    if (encoding === "unixTimestamp") return wire("UnixSeconds");
  }
  if (scalar === "duration") {
    if (encoding === "ISO8601") return { support: "default", encoding };
    if (encoding === "seconds")
      return wire(integer ? "WholeSeconds" : "Seconds");
    if (encoding === "milliseconds") {
      return wire(integer ? "WholeMilliseconds" : "Milliseconds");
    }
  }
  if (scalar === "bytes") {
    if (encoding === "base64") return { support: "default", encoding };
    if (encoding === "base64url") return wire("Base64Url");
  }

  const arrayFormat = ARRAY_ENCODINGS[encoding.replace(/^ArrayEncoding\./, "")];
  if (
    arrayFormat &&
    type.kind === "Model" &&
    type.indexer &&
    type.name === "Array" &&
    isTextItem(type.indexer.value)
  ) {
    return wire(arrayFormat);
  }

  return { support: "unsupported", encoding };
}

/**
 * Whether a format is one of the `ArrayEncoding` delimiters.
 *
 * @param wire - The format.
 * @returns `true` for a delimited list.
 */
export function isDelimited(wire: WireEncoding): boolean {
  return wire.endsWith("Delimited");
}

/**
 * The C# expression that encodes a value for a query, header, path, or cookie
 * parameter, or a plain-text body.
 *
 * @param expression - The C# expression holding the value.
 * @param wire - The format.
 * @returns The encoding call.
 */
export function encodeExpression(
  expression: string,
  wire: WireEncoding,
): string {
  return `ClientRuntime.Encode(${expression}, ClientRuntime.WireEncoding.${wire})`;
}

/**
 * The `[JsonConverter]` type for a JSON property with a runtime format.
 *
 * @param wire - The format.
 * @param csType - The property's C# type, e.g. `List<string>?` for a delimited list.
 * @returns The converter type, e.g. `ClientRuntime.UnixSecondsConverter`.
 */
export function converterType(wire: WireEncoding, csType: string): string {
  if (!isDelimited(wire)) return `ClientRuntime.${wire}Converter`;
  const list = csType.endsWith("?") ? csType.slice(0, -1) : csType;
  // The list may be written in full (`global::...List<string>`) when a model hides it.
  const item = list.slice(list.indexOf("<") + 1, -1);
  return `ClientRuntime.${wire}Converter<${item}>`;
}

/**
 * Reports `unsupported-encoding` for a declaration. A declaration is visited once
 * for every API version emitted, and the diagnostic belongs to the declaration, so
 * it is reported only the first time (see `reportOnce`).
 *
 * @param program - The compiler program, used to report.
 * @param prop - The property, parameter, or body property.
 * @param kind - What it is, for the message.
 * @param encoding - The encoding's name.
 */
export function reportUnsupportedEncoding(
  program: Program,
  prop: ModelProperty,
  kind: "property" | "parameter" | "body",
  encoding: string,
): void {
  reportOnce(
    program,
    createDiagnostic({
      code: "unsupported-encoding",
      target: prop,
      format: { kind, name: prop.name, encoding },
    }),
  );
}

/**
 * Classifies a property's or parameter's `@encode` and reports an error when the
 * client cannot honour it, since its value would otherwise travel in the wrong
 * format.
 *
 * @param program - The compiler program, used to read `@encode` and report.
 * @param prop - The property or parameter.
 * @param kind - What it is, for the message: `property` or `parameter`.
 * @returns The classification, so the caller can apply the format.
 */
export function checkEncoding(
  program: Program,
  prop: ModelProperty,
  kind: "property" | "parameter",
): EncodingClass {
  const result = classifyEncoding(program, prop);
  if (result.support === "unsupported") {
    reportUnsupportedEncoding(program, prop, kind, result.encoding ?? "");
  }
  return result;
}
