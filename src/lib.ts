import {
  createTypeSpecLibrary,
  JSONSchemaType,
  paramMessage,
} from "@typespec/compiler";
import type { TemplateOverrides } from "./renderer.js";

/** Options accepted by the emitter, configured under the emitter's key in `tspconfig.yaml`. */
export interface EmitterOptions {
  "project-name"?: string;
  "client-name"?: string;
  "root-namespace"?: string;
  "additional-usings"?: string[];
  "net-version"?: string;
  "target-version"?: string;
  "all-versions"?: boolean;
  "version-in-namespace"?: boolean;
  "route-prefix"?: string;
  "emit-project-file"?: boolean;
  "overwrite-project-file"?: boolean;
  "clean-output-dir"?: boolean;
  "abstract-discriminated-base"?: boolean;
  "dotnet-format"?: boolean;
  "nuget-package-id"?: string;
  "nuget-version"?: string;
  "nuget-authors"?: string;
  "nuget-description"?: string;
  "nuget-title"?: string;
  "nuget-tags"?: string;
  templates?: TemplateOverrides;
}

/** JSON schema describing {@link EmitterOptions}, used by the compiler to validate `tspconfig.yaml`. */
const EmitterOptionsSchema: JSONSchemaType<EmitterOptions> = {
  type: "object",
  additionalProperties: false,
  properties: {
    "project-name": {
      type: "string",
      description:
        "Override the full project name used for the .csproj filename. Defaults to the TypeSpec namespace + 'Client' (e.g. namespace 'My.Api' → 'My.ApiClient'). Dots are valid; C# identifiers use only the final segment.",
      nullable: true,
    },
    "client-name": {
      type: "string",
      description:
        "The client display name. Used as the aggregate client class name, the DI extension class/method prefix (e.g. 'PetStore' → 'AddPetStore(...)') and as the default NuGet <Title> when 'nuget-title' is not set.",
      nullable: true,
    },
    "root-namespace": {
      type: "string",
      description:
        "Override the root C# namespace. Defaults to the TypeSpec namespace + '.Client'.",
      nullable: true,
    },
    "additional-usings": {
      type: "array",
      description:
        "Extra `using` directives appended to every emitted file (endpoint clients, records, and request records). Useful when this service references models/enums declared outside its own TypeSpec namespace but already emitted elsewhere — e.g. a sibling emitter's shared namespace — so referencing them still compiles. Each entry must be a dotted C# namespace (e.g. 'Acme.Shared.Models'); an invalid entry is reported and nothing is emitted. Omitted when not set.",
      nullable: true,
      items: { type: "string" },
    },
    "net-version": {
      type: "string",
      description:
        "Target .NET version(s) for the generated project file. Use a single TFM (e.g. 'net8.0') or a semicolon-separated list for multi-targeting (e.g. 'net8.0;net9.0'). Must be net8.0 or later. Defaults to 'net8.0'.",
      nullable: true,
    },
    "target-version": {
      type: "string",
      description:
        "The specific API version to generate (e.g. 'v2.0'). Defaults to the latest declared version. Ignored when 'all-versions' is true.",
      nullable: true,
    },
    "all-versions": {
      type: "boolean",
      description:
        "When true, generate clients for every declared API version. Defaults to false (latest version only).",
      nullable: true,
    },
    "version-in-namespace": {
      type: "boolean",
      description:
        "When true, appends the sanitized API version to the C# namespace in single-version mode. Ignored when 'all-versions' is true (version is always appended then). Defaults to false.",
      nullable: true,
    },
    "route-prefix": {
      type: "string",
      description:
        "Route prefix prepended to every emitted operation path. Supports the `{version}` token, replaced by the API version value (e.g. 'api/{version}' + 'v1.0' → 'api/v1.0'). When no version is available the token is removed. Set to '' to disable. Defaults to 'api/{version}'.",
      nullable: true,
    },
    "emit-project-file": {
      type: "boolean",
      description:
        "When false, the .csproj is not emitted at all. Defaults to true.",
      nullable: true,
    },
    "overwrite-project-file": {
      type: "boolean",
      description:
        "When false (default), the .csproj is only written if it does not already exist. Set to true to always overwrite it.",
      nullable: true,
    },
    "clean-output-dir": {
      type: "boolean",
      description:
        "When true (default), delete all '*.g.cs' files in 'emitter-output-dir' before emitting. Non-generated files and project files are preserved. Set to false to skip cleanup.",
      nullable: true,
    },
    "abstract-discriminated-base": {
      type: "boolean",
      description:
        "When true (default), any model in a `@discriminator` hierarchy that never appears as a concrete wire variant (the discriminated base itself, and pass-through grouping models with no discriminator value of their own) is emitted as `abstract`, since it has no valid JSON shape of its own. Set to false to emit it as a normal instantiable record.",
      nullable: true,
    },
    "dotnet-format": {
      type: "boolean",
      description:
        "When true (default), run 'dotnet format' on the output directory after emitting. Set to false to skip formatting.",
      nullable: true,
    },
    "nuget-package-id": {
      type: "string",
      description: "NuGet <PackageId>. Omitted when not set.",
      nullable: true,
    },
    "nuget-version": {
      type: "string",
      description:
        "NuGet <Version>. When not set, auto-derived from the targeted TypeSpec API version: parsed as semver if possible (e.g. 'v2.1' → '2.1.0'), otherwise formatted as CalVer (YYYY.MM.DD).",
      nullable: true,
    },
    "nuget-authors": {
      type: "string",
      description: "NuGet <Authors> (comma-separated). Omitted when not set.",
      nullable: true,
    },
    "nuget-description": {
      type: "string",
      description:
        "NuGet <Description>. Defaults to 'Flurl client for the {namespace} API'.",
      nullable: true,
    },
    "nuget-title": {
      type: "string",
      description:
        "NuGet <Title>. Defaults to 'client-name' when set; omitted otherwise.",
      nullable: true,
    },
    "nuget-tags": {
      type: "string",
      description:
        "NuGet <PackageTags> (space-separated). Omitted when not set.",
      nullable: true,
    },
    templates: {
      type: "object",
      description:
        "Override built-in Handlebars templates with custom .hbs file paths.",
      additionalProperties: false,
      nullable: true,
      properties: {
        file: {
          type: "string",
          nullable: true,
          description: "Outer file wrapper template.",
        },
        record: {
          type: "string",
          nullable: true,
          description: "C# record (model) template.",
        },
        enum: {
          type: "string",
          nullable: true,
          description: "C# enum template.",
        },
        "endpoint-interface": {
          type: "string",
          nullable: true,
          description: "Endpoint interface template (e.g. IWidgets).",
        },
        "endpoint-client": {
          type: "string",
          nullable: true,
          description:
            "Endpoint client implementation template (e.g. WidgetsEndpoint).",
        },
        csproj: {
          type: "string",
          nullable: true,
          description: ".csproj project file template.",
        },
        extensions: {
          type: "string",
          nullable: true,
          description:
            "Aggregate client and DI registration extension class template.",
        },
        "merge-patch": {
          type: "string",
          nullable: true,
          description:
            "Generic MergePatch<T> request-body builder template, emitted only when a merge-patch body is used.",
        },
        "model-map": {
          type: "string",
          nullable: true,
          description:
            "ModelMap template: the registry that substitutes custom derived models for generated ones.",
        },
        "client-runtime": {
          type: "string",
          nullable: true,
          description:
            "ClientRuntime template: serializer configuration and wire-format helpers shared by every endpoint client.",
        },
      },
      required: [],
    },
  },
  required: [],
};

