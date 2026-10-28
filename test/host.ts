import { Diagnostic, resolvePath } from "@typespec/compiler";
import { expectDiagnosticEmpty } from "@typespec/compiler/testing";
import { createTester } from "@typespec/compiler/testing";
import type { EmitterOptions } from "../src/lib.js";

/**
 * The compiler tester every suite starts from: this emitter's TypeSpec library
 * with `@typespec/http` and `@typespec/versioning` available to the test specs.
 */
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

/**
 * The compiler tester, set to run this emitter with the given options.
 *
 * @param options - Emitter options, as under the emitter's key in `tspconfig.yaml`.
 * @returns The tester.
 */
function testerFor(options?: EmitterOptions) {
  return BaseTester.emit(
    "@massivescale/tsp-flurl-client",
    (options ?? {}) as Record<string, unknown>,
  );
}

/**
 * Compiles a spec, runs the emitter, and returns what it wrote together with every
 * diagnostic, for tests that expect diagnostics.
 *
 * @param code - The TypeSpec source.
 * @param options - Emitter options, as under the emitter's key in `tspconfig.yaml`.
 * @returns The emitted files keyed by path, and the diagnostics.
 */
export async function emitWithDiagnostics(
  code: string,
  options?: EmitterOptions,
): Promise<[Record<string, string>, readonly Diagnostic[]]> {
  const [{ outputs }, diagnostics] =
    await testerFor(options).compileAndDiagnose(code);
  return [outputs, diagnostics];
}

/**
 * Compiles a spec and runs the emitter, failing the test on any diagnostic.
 *
 * @param code - The TypeSpec source.
 * @param options - Emitter options, as under the emitter's key in `tspconfig.yaml`.
 * @returns The emitted files keyed by path.
 */
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
 * @param suffix - File name (or path tail) to look for, e.g. `WidgetsRequestBuilders.g.cs`.
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

/**
 * The messages of the diagnostics whose code ends with a suffix, such as
 * `name-collision`, so a test can ignore the library prefix.
 *
 * @param diagnostics - The diagnostics a compile reported.
 * @param suffix - The end of the code to keep.
 * @returns The messages, in the order reported.
 */
export function messagesFor(
  diagnostics: readonly { code: string; message: string }[],
  suffix: string,
): string[] {
  return diagnostics
    .filter((d) => d.code.endsWith(suffix))
    .map((d) => d.message);
}

/**
 * Whether the emitter wrote a file whose path ends with a suffix.
 *
 * @param outputs - The emitter outputs keyed by path.
 * @param suffix - File name (or path tail), e.g. `/Widget.g.cs`.
 * @returns `true` when such a file was written.
 */
export function has(outputs: Record<string, string>, suffix: string): boolean {
  return Object.keys(outputs).some((k) => k.endsWith(suffix));
}
