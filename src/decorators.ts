import { getMergePatchSource } from "@typespec/http/experimental/merge-patch";
import {
  getNamespaceFullName,
  isTemplateDeclaration,
  type DecoratorContext,
  type EnumMember,
  type Program,
  type Type,
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
  if (!isValidClientName(target, trimmed)) {
    reportDiagnostic(context.program, {
      code: "invalid-client-name",
      target,
    });
    return;
  }

  context.program.stateMap(clientNameKey).set(target, trimmed);
}

/**
 * Whether a `@clientName` value can be used for a target. The name becomes a C#
 * identifier and a file name, so anything that is not a plain identifier (spaces,
 * punctuation, path separators such as `../Client`) is rejected rather than written
 * into the output. A model, enum, or interface name also cannot be a reserved
 * keyword, since it becomes a type name.
 *
 * @param target - The renamed declaration.
 * @param name - The trimmed name.
 * @returns `true` when the name is usable.
 */
function isValidClientName(target: Type, name: string): boolean {
  const becomesTypeName =
    target.kind === "Model" ||
    target.kind === "Enum" ||
    target.kind === "Interface";
  return isCsIdentifier(name) && !(becomesTypeName && isCsKeyword(name));
}

/**
 * Reads the argument of one of this library's decorators as written on a template
 * declaration such as `@access(Access.internal) model Page<T>`.
 *
 * TypeSpec runs a decorator on each instance of a template (`Page<string>`) but
 * never on the declaration itself, while the emitter generates the declaration (the
 * generic `Page<T>`). Without this, `@access` and `@clientName` on a generic model
 * would be silently ignored.
 *
 * @param type - The type to look up.
 * @param decoratorName - The decorator, e.g. `@access`.
 * @returns The argument's value for a template declaration carrying the decorator;
 *   otherwise `undefined`.
 */
function templateDecoratorArgument(type: Type, decoratorName: string): unknown {
  if (
    (type.kind !== "Model" &&
      type.kind !== "Interface" &&
      type.kind !== "Operation" &&
      type.kind !== "Union" &&
      type.kind !== "Scalar") ||
    !isTemplateDeclaration(type)
  ) {
    return undefined;
  }
  const application = type.decorators.find(
    (d) =>
      d.definition?.name === decoratorName &&
      getNamespaceFullName(d.definition.namespace) === namespace,
  );
  return application?.args[0]?.value;
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
 * A merge-patch model synthesized by `@typespec/http` (`MergePatchUpdate<Widget>`)
 * keeps its generated name even when renamed, so it cannot collide with a user
 * model. It is recognized by the compiler's merge-patch metadata, not by its name,
 * so a user model called `AuditMergePatchUpdate` keeps its `@clientName`.
 *
 * @param program - The compiler program holding the decorator state.
 * @param type - The type to look up.
 * @returns The override, or `undefined` when the type was not renamed.
 */
export function getClientName(
  program: Program,
  type: Type,
): string | undefined {
  const value =
    program.stateMap(clientNameKey).get(type) ?? templateClientName(type);
  if (typeof value !== "string") return undefined;

  if (type.kind === "Model" && getMergePatchSource(program, type)) {
    return undefined;
  }

  return value;
}

/**
 * Reads `@clientName` from a template declaration (see
 * {@link templateDecoratorArgument}). An invalid name is ignored here; it is
 * reported as `invalid-client-name` on each instance.
 *
 * @param type - The type to look up.
 * @returns The trimmed name, or `undefined`.
 */
function templateClientName(type: Type): string | undefined {
  const arg = templateDecoratorArgument(type, "@clientName");
  const name =
    arg && typeof arg === "object" && "value" in arg
      ? (arg as { value: unknown }).value
      : arg;
  if (typeof name !== "string") return undefined;
  const trimmed = name.trim();
  return isValidClientName(type, trimmed) ? trimmed : undefined;
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
  const value = program.stateMap(accessKey).get(type) ?? templateAccess(type);
  if (value === "public" || value === "internal") {
    return value;
  }
  return undefined;
}

/**
 * Reads `@access` from a template declaration (see {@link templateDecoratorArgument}).
 *
 * @param type - The type to look up.
 * @returns The `Access` member's value, or `undefined`.
 */
function templateAccess(type: Type): string | undefined {
  const member = templateDecoratorArgument(type, "@access") as
    EnumMember | undefined;
  if (member?.kind !== "EnumMember") return undefined;
  return typeof member.value === "string" ? member.value : member.name;
}
