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
  @visibility(Lifecycle.Read) vin: string;
  seats: int32;
}

model Bike extends Vehicle {
  type: "bike";
}

@route("/vehicles")
interface Vehicles {
  @post create(@body body: Vehicle): Vehicle;
  @route("cars") @post createCar(@body body: Car): Car;
  @route("optional") @post maybeCreate(@body body?: Vehicle): void;
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

@route("/misc")
interface Misc {
  @get nested(): Nested;
  @route("scalars") @get scalars(): Scalars;
  @route("either") @get either(): Derived | Special;
  @route("lookup/{kind}/{id}") @get lookup(@path kind: string, @path id: string): string;
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
  @route("upsert") @post upsert(): { @statusCode _: 200; @body body: Derived } | { @statusCode _: 201; @body body: Spread };
  @route("label") @get label(): { @header contentType: "application/json" | "text/plain"; @body body: string };
  @route("latin") @post latin(@header contentType: "text/plain; charset=iso-8859-1", @body body: string): void;
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
