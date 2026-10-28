import { ok } from "node:assert";
import { describe, it } from "node:test";
import {
  emit,
  emitWithDiagnostics,
  fileContent,
  has,
  messagesFor,
} from "./host.js";

describe("paging", () => {
  describe("nextLink strategy", () => {
    it("declares the wrapper on the request builder and follows the link through the builder's Flurl client", async () => {
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

      const client = fileContent(results, "StoresRequestBuilders.g.cs");
      ok(
        client.includes(
          "public async IAsyncEnumerable<Store> ListAllAsync(int? skip = null, int? take = null, [EnumeratorCancellation] CancellationToken cancellationToken = default)",
        ),
        "Expected ListAllAsync implemented on the request builder, with EnumeratorCancellation on its cancellation token",
      );
      ok(
        client.split("[EnumeratorCancellation]").length === 2,
        "Expected the wrapper declared once, since there is no interface declaration any more",
      );
      ok(
        client.includes(
          "var page = await ListAsync(skip, take, cancellationToken).ConfigureAwait(false);",
        ),
        "Expected the wrapper to send the first page through the raw method",
      );
      ok(
        !client.includes("BuildListRequest"),
        "Expected no private request builder: the first page's URL is not needed",
      );
      ok(
        client.includes("page.Items"),
        "Expected the PascalCase items property",
      );
      ok(
        client.includes("var nextLink = page.Next;"),
        "Expected the PascalCase nextLink property",
      );
      ok(
        client.includes(
          "var nextRequest = Client.Request(nextLink.OriginalString);",
        ),
        "Expected a url next link handed to Flurl as the server wrote it, which ToString() would unescape",
      );
      ok(
        client.includes(
          "PagedResult<Store>? nextPage = await nextRequest.GetJsonAsync<PagedResult<Store>>(cancellationToken: cancellationToken)",
        ),
        "Expected continuation pages fetched with cancellationToken passed by name (GetJsonAsync's first positional parameter is HttpCompletionOption, not CancellationToken)",
      );
      ok(
        !/WithAutoRedirect|AllowHttpStatus|InvalidOperationException|Uri\.Compare/.test(
          client,
        ),
        "Expected Flurl to follow redirects and any host, with no origin check of its own",
      );
      ok(
        !client.includes("IHttpClientFactory"),
        "nextLink strategy on this builder needs no HttpClientFactory: its Flurl client is already configured",
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

      const client = fileContent(results, "PetsRequestBuilders.g.cs");
      ok(
        client.includes("public async IAsyncEnumerable<Pet> ListAllAsync("),
        "Expected ListAllAsync implemented",
      );
      ok(
        client.includes("string? token = continuationToken;"),
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
        !client.includes("nextUri"),
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
      ok(
        messages.length === 1,
        "Expected one unsupported-paging-style warning",
      );
      ok(
        messages[0].includes("continuationToken"),
        "Expected the reason to mention the unmatched continuationToken",
      );
      ok(
        !fileContent(results, "PetsRequestBuilders.g.cs").includes(
          "ListAllAsync",
        ),
        "Expected no wrapper to be generated",
      );
      ok(
        fileContent(results, "PetsRequestBuilders.g.cs").includes(
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

      const client = fileContent(results, "CustomersRequestBuilders.g.cs");
      ok(
        client.includes(
          "public async IAsyncEnumerable<Customer> ListAllAsync(",
        ),
        "Expected ListAllAsync implemented",
      );
      ok(
        client.includes("var currentOffset = offset ?? 0;"),
        "Expected the optional offset parameter seeded with ?? 0",
      );
      ok(
        client.includes("checked { currentOffset += (int)count; }"),
        "Expected the offset advanced by the number of items actually received, cast to the counter's own type",
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

      const client = fileContent(results, "CustomersRequestBuilders.g.cs");
      ok(
        client.includes("var currentPageIndex = pageIndex ?? 0;"),
        "Expected the pageIndex counter seeded from the input parameter",
      );
      ok(
        client.includes("checked { currentPageIndex++; }"),
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

      const client = fileContent(results, "WidgetsRequestBuilders.g.cs");
      ok(
        client.includes("Client.Request(nextLink.OriginalString)"),
        "Expected the nextLink strategy to win over continuationToken",
      );
      ok(
        !client.includes("while (!string.IsNullOrEmpty(token));"),
        "Expected no continuationToken loop to be generated",
      );
    });
  });

  describe("local name collisions with forwarded parameters", () => {
    it("renames the continuationToken loop variable when a parameter is literally named token", async () => {
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
          @list @get list(@query @continuationToken token?: string): TokenPagedResult<Pet>;
        }
      `);

      const client = fileContent(results, "PetsRequestBuilders.g.cs");
      ok(
        client.includes("string? token2 = token;"),
        "Expected the loop-local token variable renamed to avoid shadowing the token parameter",
      );
      ok(
        client.includes("token2 = page.ContinuationToken;") &&
          client.includes("while (!string.IsNullOrEmpty(token2));"),
        "Expected every reference to use the renamed variable consistently",
      );
    });

    it("renames nextLink's page/nextRequest locals when parameters use those names", async () => {
      const results = await emit(`
        import "@typespec/http";
        using Http;

        @service(#{ title: "Test API" })
        namespace TestApi;

        model Store { name: string; }

        model PagedResult<T> {
          @pageItems items: T[];
          @nextLink next?: url;
        }

        @route("/stores")
        interface Stores {
          @list @get list(@query page?: int32, @query nextRequest?: string): PagedResult<Store>;
        }
      `);

      const client = fileContent(results, "StoresRequestBuilders.g.cs");
      ok(
        client.includes(
          "var page2 = await ListAsync(page, nextRequest, cancellationToken)",
        ),
        "Expected the first-page variable renamed to avoid shadowing the page parameter",
      );
      ok(
        client.includes(
          "var nextRequest2 = Client.Request(nextLink.OriginalString);",
        ),
        "Expected the Flurl request variable renamed to avoid shadowing the nextRequest parameter",
      );
    });

    it("renames offset/pageIndex's count variable when a parameter is literally named count", async () => {
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
          @list @get list(@query @offset offset?: int32, @query count?: int32): OffsetPagedResult<Customer>;
        }
      `);

      const client = fileContent(results, "CustomersRequestBuilders.g.cs");
      ok(
        client.includes("var count2 = 0;") &&
          client.includes("count2++;") &&
          client.includes("if (count2 == 0) yield break;") &&
          client.includes("checked { currentOffset += (int)count2; }"),
        "Expected the item-count variable renamed to avoid shadowing the count parameter",
      );
    });
  });

  describe("headers and cookies on nextLink continuation requests", () => {
    it("replays an optional header parameter on every continuation request", async () => {
      const results = await emit(`
        import "@typespec/http";
        using Http;

        @service(#{ title: "Test API" })
        namespace TestApi;

        model Store { name: string; }

        model PagedResult<T> {
          @pageItems items: T[];
          @nextLink next?: url;
        }

        @route("/stores")
        interface Stores {
          @list @get list(@header("X-Tenant-Id") tenantId?: string): PagedResult<Store>;
        }
      `);

      const client = fileContent(results, "StoresRequestBuilders.g.cs");
      ok(
        client.includes(
          'if (tenantId is not null) nextRequest.WithHeader("X-Tenant-Id", ClientRuntime.ToWireString(tenantId));',
        ),
        "Expected the optional header replayed, guarded against null",
      );
    });

    it("hands the next link to Flurl as written, with no origin check of its own", async () => {
      const results = await emit(`
        import "@typespec/http";
        using Http;

        @service(#{ title: "Test API" })
        namespace TestApi;

        model Store { name: string; }

        model PagedResult<T> {
          @pageItems items: T[];
          @nextLink next?: url;
        }

        @route("/stores")
        interface Stores {
          @list @get list(@query skip?: int32): PagedResult<Store>;
        }
      `);

      const client = fileContent(results, "StoresRequestBuilders.g.cs");
      ok(
        client.includes(
          "var nextRequest = Client.Request(nextLink.OriginalString);",
        ),
        "Expected Flurl to request an absolute link as it is and append a relative one to the base URL",
      );
      ok(
        !/BaseUrl|pageUri|baseUri|InvalidOperationException|Uri\.Compare/.test(
          client,
        ),
        "Expected no resolution or origin check besides Flurl's own",
      );
      ok(
        client.includes(
          "Follows each page's next link until none remains, as Flurl does: an absolute link is",
        ) &&
          client.includes(
            "requested as it is, and a relative one is appended to the client's base URL.",
          ),
        "Expected how the link is followed documented on the wrapper",
      );
    });

    it("loops on a non-empty string for a string-typed next link", async () => {
      const results = await emit(`
        import "@typespec/http";
        using Http;

        @service(#{ title: "Test API" })
        namespace TestApi;

        model Store { name: string; }

        model PagedResult<T> {
          @pageItems items: T[];
          @nextLink next?: string;
        }

        @route("/stores")
        interface Stores {
          @list @get list(): PagedResult<Store>;
        }
      `);

      const client = fileContent(results, "StoresRequestBuilders.g.cs");
      ok(
        client.includes("while (!string.IsNullOrEmpty(nextLink))"),
        "Expected an empty string to end the loop too",
      );
      ok(
        client.includes("var nextRequest = Client.Request(nextLink);"),
        "Expected a string link handed to Flurl as it is",
      );
    });

    it("names no framework type a model could hide when following the link", async () => {
      const results = await emit(`
        import "@typespec/http";
        using Http;

        @service(#{ title: "Test API" })
        namespace TestApi;

        model \`Uri\` { v: string; }
        model StringComparison { v: string; }
        model Store { name: string; }

        model PagedResult<T> {
          @pageItems items: T[];
          @nextLink next?: url;
        }

        @route("/stores")
        interface Stores {
          @list @get list(): PagedResult<Store>;
        }
      `);

      const client = fileContent(results, "StoresRequestBuilders.g.cs");
      ok(
        client.includes(
          "var nextRequest = Client.Request(nextLink.OriginalString);",
        ) && !/\bUri\b|StringComparison/.test(client),
        "Expected the link followed without naming Uri or StringComparison, which the models hide",
      );
    });

    it("replays a cookie parameter on every continuation request", async () => {
      const results = await emit(`
        import "@typespec/http";
        using Http;

        @service(#{ title: "Test API" })
        namespace TestApi;

        model Store { name: string; }

        model PagedResult<T> {
          @pageItems items: T[];
          @nextLink next?: url;
        }

        @route("/stores")
        interface Stores {
          @list @get list(@cookie sessionId?: string): PagedResult<Store>;
        }
      `);

      const client = fileContent(results, "StoresRequestBuilders.g.cs");
      ok(
        client.includes(
          'if (sessionId is not null) nextRequest.WithCookie("session_id", ClientRuntime.ToWireString(sessionId));',
        ),
        "Expected the cookie replayed (under its wire name, session_id), guarded against null",
      );
    });
  });

  describe("page type derivation", () => {
    it("uses the operation's actual response type, not wherever @pageItems happens to be declared", async () => {
      const results = await emit(`
        import "@typespec/http";
        using Http;

        @service(#{ title: "Test API" })
        namespace TestApi;

        model Store { name: string; }

        model BasePage<T> {
          @pageItems items: T[];
        }

        model StorePage extends BasePage<Store> {
          @nextLink next?: url;
        }

        @route("/stores")
        interface Stores {
          @list @get list(): StorePage;
        }
      `);

      const client = fileContent(results, "StoresRequestBuilders.g.cs");
      ok(
        client.includes(
          "StorePage? nextPage = await nextRequest.GetJsonAsync<StorePage>(cancellationToken: cancellationToken)",
        ),
        "Expected continuation pages deserialized as the actual response type (StorePage), not the base model that merely declares @pageItems",
      );
    });

    it("rejects an anonymous page response with no named C# type to read .Items/.Next from", async () => {
      const [results, diagnostics] = await emitWithDiagnostics(`
        import "@typespec/http";
        using Http;

        @service(#{ title: "Test API" })
        namespace TestApi;

        model Widget { name: string; }

        @route("/widgets")
        interface Widgets {
          @list @get list(): { @pageItems items: Widget[]; @nextLink next?: url; };
        }
      `);

      const messages = messagesFor(diagnostics, "unsupported-paging-style");
      ok(
        messages.length === 1,
        "Expected one unsupported-paging-style warning",
      );
      ok(messages[0].includes("anonymous"), messages[0]);
      ok(
        !fileContent(results, "WidgetsRequestBuilders.g.cs").includes(
          "ListAllAsync",
        ),
      );
    });
  });

  describe("nullable @pageItems", () => {
    it("rejects an optional items array, which the loop could not safely enumerate when absent", async () => {
      const [, diagnostics] = await emitWithDiagnostics(`
        import "@typespec/http";
        using Http;

        @service(#{ title: "Test API" })
        namespace TestApi;

        model Store { name: string; }

        model PagedResult<T> {
          @pageItems items?: T[];
          @nextLink next?: url;
        }

        @route("/stores")
        interface Stores {
          @list @get list(): PagedResult<Store>;
        }
      `);

      const messages = messagesFor(diagnostics, "unsupported-paging-style");
      ok(
        messages.length === 1,
        "Expected one unsupported-paging-style warning",
      );
      ok(messages[0].includes("optional"), messages[0]);
    });
  });

  describe("offset/pageIndex counter default", () => {
    it("seeds the counter from the parameter's declared default instead of hardcoded 0", async () => {
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
          @list @get list(@query @pageIndex pageIndex?: int32 = 1): IndexedPagedResult<Customer>;
        }
      `);

      const client = fileContent(results, "CustomersRequestBuilders.g.cs");
      ok(
        client.includes("var currentPageIndex = pageIndex ?? 1;"),
        "Expected the declared default (1) honored instead of a hardcoded 0",
      );
    });
  });

  describe("counter type compatibility", () => {
    it("casts the per-page item count to the offset parameter's own type instead of a bare int addition", async () => {
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
          @list @get list(@query @offset offset?: uint64): OffsetPagedResult<Customer>;
        }
      `);

      const client = fileContent(results, "CustomersRequestBuilders.g.cs");
      ok(
        client.includes("checked { currentOffset += (ulong)count; }"),
        "Expected the int item-count cast to ulong before being added to the ulong counter — C# has no built-in += between them otherwise",
      );
    });

    it("needs no cast for pageIndex, since ++ works on any numeric type", async () => {
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
          @list @get list(@query @pageIndex pageIndex?: uint64): IndexedPagedResult<Customer>;
        }
      `);

      const client = fileContent(results, "CustomersRequestBuilders.g.cs");
      ok(
        client.includes("checked { currentPageIndex++; }"),
        "Expected a plain increment, which needs no cast regardless of the counter's numeric type",
      );
    });
  });

  describe("wrapper doc comment ambiguity", () => {
    it("does not emit an ambiguous <see cref> for a raw method with a generic overload", async () => {
      const results = await emit(`
        import "@typespec/http";
        using Http;

        @service(#{ title: "Test API" })
        namespace TestApi;

        model Store { name: string; }

        model PagedResult<T> {
          @pageItems items: T[];
          @nextLink next?: url;
        }

        @route("/stores")
        interface Stores {
          @list @get list(): PagedResult<Store>;
        }
      `);

      const iface = fileContent(results, "StoresRequestBuilders.g.cs");
      ok(
        !iface.includes('<see cref="ListAsync"'),
        "Expected plain <c> text instead of an ambiguous bare-name cref (ListAsync has a generic overload here, so a bare cref is CS0419 once XML docs are enabled)",
      );
      ok(iface.includes("<c>ListAsync</c>"), iface);
    });
  });

  describe("wrapper names", () => {
    it("never displaces a separately declared operation that already has the wrapper's name", async () => {
      const [results, diagnostics] = await emitWithDiagnostics(`
        import "@typespec/http";
        using Http;

        @service(#{ title: "Test API" })
        namespace TestApi;

        model Store { name: string; }

        model PagedResult<T> {
          @pageItems items: T[];
          @nextLink next?: url;
        }

        @route("/stores")
        interface Stores {
          @list @get list(): PagedResult<Store>;
          @route("all") @get listAll(): Store[];
        }
      `);

      const iface = fileContent(results, "StoresRequestBuilders.g.cs");
      ok(
        iface.includes("Task<List<Store>> ListAllAsync("),
        "Expected the declared listAll operation kept",
      );
      ok(
        !iface.includes("IAsyncEnumerable<Store> ListAllAsync("),
        "Expected the colliding wrapper left out",
      );
      ok(
        iface.includes("Task<PagedResult<Store>> ListAsync("),
        "Expected the raw paged method kept",
      );
      const messages = messagesFor(diagnostics, "unsupported-paging-style");
      ok(
        messages.length === 1 && messages[0].includes("ListAllAsync"),
        "Expected one unsupported-paging-style warning naming the wrapper",
      );
      ok(
        messagesFor(diagnostics, "name-collision").length === 0,
        "Expected no name-collision error, since no operation was dropped",
      );
    });
  });

  describe("continuation token types", () => {
    it("rejects a non-string token, which the loop cannot test for emptiness", async () => {
      const [results, diagnostics] = await emitWithDiagnostics(`
        import "@typespec/http";
        using Http;

        @service(#{ title: "Test API" })
        namespace TestApi;

        model Pet { name: string; }

        model TokenPagedResult<T> {
          @pageItems items: T[];
          @continuationToken @format("uuid") continuationToken?: string;
        }

        @route("/pets")
        interface Pets {
          @list @get list(@query @continuationToken @format("uuid") continuationToken?: string): TokenPagedResult<Pet>;
        }
      `);

      const messages = messagesFor(diagnostics, "unsupported-paging-style");
      ok(
        messages.length === 1 && messages[0].includes("non-string"),
        "Expected one unsupported-paging-style warning for the non-string token",
      );
      ok(
        !fileContent(results, "PetsRequestBuilders.g.cs").includes(
          "ListAllAsync",
        ),
      );
    });
  });

  describe("bodyless success responses", () => {
    it("stops on a null page instead of reading its items, in every strategy", async () => {
      const results = await emit(`
        import "@typespec/http";
        using Http;

        @service(#{ title: "Test API" })
        namespace TestApi;

        model Store { name: string; }

        model LinkPage<T> {
          @pageItems items: T[];
          @nextLink next?: url;
        }

        model TokenPage<T> {
          @pageItems items: T[];
          @continuationToken continuationToken?: string;
        }

        model OffsetPage<T> {
          @pageItems items: T[];
        }

        @route("/links")
        interface Links {
          @list @get list(): LinkPage<Store> | void;
        }

        @route("/tokens")
        interface Tokens {
          @list @get list(@query @continuationToken continuationToken?: string): TokenPage<Store> | void;
        }

        @route("/offsets")
        interface Offsets {
          @list @get list(@query @offset offset?: int32): OffsetPage<Store> | void;
        }
      `);

      for (const file of [
        "LinksRequestBuilders.g.cs",
        "TokensRequestBuilders.g.cs",
        "OffsetsRequestBuilders.g.cs",
      ]) {
        const client = fileContent(results, file);
        ok(client.includes("ListAllAsync("), `Expected a wrapper in ${file}`);
        ok(
          client.includes("if (page is null) yield break;"),
          `Expected a null-page guard in ${file}`,
        );
      }
    });

    it("emits no null-page guard when the raw method never returns null", async () => {
      const results = await emit(`
        import "@typespec/http";
        using Http;

        @service(#{ title: "Test API" })
        namespace TestApi;

        model Store { name: string; }

        model OffsetPage<T> {
          @pageItems items: T[];
        }

        @route("/offsets")
        interface Offsets {
          @list @get list(@query @offset offset?: int32): OffsetPage<Store>;
        }
      `);

      ok(
        !fileContent(results, "OffsetsRequestBuilders.g.cs").includes(
          "if (page is null)",
        ),
      );
    });
  });

  describe("following next links", () => {
    /**
     * Emits a nextLink-paged `Stores.list` with a header and a query parameter.
     *
     * @returns The generated `StoresRequestBuilders.g.cs`.
     */
    const storesEndpoint = async (): Promise<string> =>
      fileContent(
        await emit(`
          import "@typespec/http";
          using Http;

          @service(#{ title: "Test API" })
          namespace TestApi;

          model Store { name: string; }
          model StorePage { @pageItems items: Store[]; @nextLink next?: url; }

          @route("/stores")
          interface Stores {
            @list @get list(@query skip?: int32, @header("X-Tenant") tenant?: string): StorePage;
          }
        `),
        "StoresRequestBuilders.g.cs",
      );

    it("sends the first page through the raw method, so its request is built in one place", async () => {
      const client = await storesEndpoint();
      ok(
        client.includes(
          "var page = await ListAsync(skip, tenant, cancellationToken).ConfigureAwait(false);",
        ),
      );
      ok(
        client.split('flurlRequest.SetQueryParam("skip"').length === 2,
        "Expected the request built in the raw method only",
      );
      ok(!client.includes("BuildListRequest"));
    });

    it("replays the header on each continuation request and leaves redirects to Flurl", async () => {
      const client = await storesEndpoint();
      const request = client.indexOf(
        "var nextRequest = Client.Request(nextLink.OriginalString);",
      );
      const header = client.indexOf(
        'if (tenant is not null) nextRequest.WithHeader("X-Tenant", ClientRuntime.ToWireString(tenant));',
        request,
      );
      const send = client.indexOf("await nextRequest.GetJsonAsync<", header);
      ok(
        request >= 0 && header > request && send > header,
        "Expected the request, then the header, then the send",
      );
      ok(
        !/WithAutoRedirect|AllowHttpStatus|redirects|Location/.test(client),
        "Expected Flurl to follow redirects as it does for every request",
      );
    });

    it("reads each later page's link from that page", async () => {
      const client = await storesEndpoint();
      const read = client.indexOf("if (nextPage is null) yield break;");
      ok(read >= 0 && client.indexOf("nextLink = nextPage.Next;", read) > read);
    });
  });

  describe("next link types", () => {
    it("rejects a next link that maps to neither a string nor a Uri", async () => {
      const [results, diagnostics] = await emitWithDiagnostics(`
        import "@typespec/http";
        using Http;

        @service(#{ title: "Test API" })
        namespace TestApi;

        model Store { name: string; }
        model StorePage { @pageItems items: Store[]; @nextLink @format("uuid") next?: string; }

        @route("/stores")
        interface Stores {
          @list @get list(): StorePage;
        }
      `);
      ok(
        messagesFor(diagnostics, "unsupported-paging-style").some((m) =>
          m.includes("neither a string nor a URL (it maps to Guid)"),
        ),
      );
      const client = fileContent(results, "StoresRequestBuilders.g.cs");
      ok(client.includes("ListAsync("), "Expected the raw method kept");
      ok(!client.includes("ListAllAsync"), "Expected no wrapper");
    });
  });

  describe("pages that narrow their items", () => {
    it("types the items from the base record a discriminated page inherits", async () => {
      const results = await emit(`
        import "@typespec/http";
        using Http;

        @service(#{ title: "Test API" })
        namespace TestApi;

        model Book { title: string; }
        model SignedBook extends Book { signedBy: string; }

        @discriminator("kind")
        model Catalog {
          kind: string;
          @pageItems items: Book[];
          @nextLink next?: url;
        }

        model SignedCatalog extends Catalog {
          kind: "signed";
          items: SignedBook[];
        }

        @route("/catalogs")
        interface Catalogs {
          @list @get signed(): SignedCatalog;
          @route("any") @list @get any(): Catalog;
        }
      `);
      ok(
        !fileContent(results, "SignedCatalog.g.cs").includes(" Items "),
        "Expected the derived record to keep the inherited List<Book> Items",
      );
      ok(
        fileContent(results, "CatalogsRequestBuilders.g.cs").includes(
          "IAsyncEnumerable<Book> SignedAllAsync(",
        ),
        "Expected the wrapper to yield what the inherited Items property holds",
      );
    });

    it("reports items the discriminated page's record does not hold as a list", async () => {
      const [results, diagnostics] = await emitWithDiagnostics(`
        import "@typespec/http";
        using Http;

        @service(#{ title: "Test API" })
        namespace TestApi;

        model Store { name: string; }

        @discriminator("kind")
        model Page {
          kind: string;
          items: unknown;
        }

        model StorePage extends Page {
          kind: "store";
          @pageItems items: Store[];
          @nextLink next?: url;
        }

        @route("/stores")
        interface Stores {
          @list @get list(): StorePage;
          @route("any") @get any(): Page;
        }
      `);
      ok(
        messagesFor(diagnostics, "unsupported-paging-style").some((m) =>
          m.includes("does not hold as a list"),
        ),
        "Expected the shape reported instead of aborting emission",
      );
      ok(
        !fileContent(results, "StoresRequestBuilders.g.cs").includes(
          "ListAllAsync",
        ),
      );
    });

    it("names the next link by the declaration a flattened page redeclares", async () => {
      const results = await emit(`
        import "@typespec/http";
        import "@massivescale/tsp-flurl-client";
        using Http;
        using MassiveScale.TspFlurlClient;

        @service(#{ title: "Test API" })
        namespace TestApi;

        model Store { name: string; }
        model Page { @pageItems items: Store[]; @nextLink next?: url; }
        model StorePage extends Page { @clientName("Continue") next?: url; }

        @route("/stores")
        interface Stores {
          @list @get list(): StorePage;
        }
      `);
      const client = fileContent(results, "StoresRequestBuilders.g.cs");
      ok(
        client.includes("page.Continue") && !client.includes("page.Next"),
        "Expected the member the record actually has",
      );
    });

    it("types the items from the narrowed declaration when the record is flattened", async () => {
      const results = await emit(`
        import "@typespec/http";
        using Http;

        @service(#{ title: "Test API" })
        namespace TestApi;

        model Book { title: string; }
        model SignedBook extends Book { signedBy: string; }

        model Catalog { @pageItems items: Book[]; @nextLink next?: url; }
        model SignedCatalog extends Catalog { items: SignedBook[]; }

        @route("/catalogs")
        interface Catalogs {
          @list @get signed(): SignedCatalog;
        }
      `);
      ok(
        fileContent(results, "SignedCatalog.g.cs").includes(
          "List<SignedBook> Items",
        ),
      );
      ok(
        fileContent(results, "CatalogsRequestBuilders.g.cs").includes(
          "IAsyncEnumerable<SignedBook> SignedAllAsync(",
        ),
        "Expected the wrapper to yield the narrowed item type the record holds",
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
      ok(
        messages.length === 1,
        "Expected one unsupported-paging-style warning",
      );
      ok(messages[0].includes("nested"), messages[0]);
      ok(
        !fileContent(results, "WidgetsRequestBuilders.g.cs").includes(
          "ListAllAsync",
        ),
      );
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
      ok(
        messages.length === 1,
        "Expected one unsupported-paging-style warning",
      );

      const client = fileContent(results, "WidgetsRequestBuilders.g.cs");
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
        model.includes("Prev") &&
          model.includes("First") &&
          model.includes("Last"),
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
