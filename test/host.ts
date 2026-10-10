import { Diagnostic, resolvePath } from "@typespec/compiler";
import { expectDiagnosticEmpty } from "@typespec/compiler/testing";
import { createTester } from "@typespec/compiler/testing";
import type { EmitterOptions } from "../src/lib.js";

export const BaseTester = createTester(
  resolvePath(import.meta.dirname, "../.."),
  {
    libraries: [
      "@massivescale/tsp-flurl-client",
      "@typespec/http",
      "@typespec/versioning",
    ],
  },
);

function testerFor(options?: EmitterOptions) {
  return BaseTester.emit(
    "@massivescale/tsp-flurl-client",
    (options ?? {}) as Record<string, unknown>,
  );
}

export async function emitWithDiagnostics(
  code: string,
  options?: EmitterOptions,
): Promise<[Record<string, string>, readonly Diagnostic[]]> {
  const [{ outputs }, diagnostics] =
    await testerFor(options).compileAndDiagnose(code);
  return [outputs, diagnostics];
}

export async function emit(
  code: string,
  options?: EmitterOptions,
): Promise<Record<string, string>> {
  const [result, diagnostics] = await emitWithDiagnostics(code, options);
  expectDiagnosticEmpty(diagnostics);
  return result;
}

/**
 * Returns the content of the single emitted file whose path ends with `suffix`,
 * failing loudly when it is missing so a test never asserts against `undefined`.
 *
 * @param outputs - The emitter outputs keyed by path.
 * @param suffix - File name (or path tail) to look for, e.g. `IWidgets.g.cs`.
 * @returns The file content.
 */
export function fileContent(
  outputs: Record<string, string>,
  suffix: string,
): string {
  const path = Object.keys(outputs).find((k) => k.endsWith(suffix));
  if (path === undefined) {
    throw new Error(
      `Expected an emitted file ending in "${suffix}". Emitted: ${Object.keys(outputs).join(", ")}`,
    );
  }
  return outputs[path];
}
