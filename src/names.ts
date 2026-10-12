// Name validation for everything that comes straight from the TypeSpec: model,
// enum and interface names become C# type names and file names, and property,
// operation and parameter names become C# members. TypeSpec lets an identifier
// contain almost anything once it is backtick-quoted (`my/model`), so none of it
// can be trusted to be a legal C# identifier or a safe path segment.

import { NoTarget, type Program, type Type } from "@typespec/compiler";
import { isCsIdentifier, isCsTypeName } from "./identifiers.js";
import { createDiagnostic } from "./lib.js";

/** The kinds of declaration whose names are checked. */
export type NameKind =
  | "model"
  | "enum"
  | "interface"
  | "property"
  | "operation"
  | "parameter"
  | "enum member"
  | "version";

/** Which diagnostics have been reported for a program, so each bad name is reported once. */
const reported = new WeakMap<Program, Set<string>>();

/**
 * A folder name that is safe to join to the output directory: letters, digits,
 * dots, underscores and hyphens, starting with a letter or digit, and never `..`.
 */
const SAFE_FOLDER = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Explains why a name cannot be used for a kind of declaration.
 *
 * @param kind - The kind of declaration the name belongs to.
 * @param name - The name as written in the TypeSpec (or after `@clientName`).
 * @returns The reason, or `undefined` when the name is fine.
 */
function problemWith(kind: NameKind, name: string): string | undefined {
  switch (kind) {
    case "model":
    case "enum":
    case "interface":
      return isCsTypeName(name)
        ? undefined
        : "is not a valid C# type name (letters, digits and underscores, not starting with a digit, and not a C# keyword); give it one with @clientName";
    case "property":
    case "operation":
    case "parameter":
      return isCsIdentifier(name)
        ? undefined
        : "is not a valid C# identifier (letters, digits and underscores, not starting with a digit); give it one with @clientName";
    case "enum member":
      return undefined;
    case "version":
      return SAFE_FOLDER.test(name) && !name.includes("..")
        ? undefined
        : "is not safe to use as a folder name (use letters, digits, dots, underscores and hyphens)";
  }
}

/**
 * Reports an `invalid-name` diagnostic, once per program for a given kind, name
 * and reason, however many versions or files the name appears in.
 *
 * @param program - The compiler program, used to report the diagnostic.
 * @param kind - The kind of declaration.
 * @param name - The offending name.
 * @param reason - Why it cannot be used.
 * @param target - The declaration, or `NoTarget`.
 */
export function reportInvalidName(
  program: Program,
  kind: NameKind,
  name: string,
  reason: string,
  target: Type | typeof NoTarget,
): void {
  let seen = reported.get(program);
  if (!seen) {
    seen = new Set();
    reported.set(program, seen);
  }
  const key = `${kind}\u0000${name}\u0000${reason}`;
  if (seen.has(key)) return;
  seen.add(key);
  program.reportDiagnostic(
    createDiagnostic({
      code: "invalid-name",
      target,
      format: { kind, name, reason },
    }),
  );
}

/**
 * Checks that a name can be used for a kind of declaration, reporting an
 * `invalid-name` diagnostic when it cannot.
 *
 * @param program - The compiler program, used to report the diagnostic.
 * @param kind - The kind of declaration the name belongs to.
 * @param name - The effective name (after `@clientName`).
 * @param target - The declaration, used as the diagnostic target.
 * @returns `true` when the name is usable; `false` after reporting.
 */
export function checkName(
  program: Program,
  kind: NameKind,
  name: string,
  target: Type | typeof NoTarget,
): boolean {
  const reason = problemWith(kind, name);
  if (reason === undefined) return true;
  reportInvalidName(program, kind, name, reason, target);
  return false;
}
