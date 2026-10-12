import "@typespec/http";
import "@massivescale/tsp-flurl-client";

using Http;
using MassiveScale.TspFlurlClient;

/**
 * Exercises every place a caller can swap in a custom model: responses, list items,
 * nested properties, discriminated hierarchies, merge patches, and request bodies.
 */
@service(#{ title: "Custom Models" })
namespace MassiveScale.CustomModels;

enum Color {
  red,
  blue,
}

/** Declared with numbers, so it travels as a JSON number. */
enum Priority {
  low: 1,
  high: 2,
}

model Widget {
  @visibility(Lifecycle.Read)
  id: string;

  name: string;
  color?: Color;
  priority?: Priority;
}

model WidgetPage {
  items: Widget[];
  featured?: Widget;
}

model Owner {
  name: string;
}

/** Has required properties of every reference type, none of which can be left unset. */
model Gadget {
  id: string;
  owner: Owner;
  tags: Record<string>;
  raw: unknown;
  bytes: bytes;
}

/** Unions and literal types, which C# cannot express directly. */
model Mixed {
  kind: "mixed";
  value: string | int32;
  note: string | null;
  owner: Owner | null;
  tags?: string | null;
}

@discriminator("kind")
model Pet {
  kind: string;
  name: string;
}

model Dog extends Pet {
  kind: "dog";
  isBarker: boolean;
}

model Cat extends Pet {
  kind: "cat";
  isPurrer: boolean;
}

@route("/widgets")
interface Widgets {
  @get list(
    @query color?: Color,
    @query tags?: string[],
    @header("X-Trace") trace?: string,
  ): WidgetPage;

  @get read(@path id: string): Widget;
  @post create(@body body: Widget): Widget;

  @route("bulk") @post createMany(@body body: Widget[]): Widget[];

  @patch update(
    @path id: string,
    @body body: MergePatchUpdate<Widget>,
  ): Widget;

  @delete delete(@path id: string): void;
}

@route("/pets")
interface Pets {
  @get list(): Pet[];
  @post create(@body body: Pet): Pet;
}

@route("/files")
interface Files {
  @post upload(
    @header contentType: "application/octet-stream",
    @body body: bytes,
  ): void;

  @route("{id}") @get download(@path id: string): {
    @header contentType: "application/octet-stream";
    @body body: bytes;
  };
}

@route("/gadgets")
interface Gadgets {
  @get read(@path id: string): Gadget;
}

@access(Access.internal)
@route("/admin")
interface Admin {
  @post reindex(): void;
}

@route("/mixed")
interface Mixes {
  @get read(): Mixed;
  @post create(@body body: Mixed): Mixed;
  @route("either") @get either(): Widget | Owner;
}
