import "../dist/src/decorators.js";

using TypeSpec.Reflection;

namespace MassiveScale.TspFlurlClient;

/**
 * Allowed C# access modifiers for emitted types.
 */
enum Access {
  /** Emit as C# `public` (the default). */
  public,
  /** Emit as C# `internal`. */
  internal,
}

/**
 * Override the name used for this element in the emitted C# library.
 *
 * - On a `model`: replaces the C# record name and file name.
 * - On an `enum`: replaces the C# enum name and file name.
 * - On an `interface`: replaces the name portion of the C# interface
 *   (the `I` prefix is still added automatically).
 * - On an `op`: replaces the base method name (the `Async` suffix is still
 *   appended and the first letter is capitalised).
 * - On a `model property`: replaces the emitted C# property name. The original
 *   TypeSpec property name is still used as the JSON wire name.
 *
 * @param name The C# identifier to use in the emitted output.
 */
extern dec clientName(
  target: Model | Interface | Enum | Operation | ModelProperty,
  name: valueof string
);

/**
 * Override the C# access modifier for the emitted type.
 *
 * Applies to models (`record`), enums, and interfaces. Has no effect on
 * individual operations because C# interface methods do not carry explicit
 * access modifiers.
 *
 * @param value `Access.public` (default) or `Access.internal`.
 */
extern dec access(
  target: Model | Interface | Enum | Operation | ModelProperty,
  value: MassiveScale.TspFlurlClient.Access
);
