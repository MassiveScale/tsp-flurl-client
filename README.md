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

| Option                        | Type       | Default                                       | Description                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------------- | ---------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `project-name`                | `string`   | TypeSpec namespace + `Client`                 | Full project name for the `.csproj` filename (e.g. `PetStoreClient` → `PetStoreClient.csproj`). Dots are valid; C# identifiers use only the final segment.                                                                                                                                                                                                                                                       |
| `client-name`                 | `string`   | Derived from `project-name`                   | Display name for the client. Controls the aggregate client class and the DI extension class/method prefix (e.g. `PetStore` → `PetStoreExtensions.g.cs`, `AddPetStore(...)`). Also used as the default NuGet `<Title>` unless `nuget-title` is set.                                                                                                                                                               |
| `root-namespace`              | `string`   | TypeSpec namespace + `.Client`                | Overrides the root C# namespace for all generated files.                                                                                                                                                                                                                                                                                                                                                         |
| `additional-usings`           | `string[]` | —                                             | Extra `using` directives appended to every emitted C# file. Use this when the service references types declared outside its own TypeSpec namespace but emitted elsewhere — for example a sibling emitter's shared namespace — so the generated code still compiles. Each entry must be a dotted C# namespace such as `Acme.Shared.Models`; anything else is reported as `invalid-option` and nothing is emitted. |
| `net-version`                 | `string`   | `net8.0`                                      | Target .NET version(s) written into the `.csproj`. Use a single TFM (e.g. `net8.0`) or a semicolon-separated list for multi-targeting (e.g. `net8.0;net9.0`). **.NET 8 or later is required** (see [Requirements](#requirements)): `net7.0`, `netstandard2.0` and the like are reported as `invalid-option`. A suffix such as `net8.0-windows` is allowed.                                                       |
| `target-version`              | `string`   | Latest declared version                       | Emit only this API version. Ignored when `all-versions` is `true`.                                                                                                                                                                                                                                                                                                                                               |
| `all-versions`                | `boolean`  | `false`                                       | When `true`, generate every declared API version, each in its own subfolder and `V<version>` namespace with its own models. See [Multiple API versions](#multiple-api-versions).                                                                                                                                                                                                                                 |
| `version-in-namespace`        | `boolean`  | `false`                                       | When `true`, append the sanitized API version to the C# namespace in single-version mode. Has no effect when `all-versions` is `true`.                                                                                                                                                                                                                                                                           |
| `route-prefix`                | `string`   | `api/{version}`                               | Prefix prepended to every emitted route path. The `{version}` token is replaced by the API version value (e.g. `api/{version}` + `v1.0` → `api/v1.0/items`). When no version is available, `{version}` is removed (`api/items`). Set to `""` to disable.                                                                                                                                                         |
| `emit-project-file`           | `boolean`  | `true`                                        | Set to `false` to skip `.csproj` generation.                                                                                                                                                                                                                                                                                                                                                                     |
| `overwrite-project-file`      | `boolean`  | `false`                                       | When `false`, the `.csproj` is only written if it does not already exist.                                                                                                                                                                                                                                                                                                                                        |
| `clean-output-dir`            | `boolean`  | `true`                                        | When `true` (default), all `*.g.cs` files in the output directory are deleted before emitting. Non-generated files and project files are preserved. Set to `false` to skip the cleanup pass.                                                                                                                                                                                                                     |
| `abstract-discriminated-base` | `boolean`  | `true`                                        | When `true` (default), models in a `@discriminator` hierarchy with no concrete wire shape of their own (the discriminated base, and pass-through grouping models) are emitted as `abstract record`. Set to `false` to keep them concrete/instantiable.                                                                                                                                                           |
| `dotnet-format`               | `boolean`  | `true`                                        | When `true`, run `dotnet format --no-restore` on each project in the output directory after emitting (skipped when there is none, for example with `emit-project-file: false`). Set to `false` to skip formatting (e.g. in CI pipelines where formatting is handled separately).                                                                                                                                 |
| `nuget-package-id`            | `string`   | —                                             | NuGet `<PackageId>`.                                                                                                                                                                                                                                                                                                                                                                                             |
| `nuget-version`               | `string`   | Auto-derived from TypeSpec version            | NuGet `<Version>`. When not set, derived from the targeted TypeSpec API version: parsed as semver if possible (e.g. `v2.1` → `2.1.0`, `1.2-preview.1` → `1.2.0-preview.1`), otherwise formatted as CalVer (`YYYY.MM.DD`). A pre-release or build suffix is kept only when it is valid SemVer 2, so `1.2-preview build` becomes CalVer rather than an invalid package version.                                    |
| `nuget-authors`               | `string`   | —                                             | NuGet `<Authors>` (comma-separated).                                                                                                                                                                                                                                                                                                                                                                             |
| `nuget-description`           | `string`   | `Flurl client for the {namespace} API`        | NuGet `<Description>`.                                                                                                                                                                                                                                                                                                                                                                                           |
| `nuget-title`                 | `string`   | Value of `client-name` (if set), else omitted | NuGet `<Title>`.                                                                                                                                                                                                                                                                                                                                                                                                 |
| `nuget-tags`                  | `string`   | —                                             | NuGet `<PackageTags>` (space-separated).                                                                                                                                                                                                                                                                                                                                                                         |
| `templates`                   | `object`   | —                                             | Override individual built-in Handlebars templates. Keys: `file`, `record`, `enum`, `endpoint-interface`, `endpoint-client`, `csproj`, `extensions`, `merge-patch`, `model-map`, `client-runtime`.                                                                                                                                                                                                                |

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

#### Names that are not valid C#

TypeSpec lets an identifier contain almost anything once it is backtick-quoted, so the emitter checks every name it turns into a type, file, folder or member. A model, enum or interface name must be a valid C# type name (letters, digits and underscores, not starting with a digit, and not a C# keyword). A property, operation or parameter name must be a valid C# identifier. With `all-versions`, a version value must be safe as a folder name (letters, digits, dots, underscores and hyphens). A name that fails is reported as `invalid-name`, and a type with a bad name is not written. Give it a valid one with `@clientName`, which works on models, enums, interfaces, operations and properties (including parameters); the wire name is unaffected.

Different source names can also become the same C# name, which C# rejects, so collisions are reported as `name-collision` (the later declaration is left out) or, for whole types and files, `output-name-collision`:

- Properties: `foo` and `Foo`, or two `@clientName` values that differ only in the case of the first letter, and a property that shares its record's name (`model Owner { owner: string }`, which C# rejects as `CS0542`) or the name of a member every record has (`EqualityContract`, `Equals`, `ToString`, ...). In a `@discriminator` hierarchy, a derived property whose C# name is that of an inherited one (`Label` under `label`) is reported too, since C# would hide the inherited member; a derived property that redeclares an inherited one to narrow its type (`wheels: 4` under `wheels: int32`) is left to the inherited member.
- Operations: `read` and `Read` both become `ReadAsync`. Parameters: `foo` and `Foo` both become `foo`, and a parameter cannot be named `body` (when there is a request body), `cancellationToken`, `additionalQueryParameters`, `flurlRequest`, `flurlResponse` or `_client`, which the generated method already uses.
- Types: two models or enums with the same name in different child namespaces (they are flattened into one C# namespace), two interfaces with the same name, and a model named like a generated type (`IItems`, `ItemsEndpoint`, the aggregate client, its `...Extensions` class, or an enum's `...JsonConverter`). An interface cannot be named like the aggregate client, `FlurlClient` or `Create`, which are members of it.
- File names that differ only in case (`Widget` and `widget`), which are the same file on Windows and macOS.
- With `all-versions`, two version values that sanitize to the same namespace segment (`1.0` and `1_0`).

Rename one with `@clientName` to resolve any of them.

Enum members have no `@clientName`, and their wire value travels separately, so an odd member name is sanitized instead (`my-member` becomes `My_member`, `2fast` becomes `_2fast`). Two members that sanitize to the same name are reported.

Some names are fine in C# but need care, and the emitter takes it, so none of these needs `@clientName`:

- A model or enum may share its name with a .NET type the generated code uses (`Task`, `Type`, `Uri`, `CancellationToken`, `JsonElement`, ...). The generated code then writes that .NET type in full (`global::System.Threading.CancellationToken`), in that client only; everywhere else it keeps the short name. Only the emitter's own types (`ModelMap`, `ClientRuntime`, `MergePatch`, `IMergePatch`) and the aggregate client keep their names to themselves, and a model that takes one is reported.
- A model or enum named with only lower-case letters (`thing`) is declared verbatim (`record @thing`), since C# warns about the plain name (`CS8981`).
- A template parameter that is a C# keyword or all lower-case is written verbatim (`@class`, `@value`), one that is not an identifier has its other characters replaced (`my-T` is `my_T`), and one that would share a name with its record, one of its properties, or a member every record has is prefixed with `T` (`TEquals`). A caller never writes these names, only the type arguments.
- A parameter named after a keyword, or `await` (which every generated method reserves, being `async`), is written verbatim (`@class`, `@await`).

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

`@access` and `@clientName` also work on a generic model (`@access(Access.internal) model Page<T>`). TypeSpec runs a decorator only on each use of a template (`Page<string>`), never on the declaration, so the emitter reads the declaration's own decorators when it generates the generic `Page<T>` record.

#### `internal-access-leak` lint rule

A public operation or model that references an `@access(Access.internal)` type produces C# that cannot compile (`CS0053`, inconsistent accessibility), so the emitter ships a lint rule that warns about it. Enable it by adding the library's ruleset to `tspconfig.yaml`:

```yaml
linter:
  extends:
    - "@massivescale/tsp-flurl-client/recommended"
```

It also checks operations declared directly in a namespace, which are emitted as public interface methods, and a public `@discriminator` subtype of an internal base type (the emitter keeps C# inheritance there, which C# rejects as `CS0060`). The fix is either to mark the referenced type `@access(Access.public)` or to mark the interface (or, for a property, its model) `@access(Access.internal)` as well. Marking an _operation_ internal does not help: C# interface methods cannot carry an access modifier, so the rule still reports it.

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
    CustomersEndpoint.g.cs     # Its Flurl implementation (internal)
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
    var problem = await ex.GetResponseJsonAsync<ApiError>();
}
```

Models that only an error response uses (an `@error` model such as `ApiError`) are generated too, even though no method returns them, so the body of a failed call can be read as a typed model.

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

| Situation                                                                       | Behaviour                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A derived model is a property or list item of a model you send                  | Its extra properties are sent only if the type is in the model map. Otherwise it is serialized as the declared type.                                                                                                                                                                                                                                                                                                       |
| A custom subtype of a discriminated model is nested under its base type         | It must be in the model map. Without it, `System.Text.Json` throws `NotSupportedException`, rather than silently dropping data.                                                                                                                                                                                                                                                                                            |
| `models.Map<Pet, MyPet>()` where `Pet` is the base of a discriminated hierarchy | Rejected with `InvalidOperationException`. Map one of its derived models instead.                                                                                                                                                                                                                                                                                                                                          |
| A custom type that does not derive from the model, or is abstract               | Rejected with `ArgumentException` when registered.                                                                                                                                                                                                                                                                                                                                                                         |
| A mapped discriminated subtype is read directly (`ReadAsync` of `Dog`)          | The map applies when the JSON carries the discriminator, as it does through the base type. JSON without one is read as the generated type; use the generic overload to read it as yours.                                                                                                                                                                                                                                   |
| Request bodies with hidden properties (`@visibility`)                           | The request type is a record of its own (`WidgetCreateRequest`), and a bulk body takes them as items (`IEnumerable<WidgetCreateRequest>`, `IReadOnlyDictionary<string, WidgetCreateRequest>`). Derive from that to add properties to the request. A list of a derived type can be passed as it is; a dictionary of one goes to the overload generic in its items (`CreateAsync<TBody>`), which the compiler picks for you. |
| Two operations send the same model with different visible properties            | Each gets its own record: `WidgetCreateRequest`, then `WidgetCreateDraftRequest`, then `Widget{Interface}CreateDraftRequest`.                                                                                                                                                                                                                                                                                              |
| The body is part of a `@discriminator` hierarchy with hidden properties         | The request records mirror the hierarchy (`PetCreateRequest`, with `DogCreateRequest` and `CatCreateRequest` derived from it), so any subtype can be passed and its discriminator is written. Derive from one of them to add properties.                                                                                                                                                                                   |
| A model nested in the body has hidden properties                                | It gets a request record too, and so does every model that holds it: `Wrapper { child: Child }` with a read-only `Child.id` is sent as `WrapperCreateRequest { ChildCreateRequest Child }`. Lists, dictionaries, `\| null`, recursive models and nested hierarchies are filtered the same way.                                                                                                                             |
| The body is nullable (`Widget \| null`)                                         | It is filtered like `Widget`, and the parameter stays nullable (`WidgetCreateRequest?`).                                                                                                                                                                                                                                                                                                                                   |
| A model set on a `MergePatch<T>` (`Set(g => g.Owner, new MyOwner { ... })`)     | It is written as its runtime type, like a request body, so the derived type's extra properties are sent.                                                                                                                                                                                                                                                                                                                   |

## Requirements

- **.NET 8 or later.** The serializer customization that powers custom models uses `System.Text.Json` contract customization (`TypeInfoResolver`), which first shipped in .NET 7, and the project is tested on .NET 8. Multi-targeting older frameworks is not supported.
- Flurl.Http 4.x (referenced by the generated project).

## How requests are sent

- JSON uses `System.Text.Json` with web defaults (camelCase, case-insensitive reads, numbers accepted as strings). Models carry explicit `[JsonPropertyName]` attributes, so declared properties always use their wire names: the TypeSpec name, or the name given with `@encodedName("application/json", ...)` (an encoded name for another media type is ignored). A discriminator uses its property's JSON encoded name too. An optional property that is `null` is left out; a required property that allows null (`note: string | null`, or `nothing: null`) is always written, as `"note": null` when it is null.
- Path values are fully percent-encoded, so a value containing `/` or `?` cannot change the shape of the URL. A path parameter declared with `@path(#{ allowReserved: true })` keeps its `/` (`docs/a b.txt` is sent as `docs/a%20b.txt`); every other character is still encoded.
- Enum values in query strings, headers, and paths use their wire names; booleans are `true`/`false`; dates are ISO 8601. A date-time header is an RFC 7231 date (`Tue, 02 Jan 2024 03:04:05 GMT`) unless it is given another `@encode`, as TypeSpec specifies; a date-time cookie stays ISO 8601.
- Enums are read and written as their declared values through a converter generated for each enum (`ColorJsonConverter`), because `JsonStringEnumConverter` ignores `[EnumMember]` and would write the C# member name (`Blue`) where the API declared `blue`. A member declared with a number (`enum Status { ready: 1 }`) travels as a JSON number, and an enum can mix both. A value the enum does not declare, or a token of the wrong kind, is rejected with a `JsonException` instead of being guessed.
- Unions map to what is on the wire, since C# has no union type: `T | null` is `T?`; a union whose variants are all strings (literals, `string`, string enums) is `string`; any other union, such as models, or a string and a number, is `System.Text.Json.JsonElement`, which holds whatever the server sends (read it with `Deserialize<T>()`). A response that is a union of models is therefore a `JsonElement` rather than a `string` that would fail to deserialize. A literal type maps to its underlying type (`"dog"` is `string`, `5` is `int`).
- `@format("uuid")` on a string, whether it is on a property, a parameter, or a scalar, maps to `Guid`, and `@format("uri")` or `@format("url")` maps to `Uri`.
- Names that become C# string literals (property, query and header names, discriminator and enum values, media types) are escaped, and values written into the generated `.csproj` (NuGet metadata, namespace, target framework) are XML-escaped.
- A `bytes` body or response is sent and read raw.
- A scalar body or response (`string`, `int32`, `boolean`, `utcDateTime`, `duration`, `decimal`, ...) is `text/plain` in TypeSpec unless declared otherwise, so it is sent as its wire text (`42`, `true`, `2024-01-02T03:04:05.0000000+00:00`, `PT1H`) and read back by parsing that text. A union of scalars read as text is a `JsonElement` holding the number, boolean, or string that arrived. Text that is not a valid value throws `FormatException`. Text is encoded with the charset its media type declares (`text/plain; charset=iso-8859-1`, including Windows and IBM code pages such as `windows-1252`), and UTF-8 otherwise.
- A JSON body is sent as `application/json` when the operation accepts it, and otherwise with the JSON media type it declares (`application/vnd.acme+json`, `application/problem+json`), through the same serializer and model map.
- When an operation has a success response without a body (`Widget | void` is a 200 or a 204), the method returns a nullable type (`Widget?`, `TResult?`, `int?`, `byte[]?`), which is `null` when the server answers with that bodyless status. A 200 with an empty string or byte array is still that value.
- An optional body (`@body body?: Widget`) is an optional parameter (`Widget? body = null`); when it is left out, the request is sent with no body at all rather than a JSON `null`.
- When an operation's success responses carry different bodies (a 200 `Item` and a 201 `CreatedItem`), the method returns a `JsonElement` holding whichever arrived, since one C# return type cannot be both; read it with `Deserialize<Item>()` or `Deserialize<CreatedItem>()` depending on the status you expect. When they all carry the same body, the method returns that type.
- A response declared as both JSON and text (`application/json` or `text/plain`) is read according to the `Content-Type` the server actually sends. A request declared with several media types is sent as JSON, since the client chooses.
- A body declared by a property (`@body @format("uuid") id: string`, `@body @encode("string") flag: boolean`) honours that property's `@format` and `@encode`, as any other property does. An `@encode` the client cannot produce is reported as `unsupported-encoding`, once per declaration however many versions are emitted.
- Versioning is applied to everything that is emitted: an operation, a parameter, a model property, an enum member, a `@discriminator` subtype, and a whole model or enum is left out of any version that does not have it (`@added` / `@removed`).
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

A subtype is sent with its discriminator wherever it is declared: as a body (`@body body: Dog`), or as a property typed as a subtype or a grouping model (`resident: Dog`), not only through `Pet`. A property typed as a grouping model is read as the right subtype too.

`Pet` is emitted as `abstract` because a bare `Pet` has no valid JSON shape of its own — `System.Text.Json` would throw at the first (de)serialization attempt. This also applies to pass-through grouping models with no discriminator value of their own. Set `"abstract-discriminated-base": false` to keep these records concrete instead.

### Encodings (`@encode`)

`@encode` changes how a value is written on the wire. The client implements every encoding TypeSpec defines, for model properties (with a `[JsonConverter]`), query, header, path and cookie parameters, and plain-text bodies and responses. An encoding it cannot honour is an error (`unsupported-encoding`), and an operation that sends or reads such a value is left out, because the value would otherwise travel in a format the API does not expect.

| Encoding                                                                                                      | On the wire                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| none, or `rfc3339` / `ISO8601` / `base64`                                                                     | The default: RFC 3339 dates, ISO 8601 durations (`PT1H30M`), base64 bytes, JSON numbers. A date-time header with no `@encode` is an RFC 7231 date instead, as TypeSpec specifies. |
| `@encode("string")` on a `boolean`                                                                            | The property or parameter is a C# `string` (`"true"` / `"false"`).                                                                                                                |
| `@encode("string")` on a number (`int64`, `float64`, `decimal`, ...)                                          | The C# type stays numeric and is written and read as a JSON string, so an `int64` keeps its precision.                                                                            |
| `unixTimestamp` on a date-time                                                                                | Whole seconds since 1970 (`1704164645`).                                                                                                                                          |
| `rfc7231` on a date-time                                                                                      | An HTTP date (`Tue, 02 Jan 2024 03:04:05 GMT`). The default for a header.                                                                                                         |
| `seconds` / `milliseconds` on a duration                                                                      | A number, whole or with a fraction following the type it is encoded as (`90`, `1.5`).                                                                                             |
| `base64url` on bytes                                                                                          | URL-safe base64 without padding (`-_8`).                                                                                                                                          |
| `ArrayEncoding.pipeDelimited` / `spaceDelimited` / `commaDelimited` / `newlineDelimited` on a list of scalars | One string (`a\|b`), in a JSON property or a parameter.                                                                                                                           |

Not supported, and reported as an error: a custom encoding name, `@encode("string")` on a date or duration, a delimited list of models, a delimited list as a whole plain-text body, a newline-delimited list in a header or cookie (a header value cannot contain a line break), and a special encoding on a JSON body that is a single scalar (a standalone body has no property to carry the converter).

```typespec
model Widget {
  @encode("string") active: boolean;   // → public string Active
  @encode("string") total: int64;      // → public long Total, written as "9007199254740993"
  took: duration;                      // → public TimeSpan Took, written as "PT1H30M"
}
```

Durations are written and read as ISO 8601 (`PT1H30M`), which is what a TypeSpec `duration` is on the wire; `System.Text.Json` would otherwise write a `TimeSpan` as `01:30:00`. An `integer` is a C# `long`.

### Query, header, and cookie parameters

- A `@query` array that is not exploded (TypeSpec's default) is sent as one comma-separated value, `tags=a,b`. With `@query(#{ explode: true })` it is repeated, `tags=a&tags=b`.
- A `@cookie` parameter is sent as a cookie.
- A header or path value that is an array is joined with commas; enums use their wire names, booleans are `true`/`false`, and dates are ISO 8601.

### What is not supported

A request or success response that cannot be sent or read correctly is reported as an error (`unsupported-feature`) and that one operation is left out of the client, rather than being generated with the wrong behaviour. The rest of the client is generated. Call such an operation through the Flurl client the aggregate client exposes (`FlurlClient`).

- Multipart request or response bodies (`@multipartBody`).
- File bodies (`Http.File`).
- A template model carrying `@discriminator` (`@discriminator("kind") model Shape<T>`). System.Text.Json cannot list the subtypes of a generic base, and TypeSpec does not run the decorator on the template declaration the emitter generates. Reported as `unsupported-generic-discriminator`; declare the discriminated base as a non-template model.
- A template model given a value for a template parameter (`model Sized<N extends valueof int32>`, used as `Sized<3>`). A C# generic type takes types, not values. Reported as `unsupported-value-template`, and an operation that sends or reads it is left out.
- A model, list, or dictionary declared only with a non-JSON media type (`application/xml`, `application/x-www-form-urlencoded`, `application/x-ndjson`, ...). The client can only write and read it as JSON. A scalar with a non-JSON media type is sent as text, as above.
- A response that may arrive in a media type the client cannot read as its type, such as a model declared as `application/json` or `application/xml`.
- Success responses with different bodies that are not all JSON (a 200 model and a 201 plain-text string).
- Success responses that carry the same value in different `@encode` formats (a 200 duration in seconds and a 201 in milliseconds), since one method reads one way.
- Two operations that send the same model with different visible properties, when every request record name the emitter tries is already a different record. Reported as `name-collision`; rename one operation with `@clientName`.
- A `@discriminator` model that is also a variant of another discriminated model (a nested discriminator). `System.Text.Json` can resolve only one discriminator per hierarchy: reading through the base type would return the wrong subtype, and writing a subtype would fail or omit a discriminator. Reported as `unsupported-nested-discriminator`. A grouping model with no discriminator of its own (`model Dog extends Animal {}`) is fine.
- `@encode` values the client cannot honour (see the encodings table). Reported as `unsupported-encoding`, and an operation that sends or reads one is left out.
- Streaming responses such as server-sent events are read in full before the call returns.
- A `@list` operation whose paging shape cannot be auto-paginated: a paging property nested inside a sub-object, a non-string continuation token, a wrapper name another method already uses, or none of `@nextLink`/`@continuationToken`/`@offset`/`@pageIndex` to follow. Reported as `unsupported-paging-style`; the raw single-page method is still generated.

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

### Pagination

A `@list` operation whose response is shaped with TypeSpec's own pagination decorators gets an extra `IAsyncEnumerable<T>` method alongside the raw single-page one, so you don't have to write the page-following loop yourself:

```typespec
model PagedResult<T> {
  @pageItems items: T[];
  @nextLink next?: url;
}

@route("/stores")
interface Stores {
  @list @get list(@query skip?: int32, @query take?: int32): PagedResult<Store>;
}
```

```csharp
Task<PagedResult<Store>> ListAsync(int? skip, int? take, ...);   // one page
IAsyncEnumerable<Store> ListAllAsync(int? skip, int? take, ...); // every page

await foreach (var store in client.Stores.ListAllAsync(cancellationToken: ct))
{
    Console.WriteLine(store.Name);
}
```

Three paging styles are supported, detected from whichever decorators the page model and operation parameters carry (priority `@nextLink` > `@continuationToken` > `@offset`/`@pageIndex`, when a page model somehow carries more than one):

| Decorator                         | How `ListAllAsync` follows it                                                                                                                               |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@nextLink` (a `url` or `string`) | Follows the link directly through `_client`, resolved against the URL of the page that returned it, replaying the operation's header and cookie parameters. |
| `@continuationToken` (a `string`) | Re-calls the raw method with the previous response's token in place of the matching input parameter, until the token comes back empty.                      |
| `@offset` / `@pageIndex`          | Re-calls the raw method with the counter advanced, until a page comes back with no items (there is no total-count signal to stop on otherwise).             |

A relative next link resolves against the page that returned it, as RFC 3986 has it: `?skip=25` keeps that page's path, and `page2` replaces its last segment. To know the first page's URL, the wrapper sends the first request itself, built by the same private method the raw method uses. A next link is server-controlled, so once resolved it must stay on the origin (scheme, host, and port) of the client's base URL. A link to any other origin throws `InvalidOperationException` before anything is sent, so neither the operation's headers and cookies nor credentials configured on the client itself reach another host. A response declared with a bodyless success (`PagedResult<Store> | void`) ends the enumeration when it arrives.

`@prevLink`, `@firstLink`, `@lastLink`, and `@pageSize` are read as ordinary model and operation properties — they're backward and random-access links, not something a forward-only `IAsyncEnumerable<T>` follows.

A page model whose paging property is nested inside a sub-object, a non-string continuation token, a `@list` operation carrying none of the decorators above, or a wrapper whose name another method of the interface already uses, is reported as `unsupported-paging-style`; the raw single-page method is still generated.

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
dotnet run --project ../../e2e/CustomModels.Tests -f net8.0
dotnet run --project ../../e2e/CustomModels.Tests -f net10.0
```

They also write and read back every model and enum of every example client with the client's own serializer settings, so a contract System.Text.Json rejects fails a test rather than the first request.

### Compile matrix

`npm run matrix` generates one spec covering every type shape in every position, every `@encode` in every position, every media type, awkward names, visibility, and discriminators. Whatever TypeSpec itself rejects is pruned; for the rest, the emitter must either report it or generate C# that builds with warnings as errors and whose every model and enum round-trips through the client serializer.

```powershell
npm run build
npm run matrix                    # check
npm run matrix -- --update        # accept a change to the operations left out
npm run matrix -- --skip=Shadowing  # leave out a group of cases while investigating
```

The operations the emitter leaves out are recorded in `matrix/left-out.txt`, so a supported case that starts being left out fails the run. On a machine whose NuGet config includes a private feed that rejects the current credentials, set `MATRIX_RESTORE_SOURCES=https://api.nuget.org/v3/index.json`.

### Lint & Format

```powershell
npm run lint          # check for lint errors
npm run lint:fix      # auto-fix lint errors
npm run format        # format all files
npm run format:check  # check formatting without writing
```

## Multiple API versions

By default only the latest declared version is emitted (or the one named by `target-version`), into the root namespace. Set `all-versions: true` to emit every version side by side (an API with no `@versioned` declaration has only one "version" and is emitted normally, with no version folder):

Each version is emitted from TypeSpec's projection of the service onto that version, so every declaration has exactly the shape it has there: not only whether it exists (`@added`, `@removed`), but its name (`@renamedFrom`), its type (`@typeChangedFrom`, `@returnTypeChangedFrom`), and whether it is optional (`@madeOptional`, `@madeRequired`). A v1 client for a model renamed in v2 uses the v1 name, and a parameter renamed in v2 is sent under its v1 name. Diagnostics about a declaration are reported once, however many versions are emitted.

```
<output-dir>/
  v1.0/
    Endpoints/        # IWidgets, WidgetsEndpoint, ... for v1.0
    Models/           # Widget, Status, WidgetCreateRequest, ... exactly as v1.0 declares them
    ApiClientExtensions.g.cs
  v2.0/
    Endpoints/
    Models/
    ApiClientExtensions.g.cs
  Infrastructure/     # ModelMap, ClientRuntime: shared by every version
  Models/MergePatch.g.cs   # only when used; shared
  ApiClient.csproj
```

Each version is emitted on its own, into the namespace `<root>.V1_0`, `<root>.V2_0`, and so on. A version's types have exactly that version's shape: a property `@added(Versions.v2)` is absent from `V1_0.Widget`, an enum member `@removed(Versions.v2)` is absent from `V2_0.Status`, a model that only exists from v2 is only generated in `V2_0`, and a `@discriminator` subtype only registers in the versions that have it. Routes use the version (`api/v1.0/widgets`).

```csharp
V1_0.Widget old = await v1Client.Widgets.ReadAsync(id);           // has LegacyCode, no Color
V2_0.Widget current = await v2Client.Widgets.ReadAsync(id, expand: true);   // has Color, no LegacyCode
```

Both versions can be registered in one application. Each registration keeps its own model map, so custom models for one version never leak into another:

```csharp
V1_0.ApiClientExtensions.AddApiClient(services, http => ..., configureModels: m => m.Map<V1_0.Widget, MyV1Widget>());
V2_0.ApiClientExtensions.AddApiClient(services, http => ...);
```

`ModelMap`, `ClientRuntime` and `MergePatch<T>` are written once, in the root namespace, which every version's namespace is nested in. A model in a single-version emit (no `all-versions`) is projected onto that version in the same way, and `version-in-namespace` moves only the endpoints into the version namespace, as it always has.

## Examples

- [`example/simple-api/`](example/simple-api/) — a small widget service.
- [`example/custom-models/`](example/custom-models/) — exercises every place a custom model can be swapped in. It is the subject of the end-to-end tests.
- [`example/all-versions/`](example/all-versions/) — a service whose versions differ in models, enums, subtypes, operations and parameters, emitted with `all-versions`. Its end-to-end tests prove each version has exactly its own shape.
- [`example/versioned-api/`](example/versioned-api/) — a versioned Pet Store demonstrating multi-version route and model definitions. Run it with `./example/versioned-api/build.ps1`.

## Contributing

See [`.github/copilot-instructions.md`](.github/copilot-instructions.md) for architecture details, conventions, and development guidance.
