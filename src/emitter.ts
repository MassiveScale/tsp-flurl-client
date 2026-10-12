// Emitter entry point and orchestration. `$onEmit` drives the whole run;
// `emitService` coordinates the per-service pipeline, delegating the actual C#
// generation to the domain modules:
//   - ./endpoints  — endpoint interfaces + Flurl clients (+ request-type collection)
//   - ./models     — records and enums
//   - ./helpers    — ModelMap, ClientRuntime and MergePatch helper files
//   - ./client     — DI extensions + aggregate client
//   - ./project    — .csproj + NuGet version
//   - ./utils      — type mapping and name/format helpers
// Everything else here is coordination: renderer setup, file IO, dotnet-format,
// output-name reservation, and version selection/filtering.

import {
  EmitContext,
  Model,
  Enum,
  Type,
  Interface,
  Namespace,
  Program,
  getDoc,
  getNamespaceFullName,
  resolvePath,
  isService,
  NoTarget,
} from "@typespec/compiler";
import { getAllHttpServices, HttpOperation } from "@typespec/http";
import { getAllVersions, Version } from "@typespec/versioning";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createRenderer, Renderer, TemplateOverrides } from "./renderer.js";
import { EmitterOptions, createDiagnostic } from "./lib.js";
import { isCsNamespace, isCsTypeName } from "./identifiers.js";
import { getClientName, getAccess } from "./decorators.js";
import { buildEndpoint, RequestType } from "./endpoints.js";
import {
  buildRecord,
  buildFilteredRecord,
  buildEnum,
  collectDerivedModels,
  isEmittable,
  isEmittableEnum,
} from "./models.js";
import {
  ALL_HELPERS,
  ALWAYS_EMITTED_HELPERS,
  buildHelper,
  helperFolder,
  type HelperName,
} from "./helpers.js";
import { buildExtensions, type EndpointName } from "./client.js";
import { buildCsproj, deriveNugetVersion } from "./project.js";
import {
  sanitizeVersionForNs,
  isInVersion,
  MERGE_PATCH_HELPER_NAME,
  type UsedHelpers,
} from "./utils.js";

/** For each helper, the C# namespaces that need a copy of it. */
type HelperNamespaces = Map<HelperName, Set<string>>;

/** Records which declaration first claimed a given output file name, for collision reporting. */
type OutputNameOwner = {
  /** Human-readable label of the claiming declaration (e.g. `model Widget`). */
  label: string;
};

/**
 * Emitter entry point invoked by the TypeSpec compiler. Cleans stale output,
 * builds the renderer, then emits every HTTP service in the program and finally
 * runs `dotnet format` (unless disabled).
 *
 * @param context - The emit context supplying the program, output dir, and options.
 */
export async function $onEmit(
  context: EmitContext<EmitterOptions>,
): Promise<void> {
  const { program, emitterOutputDir, options } = context;
  if (program.compilerOptions.noEmit) return;

  if (options["clean-output-dir"] !== false) {
    await deleteGcsFiles(program, emitterOutputDir);
  }

  const renderer = buildRenderer(program, options);

  const [services, diags] = getAllHttpServices(program);
  program.reportDiagnostics(diags);

  // Each service emits into its own C# namespace but shares one output directory,
  // so the helpers have to be collected across all of them and written afterwards —
  // emitting them per service would have the last service overwrite the file and
  // leave every earlier namespace referencing a type that isn't there.
  const helperNamespaces: HelperNamespaces = new Map(
    ALL_HELPERS.map((name) => [name, new Set<string>()]),
  );
  // Endpoint and aggregate-client files are named after the interface and client,
  // not the service, so two services can aim at the same path. Their reservations
  // are shared so the clash is reported instead of the later write winning.
  const endpointOutputOwners = new Map<string, OutputNameOwner>();

  for (const service of services) {
    if (!isService(program, service.namespace)) continue;
    if (service.operations.length === 0) continue;
    await emitService(
      program,
      service.namespace,
      service.operations,
      emitterOutputDir,
      options,
      renderer,
      helperNamespaces,
      endpointOutputOwners,
    );
  }

  await emitHelpers(
    program,
    emitterOutputDir,
    helperNamespaces,
    renderer,
    new Set(options["additional-usings"] ?? []),
  );

  if (options["dotnet-format"] !== false) {
    runDotnetFormat(program, emitterOutputDir);
  }
}

