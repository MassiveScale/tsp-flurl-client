import type {
  DecoratorContext,
  EnumMember,
  Program,
  Type,
} from "@typespec/compiler";
import { createDiagnostic, reportDiagnostic } from "./lib.js";
import { isCsIdentifier, isCsKeyword } from "./identifiers.js";

/**
 * The TypeSpec namespace the decorators are declared in (`lib/main.tsp`). The
 * compiler uses this export to find the JavaScript implementation of each
 * `extern dec`, so it must match the namespace there exactly.
 */
export const namespace = "MassiveScale.TspFlurlClient";

/** Key of the compiler state map that stores each type's `@clientName` override. */
const clientNameKey = Symbol.for("@massivescale/tsp-flurl-client/clientName");
/** Key of the compiler state map that stores each type's `@access` modifier. */
const accessKey = Symbol.for("@massivescale/tsp-flurl-client/access");

/**
 * Implementation of the `@clientName` decorator: stores the name to use for the
 * decorated declaration in the emitted C#.
 *
 * The name is trimmed and must be a plain C# identifier, because it becomes a type
 * name, a member name, or a file name; anything else (spaces, punctuation, a path
 * such as `../Client`) is reported as `invalid-client-name` and nothing is stored.
 * A model, enum, or interface name also cannot be a C# keyword. A rename of a
 * synthesized merge-patch model is stored but ignored by {@link getClientName}.
 *
 * @param context - The decorator context, used to reach the program and report diagnostics.
 * @param target - The model, interface, enum, operation, or property being renamed.
 * @param name - The requested C# name.
 */
export function $clientName(
  context: DecoratorContext,
  target: Type,
  name: string,
): void {
  const trimmed = name.trim();
  // The name becomes a C# identifier and a file name, so anything that is not a
  // plain identifier (spaces, punctuation, path separators such as `../Client`)
  // is rejected rather than written into the output. A model, enum, or interface
  // name also cannot be a reserved keyword, since it becomes a type name.
  const becomesTypeName =
    target.kind === "Model" ||
    target.kind === "Enum" ||
    target.kind === "Interface";
  if (!isCsIdentifier(trimmed) || (becomesTypeName && isCsKeyword(trimmed))) {
    reportDiagnostic(context.program, {
      code: "invalid-client-name",
      target,
    });
    return;
  }

  context.program.stateMap(clientNameKey).set(target, trimmed);
}

/**
 * Implementation of the `@access` decorator: stores the C# access modifier of the
 * decorated declaration.
 *
 * @param context - The decorator context, used to reach the program and report diagnostics.
 * @param target - The model, interface, enum, operation, or property being decorated.
 * @param value - The `Access` enum member: `public` or `internal`. Any other value is
 *   reported as `invalid-access-modifier` and nothing is stored.
 */
export function $access(
  context: DecoratorContext,
  target: Type,
  value: EnumMember,
): void {
  const v = typeof value.value === "string" ? value.value : value.name;
  if (v !== "public" && v !== "internal") {
    context.program.reportDiagnostic(
      createDiagnostic({
        code: "invalid-access-modifier",
        target,
        format: { value: String(v) },
      }),
    );
    return;
  }

  context.program.stateMap(accessKey).set(target, v);
}

/**
 * Reads the `@clientName` override of a type.
 *
 * A synthesized merge-patch model (a name ending in `MergePatchUpdate`,
 * `MergePatchUpdateReplaceOnly`, or `MergePatchCreateOrUpdate`) keeps its generated
 * name even when renamed, so it cannot collide with a user model.
 *
 * @param program - The compiler program holding the decorator state.
 * @param type - The type to look up.
 * @returns The override, or `undefined` when the type was not renamed.
 */
export function getClientName(
  program: Program,
  type: Type,
): string | undefined {
  const value = program.stateMap(clientNameKey).get(type);
  if (typeof value !== "string") return undefined;

  // TypeSpec HTTP synthesized merge-patch models should keep their generated
  // distinct names to avoid collisions with user models.
  if (
    type.kind === "Model" &&
    type.name &&
    (type.name.endsWith("MergePatchUpdate") ||
      type.name.endsWith("MergePatchUpdateReplaceOnly") ||
      type.name.endsWith("MergePatchCreateOrUpdate"))
  ) {
    return undefined;
  }

  return value;
}

/**
 * Reads the `@access` modifier of a type.
 *
 * @param program - The compiler program holding the decorator state.
 * @param type - The type to look up.
 * @returns `"public"` or `"internal"`, or `undefined` when the type has no `@access`
 *   (callers treat that as public).
 */
export function getAccess(
  program: Program,
  type: Type,
): "public" | "internal" | undefined {
  const value = program.stateMap(accessKey).get(type);
  if (value === "public" || value === "internal") {
    return value;
  }
  return undefined;
}
