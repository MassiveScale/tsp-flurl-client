# Project Instructions

This file is the **single source of truth** for AI assistant guidance in this repository. All project conventions, architecture notes, and development instructions live here. `CLAUDE.md` at the repo root points to this file.

---

## Project Overview

`@massivescale/tsp-flurl-client` is a [TypeSpec](https://typespec.io) emitter that generates C# API clients using [Flurl.Http](https://flurl.dev). Given a TypeSpec definition, it produces a C# project with an endpoint interface and a Flurl-backed implementation for each TypeSpec `interface`, including version-aware client generation.

It deliberately mirrors [`@massivescale/tsp-refit-client`](https://github.com/MassiveScale/tsp-refit-client): same options, decorators, versioning, model, and merge-patch behaviour. Keep the two in step unless a difference is forced by Flurl. When in doubt about how something should behave, check what the Refit emitter does first.

What this emitter adds is **extensible models**. Users derive their own types from the generated records, send them to the API, and read responses back as them. The API may collect the extra properties as JSON extension properties; whether it accepts them is the implementor's concern, never the emitter's. See "Custom models" below before touching anything that affects serialization.

While not a dependency, this emitter is often used in conjunction with [@massivescale/tsp-aspnetcore-api](https://github.com/MassiveScale/tsp-aspnetcore-api) and supports similar implementation patterns.

---

## Commands

```powershell
npm run build          # Compile TypeScript → dist/
npm test               # Run tests (requires build first)
npm run lint           # Lint src/ and test/
npm run lint:fix       # Lint with auto-fix
npm run format         # Format all files with Prettier
npm run format:check   # Check formatting without writing
npm run watch          # Watch mode TypeScript compilation
npm run test:coverage  # Run tests under c8
```

**Important:** Tests run against compiled output in `dist/`. Always run `npm run build` before `npm test`, or chain them:

```powershell
npm run build && npm test
```

To run a single test file after building:

```powershell
node --test dist/test/emitter.test.js
```

always run `npm run format` after any change

---

## Architecture

### TypeSpec Emitter Pattern

TypeSpec discovers this emitter via two required exports in `src/index.ts`:

- **`$lib`** (`src/lib.ts`) — Registers the library name (`"@massivescale/tsp-flurl-client"`) and declares compiler diagnostics via `createTypeSpecLibrary`. Add new diagnostic codes here before using `reportDiagnostic` or `createDiagnostic`.
- **`$onEmit`** (`src/emitter.ts`) — The emitter entry point called by the TypeSpec compiler. Receives an `EmitContext` containing the program's type graph, then orchestrates the run.

### Source Layout

Generation logic is split by output domain, each with a matching `test/<name>.test.ts`:

- **`src/emitter.ts`** — Entry point and orchestration only: `$onEmit`, the per-service pipeline (`emitService`), renderer setup, file IO, `dotnet format`, output-name reservation, and version selection. Each API version is emitted as its own unit (`emitUnit`) with its own model and enum accumulators and its own name reservations, so with `all-versions` every version gets models shaped exactly as that version declares them. Delegates all C# generation to the modules below.
- **`src/endpoints.ts`** — Endpoint generation: for each TypeSpec interface, the C# interface and its Flurl implementation; route resolution into interpolated path strings; parameter bindings; body and response payload kinds; the generic overloads (see below); and collection of visibility-filtered request payload types.
- **`src/models.ts`** — C# `record` and `enum` generation, including `@discriminator` polymorphic hierarchies, request-payload records, and namespace-based emission filters.
- **`src/helpers.ts`** — The hand-written C# the generated project depends on: `ModelMap`, `ClientRuntime`, and `MergePatch<T>`. Written once per C# namespace.
- **`src/client.ts`** — The aggregate client class (with `Create` factories) and the DI registration extension class.
- **`src/project.ts`** — `.csproj` generation and NuGet `<Version>` derivation.
- **`src/utils.ts`** — Dependency-light shared helpers: C# type mapping (`mapType`), `findModelSlot`, and name/formatting utilities. A leaf module — never imports the other codegen modules.
- **`src/renderer.ts`** — Handlebars renderer, view interfaces, and the method-block renderers. **`src/decorators.ts`** — `@clientName` / `@access` decorator implementations.
- **`src/templates/*.hbs`** — The C# templates, copied to `dist/templates` by `scripts/copy-templates.mjs`. Each documents its variables in a header comment.

Import direction is a DAG: `utils` ← `models` ← `endpoints`; `helpers`/`client`/`project` ← `emitter`; `emitter` is the only module that imports the domain modules.

### Custom models

This is the feature that distinguishes this emitter. Four mechanisms cooperate, and a change to any of them needs the end-to-end tests (see below) as well as the unit tests:

1. **Records are never sealed**, so users can derive from them. Do not add `sealed` to generated records.
2. **Sending.** Request bodies are passed to Flurl as `object`, so `System.Text.Json` serializes the runtime type and a derived model keeps its extra properties. Collection bodies are emitted as covariant `IEnumerable<T>` / `IReadOnlyDictionary<string, T>` and merge-patch bodies as covariant `IMergePatch<T>` so a `List<MyWidget>` or `MergePatch<MyWidget>` is accepted. Optional null properties are omitted (`DefaultIgnoreCondition.WhenWritingNull`).
3. **Reading, per call.** Every operation whose response contains a named model (`findModelSlot` in `src/utils.ts`) gets a generic overload `Task<TResult> OpAsync<TResult>(...) where TResult : Model`. The declared overload forwards to it. `Widget[]` becomes `List<TResult>`, `Record<Widget>` becomes `Dictionary<string, TResult>`.
4. **Reading, everywhere.** `ModelMap` (`src/templates/model-map.hbs`) is a registry of `TModel → TCustom` substitutions that `ClientRuntime` (`src/templates/client-runtime.hbs`) applies to the Flurl client's `System.Text.Json` serializer, so it also governs raw Flurl calls on the exposed `IFlurlClient`. Models outside a `@discriminator` hierarchy use a `JsonConverterFactory`. Models inside one cannot (System.Text.Json owns derived-type resolution there), so the map rewrites the base type's derived-type list, and a custom subtype used on its own registers itself so its discriminator is still written.

The behaviour of (4) was validated against real .NET before it was built; do not change the serializer logic from reasoning alone. The known limits (a custom subtype nested under a discriminated base must be in the map; a discriminated base cannot itself be mapped; `net8.0` or later is required) are documented in the README. Keep that table accurate.

### Test Infrastructure

`test/host.ts` sets up a TypeSpec test harness using `createTester` pointed at the repo root, with `@massivescale/tsp-flurl-client` as the loaded library. It exports:

- `emit(code)` — Compiles inline TypeSpec, asserts no diagnostics, returns `Record<string, string>` mapping output file paths to their string content.
- `emitWithDiagnostics(code)` — Same but also returns compiler diagnostics for testing error cases.
- `fileContent(outputs, suffix)` — Returns one emitted file's content, failing loudly if it is absent.

Tests use Node.js native test runner (`node:test` / `node:assert`) — no external test framework.

**End-to-end tests** live in `e2e/CustomModels.Tests` (MSTest.Sdk, AwesomeAssertions). They reference the C# generated from `example/custom-models` and drive it through a stubbed `HttpMessageHandler`, so they prove the generated code really sends and reads derived models. TypeScript tests can only assert on emitted text, so any change to emitted C# behaviour should be exercised here too.

```powershell
cd example/custom-models; npm install; npx tsp compile .
dotnet run --project ../../e2e/CustomModels.Tests
```

On a machine whose NuGet config includes a private feed that rejects the current credentials, add `-p:RestoreSources=https://api.nuget.org/v3/index.json` to the restore.

### Examples

- `example/simple-api/` — a small widget service.
- `example/custom-models/` — every place a custom model can be swapped in. The subject of the end-to-end tests.
- `example/all-versions/` — versions that genuinely differ, emitted with `all-versions`. Its tests in `e2e/CustomModels.Tests` prove each version has exactly its own shape.
- `example/versioned-api/` — a versioned Pet Store for manual end-to-end validation. Run it via `example/versioned-api/build.ps1`.

---

## Conventions

### ESM and Import Extensions

The project uses ESM (`"type": "module"`). All internal imports must use `.js` extensions — TypeScript resolves them to `.ts` at compile time, Node.js resolves to `.js` at runtime.

### TypeSpec Peer Dependency

`@typespec/compiler` is declared as a peer dependency. Keep it in sync with any TypeSpec packages used in tests or the examples.

### Diagnostics

Declare all diagnostic codes in `src/lib.ts` inside the `diagnostics` map passed to `createTypeSpecLibrary`. Use `reportDiagnostic` (for non-fatal) or `createDiagnostic` (to return a diagnostic value) from the destructured exports of `$lib`.

### Linting

ESLint uses the flat config format (`eslint.config.js`) with `typescript-eslint`. Unused variables prefixed with `_` are allowed by convention.

### Comments

Do **not** add decorative section-divider banner comments (e.g. `// ─── C# interface generation ───`). Keep inline comments to genuine explanations of non-obvious code. Rely on the file/module split — not in-file banners — to separate concerns.

### JSDoc

Every function, method, type, interface, and exported constant must have a JSDoc (`/** … */`) block describing what it is. Document parameters and return values with `@param` / `@returns` where they are not fully self-evident from the signature, and document non-obvious fields on interfaces/types. This is a hard requirement for all new and modified declarations — do not omit it.

### Generated C#

Every public type and member in the `.hbs` templates carries an XML doc comment; the generated project sets `GenerateDocumentationFile`, so a malformed `cref` or `typeparamref` surfaces as a build warning. The generated example projects must build with zero warnings.

---

## After Every Change

After making any change to the codebase:

1. **Rebuild and test the package:**

   ```powershell
   npm run build && npm test
   ```

2. **Rebuild all TypeSpec examples:**

   ```powershell
   cd example/simple-api && npm install && tsp compile .
   cd example/custom-models && npm install && tsp compile .
   cd example/all-versions && npm install && tsp compile .
   cd example/versioned-api && npm install && ./build.ps1
   ```

   Run this for every subdirectory under `example/`.

3. **Run the end-to-end tests** (after compiling `example/custom-models` and `example/all-versions`):

   ```powershell
   dotnet run --project e2e/CustomModels.Tests
   ```

All steps must pass before a change is considered complete.

## Maintenance

- **CLAUDE.md** — Redirects to this file. Do not add content there.
- **README.md** — User-facing documentation. Update it alongside user-visible feature changes.
- **CHANGELOG.md** — Keep a changelog following [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) format. Update it for every meaningful change.
