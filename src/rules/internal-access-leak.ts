// Lint rule: a public Interface/Model must never reference an
// `@access(Access.internal)` Model/Enum through an operation's parameters,
// request body, or return type, or through a model property. The generated C#
// would otherwise fail to compile (CS0053: inconsistent accessibility), since
// the internal type's C# `internal` modifier is narrower than the `public`
// surface that exposes it.

import {
  createRule,
  paramMessage,
  type Enum,
  type Interface,
  type Model,
  type ModelProperty,
  type Operation,
  type Type,
  isArrayModelType,
  isRecordModelType,
} from "@typespec/compiler";
import { getAccess } from "../decorators.js";
import { flattenProperties } from "../models.js";

/**
 * Unwraps one level of `Array<T>` / `Record<T>` / `Union` wrapping (mirroring
 * how `mapType` in `../utils.ts` treats these wrapper kinds) to find the named
 * `Model`/`Enum` type(s) actually referenced. Anonymous models, scalars, and
 * other non-named types are not tracked since they cannot carry `@access`.
 *
 * @param type - The type to resolve.
 * @returns The named `Model`/`Enum` types reachable from `type`.
 */
function resolveNamedTypes(type: Type): (Model | Enum)[] {
  switch (type.kind) {
    case "Model": {
      if (isArrayModelType(type) || isRecordModelType(type)) {
        return type.indexer ? resolveNamedTypes(type.indexer.value) : [];
      }
      return type.name ? [type] : [];
    }
    case "Enum":
      return type.name ? [type] : [];
    case "Union":
      return [...type.variants.values()].flatMap((variant) =>
        resolveNamedTypes(variant.type),
      );
    default:
      return [];
  }
}

export const internalAccessLeakRule = createRule({
  name: "internal-access-leak",
  severity: "warning",
  description:
    "A public operation or model must not reference an @access(Access.internal) type; the generated C# would fail to compile.",
  url: "https://github.com/massivescale/typespec/blob/main/tsp-flurl-client/README.md#internal-access-leak",
  messages: {
    default: paramMessage`"${"referencingName"}" is public but its ${"kind"} type "${"internalTypeName"}" is marked @access(Access.internal); the generated C# will fail to compile (CS0053: inconsistent accessibility). Mark "${"internalTypeName"}" @access(Access.public), or mark "${"referencingName"}" @access(Access.internal) as well.`,
  },
  create(context) {
    function checkReferencedTypes(
      type: Type,
      referencingName: string,
      kind: string,
      target: Operation | ModelProperty,
    ): void {
      for (const named of resolveNamedTypes(type)) {
        if (getAccess(context.program, named) === "internal") {
          context.reportDiagnostic({
            target,
            format: {
              referencingName,
              kind,
              internalTypeName: named.name!,
            },
          });
        }
      }
    }

    return {
      interface: (iface: Interface) => {
        const containerAccess = getAccess(context.program, iface) ?? "public";
        if (containerAccess === "internal") return;

        for (const op of iface.operations.values()) {
          const opAccess = getAccess(context.program, op) ?? "public";
          if (opAccess === "internal") continue;

          for (const prop of op.parameters.properties.values()) {
            checkReferencedTypes(prop.type, op.name, "parameter", prop);
          }
          checkReferencedTypes(op.returnType, op.name, "return", op);
        }
      },
      model: (model: Model) => {
        const modelAccess = getAccess(context.program, model) ?? "public";
        if (modelAccess === "internal") return;

        for (const [, prop] of flattenProperties(model)) {
          checkReferencedTypes(prop.type, prop.name, "property", prop);
        }
      },
    };
  },
});