/**
 * Writes each helper once for every C# namespace that needs it.
 *
 * With a single service — the normal case — each helper is one file
 * (`Infrastructure/ModelMap.g.cs`, `Models/MergePatch.g.cs`, ...). A program
 * declaring several `@service` namespaces needs the helpers visible in each of
 * them, and C# allows one class name per namespace but only one file per path, so
 * the extra copies get a namespace-qualified file name.
 *
 * @param program - The compiler program (its host performs the writes).
 * @param outputDir - The root emitter output directory.
 * @param helperNamespaces - For each helper, the C# namespaces that reference it.
 * @param renderer - Handlebars renderer used to produce the file contents.
 * @param additionalUsings - Extra `using` directives from the `additional-usings` option.
 */
async function emitHelpers(
  program: Program,
  outputDir: string,
  helperNamespaces: HelperNamespaces,
  renderer: Renderer,
  additionalUsings: Set<string>,
): Promise<void> {
  for (const name of ALL_HELPERS) {
    const sorted = [...(helperNamespaces.get(name) ?? [])].sort();
    for (const [index, ns] of sorted.entries()) {
      const fileName = index === 0 ? `${name}.g.cs` : `${name}.${ns}.g.cs`;
      await writeFile(
        program,
        resolvePath(outputDir, helperFolder(name), fileName),
        buildHelper(name, ns, renderer, additionalUsings),
      );
    }
  }
}

/**
 * Creates the Handlebars renderer, applying any configured template overrides.
 * On failure to load an override, reports a `template-load-failed` diagnostic
 * and falls back to the built-in templates.
 *
 * @param program - The compiler program, used to report diagnostics.
 * @param options - Emitter options carrying optional template overrides.
 * @returns A ready-to-use renderer.
 */
function buildRenderer(program: Program, options: EmitterOptions): Renderer {
  const overrides = resolveTemplateOverrides(options.templates);
  try {
    return createRenderer(overrides);
  } catch (e) {
    program.reportDiagnostic(
      createDiagnostic({
        code: "template-load-failed",
        target: NoTarget,
        format: { message: String(e) },
      }),
    );
    return createRenderer({});
  }
}

/**
 * Resolves configured template override paths to absolute paths (relative to the
 * current working directory), dropping empty entries.
 *
 * @param templates - The raw template overrides from options, if any.
 * @returns A map of template name to absolute override path.
 */
function resolveTemplateOverrides(
  templates?: TemplateOverrides,
): TemplateOverrides {
  if (!templates) return {};
  const result: TemplateOverrides = {};
  for (const [key, val] of Object.entries(templates)) {
    if (val) {
      (result as Record<string, string>)[key] = resolve(process.cwd(), val);
    }
  }
  return result;
}

/**
 * Whether a file exists at the given path on the compiler host.
 *
 * @param program - The compiler program (its host performs the stat).
 * @param filePath - Absolute path to check.
 * @returns `true` if the path exists and is a file.
 */
async function fileExists(
  program: Program,
  filePath: string,
): Promise<boolean> {
  try {
    const s = await program.host.stat(filePath);
    return s.isFile();
  } catch {
    return false;
  }
}

/**
 * Writes a file through the compiler host, creating parent directories as needed.
 *
 * @param program - The compiler program (its host performs the write).
 * @param filePath - Absolute destination path.
 * @param content - File contents to write.
 */
async function writeFile(
  program: Program,
  filePath: string,
  content: string,
): Promise<void> {
  const dir = filePath.substring(0, filePath.lastIndexOf("/"));
  if (dir) await program.host.mkdirp(dir);
  await program.host.writeFile(filePath, content);
}

/**
 * Recursively deletes all `*.g.cs` files under a directory (the pre-emit
 * cleanup pass), leaving non-generated files and project files in place. A
 * missing directory is a no-op.
 *
 * @param program - The compiler program (its host performs the IO).
 * @param dir - Directory to clean, recursively.
 */
async function deleteGcsFiles(program: Program, dir: string): Promise<void> {
  let entries: string[];
  try {
    entries = await program.host.readDir(dir);
  } catch {
    return;
  }
  await Promise.all(
    entries.map(async (entry) => {
      const entryPath = resolvePath(dir, entry);
      let stat;
      try {
        stat = await program.host.stat(entryPath);
      } catch {
        return;
      }
      if (stat.isDirectory()) {
        await deleteGcsFiles(program, entryPath);
      } else if (stat.isFile() && entry.endsWith(".g.cs")) {
        await program.host.rm(entryPath);
      }
    }),
  );
}

