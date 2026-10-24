import { ok } from "node:assert";
import { describe, it } from "node:test";
import { emit, emitWithDiagnostics, fileContent, has, messagesFor } from "./host.js";

describe("paging", () => {
  describe("nextLink strategy", () => {
    it("declares the wrapper on the interface and implements it by following the link through _client", async () => {
      const results = await emit(`
        import "@typespec/http";
        using Http;

        @service(#{ title: "Test API" })
        namespace TestApi;

        model Store { name: string; }

        model PagedResult<T> {
          @pageItems items: T[];
          totalCount?: int32;
          @nextLink next?: url;
        }

        @route("/stores")
        interface Stores {
          @list @get list(@query skip?: int32, @query take?: int32): PagedResult<Store>;
        }
      `);

      const iface = fileContent(results, "IStores.g.cs");
      ok(
        iface.includes("IAsyncEnumerable<Store> ListAllAsync("),
        "Expected ListAllAsync declared on the interface",
      );
      ok(
        !iface.includes("[EnumeratorCancellation]"),
        "The interface declaration isn't itself an iterator method, so EnumeratorCancellation there would only warn (CS8424)",
      );

      const client = fileContent(results, "StoresEndpoint.g.cs");
      ok(
        client.includes("public async IAsyncEnumerable<Store> ListAllAsync("),
        "Expected ListAllAsync implemented on the endpoint client",
      );
      ok(
        client.includes("[EnumeratorCancellation] CancellationToken cancellationToken = default)"),
        "Expected EnumeratorCancellation on the implementation's cancellation token",
      );
      ok(
        client.includes("var page = await ListAsync("),
        "Expected the wrapper to call the raw method directly (same class)",
      );
      ok(client.includes("page.Items"), "Expected the PascalCase items property");
      ok(
        client.includes("var nextLink = page.Next;"),
        "Expected the PascalCase nextLink property",
      );
      ok(
        client.includes(
          "_client.Request(nextLink).GetJsonAsync<PagedResult<Store>>(cancellationToken: cancellationToken)",
        ),
        "Expected continuation pages fetched directly through _client, with cancellationToken passed by name (GetJsonAsync's 2nd positional parameter is HttpCompletionOption, not CancellationToken)",
      );
      ok(
        !client.includes("IHttpClientFactory"),
        "nextLink strategy on this client needs no HttpClientFactory: _client is already configured",
      );
    });
  });

  describe("continuationToken strategy", () => {
    it("loops by re-calling the raw method with the token substituted in", async () => {
      const results = await emit(`
        import "@typespec/http";
        using Http;

        @service(#{ title: "Test API" })
        namespace TestApi;

        model Pet { name: string; }

        model TokenPagedResult<T> {
          @pageItems items: T[];
          @continuationToken continuationToken?: string;
        }

        @route("/pets")
        interface Pets {
          @list @get list(@query @continuationToken continuationToken?: string): TokenPagedResult<Pet>;
        }
      `);

      const client = fileContent(results, "PetsEndpoint.g.cs");
      ok(
        client.includes("public async IAsyncEnumerable<Pet> ListAllAsync("),
        "Expected ListAllAsync implemented",
      );
      ok(
        client.includes("var token = continuationToken;"),
        "Expected the token seeded from the input parameter",
      );
      ok(
        client.includes("token = page.ContinuationToken;"),
        "Expected the token refreshed from the response each iteration",
      );
      ok(
        client.includes("} while (!string.IsNullOrEmpty(token));"),
        "Expected the loop to stop once the token is empty",
      );
      ok(
        !client.includes("_client.Request(nextLink)"),
        "continuationToken strategy must not bypass the raw method via an absolute-URL request",
      );
    });

    it("falls back to the raw method and warns when the output token has no matching input parameter", async () => {
      const [results, diagnostics] = await emitWithDiagnostics(`
        import "@typespec/http";
        using Http;

        @service(#{ title: "Test API" })
        namespace TestApi;

        model Pet { name: string; }

        model TokenPagedResult<T> {
          @pageItems items: T[];
          @continuationToken continuationToken?: string;
        }

        @route("/pets")
        interface Pets {
          @list @get list(): TokenPagedResult<Pet>;
        }
      `);

      const messages = messagesFor(diagnostics, "unsupported-paging-style");
      ok(messages.length === 1, "Expected one unsupported-paging-style warning");
      ok(
        messages[0].includes("continuationToken"),
        "Expected the reason to mention the unmatched continuationToken",
      );
      ok(
        !fileContent(results, "PetsEndpoint.g.cs").includes("ListAllAsync"),
        "Expected no wrapper to be generated",
      );
      ok(
        fileContent(results, "PetsEndpoint.g.cs").includes(
          "Task<TokenPagedResult<Pet>> ListAsync(",
        ),
        "Expected the raw method to still be generated",
      );
    });
  });

  describe("offset / pageIndex strategy", () => {
    it("follows an offset, stopping on an empty page", async () => {
      const results = await emit(`
        import "@typespec/http";
        using Http;

        @service(#{ title: "Test API" })
        namespace TestApi;

        model Customer { name: string; }

        model OffsetPagedResult<T> {
          @pageItems items: T[];
        }

        @route("/customers")
        interface Customers {
          @list @get list(@query @offset offset?: int32, @query take?: int32): OffsetPagedResult<Customer>;
        }
      `);

      const client = fileContent(results, "CustomersEndpoint.g.cs");
      ok(
        client.includes("public async IAsyncEnumerable<Customer> ListAllAsync("),
        "Expected ListAllAsync implemented",
      );
      ok(
        client.includes("var currentOffset = offset ?? 0;"),
        "Expected the optional offset parameter seeded with ?? 0",
      );
      ok(
        client.includes("currentOffset += count;"),
        "Expected the offset advanced by the number of items actually received",
      );
      ok(
        client.includes("if (count == 0) yield break;"),
        "Expected the loop to stop on an empty page",
      );
    });

    it("follows a pageIndex, incrementing by one per page", async () => {
      const results = await emit(`
        import "@typespec/http";
        using Http;

        @service(#{ title: "Test API" })
        namespace TestApi;

        model Customer { name: string; }

        model IndexedPagedResult<T> {
          @pageItems items: T[];
        }

        @route("/customers")
        interface Customers {
          @list @get list(@query @pageIndex pageIndex?: int32): IndexedPagedResult<Customer>;
        }
      `);

      const client = fileContent(results, "CustomersEndpoint.g.cs");
      ok(
        client.includes("var currentPageIndex = pageIndex ?? 0;"),
        "Expected the pageIndex counter seeded from the input parameter",
      );
      ok(
        client.includes("currentPageIndex++;"),
        "Expected the page index advanced by one per iteration",
      );
    });
  });

  describe("priority when multiple signals are present", () => {
    it("prefers nextLink over continuationToken", async () => {
      const results = await emit(`
        import "@typespec/http";
        using Http;

        @service(#{ title: "Test API" })
        namespace TestApi;

        model Widget { name: string; }

        model MultiPagedResult<T> {
          @pageItems items: T[];
          @nextLink next?: url;
          @continuationToken continuationToken?: string;
        }

        @route("/widgets")
        interface Widgets {
          @list @get list(@query @continuationToken continuationToken?: string): MultiPagedResult<Widget>;
        }
      `);

      const client = fileContent(results, "WidgetsEndpoint.g.cs");
      ok(
        client.includes("_client.Request(nextLink)"),
        "Expected the nextLink strategy to win over continuationToken",
      );
      ok(
        !client.includes("while (!string.IsNullOrEmpty(token));"),
        "Expected no continuationToken loop to be generated",
      );
    });
  });

  describe("unsupported shapes", () => {
    it("warns and falls back to the raw method for a nested paging property", async () => {
      const [results, diagnostics] = await emitWithDiagnostics(`
        import "@typespec/http";
        using Http;

        @service(#{ title: "Test API" })
        namespace TestApi;

        model Widget { name: string; }

        model LinkContainer {
          @nextLink next?: url;
        }

        model NestedPagedResult<T> {
          @pageItems items: T[];
          links: LinkContainer;
        }

        @route("/widgets")
        interface Widgets {
          @list @get list(): NestedPagedResult<Widget>;
        }
      `);

      const messages = messagesFor(diagnostics, "unsupported-paging-style");
      ok(messages.length === 1, "Expected one unsupported-paging-style warning");
      ok(messages[0].includes("nested"), messages[0]);
      ok(!fileContent(results, "WidgetsEndpoint.g.cs").includes("ListAllAsync"));
    });

    it("warns and falls back to the raw method when no forward-iteration signal is recognized", async () => {
      const [results, diagnostics] = await emitWithDiagnostics(`
        import "@typespec/http";
        using Http;

        @service(#{ title: "Test API" })
        namespace TestApi;

        model Widget { name: string; }

        model LinkOnlyPagedResult<T> {
          @pageItems items: T[];
          @prevLink prev?: url;
          @firstLink first?: url;
          @lastLink last?: url;
        }

        @route("/widgets")
        interface Widgets {
          @list @get list(): LinkOnlyPagedResult<Widget>;
        }
      `);

      const messages = messagesFor(diagnostics, "unsupported-paging-style");
      ok(messages.length === 1, "Expected one unsupported-paging-style warning");

      const client = fileContent(results, "WidgetsEndpoint.g.cs");
      ok(!client.includes("ListAllAsync"));
      ok(
        client.includes("Task<LinkOnlyPagedResult<Widget>> ListAsync("),
        "Expected the raw method to still be generated",
      );
      ok(
        has(results, "LinkOnlyPagedResult.g.cs"),
        "Expected the page model's record to still be emitted",
      );
      const model = fileContent(results, "LinkOnlyPagedResult.g.cs");
      ok(
        model.includes("Prev") && model.includes("First") && model.includes("Last"),
        "Expected prevLink/firstLink/lastLink to still render as ordinary properties",
      );
    });

    it("does not crash and reports the compiler's own diagnostic when @list is missing @pageItems", async () => {
      const [, diagnostics] = await emitWithDiagnostics(`
        import "@typespec/http";
        using Http;

        @service(#{ title: "Test API" })
        namespace TestApi;

        model Widget { name: string; }

        model EmptyPagedResult<T> {
          @nextLink next?: url;
        }

        @route("/widgets")
        interface Widgets {
          @list @get list(): EmptyPagedResult<Widget>;
        }
      `);

      // Severity "error" — the compiler's own validatePagingOperations pass
      // reports this and skips emission for the program entirely, before the
      // emitter's own paging detection ever runs.
      ok(
        diagnostics.some((d) => d.code === "missing-paging-items"),
        "Expected the compiler's own missing-paging-items diagnostic",
      );
    });
  });
});
