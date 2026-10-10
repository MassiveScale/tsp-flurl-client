// C# project-file generation: builds the `.csproj` view and derives the NuGet
// `<Version>` from the targeted TypeSpec API version (semver when parseable,
// otherwise CalVer).

import { Version } from "@typespec/versioning";
import { Renderer, CsprojView } from "./renderer.js";
import { EmitterOptions } from "./lib.js";

/**
 * Renders the generated `.csproj` file for the client package.
 *
 * @param rootNs - Root C# namespace, written as `<RootNamespace>`.
 * @param netVersion - Target framework moniker(s); a single TFM or a
 *   semicolon-separated list for multi-targeting.
 * @param isMultiTarget - When `true`, emit `<TargetFrameworks>` (plural) instead
 *   of `<TargetFramework>`.
 * @param nugetVersion - Value for the NuGet `<Version>` property.
 * @param nugetDescription - Value for the NuGet `<Description>` property.
 * @param nugetTitle - Value for the NuGet `<Title>` property, or `undefined` to omit it.
 * @param options - Emitter options supplying the remaining optional NuGet fields
 *   (`nuget-package-id`, `nuget-authors`, `nuget-tags`).
 * @param renderer - Handlebars renderer used to produce the file contents.
 * @returns The full XML source of the generated `.csproj`.
 */
export function buildCsproj(
  rootNs: string,
  netVersion: string,
  isMultiTarget: boolean,
  nugetVersion: string,
  nugetDescription: string,
  nugetTitle: string | undefined,
  options: EmitterOptions,
  renderer: Renderer,
): string {
  const view: CsprojView = {
    rootNamespace: rootNs,
    netVersion,
    isMultiTarget,
    nugetDescription,
    nugetTitle,
    nugetPackageId: options["nuget-package-id"],
    nugetVersion,
    nugetAuthors: options["nuget-authors"],
    nugetTags: options["nuget-tags"],
  };
  return renderer.renderCsproj(view);
}

/**
 * Attempts to parse a semver string from a TypeSpec version value.
 * Accepts an optional leading `v`/`V`, two-part (`1.2`) or three-part (`1.2.3`)
 * numeric versions, and preserves any pre-release / build-metadata suffix.
 * Returns `undefined` when the string cannot be interpreted as semver.
 */
export function tryParseSemver(value: string): string | undefined {
  const stripped = value.replace(/^[vV]/, "");
  const match = stripped.match(/^(\d+)\.(\d+)(?:\.(\d+))?([-+].+)?$/);
  if (!match) return undefined;
  const patch = match[3] ?? "0";
  const rest = match[4] ?? "";
  return `${match[1]}.${match[2]}.${patch}${rest}`;
}

/** Formats a date as a CalVer string (`YYYY.MM.DD`). */
export function toCalVer(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}.${m}.${d}`;
}

/**
 * Derives the NuGet `<Version>` to write into the `.csproj`.
 *
 * Priority:
 * 1. `nuget-version` option (explicit override)
 * 2. Semver parsed from the targeted TypeSpec API version
 *    - `target-version` (single-version mode) if specified
 *    - Latest declared version otherwise (covers both default single-version and all-versions)
 * 3. CalVer (`YYYY.MM.DD`) when no version is declared or semver cannot be parsed
 */
export function deriveNugetVersion(
  allVersions: Version[],
  options: EmitterOptions,
): string {
  if (options["nuget-version"]) return options["nuget-version"];

  let versionString: string | undefined;
  if (allVersions.length > 0) {
    if (options["target-version"] && options["all-versions"] !== true) {
      versionString = allVersions.find(
        (v) => v.value === options["target-version"],
      )?.value;
    }
    versionString ??= allVersions[allVersions.length - 1].value;
  }

  if (versionString) {
    const parsed = tryParseSemver(versionString);
    if (parsed) return parsed;
  }

  return toCalVer(new Date());
}
