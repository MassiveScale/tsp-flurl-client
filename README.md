# @massivescale/tsp-flurl-client

[TypeSpec](https://typespec.io) emitter for generating C# API clients using [Flurl.Http](https://flurl.dev).

## Summary

This emitter produces a C# project with an endpoint interface and a Flurl-backed implementation for each TypeSpec `interface`, covering every `GET`, `POST`, `PUT`, `PATCH`, and `DELETE` operation. The generated client contains everything needed to call your API — simply provide the base URI at runtime.

It mirrors [`@massivescale/tsp-refit-client`](https://github.com/MassiveScale/tsp-refit-client) (same options, decorators, versioning, models, and merge-patch support) but builds on Flurl.Http, and adds one thing Refit cannot offer: **models you can extend**.

- **Extensible models.** Derive your own types from the generated models, send them to the API, and read responses back as them. If the API accepts extension properties, your extra properties travel with the request and come back in the response. See [Custom models](#custom-models).
- **Version-aware.** Call any endpoint version from a single client.
- **A Flurl client you can drop down to.** The aggregate client exposes its configured `IFlurlClient`, so anything the generated methods do not cover is one Flurl call away.

## Usage

Add the emitter to your TypeSpec project:

```bash
npm install @massivescale/tsp-flurl-client
```

Configure it in your `tspconfig.yaml`:

```yaml
emit:
  - "@massivescale/tsp-flurl-client"
options:
  "@massivescale/tsp-flurl-client":
    emitter-output-dir: "{output-dir}/client"
```

### Emitter options

| Option                        | Type       | Default                                       | Description                                                                                                                                                                                                                                                         |
| ----------------------------- | ---------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `project-name`                | `string`   | TypeSpec namespace + `Client`                 | Full project name for the `.csproj` filename (e.g. `PetStoreClient` → `PetStoreClient.csproj`). Dots are valid; C# identifiers use only the final segment.                                                                                                          |
| `client-name`                 | `string`   | Derived from `project-name`                   | Display name for the client. Controls the aggregate client class and the DI extension class/method prefix (e.g. `PetStore` → `PetStoreExtensions.g.cs`, `AddPetStore(...)`). Also used as the default NuGet `<Title>` unless `nuget-title` is set.                  |
| `root-namespace`              | `string`   | TypeSpec namespace + `.Client`                | Overrides the root C# namespace for all generated files.                                                                                                                                                                                                            |
| `additional-usings`           | `string[]` | —                                             | Extra `using` directives appended to every emitted C# file. Use this when the service references types declared outside its own TypeSpec namespace but emitted elsewhere — for example a sibling emitter's shared namespace — so the generated code still compiles. |
| `net-version`                 | `string`   | `net8.0`                                      | Target .NET version(s) written into the `.csproj`. Use a single TFM (e.g. `net8.0`) or a semicolon-separated list for multi-targeting (e.g. `net8.0;net9.0`). **.NET 8 or later is required** (see [Requirements](#requirements)).                                  |
| `target-version`              | `string`   | Latest declared version                       | Emit only this API version. Ignored when `all-versions` is `true`.                                                                                                                                                                                                  |
| `all-versions`                | `boolean`  | `false`                                       | When `true`, generate clients for every declared API version in separate subfolders.                                                                                                                                                                                |
| `version-in-namespace`        | `boolean`  | `false`                                       | When `true`, append the sanitized API version to the C# namespace in single-version mode. Has no effect when `all-versions` is `true`.                                                                                                                              |
| `route-prefix`                | `string`   | `api/{version}`                               | Prefix prepended to every emitted route path. The `{version}` token is replaced by the API version value (e.g. `api/{version}` + `v1.0` → `api/v1.0/items`). When no version is available, `{version}` is removed (`api/items`). Set to `""` to disable.            |
| `emit-project-file`           | `boolean`  | `true`                                        | Set to `false` to skip `.csproj` generation.                                                                                                                                                                                                                        |
| `overwrite-project-file`      | `boolean`  | `false`                                       | When `false`, the `.csproj` is only written if it does not already exist.                                                                                                                                                                                           |
| `clean-output-dir`            | `boolean`  | `true`                                        | When `true` (default), all `*.g.cs` files in the output directory are deleted before emitting. Non-generated files and project files are preserved. Set to `false` to skip the cleanup pass.                                                                        |
| `abstract-discriminated-base` | `boolean`  | `true`                                        | When `true` (default), models in a `@discriminator` hierarchy with no concrete wire shape of their own (the discriminated base, and pass-through grouping models) are emitted as `abstract record`. Set to `false` to keep them concrete/instantiable.              |
| `dotnet-format`               | `boolean`  | `true`                                        | When `true`, run `dotnet format --no-restore` on the output directory after emitting. Set to `false` to skip formatting (e.g. in CI pipelines where formatting is handled separately).                                                                              |
| `nuget-package-id`            | `string`   | —                                             | NuGet `<PackageId>`.                                                                                                                                                                                                                                                |
| `nuget-version`               | `string`   | Auto-derived from TypeSpec version            | NuGet `<Version>`. When not set, derived from the targeted TypeSpec API version: parsed as semver if possible (e.g. `v2.1` → `2.1.0`), otherwise formatted as CalVer (`YYYY.MM.DD`).                                                                                |
| `nuget-authors`               | `string`   | —                                             | NuGet `<Authors>` (comma-separated).                                                                                                                                                                                                                                |
| `nuget-description`           | `string`   | `Flurl client for the {namespace} API`        | NuGet `<Description>`.                                                                                                                                                                                                                                              |
| `nuget-title`                 | `string`   | Value of `client-name` (if set), else omitted | NuGet `<Title>`.                                                                                                                                                                                                                                                    |
| `nuget-tags`                  | `string`   | —                                             | NuGet `<PackageTags>` (space-separated).                                                                                                                                                                                                                            |
| `templates`                   | `object`   | —                                             | Override individual built-in Handlebars templates. Keys: `file`, `record`, `enum`, `endpoint-interface`, `endpoint-client`, `csproj`, `extensions`, `merge-patch`, `model-map`, `client-runtime`.                                                                   |

`project-name`, `client-name` and `root-namespace` become file paths and C# identifiers, so they are validated before anything is written. A project name must be dot-separated C# identifiers (no path separators), a client name must be a valid class name that is not a C# keyword, and a root namespace must be a valid dotted C# namespace. A bad value is reported as `invalid-option` and nothing is emitted.

### Decorators

Import the library and bring the namespace into scope to use the decorators:

```typespec
import "@massivescale/tsp-flurl-client";
using MassiveScale.TspFlurlClient;
```

#### `@clientName(name)`

Overrides the C# identifier used for the decorated element in the emitted output. The name must be a plain C# identifier (letters, digits and underscores, not starting with a digit), because it becomes a type name and a file name; anything else is reported as `invalid-client-name`.

| Target           | Effect                                                                                         |
| ---------------- | ---------------------------------------------------------------------------------------------- |
| `model`          | Replaces the record name and file name (e.g. `Animal` → `Pet.g.cs` / `public record Pet`).     |
| `enum`           | Replaces the enum name and file name.                                                          |
| `interface`      | Replaces the name portion of the C# interface (the `I` prefix is still prepended).             |
| `op`             | Replaces the base method name (the `Async` suffix is still appended, first letter uppercased). |
| `model property` | Replaces the C# property name (PascalCase conversion is still applied).                        |

```typespec
@clientName("Pet")
model Animal { id: string; }

interface Animals {
  @clientName("search")
  @get list(): Animal[];
}
```

#### `@access(Access.public | Access.internal)`

Controls the C# access modifier on the emitted type declaration. Defaults to `public`.

```typespec
@access(Access.internal)
model InternalDto { value: string; }

@access(Access.internal)
interface SecretEndpoints {
  @get read(): InternalDto;
}
```

An internal interface is an internal property of the aggregate client, and the aggregate client's constructor becomes internal whenever any endpoint is internal (a public constructor cannot take an internal type).

#### `internal-access-leak` lint rule

A public operation or model that references an `@access(Access.internal)` type produces C# that cannot compile (`CS0053`, inconsistent accessibility), so the emitter ships a lint rule that warns about it. Enable it by adding the library's ruleset to `tspconfig.yaml`:

```yaml
linter:
  extends:
    - "@massivescale/tsp-flurl-client/recommended"
```

The fix is either to mark the referenced type `@access(Access.public)` or to mark the interface (or, for a property, its model) `@access(Access.internal)` as well. Marking an _operation_ internal does not help: C# interface methods cannot carry an access modifier, so the rule still reports it.

Then compile your TypeSpec definition:

```bash
tsp compile .
```

## Using the generated client

After running `tsp compile`, the emitter writes a self-contained C# project to your configured output directory:

```
<output-dir>/
  Endpoints/
    ICustomers.g.cs          # Endpoint interface per TypeSpec interface
    CustomersClient.g.cs     # Its Flurl implementation (internal)
  Models/
    Customer.g.cs            # C# records for every model
    CustomerCreateRequest.g.cs
    MergePatch.g.cs          # Only when a merge-patch body is used
  Infrastructure/
    ModelMap.g.cs            # Registry for custom models
    ClientRuntime.g.cs       # Serializer setup and wire-format helpers (internal)
  ApiClientExtensions.g.cs   # Aggregate client + DI registration helper
  ApiClient.csproj           # Project file (Flurl.Http + Microsoft.Extensions.Http)
```

### 1. Reference the generated project

Add a project reference from your application to the generated `.csproj`:

```xml
<!-- YourApp.csproj -->
<ItemGroup>
  <ProjectReference Include="../path/to/client/ApiClient.csproj" />
</ItemGroup>
```

### 2. Register with dependency injection

Call the generated extension method in your `Program.cs`:

```csharp
builder.Services.AddApiClient(client =>
{
    client.BaseAddress = new Uri("https://api.example.com");
});
```

To add delegating handlers (e.g. auth, logging) or resilience policies, pass the optional second argument. The third argument registers [custom models](#custom-models):

```csharp
builder.Services.AddApiClient(
    client => client.BaseAddress = new Uri("https://api.example.com"),
    builder => builder
        .AddHttpMessageHandler<AuthHeaderHandler>()
        .AddStandardResilienceHandler(),
    models => models.Map<Widget, MyWidget>()
);
```

Without dependency injection, create the client directly:

```csharp
var api = ApiClient.Create("https://api.example.com");

// or on top of a Flurl client you already configured
var api = ApiClient.Create(myFlurlClient);
```

> `Create(IFlurlClient)` replaces the Flurl client's JSON serializer with the one the generated models need. Do not share that client with code that expects Flurl's default serializer.

### 3. Inject and call

Inject the single aggregate client and access each endpoint group as a named property:

```csharp
public class ProductService(ApiClient api)
{
    public Task<Item> GetAsync(string id, CancellationToken ct) =>
        api.Items.ReadAsync(id, cancellationToken: ct);

    public Task<Item> CreateAsync(ItemCreateRequest body, CancellationToken ct) =>
        api.Items.CreateAsync(body, cancellationToken: ct);
}
```

You can also inject an endpoint interface directly (`IItems`), which is the easiest thing to substitute in tests.

The aggregate client (`ApiClient` by default, or the name derived from `client-name`/`project-name`) exposes one strongly-typed property per TypeSpec `interface` in your spec, plus `FlurlClient`, the underlying `IFlurlClient`.

Optional TypeSpec parameters (`?`) are emitted as nullable C# types with `= null` defaults so callers can omit them:

```csharp
// TypeSpec: list(@query skip?: int32, @query take?: int32): Item[];
Task<List<Item>> ListAsync(int? skip = null, int? take = null, Dictionary<string, object>? additionalQueryParameters = null, CancellationToken cancellationToken = default);

// Call site:
await api.Items.ListAsync(skip: 20, take: 10, cancellationToken: ct);
```

### Errors

A non-success response throws Flurl's `FlurlHttpException`, carrying the status code and body:

```csharp
try
{
    await api.Items.ReadAsync(id);
}
catch (FlurlHttpException ex) when (ex.StatusCode == 404)
{
    var problem = await ex.GetResponseJsonAsync<ProblemDetails>();
}
```

### Adding custom query parameters

Every generated method accepts an `additionalQueryParameters` dictionary, so callers can append query parameters that aren't part of the TypeSpec contract (feature flags, tracing params, etc.) to any call:

```csharp
await api.Items.ListAsync(
    skip: 20,
    additionalQueryParameters: new Dictionary<string, object> { ["debug"] = true },
    cancellationToken: ct);
// GET /api/items?skip=20&debug=true
```

## Custom models

A generated model is a plain C# `record` that is never sealed, so you can derive from it to add your own properties. This is what lets you talk to an API that accepts **extension properties**: the extra properties on your type are sent as JSON, and the API keeps them.

```csharp
public record MyWidget : Widget
{
    [JsonPropertyName("sku")]
    public string? Sku { get; init; }
}
```

Whether the API accepts or rejects the extra properties is the API's business. The client sends what you give it. If the API does not support extension properties it will answer with an error, which surfaces as a `FlurlHttpException` like any other failure.

### Sending

Pass your derived model wherever the generated one is accepted. It is serialized as the type you gave it, so its extra properties are included:

```csharp
await api.Widgets.CreateAsync(new MyCreateRequest { Name = "gear", Sku = "G-1" });
// {"name":"gear","sku":"G-1"}
```

This also works for collections of models (`IEnumerable<Widget>` accepts a `List<MyWidget>`), and for merge patches (`IMergePatch<Widget>` accepts a `MergePatch<MyWidget>`):

```csharp
var patch = new MergePatch<MyWidget>().Set(w => w.Sku, "G-2");
await api.Widgets.UpdateAsync(id, patch);
// {"sku":"G-2"}
```

Unset (`null`) optional properties are left out of the request body.

### Reading, per call

Every operation whose response contains a model has a generic overload. Name your type and the response is deserialized as it:

```csharp
Widget plain = await api.Widgets.ReadAsync(id);                 // extra properties are dropped
MyWidget mine = await api.Widgets.ReadAsync<MyWidget>(id);      // mine.Sku is populated
List<MyWidget> all = await api.Widgets.CreateManyAsync<MyWidget>(bodies);
```

The type argument is constrained to the model the operation declares (`where TResult : Widget`) and sits at the core of the response: `Widget[]` becomes `List<TResult>`, `Record<Widget>` becomes `Dictionary<string, TResult>`. When the response is a wrapper around the model you care about, derive the wrapper:

```csharp
public record MyWidgetPage : WidgetPage { public string? Cursor { get; init; } }

MyWidgetPage page = await api.Widgets.ListAsync<MyWidgetPage>();
```

### Reading, everywhere: the model map

To get your type wherever a generated model appears — as a response, as a property of another model, or as a list item — register it once:

```csharp
builder.Services.AddApiClient(
    client => client.BaseAddress = new Uri("https://api.example.com"),
    configureModels: models => models.Map<Widget, MyWidget>());

var page = await api.Widgets.ListAsync();
// page.Items[0] and page.Featured are MyWidget at runtime, though typed as Widget.
```

Method return types stay as the generated types, so cast when you need your members (`(MyWidget)widget`). Without dependency injection, pass the map to `Create`:

```csharp
var api = ApiClient.Create("https://api.example.com", m => m.Map<Widget, MyWidget>());
```

A registered type is also what gets serialized when it appears inside another model, so a `MyWidget` nested in a request body keeps its extra properties.

### Dropping down to Flurl

The map lives in the serializer of the client's `IFlurlClient`, so raw Flurl calls get it too:

```csharp
Widget widget = await api.FlurlClient
    .Request("api/widgets", id)
    .GetJsonAsync<Widget>();   // a MyWidget, if Widget is mapped
```

### Discriminated models

For `@discriminator` hierarchies, custom subtypes work in the same ways, with the discriminator written for you:

```csharp
public record MyDog : Dog { public string? Breed { get; init; } }

await api.Pets.CreateAsync(new MyDog { Name = "rex", Breed = "lab" });   // {"kind":"dog",...}
List<MyDog> dogs = await api.Pets.ListAsync<MyDog>();

// or: models.Map<Dog, MyDog>(); then ListAsync() returns MyDog for every "dog".
```

### What to know

| Situation                                                                       | Behaviour                                                                                                                       |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| A derived model is a property or list item of a model you send                  | Its extra properties are sent only if the type is in the model map. Otherwise it is serialized as the declared type.            |
| A custom subtype of a discriminated model is nested under its base type         | It must be in the model map. Without it, `System.Text.Json` throws `NotSupportedException`, rather than silently dropping data. |
| `models.Map<Pet, MyPet>()` where `Pet` is the base of a discriminated hierarchy | Rejected with `InvalidOperationException`. Map one of its derived models instead.                                               |
| A custom type that does not derive from the model, or is abstract               | Rejected with `ArgumentException` when registered.                                                                              |
| A mapped discriminated subtype is read directly (`ReadAsync` of `Dog`)          | The map applies when it is read through its base type. Use the generic overload to read it directly.                            |
| Request bodies with hidden properties (`@visibility`)                           | The request type is a record of its own (`WidgetCreateRequest`). Derive from that to add properties to the request.             |

## Requirements

- **.NET 8 or later.** The serializer customization that powers custom models uses `System.Text.Json` contract customization (`TypeInfoResolver`), which first shipped in .NET 7, and the project is tested on .NET 8. Multi-targeting older frameworks is not supported.
- Flurl.Http 4.x (referenced by the generated project).

## How requests are sent

- JSON uses `System.Text.Json` with web defaults (camelCase, case-insensitive reads, numbers accepted as strings). Models carry explicit `[JsonPropertyName]` attributes, so declared properties always use their TypeSpec wire names.
- Path values are fully percent-encoded, so a value containing `/` or `?` cannot change the shape of the URL.
- Enum values in query strings, headers, and paths use their wire names; booleans are `true`/`false`; dates are ISO 8601.
- Enums are read and written as their declared values through a converter generated for each enum (`ColorJsonConverter`), because `JsonStringEnumConverter` ignores `[EnumMember]` and would write the C# member name (`Blue`) where the API declared `blue`. A member declared with a number (`enum Status { ready: 1 }`) travels as a JSON number, and an enum can mix both. A value the enum does not declare, or a token of the wrong kind, is rejected with a `JsonException` instead of being guessed.
- Names that become C# string literals (property, query and header names, discriminator and enum values, media types) are escaped, and values written into the generated `.csproj` (NuGet metadata, namespace, target framework) are XML-escaped.
- A `bytes` body or response is sent and read raw, as is a `string` body or response with a non-JSON media type (TypeSpec's default for `string` is `text/plain`).
- Versioning is applied per emitted version: an operation, and a parameter, that was `@added` later or `@removed` is left out of the client for versions that do not have it. In single-version mode (the default, or `target-version`) model properties are filtered the same way. With `all-versions`, each model is written once and carries the properties of every version, because the versions share one set of models; the per-version clients still omit the parameters they do not have.
- A `Content-Type` header declared as an operation parameter is not exposed; the body's media type decides it.

### Polymorphism (`@discriminator`)

A model decorated with the standard TypeSpec `@discriminator("propName")` decorator is emitted with `[JsonPolymorphic]` / `[JsonDerivedType]` attributes, and its derived models are emitted as C# records that inherit from it — so `System.Text.Json` can deserialize a base-typed response into the correct concrete type at runtime:

```typespec
@discriminator("kind")
model Pet { kind: string; name: string; }

model Dog extends Pet { kind: "dog"; isBarker: boolean; }
model Cat extends Pet { kind: "cat"; isPurrer: boolean; }
```

```csharp
[JsonPolymorphic(TypeDiscriminatorPropertyName = "kind")]
[JsonDerivedType(typeof(Cat), "cat")]
[JsonDerivedType(typeof(Dog), "dog")]
public abstract record Pet { ... }

public record Dog : Pet { public bool IsBarker { get; init; } }
public record Cat : Pet { public bool IsPurrer { get; init; } }

// A response typed as List<Pet> deserializes each element to its concrete Dog/Cat type.
List<Pet> pets = await api.Pets.ListAsync();
```

`Dog` and `Cat` are emitted even though nothing in the TypeSpec definition references them directly — they only ever appear as a polymorphic `Pet` at runtime.

`Pet` is emitted as `abstract` because a bare `Pet` has no valid JSON shape of its own — `System.Text.Json` would throw at the first (de)serialization attempt. This also applies to pass-through grouping models with no discriminator value of their own. Set `"abstract-discriminated-base": false` to keep these records concrete instead.

### String-encoded booleans (`@encode`)

A `boolean` property or parameter decorated with `@encode("string")` travels on the wire as a JSON string (`"true"`/`"false"`), so it is emitted as C# `string` rather than `bool`:

```typespec
model Widget {
  @encode(string)
  active: boolean;   // → public string Active
  enabled: boolean;  // → public bool Enabled
}
```

Other `@encode` targets (dates, durations, bytes) are not yet honored and map by their declared type.

### Merge-patch request bodies

A PATCH operation whose body is `MergePatchUpdate<T>` (or `MergePatchUpdateReplaceOnly<T>` / `MergePatchCreateOrUpdate<T>`) maps to a covariant `IMergePatch<T>` parameter:

```typespec
@route("/widgets")
interface Widgets {
  @patch update(@path id: string, @body body: MergePatchUpdate<Widget>): Widget;
}
```

```csharp
Task<Widget> UpdateAsync(string id, IMergePatch<Widget> body, ...);
```

`MergePatch<T>` is a helper class the emitter writes to `Models/MergePatch.g.cs`, in the same namespace as the records. It is only emitted when something actually uses a merge-patch body, so a service without one gets no extra file. (If your TypeSpec declares several `@service` namespaces, each one that needs the helper gets its own copy; the extra files are named after their namespace.)

The point of a merge patch (RFC 7396) is that it carries only the fields you want changed. The helper is a builder for exactly that:

```csharp
var patch = new MergePatch<Widget>()
    .Set(w => w.Name, "new name")  // send a new value
    .Clear(w => w.Description);    // send an explicit null, clearing the field

await client.Widgets.UpdateAsync(id, patch, ct);
// body: {"name":"new name","description":null}
```

| Method                 | Effect on the request body                                              |
| ---------------------- | ----------------------------------------------------------------------- |
| `Set(selector, value)` | Sends the property with that value.                                     |
| `Clear(selector)`      | Sends the property as JSON `null`, asking the server to clear it.       |
| `Remove(selector)`     | Drops the property from the body, so the request says nothing about it. |
| `IsDefined(selector)`  | Whether the body carries the property (including an explicit `null`).   |
| `IsNull(selector)`     | Whether the body carries the property as `null`.                        |

Every method also takes a plain JSON wire name (`patch.Set("displayName", "…")`) if you need a property that isn't on the model. With the expression form, the wire name is read from the record's `[JsonPropertyName]` attribute, so you don't have to know it.

The expression form only accepts a property read straight off the lambda parameter, because a merge patch is a flat map of the model's own JSON properties. Something nested like `w => w.Name.Length` throws `ArgumentException` rather than quietly sending a `"Length"` field the server has never heard of. To patch inside a nested object, `Set` the whole object.

Because the parameter is the covariant `IMergePatch<Widget>`, a `MergePatch<MyWidget>` is accepted too, so you can patch your own extension properties.

> **Note:** this is the client-side counterpart to the `MergePatch<T>` emitted by `@massivescale/tsp-aspnetcore-api`. That one is built for _reading_ a patch in a controller; this one is built for _writing_ one. If your solution references both generated projects, the two types live in different namespaces and do not conflict — but don't `using` both into the same file.

## Development

### Prerequisites

- Node.js (LTS)
- npm 11+
- The .NET SDK, to build the generated C# and run the end-to-end tests

### Setup

```powershell
npm install
```

### Build

TypeScript must be compiled before running tests:

```powershell
npm run build
```

Use watch mode during active development:

```powershell
npm run watch
```

### Test

```powershell
npm run build && npm test
```

To run a single test file:

```powershell
node --test dist/test/endpoints.test.js
```

The end-to-end tests compile the `custom-models` example, then run the **generated C#** against a stubbed HTTP layer to prove that derived models really round-trip:

```powershell
cd example/custom-models; npm install; npx tsp compile .
dotnet run --project ../../e2e/CustomModels.Tests
```

### Lint & Format

```powershell
npm run lint          # check for lint errors
npm run lint:fix      # auto-fix lint errors
npm run format        # format all files
npm run format:check  # check formatting without writing
```

## Examples

- [`example/simple-api/`](example/simple-api/) — a small widget service.
- [`example/custom-models/`](example/custom-models/) — exercises every place a custom model can be swapped in. It is the subject of the end-to-end tests.
- [`example/versioned-api/`](example/versioned-api/) — a versioned Pet Store demonstrating multi-version route and model definitions. Run it with `./example/versioned-api/build.ps1`.

## Contributing

See [`.github/copilot-instructions.md`](.github/copilot-instructions.md) for architecture details, conventions, and development guidance.
