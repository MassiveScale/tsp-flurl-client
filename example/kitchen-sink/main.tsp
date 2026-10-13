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
}