/**
 * Runs `dotnet format --no-restore` over the output directory to normalize the
 * generated C#. Skipped when the directory doesn't exist on the real filesystem
 * (e.g. the in-memory test harness); a non-zero exit reports a
 * `dotnet-format-failed` diagnostic rather than throwing.
 *
 * @param program - The compiler program, used to report diagnostics.
 * @param outputDir - The emitter output directory to format.
 */
function runDotnetFormat(program: Program, outputDir: string): void {
  // Skip when the output directory doesn't exist on the real filesystem
  // (e.g. in-memory test harness).
  if (!existsSync(outputDir)) return;

  const result = spawnSync("dotnet", ["format", outputDir, "--no-restore"], {
    encoding: "utf-8",
    stdio: "pipe",
  });

  if (result.error || (result.status !== null && result.status !== 0)) {
    const message =
      result.error?.message ??
      result.stderr?.trim() ??
      `exited with code ${result.status}`;
    program.reportDiagnostic(
      createDiagnostic({
        code: "dotnet-format-failed",
        target: NoTarget,
        format: { message },
      }),
    );
  }
}

/**
 * Checks the names that become file paths and C# identifiers before anything is
 * written: a project name such as `../../Outside` would write the `.csproj` outside
 * the output directory, and a client name such as `class` would generate C# that
 * cannot compile. Reports an `invalid-option` diagnostic for each bad value.
 *
 * @param program - The compiler program, used to report diagnostics.
 * @param projectName - The effective project name (dots separate namespace-like segments).
 * @param clientName - The effective aggregate client name.
 * @param rootNamespace - The effective root C# namespace.
 * @param clientNameIsDerived - Whether the client name was derived from the project
 *   name rather than given. A derived name is only checked when the project name is
 *   valid, so one bad project name is reported once.
 * @returns `true` when every name is safe to use; `false` after reporting.
 */
function validateNames(
  program: Program,
  projectName: string,
  clientName: string,
  rootNamespace: string,
  clientNameIsDerived: boolean,
): boolean {
  const problems: { option: string; value: string; reason: string }[] = [];
  if (!isCsNamespace(projectName)) {
    problems.push({
      option: "project-name",
      value: projectName,
      reason:
        "is not a safe file name; use dot-separated C# identifiers such as `Acme.PetStoreClient`",
    });
  }
  if (
    !isCsTypeName(clientName) &&
    !(clientNameIsDerived && problems.length > 0)
  ) {
    problems.push({
      option: "client-name",
      value: clientName,
      reason: "is not a valid C# class name (it must not be a C# keyword)",
    });
  }
  if (!isCsNamespace(rootNamespace)) {
    problems.push({
      option: "root-namespace",
      value: rootNamespace,
      reason: "is not a valid C# namespace",
    });
  }

  for (const format of problems) {
    program.reportDiagnostic(
      createDiagnostic({ code: "invalid-option", target: NoTarget, format }),
    );
  }
  return problems.length === 0;
}

/**
 * Emits all output for a single HTTP service: resolves options and target
 * versions, groups operations by container, then writes the endpoint interfaces
 * and clients (via {@link buildEndpoint}), request-type records, DI extensions,
 * model and enum files, and finally the `.csproj`. Handles both versioned
 * (optionally per-version folders) and unversioned emission.
 *
 * @param program - The compiler program.
 * @param serviceNs - The service namespace being emitted.
 * @param operations - The service's HTTP operations.
 * @param outputDir - The root emitter output directory.
 * @param options - The resolved emitter options.
 * @param renderer - Handlebars renderer used to produce file contents.
 * @param helperNamespaces - Shared accumulator of the C# namespaces needing each
 *   helper. This service adds its own namespace to every helper it uses; the
 *   caller writes the helper files once every service has been emitted.
 * @param endpointOutputOwners - Shared record of which declaration claimed each
 *   endpoint and aggregate-client file, keyed by path relative to the output
 *   directory, so clashes between services are reported.
 */
