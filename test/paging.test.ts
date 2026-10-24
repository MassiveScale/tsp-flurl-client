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
        client.includes(
          "[EnumeratorCancellation] CancellationToken cancellationToken = default)",
        ),
        "Expected EnumeratorCancellation on the implementation's cancellation token",
      );
      ok(
        client.includes("var page = await ListAsync("),
        "Expected the wrapper to call the raw method directly (same class)",
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
          "var nextRequest = _client.Request(nextUri.AbsoluteUri);",
        ),
        "Expected the continuation request built against the opaque nextLink URL through _client",
      );
      ok(
        client.includes(
          "nextRequest.GetJsonAsync<PagedResult<Store>>(cancellationToken: cancellationToken)",
        ),
        "Expected continuation pages fetched with cancellationToken passed by name (GetJsonAsync's 2nd positional parameter is HttpCompletionOption, not CancellationToken)",
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

      const client = fileContent(results, "CustomersEndpoint.g.cs");
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

      const client = fileContent(results, "WidgetsEndpoint.g.cs");
      ok(
        client.includes("_client.Request(nextUri.AbsoluteUri)"),
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

      const client = fileContent(results, "PetsEndpoint.g.cs");
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

      const client = fileContent(results, "StoresEndpoint.g.cs");
      ok(
        client.includes("var page2 = await ListAsync("),
        "Expected the first-page variable renamed to avoid shadowing the page parameter",
      );
      ok(
        client.includes(
          "var nextRequest2 = _client.Request(nextUri.AbsoluteUri);",
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

      const client = fileContent(results, "CustomersEndpoint.g.cs");
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

      const client = fileContent(results, "StoresEndpoint.g.cs");
      ok(
        client.includes(
          'if (tenantId is not null) nextRequest.WithHeader("X-Tenant-Id", ClientRuntime.ToWireString(tenantId));',
        ),
        "Expected the optional header replayed, guarded against null",
      );
      ok(
        !client.includes("sameOrigin"),
        "Expected the header replayed unconditionally, since a cross-origin link is refused before sending",
      );
    });

    it("refuses a next link to another origin before sending anything, even with nothing to replay", async () => {
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

      const client = fileContent(results, "StoresEndpoint.g.cs");
      ok(
        client.includes(
          "var baseUri = string.IsNullOrEmpty(_client.BaseUrl)",
        ) &&
          client.includes(
            '? throw new InvalidOperationException("Cannot follow a next-page link without a base URL to check its origin against.")',
          ) &&
          client.includes(": new Uri(_client.BaseUrl, UriKind.Absolute);"),
        "Expected the base taken from the Flurl client's BaseUrl, which both the DI and Create(baseUrl) paths set",
      );
      ok(
        client.includes("var nextUri = new Uri(baseUri, nextLink);"),
        "Expected a relative next link resolved against the base URL",
      );
      ok(
        client.includes(
          "if (Uri.Compare(nextUri, baseUri, UriComponents.SchemeAndServer, UriFormat.UriEscaped, StringComparison.OrdinalIgnoreCase) != 0)",
        ) &&
          client.includes(
            'throw new InvalidOperationException($"Refusing to follow a next-page link to {nextUri.GetLeftPart(UriPartial.Authority)}, a different origin than the client\'s base URL.");',
          ),
        "Expected a cross-origin next link refused, so the client's own credentials never reach another host",
      );
      const checkAt = client.indexOf("if (Uri.Compare(");
      const requestAt = client.indexOf(
        "var nextRequest = _client.Request(nextUri.AbsoluteUri);",
      );
      ok(
        checkAt >= 0 && requestAt > checkAt,
        "Expected the origin check before the continuation request is built",
      );
      const iface = fileContent(results, "IStores.g.cs");
      ok(
        iface.includes(
          'else throws <see cref="InvalidOperationException"/> before any request is sent,',
        ),
        "Expected the cross-origin refusal documented on the interface",
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

      const client = fileContent(results, "StoresEndpoint.g.cs");
      ok(
        client.includes("while (!string.IsNullOrEmpty(nextLink))"),
        "Expected an empty string to end the loop too",
      );
      ok(
        client.includes("var nextUri = new Uri(baseUri, nextLink);"),
        "Expected the string link resolved through the same Uri constructor",
      );
    });

    it("qualifies the framework types it names when a model hides them", async () => {
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

      const client = fileContent(results, "StoresEndpoint.g.cs");
      ok(
        client.includes(
          "if (global::System.Uri.Compare(nextUri, baseUri, UriComponents.SchemeAndServer, UriFormat.UriEscaped, global::System.StringComparison.OrdinalIgnoreCase) != 0)",
        ),
        "Expected Uri and StringComparison written in full when generated models hide them",
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

      const client = fileContent(results, "StoresEndpoint.g.cs");
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

      const client = fileContent(results, "StoresEndpoint.g.cs");
      ok(
        client.includes(
          "GetJsonAsync<StorePage>(cancellationToken: cancellationToken)",
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
        !fileContent(results, "WidgetsEndpoint.g.cs").includes("ListAllAsync"),
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

      const client = fileContent(results, "CustomersEndpoint.g.cs");
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

      const client = fileContent(results, "CustomersEndpoint.g.cs");
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

      const client = fileContent(results, "CustomersEndpoint.g.cs");
      ok(
        client.includes("checked { currentPageIndex++; }"),
        "Expected a plain increment, which needs no cast regardless of the counter's numeric type",
      );
    });
  });

  describe("interface doc comment ambiguity", () => {
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

      const iface = fileContent(results, "IStores.g.cs");
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

      const iface = fileContent(results, "IStores.g.cs");
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
      ok(!fileContent(results, "PetsEndpoint.g.cs").includes("ListAllAsync"));
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
        "LinksEndpoint.g.cs",
        "TokensEndpoint.g.cs",
        "OffsetsEndpoint.g.cs",
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
        !fileContent(results, "OffsetsEndpoint.g.cs").includes(
          "if (page is null)",
        ),
      );
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
      const client = fileContent(results, "StoresEndpoint.g.cs");
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
        fileContent(results, "CatalogsEndpoint.g.cs").includes(
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
      ok(!fileContent(results, "StoresEndpoint.g.cs").includes("ListAllAsync"));
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
      const client = fileContent(results, "StoresEndpoint.g.cs");
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
        fileContent(results, "CatalogsEndpoint.g.cs").includes(
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
        !fileContent(results, "WidgetsEndpoint.g.cs").includes("ListAllAsync"),
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
