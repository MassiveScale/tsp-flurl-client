import type {
  DecoratorContext,
  EnumMember,
  Program,
  Type,
} from "@typespec/compiler";
import { createDiagnostic, reportDiagnostic } from "./lib.js";

export const namespace = "MassiveScale.TspFlurlClient";

const clientNameKey = Symbol.for("@massivescale/tsp-flurl-client/clientName");
const accessKey = Symbol.for("@massivescale/tsp-flurl-client/access");

/**
 * A plain C# identifier: a letter or underscore followed by letters, digits, or
 * underscores. Keeps `@clientName` values safe to use as type names and file names.
 */
const CS_IDENTIFIER = /^[\p{L}_][\p{L}\p{Nd}_]*$/u;

export function $clientName(
  context: DecoratorContext,
  target: Type,
  name: string,
): void {
  const trimmed = name.trim();
  // The name becomes a C# identifier and a file name, so anything that is not a
  // plain identifier (spaces, punctuation, path separators such as `../Client`)
  // is rejected rather than written into the output.
  if (!CS_IDENTIFIER.test(trimmed)) {
    reportDiagnostic(context.program, {
      code: "invalid-client-name",
      target,
    });
    return;
  }

  context.program.stateMap(clientNameKey).set(target, trimmed);
}

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