async function emitService(
  program: Program,
  serviceNs: Namespace,
  operations: HttpOperation[],
  outputDir: string,
  options: EmitterOptions,
  renderer: Renderer,
  helperNamespaces: HelperNamespaces,
  endpointOutputOwners: Map<string, OutputNameOwner>,
): Promise<void> {
  const nsFullName = getNamespaceFullName(serviceNs);
  const projectName = options["project-name"] ?? `${nsFullName}Client`;
  const csharpName = projectName.includes(".")
    ? projectName.substring(projectName.lastIndexOf(".") + 1)
    : projectName;
  const clientName = options["client-name"] ?? csharpName;
  const baseNs = options["root-namespace"] ?? `${nsFullName}.Client`;
  if (
    !validateNames(
      program,
      projectName,
      clientName,
      baseNs,
      options["client-name"] === undefined,
    )
  )
    return;
  const rawNetVersion = options["net-version"] ?? "net8.0";
  const netVersionParts = rawNetVersion
    .split(";")
    .map((v) => v.trim())
    .filter(Boolean);
  const netVersion = netVersionParts.join(";");
  const isMultiTarget = netVersionParts.length > 1;

  const rawRoutePrefix = options["route-prefix"] ?? "api/{version}";
  const additionalUsings = new Set(options["additional-usings"] ?? []);
  const nugetDescription =
    options["nuget-description"] ?? `Flurl client for the ${baseNs} API`;
  const nugetTitle =
    options["nuget-title"] ??
    (options["client-name"] !== undefined ? clientName : undefined);
  const allVersions = getAllVersions(program, serviceNs) ?? [];

  // Group operations by container (Interface or Namespace)
  const byContainer = new Map<
    string,
    { name: string; container: Interface | Namespace; ops: HttpOperation[] }
  >();
  for (const op of operations) {
    const c = op.container;
    const key =
      c.kind === "Interface" ? c.name : `__ns_${(c as Namespace).name}`;
    const baseName =
      c.kind === "Interface"
        ? (getClientName(program, c) ?? c.name)
        : serviceNs.name;
    if (!byContainer.has(key))
      byContainer.set(key, { name: baseName, container: c, ops: [] });
    byContainer.get(key)!.ops.push(op);
  }

  const versionsToEmit = resolveTargetVersions(program, allVersions, options);
  if (versionsToEmit === null) return; // diagnostic already reported

  // Use version subfolders only when explicitly emitting all versions.
  const useVersionedFolders = options["all-versions"] === true;

  /**
   * Emits one self-contained set of output: the endpoint interfaces and clients,
   * the aggregate client, and exactly the models, enums and request records those
   * endpoints reference, projected onto the unit's API version. A unit owns its
   * own model and enum accumulators and its own output-name reservations, so the
   * same name can be used by different versions without clashing.
   *
   * @param unit - Where and how to emit.
   * @param unit.dir - Folder the Endpoints folder and aggregate client are written under.
   * @param unit.endpointNs - C# namespace of the endpoints and aggregate client.
   * @param unit.modelNs - C# namespace of the models, enums, and request records.
   * @param unit.modelsDir - Folder the models, enums, and request records are written to.
   * @param unit.version - The API version emitted, or `undefined` when unversioned.
   */
  const emitUnit = async (unit: {
    dir: string;
    endpointNs: string;
    modelNs: string;
    modelsDir: string;
    version: Version | undefined;
  }): Promise<void> => {
    const { dir, endpointNs, modelNs, modelsDir, version } = unit;
    const models = new Map<string, Model>();
    const enums = new Map<string, Enum>();
    const modelOutputOwners = new Map<string, OutputNameOwner>();
    const usedHelpers: UsedHelpers = new Set();
    const requestTypes = new Map<string, RequestType>();
    const endpointNames: EndpointName[] = [];

    for (const { name, container, ops } of byContainer.values()) {
      const vOps = ops.filter((op) =>
        isInVersion(program, op.operation, version),
      );
      if (vOps.length === 0) continue;
      const interfaceName = `I${name}`;
      const endpointClientName = `${name}Client`;
      const label = `interface ${container.name ?? name} in ${nsFullName}`;
      const claimed = [interfaceName, endpointClientName].map((file) =>
        tryReserveModelOutputName(
          program,
          endpointOutputOwners,
          relativeTo(outputDir, resolvePath(dir, "Endpoints", file)),
          label,
          NoTarget,
        ),
      );
      // Both names are always claimed (so every clash is reported); the interface
      // is only emitted when it won both files.
      if (claimed.includes(false)) continue;
      const access = getAccess(program, container) ?? "public";
      endpointNames.push({
        interfaceName,
        clientName: endpointClientName,
        access,
      });
      const sources = buildEndpoint(
        interfaceName,
        endpointClientName,
        endpointNs,
        vOps,
        getDoc(program, container),
        access,
        program,
        models,
        enums,
        usedHelpers,
        version,
        requestTypes,
        renderer,
        rawRoutePrefix,
        additionalUsings,
      );
      await writeFile(
        program,
        resolvePath(dir, "Endpoints", `${interfaceName}.g.cs`),
        sources.interfaceSource,
      );
      await writeFile(
        program,
        resolvePath(dir, "Endpoints", `${endpointClientName}.g.cs`),
        sources.clientSource,
      );
    }

    // Request records share the models folder, so a model with the same name must
    // be reported, not overwritten.
    for (const [, rt] of requestTypes) {
      if (
        !tryReserveModelOutputName(
          program,
          modelOutputOwners,
          rt.name,
          `the ${rt.name} request type`,
          NoTarget,
        )
      ) {
        continue;
      }
      await writeFile(
        program,
        resolvePath(modelsDir, `${rt.name}.g.cs`),
        buildFilteredRecord(
          rt.name,
          rt.doc,
          rt.props,
          modelNs,
          program,
          models,
          enums,
          usedHelpers,
          renderer,
          additionalUsings,
          rt.access,
        ),
      );
    }

    if (
      endpointNames.length > 0 &&
      tryReserveModelOutputName(
        program,
        endpointOutputOwners,
        relativeTo(outputDir, resolvePath(dir, `${clientName}Extensions`)),
        `the ${clientName} client in ${nsFullName}`,
        NoTarget,
      )
    ) {
      await writeFile(
        program,
        resolvePath(dir, `${clientName}Extensions.g.cs`),
        buildExtensions(clientName, endpointNs, endpointNames, renderer),
      );
    }

    // A model's `derivedModels` are only discovered by walking `@discriminator`
    // hierarchies explicitly — unlike sub-models reached through a property type,
    // they may never appear as an operation parameter/return type or field type.
    collectDerivedModels(program, models, version);

    for (const [, model] of models) {
      if (!isEmittable(model, nsFullName)) continue;
      if (!isInVersion(program, model, version)) continue;
      const recordFileName = getClientName(program, model) ?? model.name!;
      if (
        !tryReserveModelOutputName(
          program,
          modelOutputOwners,
          recordFileName,
          `model ${model.name!}`,
          model,
        )
      ) {
        continue;
      }
      await writeFile(
        program,
        resolvePath(modelsDir, `${recordFileName}.g.cs`),
        buildRecord(
          model,
          modelNs,
          program,
          models,
          enums,
          usedHelpers,
          renderer,
          options["abstract-discriminated-base"] !== false,
          additionalUsings,
          version,
        ),
      );
    }
    for (const [, e] of enums) {
      if (!isEmittableEnum(e, nsFullName)) continue;
      if (!isInVersion(program, e, version)) continue;
      const enumFileName = getClientName(program, e) ?? e.name;
      if (
        !tryReserveModelOutputName(
          program,
          modelOutputOwners,
          enumFileName,
          `enum ${e.name}`,
          e,
        )
      ) {
        continue;
      }
      await writeFile(
        program,
        resolvePath(modelsDir, `${enumFileName}.g.cs`),
        buildEnum(e, modelNs, program, renderer, version),
      );
    }

    // The runtime helpers are needed by every service. MergePatch is only needed
    // when type mapping actually rewrote a merge-patch body. Each is reserved like
    // a model so a user type of the same name reports a collision instead of being
    // silently overwritten, and the files themselves are written by the caller
    // once every service has had its turn. They live in the root namespace, which
    // every version's namespace is nested in, so one copy serves all versions.
    const neededHelpers: HelperName[] = [...ALWAYS_EMITTED_HELPERS];
    if (usedHelpers.has(MERGE_PATCH_HELPER_NAME)) {
      neededHelpers.push(MERGE_PATCH_HELPER_NAME);
    }
    for (const helper of neededHelpers) {
      if (
        tryReserveModelOutputName(
          program,
          modelOutputOwners,
          helper,
          `the ${helper} helper`,
          NoTarget,
        )
      ) {
        helperNamespaces.get(helper)!.add(baseNs);
      }
    }
  };

  if (useVersionedFolders) {
    // Every version is emitted on its own: its own folder, namespace, and models,
    // so each version's types have exactly that version's shape.
    for (const version of versionsToEmit) {
      const vDir = resolvePath(outputDir, version.value);
      const vNs = `${baseNs}.${sanitizeVersionForNs(version.value)}`;
      await emitUnit({
        dir: vDir,
        endpointNs: vNs,
        modelNs: vNs,
        modelsDir: resolvePath(vDir, "Models"),
        version,
      });
    }
  } else {
    // At most one version. Its models live in the root namespace even when the
    // endpoints are placed in a version namespace.
    const version = versionsToEmit[0];
    await emitUnit({
      dir: outputDir,
      endpointNs:
        version && options["version-in-namespace"] === true
          ? `${baseNs}.${sanitizeVersionForNs(version.value)}`
          : baseNs,
      modelNs: baseNs,
      modelsDir: resolvePath(outputDir, "Models"),
      version,
    });
  }

  // Emit project file
  if (options["emit-project-file"] !== false) {
    const csprojPath = resolvePath(outputDir, `${projectName}.csproj`);
    const overwrite = options["overwrite-project-file"] ?? false;
    if (overwrite || !(await fileExists(program, csprojPath))) {
      await writeFile(
        program,
        csprojPath,
        buildCsproj(
          baseNs,
          netVersion,
          isMultiTarget,
          deriveNugetVersion(allVersions, options),
          nugetDescription,
          nugetTitle,
          options,
          renderer,
        ),
      );
    }
  }
}

