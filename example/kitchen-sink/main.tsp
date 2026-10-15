import "@typespec/http";
import "@massivescale/tsp-flurl-client";

using Http;
using MassiveScale.TspFlurlClient;

/**
 * Exercises most of TypeSpec so the generated C# can be compiled with warnings as
 * errors. Docs here deliberately contain XML-significant characters: a < b && c > d.
 */
@service(#{ title: "Kitchen Sink" })
namespace MassiveScale.KitchenSink;

model Scalars {
  s: string;
  i8: int8;
  i16: int16;
  i32: int32;
  i64: int64;
  u8: uint8;
  u16: uint16;
  u32: uint32;
  u64: uint64;
  safe: safeint;
  f32: float32;
  f64: float64;
  money: decimal;
  dec128: decimal128;
  b: boolean;
  data: bytes;
  utc: utcDateTime;
  off: offsetDateTime;
  date: plainDate;
  time: plainTime;
  dur: duration;
  link: url;
  num: numeric;
  whole: integer;
  fl: float;
  @format("uuid") id: string;
  @encode("string") flag: boolean;
}

/** An enum of strings. */
enum Color {
  /** The colour red. */
  red,
  blue,
  `dark-green`,
}

enum Magnitude {
  one: 1,
  huge: 100000000000000000000,
  tiny: 0.5,
}

enum Level {
  low: 1,
  high: 2,
  mixed: "mixed",
}

model Base {
  id: string;
}

model Derived extends Base {
  name: string;
}

model Spread {
  ...Base;
  extra: string;
}

model Special is Derived {
  note?: string;
}

model Page<T> {
  items: T[];
  next?: string;
}

/** A generic model that only the internal admin interface uses. */
@access(Access.internal)
model Envelope<T> {
  data: T;
}

/** A generic model with a parameter no property uses, so every reference still passes two arguments. */
model Tagged<T, Tag> {
  value: T;
}

/** A generic model renamed for C#. */
@clientName("Bundle")
model Box<T> {
  content: T;
}

model Nested {
  grid: string[][];
  byName: Record<Derived>;
  lists: Record<string[]>;
  maybe: string | null;
  either: string | int32;
  oneOf: "a" | "b" | "c";
  color?: Color;
  level: Level;
  scalars: Scalars;
  page: Page<Derived>;
  pageOfText: Page<string>;
}

/** Wire names that differ from the TypeSpec names, and a property that is always null. */
model WireNames {
  @encodedName("application/json", "display_name") displayName: string;
  @encodedName("application/xml", "Ignored") count: int32;
  nothing: null;
}

/** Every @encode TypeSpec defines that is not the default wire format. */
model Timed {
  @encode(DateTimeKnownEncoding.unixTimestamp, int64) at: utcDateTime;
  @encode(DateTimeKnownEncoding.unixTimestamp, int64) maybeAt?: utcDateTime;
  @encode(DateTimeKnownEncoding.rfc7231) httpDate: utcDateTime;
  @encode(DurationKnownEncoding.seconds, int32) wait: duration;
  @encode(DurationKnownEncoding.seconds, float64) precise: duration;
  @encode(DurationKnownEncoding.milliseconds, int64) ms: duration;
  @encode(BytesKnownEncoding.base64url) token: bytes;
  @encode(ArrayEncoding.pipeDelimited) tags: string[];
  @encode(ArrayEncoding.commaDelimited) counts?: int32[];
}

model Encoded {
  @encode("string") big: int64;
  @encode("string") ratio: float64;
  took: duration;
  @encode(DateTimeKnownEncoding.rfc3339) at: utcDateTime;
  @encode(BytesKnownEncoding.base64) blob: bytes;
  whole: integer;
}

@discriminator("kind")
model Animal {
  kind: string;
  name: string;
}

/** A grouping model with no discriminator value of its own. */
model Dog extends Animal {}

model Labrador extends Dog {
  kind: "labrador";
  guide?: boolean;
}

model Poodle extends Dog {
  kind: "poodle";
}

model Cat extends Animal {
  kind: "cat";
}

/** A discriminated hierarchy with read-only properties, so its requests are filtered as a hierarchy. */
@discriminator("type")
model Vehicle {
  @visibility(Lifecycle.Read) id: string;
  type: string;
  wheels: int32;
}

model Car extends Vehicle {
  type: "car";
  /** Narrows the inherited property; the inherited C# member already carries it. */
  wheels: 4;
  @visibility(Lifecycle.Read) vin: string;
  seats: int32;
}

model Bike extends Vehicle {
  type: "bike";
}

/** A body whose read-only properties are nested too, so each nested model is filtered as well. */
model Fleet {
  @visibility(Lifecycle.Read) id: string;
  name: string;
  vehicles: Vehicle[];
  depot: Depot | null;
}

/** A model with a read-only property, nested in a request and sent as a nullable body. */
model Depot {
  @visibility(Lifecycle.Read) id: string;
  city: string;
}

@route("/vehicles")
interface Vehicles {
  @post create(@body body: Vehicle): Vehicle;
  @route("cars") @post createCar(@body body: Car): Car;
  @route("optional") @post maybeCreate(@body body?: Vehicle): void;
  @route("fleets") @post createFleet(@body body: Fleet): Fleet;
  @route("depots") @post createDepot(@body body: Depot | null): void;
}

@error
model ApiError {
  code: int32;
  message: string;
}

model Created {
  @statusCode _: 201;
  @body body: Derived;
}

@route("/derived")
interface DerivedItems {
  @get list(@query limit?: int32, @query color?: Color, @query tags?: string[], @header("X-Trace") trace?: string): Page<Derived> | ApiError;
  @get read(@path id: string): Derived | ApiError;
  @post create(@body body: Derived): Created | ApiError;
  @put replace(@path id: string, @body body: Derived): Derived | ApiError;
  @patch update(@path id: string, @body body: MergePatchUpdate<Derived>): Derived | ApiError;
  @delete remove(@path id: string): void | ApiError;
  @route("bulk") @post createMany(@body body: Derived[]): Derived[] | ApiError;
}

@route("/animals")
interface Animals {
  @get list(): Animal[];
  @get read(@path id: string): Animal;
  @post create(@body body: Animal): Animal;
}

@route("/files")
interface Files {
  @post upload(@header contentType: "application/octet-stream", @body body: bytes): void;
  @route("{id}") @get download(@path id: string): {
    @header contentType: "application/octet-stream";
    @body body: bytes;
  };
  @route("notes") @post note(@header contentType: "text/plain", @body body: string): void;
}

/** A generic model whose template parameter is named after a C# keyword, so it is written `@class`. */
model Keyed<class> {
  key: string;
  value: class;
}

@route("/misc")
interface Misc {
  @get nested(): Nested;
  @route("scalars") @get scalars(): Scalars;
  @route("either") @get either(): Derived | Special;
  @route("keyed") @get keyed(): Keyed<Scalars>;
  @route("lookup/{kind}/{id}") @get lookup(@path kind: string, @path id: string): string;
  /** Parameters named after C# keywords, which are escaped (`@await`, `@class`). */
  @route("keywords/{await}") @get keywords(@path await: string, @query class?: string, @header var?: string): string;
  @route("encoded") @get encoded(): Encoded;
  @route("encoded") @post sendEncoded(@body body: Encoded): Encoded;
  @route("cookies") @get cookies(@cookie session: string, @cookie flavour?: string): string;
  @route("lists") @get lists(@query tags?: string[], @query(#{ explode: true }) labels?: string[], @query(#{ explode: false }) csv?: string[]): string;
  @route("fail") @get fail(): string | ApiError;
  @route("blob") @get blob(@query data: bytes, @header("X-Blob") token: bytes): string;
  @route("magnitude") @get magnitude(): Magnitude;
  @route("vendor") @post vendor(@header contentType: "application/vnd.acme+json", @body body: Derived): Derived;
  @route("optional") @get optional(): Derived | void;
  @route("box") @get box(): Box<Derived>;
  @route("tagged") @get tagged(): Tagged<Derived, string>;
  @route("wire") @post wireNames(@body body: WireNames): WireNames;
  @route("timed") @post timed(@body body: Timed): Timed;
  @route("timed") @patch patchTimed(@body body: MergePatchUpdate<Timed>): void;
  @route("encoded") @patch patchEncoded(@body body: MergePatchUpdate<Encoded>): void;
  @route("encoded-params/{at}") @get encodedParams(
    @path @encode(DateTimeKnownEncoding.unixTimestamp, int64) at: utcDateTime,
    @query @encode(DateTimeKnownEncoding.rfc7231) since: utcDateTime,
    @query @encode(ArrayEncoding.pipeDelimited) tags: string[],
    @header("X-Wait") @encode(DurationKnownEncoding.seconds, int32) wait: duration,
    @query @encode(BytesKnownEncoding.base64url) token: bytes,
  ): void;
  @route("unix") @get unix(): { @body @encode(DateTimeKnownEncoding.unixTimestamp, int64) at: utcDateTime };
  @route("unix") @put setUnix(@body @encode(DateTimeKnownEncoding.unixTimestamp, int64) at: utcDateTime): void;
  @route("upsert") @post upsert(): { @statusCode _: 200; @body body: Derived } | { @statusCode _: 201; @body body: Spread };
  @route("label") @get label(): { @header contentType: "application/json" | "text/plain"; @body body: string };
  @route("latin") @post latin(@header contentType: "text/plain; charset=iso-8859-1", @body body: string): void;
  @route("cp1252") @post cp1252(@header contentType: "text/plain; charset=windows-1252", @body body: string): void;
  @route("maybebytes") @get maybeBytes(): { @header contentType: "application/octet-stream"; @body body: bytes } | void;
  /** A date-time header is an RFC 7231 date unless it is given another @encode; a cookie or query is ISO 8601. */
  @route("dates") @get dates(
    @header ifModifiedSince: utcDateTime,
    @header("X-Seen") seen?: offsetDateTime,
    @header @encode(DateTimeKnownEncoding.rfc3339) ifUnmodifiedSince: utcDateTime,
    @cookie since: utcDateTime,
    @query after: utcDateTime,
  ): void;
  /** A path parameter that allows reserved characters (`{+path}`) keeps its `/`; each segment is still encoded. */
  @route("reserved/{+path}/items/{id}") @get reserved(@path path: string, @path id: string): string;
}

/** Scalar bodies, which TypeSpec sends as text/plain. */
@route("/text")
interface Text {
  @route("when") @get when(): utcDateTime;
  @route("when") @put setWhen(@body body: utcDateTime): void;
  @route("count") @get count(): int32;
  @route("count") @put setCount(@body body: int32): void;
  @route("took") @get took(): duration;
  @route("day") @get day(): plainDate;
  @route("price") @get price(): decimal;
  @route("on") @get on(): boolean;
  @route("either") @get either(): int32 | string;
  @route("maybe") @get maybe(): int32 | void;
  @route("id") @get id(): { @body @format("uuid") id: string };
  @route("id") @put setId(@body @format("uuid") id: string): void;
}

/** One operation per @encode, carrying the value in every position, to check each wire format end to end. */
@route("/encodings")
interface Encodings {
  @route("unix/{p}") @put unix(
    @path @encode(DateTimeKnownEncoding.unixTimestamp, int64) p: utcDateTime,
    @query @encode(DateTimeKnownEncoding.unixTimestamp, int64) q: utcDateTime,
    @header("X-V") @encode(DateTimeKnownEncoding.unixTimestamp, int64) h: utcDateTime,
    @cookie @encode(DateTimeKnownEncoding.unixTimestamp, int64) c: utcDateTime,
    @body @encode(DateTimeKnownEncoding.unixTimestamp, int64) body: utcDateTime,
  ): { @body @encode(DateTimeKnownEncoding.unixTimestamp, int64) value: utcDateTime };
  @route("rfc7231/{p}") @put rfc7231(
    @path @encode(DateTimeKnownEncoding.rfc7231) p: utcDateTime,
    @query @encode(DateTimeKnownEncoding.rfc7231) q: utcDateTime,
    @header("X-V") @encode(DateTimeKnownEncoding.rfc7231) h: utcDateTime,
    @cookie @encode(DateTimeKnownEncoding.rfc7231) c: utcDateTime,
    @body @encode(DateTimeKnownEncoding.rfc7231) body: utcDateTime,
  ): { @body @encode(DateTimeKnownEncoding.rfc7231) value: utcDateTime };
  @route("wholeSeconds/{p}") @put wholeSeconds(
    @path @encode(DurationKnownEncoding.seconds, int32) p: duration,
    @query @encode(DurationKnownEncoding.seconds, int32) q: duration,
    @header("X-V") @encode(DurationKnownEncoding.seconds, int32) h: duration,
    @cookie @encode(DurationKnownEncoding.seconds, int32) c: duration,
    @body @encode(DurationKnownEncoding.seconds, int32) body: duration,
  ): { @body @encode(DurationKnownEncoding.seconds, int32) value: duration };
  @route("seconds/{p}") @put seconds(
    @path @encode(DurationKnownEncoding.seconds, float64) p: duration,
    @query @encode(DurationKnownEncoding.seconds, float64) q: duration,
    @header("X-V") @encode(DurationKnownEncoding.seconds, float64) h: duration,
    @cookie @encode(DurationKnownEncoding.seconds, float64) c: duration,
    @body @encode(DurationKnownEncoding.seconds, float64) body: duration,
  ): { @body @encode(DurationKnownEncoding.seconds, float64) value: duration };
  @route("wholeMilliseconds/{p}") @put wholeMilliseconds(
    @path @encode(DurationKnownEncoding.milliseconds, int64) p: duration,
    @query @encode(DurationKnownEncoding.milliseconds, int64) q: duration,
    @header("X-V") @encode(DurationKnownEncoding.milliseconds, int64) h: duration,
    @cookie @encode(DurationKnownEncoding.milliseconds, int64) c: duration,
    @body @encode(DurationKnownEncoding.milliseconds, int64) body: duration,
  ): { @body @encode(DurationKnownEncoding.milliseconds, int64) value: duration };
  @route("milliseconds/{p}") @put milliseconds(
    @path @encode(DurationKnownEncoding.milliseconds, float32) p: duration,
    @query @encode(DurationKnownEncoding.milliseconds, float32) q: duration,
    @header("X-V") @encode(DurationKnownEncoding.milliseconds, float32) h: duration,
    @cookie @encode(DurationKnownEncoding.milliseconds, float32) c: duration,
    @body @encode(DurationKnownEncoding.milliseconds, float32) body: duration,
  ): { @body @encode(DurationKnownEncoding.milliseconds, float32) value: duration };
  @route("base64url/{p}") @put base64url(
    @path @encode(BytesKnownEncoding.base64url) p: bytes,
    @query @encode(BytesKnownEncoding.base64url) q: bytes,
    @header("X-V") @encode(BytesKnownEncoding.base64url) h: bytes,
    @cookie @encode(BytesKnownEncoding.base64url) c: bytes,
    @body @encode(BytesKnownEncoding.base64url) body: bytes,
  ): { @body @encode(BytesKnownEncoding.base64url) value: bytes };
  @route("base64/{p}") @put base64(
    @path @encode(BytesKnownEncoding.base64) p: bytes,
    @query @encode(BytesKnownEncoding.base64) q: bytes,
    @header("X-V") @encode(BytesKnownEncoding.base64) h: bytes,
    @cookie @encode(BytesKnownEncoding.base64) c: bytes,
    @body @encode(BytesKnownEncoding.base64) body: bytes,
  ): { @body @encode(BytesKnownEncoding.base64) value: bytes };
  @route("pipe") @get pipe(@query @encode(ArrayEncoding.pipeDelimited) q: string[], @header("X-V") @encode(ArrayEncoding.pipeDelimited) h: string[], @cookie @encode(ArrayEncoding.pipeDelimited) c: string[]): void;
  @route("space") @get space(@query @encode(ArrayEncoding.spaceDelimited) q: string[], @header("X-V") @encode(ArrayEncoding.spaceDelimited) h: string[], @cookie @encode(ArrayEncoding.spaceDelimited) c: string[]): void;
  @route("comma") @get comma(@query @encode(ArrayEncoding.commaDelimited) q: string[], @header("X-V") @encode(ArrayEncoding.commaDelimited) h: string[], @cookie @encode(ArrayEncoding.commaDelimited) c: string[]): void;
  @route("newline-query") @get newlineQuery(@query @encode(ArrayEncoding.newlineDelimited) q: string[]): void;
}

@clientName("Pings")
@route("/ping")
interface Health {
  @get ping(): string;
}

@access(Access.internal)
@route("/admin")
interface Admin {
  @post reindex(): void;
  @route("status") @get status(): Envelope<string>;
}
