# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Initial release of the emitter. It generates a C# client built on Flurl.Http and mirrors `@massivescale/tsp-refit-client`: the same options, `@clientName` / `@access` decorators, API versioning (`target-version`, `all-versions`, `version-in-namespace`, `route-prefix`), `@discriminator` polymorphism, `@encode("string")` booleans, visibility-filtered request records, merge-patch bodies, Handlebars template overrides, NuGet metadata, and the `internal-access-leak` lint rule.
- One endpoint interface (`IWidgets`) and one internal Flurl-backed implementation (`WidgetsClient`) per TypeSpec interface, an aggregate client with the underlying `IFlurlClient` exposed as `FlurlClient`, `Create` factories for use without dependency injection, and an `Add{Client}` registration method built on `IHttpClientFactory`, so delegating handlers and resilience policies can be added.
- **Extensible models.** Generated records are never sealed, so callers can derive their own types and send them to the API with their extra properties intact.
  - Every operation whose response contains a model gets a generic overload (`ReadAsync<TResult>(...) where TResult : Widget`) that deserializes the response as the caller's derived type. `Widget[]` becomes `List<TResult>` and `Record<Widget>` becomes `Dictionary<string, TResult>`.
  - `ModelMap` registers a custom type once (`models.Map<Widget, MyWidget>()`) so every `Widget` the client reads — as a response, a nested property, or a list item — is created as `MyWidget`. It lives in the serializer of the exposed `IFlurlClient`, so raw Flurl calls get it too.
  - Collection request bodies are accepted as covariant `IEnumerable<T>` / `IReadOnlyDictionary<string, T>`, and merge-patch bodies as covariant `IMergePatch<T>`, so a `List<MyWidget>` or `MergePatch<MyWidget>` can be sent where the declared model is expected.
  - Custom subtypes of `@discriminator` models are sent with their discriminator and can be read directly by generic overload or through the model map.
  - A non-success response throws Flurl's `FlurlHttpException`; whether an API accepts extension properties is left to the API and the implementor.
- Raw request and response bodies: a `bytes` body or response, and a `string` body or response with a non-JSON media type, are sent and read raw instead of being JSON-encoded.
- Path values are fully percent-encoded; query, header and path values use enum wire names, lower-case booleans, and ISO 8601 dates.
- A parameter named after a C# keyword is escaped (`@params`), and a `Content-Type` header parameter is no longer exposed, because the body's media type decides it.
- `example/custom-models`, plus an MSTest end-to-end suite (`e2e/CustomModels.Tests`) that runs the generated C# against a stubbed HTTP layer to verify derived models round-trip.