/**
 * The path of `file` relative to the output directory, with forward slashes, for
 * use as a reservation key and in collision messages.
 *
 * @param outputDir - The root emitter output directory.
 * @param file - An absolute path inside it.
 * @returns The relative path, e.g. `Endpoints/IItems` or `v1.0/Endpoints/IItems`.
 */
function relativeTo(outputDir: string, file: string): string {
  return file.startsWith(outputDir)
    ? file.slice(outputDir.length).replace(/^\/+/, "")
    : file;
}

/**
 * Reserves an output file name for a model/enum, guarding against collisions. On
 * the first claim it records the owner and returns `true`; a subsequent claim of
 * the same name reports an `output-name-collision` diagnostic and returns
 * `false` so the caller skips emitting the clashing file.
 *
 * @param program - The compiler program, used to report diagnostics.
 * @param owners - Map of already-claimed output names to their first owner.
 * @param name - The output file base name being claimed.
 * @param ownerLabel - Human-readable label of the claiming declaration.
 * @param target - The declaration, used as the diagnostic target, or `NoTarget`
 *   for generated files with no corresponding TypeSpec declaration.
 * @returns `true` if the name was free and is now reserved; `false` on collision.
 */
function tryReserveModelOutputName(
  program: Program,
  owners: Map<string, OutputNameOwner>,
  name: string,
  ownerLabel: string,
  target: Type | typeof NoTarget,
): boolean {
  const existing = owners.get(name);
  if (!existing) {
    owners.set(name, { label: ownerLabel });
    return true;
  }

  program.reportDiagnostic(
    createDiagnostic({
      code: "output-name-collision",
      target,
      format: {
        name,
        first: existing.label,
        second: ownerLabel,
      },
    }),
  );
  return false;
}

