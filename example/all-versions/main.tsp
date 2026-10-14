import "@typespec/http";
import "@typespec/versioning";

using Http;
using Versioning;

/**
 * A service whose versions genuinely differ, emitted with `all-versions`: each
 * version gets its own models, enums, request records and clients, shaped exactly
 * as that version declares them.
 */
@service(#{ title: "All Versions" })
@versioned(Versions)
namespace MassiveScale.AllVersions;

enum Versions {
  v1: "v1.0",
  v2: "v2.0",
}

enum Status {
  active,
  @added(Versions.v2) archived,
  @removed(Versions.v2) legacy,
}

model Widget {
  @visibility(Lifecycle.Read) id: string;
  name: string;
  status?: Status;
  @added(Versions.v2) color?: string;
  @removed(Versions.v2) legacyCode?: string;
}

@added(Versions.v2)
model Label {
  text: string;
}

@discriminator("kind")
model Pet {
  kind: string;
  name: string;
}

model Dog extends Pet {
  kind: "dog";
}

@added(Versions.v2)
model Cat extends Pet {
  kind: "cat";
}

@route("/widgets")
interface Widgets {
  @get read(
    @path id: string,
    @added(Versions.v2) @query expand?: boolean,
  ): Widget;

  @post create(@body body: Widget): Widget;

  @route("labels") @added(Versions.v2) @get labels(): Label[];
}

/** Renamed, retyped and made optional in v2, so v1 must keep its original shape. */
@renamedFrom(Versions.v2, "Gadget")
model Gizmo {
  @renamedFrom(Versions.v2, "title") name: string;
  @typeChangedFrom(Versions.v2, int32) size: string;
  @madeOptional(Versions.v2) note?: string;
}

@route("/gizmos")
interface Gizmos {
  @get read(@query @renamedFrom(Versions.v2, "q") search: string): Gizmo;
  @returnTypeChangedFrom(Versions.v2, int32) @route("count") @get count(): string;
}

@route("/pets")
interface Pets {
  @get list(): Pet[];
}
