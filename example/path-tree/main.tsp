import "@typespec/http";

using Http;

/**
 * A store API emitted with `client-shape: path`, where every URL segment is a step
 * of the call chain: `client.Stores(storeId).Pets(petId).GetAsync()`. It covers
 * steps shared by several interfaces, a route that starts with a parameter (an
 * indexer on the client), a segment that mixes text and parameters, a route of
 * `/`, two operations sharing a verb on one builder, and paging.
 */
@service(#{ title: "Path Tree" })
namespace MassiveScale.PathTree;

model Store {
  id: string;
  name: string;
}

model Pet {
  id: string;
  name: string;
}

model PetPage {
  @pageItems items: Pet[];
  @nextLink next?: url;
}

model Toy {
  name: string;
}

model Settings {
  theme: string;
}

model Report {
  total: int32;
}

@route("/stores")
interface Stores {
  @get list(): Store[];
  @post create(@body body: Store): Store;
  @get read(@path storeId: string): Store;
  @delete remove(@path storeId: string): void;
}

@route("/stores/{storeId}/pets")
interface Pets {
  @list @get list(@path storeId: string): PetPage;
  @get read(@path storeId: string, @path petId: string): Pet;
  @patch update(
    @path storeId: string,
    @path petId: string,
    @body body: MergePatchUpdate<Pet>,
  ): void;
}

@route("/stores/{storeId}/pets/{petId}/toys")
interface Toys {
  @sharedRoute @get list(@path storeId: string, @path petId: string): Toy[];
  @sharedRoute @get search(
    @path storeId: string,
    @path petId: string,
    @query q: string,
  ): Toy[];
}

@route("/{tenant}/settings")
interface TenantSettings {
  @get read(@path tenant: string): Settings;
}

@route("/reports")
interface Reports {
  @route("{from}-{to}") @get range(@path from: string, @path to: string): Report;
}

@route("/")
interface Health {
  @get check(): void;
}