/**
 * Determines which declared versions to emit: all versions in `all-versions`
 * mode, the single `target-version` when specified, or the latest declared
 * version by default. Reports a `version-not-found` diagnostic and returns
 * `null` when an explicit `target-version` cannot be satisfied.
 *
 * @param program - The compiler program, used to report diagnostics.
 * @param versions - All declared versions in declaration order (empty when unversioned).
 * @param options - The resolved emitter options.
 * @returns The versions to emit (possibly empty for unversioned APIs), or `null`
 *   when the requested version is unresolvable.
 */
function resolveTargetVersions(
  program: Program,
  versions: Version[],
  options: EmitterOptions,
): Version[] | null {
  const targetValue = options["target-version"];

  // All-versions mode: emit every declared version (or fall through to unversioned).
  if (options["all-versions"]) {
    return versions; // may be empty for unversioned APIs
  }

  // Unversioned API: target-version is unsatisfiable.
  if (versions.length === 0) {
    if (targetValue) {
      program.reportDiagnostic(
        createDiagnostic({
          code: "version-not-found",
          target: NoTarget,
          format: {
            version: targetValue,
            available: "none (API is not versioned)",
          },
        }),
      );
      return null;
    }
    return [];
  }

  // Versioned API with an explicit target.
  if (targetValue) {
    const found = versions.find((v) => v.value === targetValue);
    if (!found) {
      program.reportDiagnostic(
        createDiagnostic({
          code: "version-not-found",
          target: NoTarget,
          format: {
            version: targetValue,
            available: versions.map((v) => v.value).join(", "),
          },
        }),
      );
      return null;
    }
    return [found];
  }

  // Default: latest declared version (last in declaration order).
  return [versions[versions.length - 1]];
}