/** The emitter's TypeSpec library definition: name, diagnostics, and option schema. */
export const $lib = createTypeSpecLibrary({
  name: "@massivescale/tsp-flurl-client",
  diagnostics: {
    "template-load-failed": {
      severity: "error",
      messages: {
        default: paramMessage`Failed to load Handlebars template: ${"message"}`,
      },
    },
    "version-not-found": {
      severity: "error",
      messages: {
        default: paramMessage`Version "${"version"}" was not found. Available versions: ${"available"}.`,
      },
    },
    "dotnet-format-failed": {
      severity: "warning",
      messages: {
        default: paramMessage`dotnet format failed: ${"message"}`,
      },
    },
    "invalid-client-name": {
      severity: "error",
      messages: {
        default:
          "@clientName(name) requires a valid C# identifier: letters, digits and underscores, not starting with a digit. A model, enum or interface name cannot be a C# keyword.",
      },
    },
    "invalid-name": {
      severity: "error",
      messages: {
        default: paramMessage`The ${"kind"} name "${"name"}" ${"reason"}.`,
      },
    },
    "unsupported-nested-discriminator": {
      severity: "error",
      messages: {
        default: paramMessage`The model "${"name"}" declares its own @discriminator but is also a variant of "${"parent"}", so a value would need two discriminators resolved. System.Text.Json can resolve only one per hierarchy: reading through the base type would return the wrong subtype, and writing a subtype would fail or omit a discriminator. Use a single discriminator for the whole hierarchy, or model the second level as an ordinary property.`,
      },
    },
    "unsupported-encoding": {
      severity: "warning",
      messages: {
        default: paramMessage`The ${"kind"} "${"name"}" uses @encode "${"encoding"}", which this emitter cannot produce or read. The default wire format is used instead, so it will not match what the API expects.`,
      },
    },
    "unsupported-feature": {
      severity: "error",
      messages: {
        default: paramMessage`${"feature"} in operation "${"operation"}" is not supported by this emitter, so the operation is not generated. ${"hint"}`,
      },
    },
    "name-collision": {
      severity: "error",
      messages: {
        default: paramMessage`The C# ${"kind"} name "${"name"}" in ${"scope"} is produced by both ${"first"} and ${"second"}. Give one of them another name with @clientName.`,
      },
    },
    "invalid-option": {
      severity: "error",
      messages: {
        default: paramMessage`Option "${"option"}" has the value "${"value"}", which ${"reason"}.`,
      },
    },
    "invalid-access-modifier": {
      severity: "error",
      messages: {
        default: paramMessage`Unsupported access modifier "${"value"}". Use Access.public or Access.internal.`,
      },
    },
    "output-name-collision": {
      severity: "error",
      messages: {
        default: paramMessage`Generated file name collision for "${"name"}.g.cs": ${"first"} and ${"second"}.`,
      },
    },
  },
  emitter: {
    options: EmitterOptionsSchema,
  },
});

export const { reportDiagnostic, createDiagnostic } = $lib;
