import { ok, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import { emit, emitWithDiagnostics, fileContent, messagesFor } from "./host.js";

const PREAMBLE = `
  import "@typespec/http";
  import "@massivescale/tsp-flurl-client";
  using Http;
  using MassiveScale.TspFlurlClient;

  @service(#{ title: "Test API" })
  namespace TestApi;
`;

describe("user models named like merge patches", () => {
  it("filters a user model's request body even when its name ends in MergePatchUpdate", async () => {
    const results = await emit(`${PREAMBLE}
      model AuditMergePatchUpdate { @visibility(Lifecycle.Read) id: string; note: string; }
      @route("/a") interface Audits { @post create(@body body: AuditMergePatchUpdate): void; }
    `);

    ok(
      fileContent(results, "IAudits.g.cs").includes(
        "CreateAsync(AuditMergePatchUpdateCreateRequest body,",
      ),
    );
    ok(
      !fileContent(results, "AuditMergePatchUpdateCreateRequest.g.cs").includes(
        "Id",
      ),
    );
  });

  it("keeps the @clientName of a user model whose name ends in MergePatchUpdate", async () => {
    const results = await emit(`${PREAMBLE}
      @clientName("AuditRecord") model AuditMergePatchUpdate { note: string; }
      @route("/a") interface Audits { @get read(): AuditMergePatchUpdate; }
    `);

    ok(
      fileContent(results, "AuditRecord.g.cs").includes(
        "public record AuditRecord",
      ),
    );
    ok(
      fileContent(results, "IAudits.g.cs").includes(
        "Task<AuditRecord> ReadAsync(",
      ),
    );
  });

  it("still passes a synthesized merge patch through unfiltered as IMergePatch", async () => {
    const results = await emit(`${PREAMBLE}
      @clientName("Product") model Widget { @visibility(Lifecycle.Read) id: string; name: string; }
      @route("/w") interface Widgets { @patch update(@body body: MergePatchUpdate<Widget>): void; }
    `);

    ok(
      fileContent(results, "IWidgets.g.cs").includes(
        "UpdateAsync(IMergePatch<Product> body,",
      ),
    );
    ok(!Object.keys(results).some((k) => /UpdateRequest\.g\.cs$/.test(k)));
  });
});

describe("success responses with the same type in different formats", () => {
  it("leaves out an operation whose statuses encode one value differently", async () => {
    const [results, diagnostics] = await emitWithDiagnostics(`${PREAMBLE}
      @route("/d") interface Durations {
        @get read():
          | { @statusCode _: 200; @body @encode(DurationKnownEncoding.seconds, int32) took: duration }
          | { @statusCode _: 201; @body @encode(DurationKnownEncoding.milliseconds, int32) took: duration };
        @route("ok") @get ok(): string;
      }
    `);

    const messages = messagesFor(diagnostics, "unsupported-feature");
    strictEqual(messages.length, 1, messages.join("; "));
    ok(messages[0].includes("different @encode formats"));
    const iface = fileContent(results, "IDurations.g.cs");
    ok(!iface.includes("ReadAsync"));
    ok(iface.includes("OkAsync"));
  });

  it("reads statuses that encode one value the same way", async () => {
    const results = await emit(`${PREAMBLE}
      @route("/d") interface Durations {
        @get read():
          | { @statusCode _: 200; @body @encode(DurationKnownEncoding.seconds, int32) took: duration }
          | { @statusCode _: 201; @body @encode(DurationKnownEncoding.seconds, int32) took: duration };
      }
    `);

    ok(
      fileContent(results, "DurationsEndpoint.g.cs").includes(
        "ClientRuntime.WireEncoding.WholeSeconds",
      ),
    );
  });
});

describe("the aggregate client's constructor", () => {
  it("rejects a null for every endpoint, not just the Flurl client", async () => {
    const results = await emit(`${PREAMBLE}
      @route("/a") interface Alphas { @get read(): string; }
      @route("/b") interface Betas { @get read(): string; }
    `);

    const client = fileContent(results, "TestApiClientExtensions.g.cs");
    ok(
      client.includes(
        "FlurlClient = flurlClient ?? throw new ArgumentNullException(nameof(flurlClient));",
      ),
    );
    ok(
      client.includes(
        "Alphas = alphas ?? throw new ArgumentNullException(nameof(alphas));",
      ),
    );
    ok(
      client.includes(
        "Betas = betas ?? throw new ArgumentNullException(nameof(betas));",
      ),
    );
  });
});
