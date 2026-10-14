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
  type Program,
  type Type,
  isArrayModelType,
  isRecordModelType,
} from "@typespec/compiler";
import { getMergePatchSource } from "@typespec/http/experimental/merge-patch";
import { getAccess } from "../decorators.js";
import { flattenProperties, findDiscriminatedRoot } from "../models.js";

/**
 * Returns the declaration the emitter generates for a model. A template instance
 * such as `Page<string>` is emitted as the generic `Page<T>` declaration, so its
 * `@access` is read from that declaration, exactly as `mapType` resolves it.
 *
 * @param model - A model, possibly a template instance.
 * @returns The template declaration for an instance; otherwise the model itself.
 */
function declarationOf(model: Model): Model {
  return model.templateMapper && model.name
    ? (model.namespace?.models.get(model.name) ?? model)
    : model;
}

/**
 * Unwraps `Array<T>` / `Record<T>` / nullable `Union` wrapping and the type arguments of
 * template instances (mirroring how `mapType` in `../utils.ts` treats these
 * wrapper kinds) to find the named `Model`/`Enum` type(s) actually referenced.
 * Anonymous models, scalars, and
 * other non-named types are not tracked since they cannot carry `@access`.
 *
 * A synthesized merge-patch body (`MergePatchUpdate<Secret>`) is emitted as
 * `IMergePatch<Secret>`, so it resolves to its source model.
 *
 * @param program - The compiler program, used to find a merge-patch source.
 * @param type - The type to resolve.
 * @returns The named `Model`/`Enum` types reachable from `type`.
 */
function resolveNamedTypes(program: Program, type: Type): (Model | Enum)[] {
  const resolve = (t: Type): (Model | Enum)[] => resolveNamedTypes(program, t);
  switch (type.kind) {
    case "Model": {
      if (isArrayModelType(type) || isRecordModelType(type)) {
        return type.indexer ? resolve(type.indexer.value) : [];
      }
      const mergePatchSource = getMergePatchSource(program, type);
      if (mergePatchSource) return resolve(mergePatchSource);
      // A template instance such as `Page<Secret>` is emitted as `Page<Secret>`, so
      // its type arguments are as visible in the signature as the model itself.
      const typeArguments = (type.templateMapper?.args ?? []).filter(
        (arg): arg is Type =>
          (arg as { entityKind?: string }).entityKind === "Type",
      );
      return [
        ...(type.name ? [declarationOf(type)] : []),
        ...typeArguments.flatMap(resolve),
      ];
    }
    case "Enum":
      return type.name ? [type] : [];
    case "Union": {
      // Mirrors `mapUnion`: only a union with a single non-null variant (an optional
      // `T | null`) is emitted as that type. A union of several variants is a
      // `JsonElement` or `string` and names no model or enum in the signature.
      const present = [...type.variants.values()]
        .map((variant) => variant.type)
        .filter((t) => !(t.kind === "Intrinsic" && t.name === "null"));
      return present.length === 1 ? resolve(present[0]) : [];
    }
    default:
      return [];
  }
}

/**
 * Lint rule `internal-access-leak`: warns when something public in the generated C#
 * would expose an `@access(Access.internal)` type, which C# rejects as
 * inconsistent accessibility. It checks operation parameters and return types
 * (including type arguments of template instances), operations declared directly in
 * a namespace, model property types, and the internal base of a public
 * discriminated subtype.
 */
export const internalAccessLeakRule = createRule({
  name: "internal-access-leak",
  severity: "warning",
  description:
    "A public operation or model must not reference an @access(Access.internal) type; the generated C# would fail to compile.",
  url: "https://github.com/MassiveScale/tsp-flurl-client#internal-access-leak",
  messages: {
    default: paramMessage`"${"referencingName"}" is public but its ${"kind"} type "${"internalTypeName"}" is marked @access(Access.internal); the generated C# will fail to compile (CS0053: inconsistent accessibility). Mark "${"internalTypeName"}" @access(Access.public), or mark the ${"container"} that declares "${"referencingName"}" @access(Access.internal) as well.`,
    standalone: paramMessage`"${"referencingName"}" is a namespace-level operation, which is emitted as a public interface method, but its ${"kind"} type "${"internalTypeName"}" is marked @access(Access.internal); the generated C# will fail to compile (CS0053: inconsistent accessibility). Mark "${"internalTypeName"}" @access(Access.public), or move the operation into an interface marked @access(Access.internal).`,
    base: paramMessage`"${"referencingName"}" is public but its base type "${"internalTypeName"}" is marked @access(Access.internal); the generated C# will fail to compile (CS0060: inconsistent accessibility of the base type). Mark "${"internalTypeName"}" @access(Access.public), or mark "${"referencingName"}" @access(Access.internal) as well.`,
  },
  create(context) {
    function checkReferencedTypes(
      type: Type,
      referencingName: string,
      kind: string,
      target: Operation | ModelProperty,
      standalone = false,
    ): void {
      for (const named of resolveNamedTypes(context.program, type)) {
        if (getAccess(context.program, named) === "internal") {
          context.reportDiagnostic({
            target,
            messageId: standalone ? "standalone" : "default",
            format: {
              referencingName,
              kind,
              // An operation's access is ignored (C# interface members are always
              // public), so the fix is on the interface, or on the model for a property.
              container: kind === "property" ? "model" : "interface",
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

        // An operation marked @access(Access.internal) is still checked: the emitter
        // ignores operation access because C# interface methods cannot carry an
        // access modifier, so such a method is public in the generated interface.
        for (const op of iface.operations.values()) {
          for (const prop of op.parameters.properties.values()) {
            checkReferencedTypes(prop.type, op.name, "parameter", prop);
          }
          checkReferencedTypes(op.returnType, op.name, "return", op);
        }
      },
      // An operation declared directly in a namespace is emitted as a public method
      // of a public interface, and there is no container to mark internal. The ones
      // in an interface are checked by the interface visitor above.
      operation: (op: Operation) => {
        if (op.interface) return;
        for (const prop of op.parameters.properties.values()) {
          checkReferencedTypes(prop.type, op.name, "parameter", prop, true);
        }
        checkReferencedTypes(op.returnType, op.name, "return", op, true);
      },
      model: (model: Model) => {
        // A template instance such as `Page<Secret>` is emitted as the generic
        // `Page<T>`, whose declaration never names `Secret`. The leak is where the
        // instance is used, which the operation and property checks report.
        if (model.templateMapper) return;

        const modelAccess = getAccess(context.program, model) ?? "public";
        if (modelAccess === "internal") return;

        // In a discriminated hierarchy the emitter keeps C# inheritance
        // (`public record Dog : Pet`), and a base type must be at least as
        // accessible as the type that derives from it.
        const base = model.baseModel && declarationOf(model.baseModel);
        if (
          base?.name &&
          findDiscriminatedRoot(context.program, base) &&
          getAccess(context.program, base) === "internal"
        ) {
          context.reportDiagnostic({
            target: model,
            messageId: "base",
            format: {
              referencingName: model.name,
              internalTypeName: base.name,
            },
          });
        }

        for (const [, prop] of flattenProperties(model)) {
          checkReferencedTypes(prop.type, prop.name, "property", prop);
        }
      },
    };
  },
});
