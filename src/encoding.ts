// `@encode` changes how a value is written on the wire: a number as a JSON string,
// a date as a Unix timestamp, a duration as seconds, bytes as base64url. This
// module decides which of those the generated client honours and which it cannot,
// so an unsupported one is reported instead of silently using the wrong format.

import {
  getEncode,
  NoTarget,
  type ModelProperty,
  type Program,
  type Scalar,
} from "@typespec/compiler";
import { createDiagnostic } from "./lib.js";
import { builtinScalarName } from "./utils.js";

/** How the generated client treats a property or parameter's `@encode`. */
export type EncodingSupport =
  /** No `@encode`, or one that is the same as the default wire format. */
  | "default"
  /** A number written as a JSON string, handled with `JsonNumberHandling`. */
  | "number-as-string"
  /** An encoding the client cannot produce or read. */
  | "unsupported";

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

/**
 * Classifies the `@encode` of a model property or parameter.
 *
 * Supported: none (the default), `"string"` on a boolean (the C# type becomes
 * `string`, see `mapPropertyType`) or on a number (`number-as-string`), and the
 * encodings that already are the default wire format: `rfc3339` for a date-time,
 * `ISO8601` for a duration, and `base64` for bytes. Anything else, such as
 * `unixTimestamp`, `rfc7231`, `seconds`, or `base64url`, is unsupported.
 *
 * @param program - The compiler program, used to read `@encode`.
 * @param prop - The property or parameter.
 * @returns How the client treats its encoding, and the encoding's name for messages.
 */
export function classifyEncoding(
  program: Program,
  prop: ModelProperty,
): { support: EncodingSupport; encoding?: string } {
  const encode = getEncode(program, prop);
  if (!encode?.encoding) return { support: "default" };

  const { encoding } = encode;
  const scalar =
    prop.type.kind === "Scalar" ? builtinScalarName(prop.type as Scalar) : "";

  if (encoding === "string") {
    if (scalar === "boolean") return { support: "default", encoding };
    if (NUMERIC_SCALARS.has(scalar)) {
      return { support: "number-as-string", encoding };
    }
    return { support: "unsupported", encoding };
  }

  const isDefault =
    (encoding === "rfc3339" &&
      (scalar === "utcDateTime" || scalar === "offsetDateTime")) ||
    (encoding === "ISO8601" && scalar === "duration") ||
    (encoding === "base64" && scalar === "bytes");
  return { support: isDefault ? "default" : "unsupported", encoding };
}

/**
 * Reports a warning when a property or parameter uses an `@encode` the client
 * cannot honour, because its value would otherwise travel in the wrong format with
 * no sign of it. The default wire format is used.
 *
 * @param program - The compiler program, used to read `@encode` and report.
 * @param prop - The property or parameter.
 * @param kind - What it is, for the message: `property` or `parameter`.
 * @returns The classification, so the caller can act on `number-as-string`.
 */
export function checkEncoding(
  program: Program,
  prop: ModelProperty,
  kind: "property" | "parameter",
): EncodingSupport {
  const { support, encoding } = classifyEncoding(program, prop);
  if (support === "unsupported") {
    program.reportDiagnostic(
      createDiagnostic({
        code: "unsupported-encoding",
        target: prop ?? NoTarget,
        format: { kind, name: prop.name, encoding: encoding ?? "" },
      }),
    );
  }
  return support;
}
