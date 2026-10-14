import { describe, it, before } from "node:test";
import { getSourceLocation } from "@typespec/compiler";
import {
  createLinterRuleTester,
  t,
  type LinterRuleTester,
} from "@typespec/compiler/testing";
import { BaseTester } from "./host.js";
import { internalAccessLeakRule } from "../src/rules/internal-access-leak.js";

describe("internal-access-leak", () => {
  let tester: LinterRuleTester;

  before(async () => {
    const runner = await BaseTester.createInstance();
    tester = createLinterRuleTester(
      runner,
      internalAccessLeakRule,
      "@massivescale/tsp-flurl-client",
    );
  });

  it("flags a public interface operation whose parameter type is @access(Access.internal)", async () => {
    await tester
      .expect(
        `
        import "@massivescale/tsp-flurl-client";
        using MassiveScale.TspFlurlClient;

        namespace TestApi;

        @access(Access.internal)
        model Secret {
          value: string;
        }

        interface Widgets {
          read(secret: Secret): void;
        }
      `,
      )
      .toEmitDiagnostics({
        code: "@massivescale/tsp-flurl-client/internal-access-leak",
        message:
          '"read" is public but its parameter type "Secret" is marked @access(Access.internal); the generated C# will fail to compile (CS0053: inconsistent accessibility). Mark "Secret" @access(Access.public), or mark the interface that declares "read" @access(Access.internal) as well.',
      });
  });

  it("flags a public interface operation whose return type is @access(Access.internal)", async () => {
    await tester
      .expect(
        `
        import "@massivescale/tsp-flurl-client";
        using MassiveScale.TspFlurlClient;

        namespace TestApi;

        @access(Access.internal)
        model Secret {
          value: string;
        }

        interface Widgets {
          read(): Secret;
        }
      `,
      )
      .toEmitDiagnostics({
        code: "@massivescale/tsp-flurl-client/internal-access-leak",
        message:
          '"read" is public but its return type "Secret" is marked @access(Access.internal); the generated C# will fail to compile (CS0053: inconsistent accessibility). Mark "Secret" @access(Access.public), or mark the interface that declares "read" @access(Access.internal) as well.',
      });
  });

  it("flags a public interface operation whose array-wrapped return type is @access(Access.internal)", async () => {
    await tester
      .expect(
        `
        import "@massivescale/tsp-flurl-client";
        using MassiveScale.TspFlurlClient;

        namespace TestApi;

        @access(Access.internal)
        model Secret {
          value: string;
        }

        interface Widgets {
          list(): Secret[];
        }
      `,
      )
      .toEmitDiagnostics({
        code: "@massivescale/tsp-flurl-client/internal-access-leak",
      });
  });

  it("flags a public interface operation whose nullable return type is @access(Access.internal)", async () => {
    await tester
      .expect(
        `
        import "@massivescale/tsp-flurl-client";
        using MassiveScale.TspFlurlClient;

        namespace TestApi;

        @access(Access.internal)
        model Secret {
          value: string;
        }

        interface Widgets {
          read(): Secret | null;
        }
      `,
      )
      .toEmitDiagnostics({
        code: "@massivescale/tsp-flurl-client/internal-access-leak",
      });
  });

  it("does not flag a multi-variant union, which is emitted as JsonElement and names no model", async () => {
    await tester
      .expect(
        `
        import "@massivescale/tsp-flurl-client";
        using MassiveScale.TspFlurlClient;

        namespace TestApi;

        model Widget {
          id: string;
        }

        @access(Access.internal)
        model Secret {
          value: string;
        }

        interface Widgets {
          read(): Widget | Secret;
        }
      `,
      )
      .toEmitDiagnostics([]);
  });

  it("flags a public operation returning an instance of an internal template", async () => {
    await tester
      .expect(
        `
        import "@massivescale/tsp-flurl-client";
        using MassiveScale.TspFlurlClient;

        namespace TestApi;

        @access(Access.internal)
        model Page<T> {
          items: T[];
        }

        interface Widgets {
          list(): Page<string>;
        }
      `,
      )
      .toEmitDiagnostics({
        code: "@massivescale/tsp-flurl-client/internal-access-leak",
        message: /"Page"/,
      });
  });

  it("flags a public model whose property is an instance of an internal template", async () => {
    await tester
      .expect(
        `
        import "@massivescale/tsp-flurl-client";
        using MassiveScale.TspFlurlClient;

        namespace TestApi;

        @access(Access.internal)
        model Page<T> {
          items: T[];
        }

        model Catalog {
          page: Page<int32>;
        }
      `,
      )
      .toEmitDiagnostics({
        code: "@massivescale/tsp-flurl-client/internal-access-leak",
        message: /"Page"/,
      });
  });

  it("flags an internal success type when the return union also names an @error model", async () => {
    await tester
      .expect(
        `
        import "@typespec/http";
        import "@massivescale/tsp-flurl-client";
        using Http;
        using MassiveScale.TspFlurlClient;

        namespace TestApi;

        @access(Access.internal)
        model Secret {
          value: string;
        }

        @error
        model Problem {
          code: int32;
        }

        interface Secrets {
          @get read(): Secret | Problem;
        }
      `,
      )
      .toEmitDiagnostics({
        code: "@massivescale/tsp-flurl-client/internal-access-leak",
        message: /"Secret"/,
      });
  });

  it("does not flag success bodies of different shapes, which are returned as JsonElement", async () => {
    await tester
      .expect(
        `
        import "@typespec/http";
        import "@massivescale/tsp-flurl-client";
        using Http;
        using MassiveScale.TspFlurlClient;

        namespace TestApi;

        @access(Access.internal)
        model Secret {
          value: string;
        }

        model Open {
          id: string;
        }

        interface Secrets {
          @get read(): { @statusCode _: 200; @body b: Secret } | { @statusCode _: 201; @body b: Open };
        }
      `,
      )
      .toEmitDiagnostics([]);
  });

  it("flags a public operation whose merge-patch body patches an internal model", async () => {
    await tester
      .expect(
        `
        import "@typespec/http";
        import "@massivescale/tsp-flurl-client";
        using Http;
        using MassiveScale.TspFlurlClient;

        namespace TestApi;

        @access(Access.internal)
        model Secret {
          value: string;
        }

        interface Secrets {
          @patch update(@body body: MergePatchUpdate<Secret>): void;
        }
      `,
      )
      .toEmitDiagnostics({
        code: "@massivescale/tsp-flurl-client/internal-access-leak",
        message: /"Secret"/,
      });
  });

  it("does not flag an instance of a public template", async () => {
    await tester
      .expect(
        `
        import "@massivescale/tsp-flurl-client";
        using MassiveScale.TspFlurlClient;

        namespace TestApi;

        model Page<T> {
          items: T[];
        }

        interface Widgets {
          list(): Page<string>;
        }
      `,
      )
      .toEmitDiagnostics([]);
  });

  it("flags a public model whose property type is @access(Access.internal)", async () => {
    await tester
      .expect(
        `
        import "@massivescale/tsp-flurl-client";
        using MassiveScale.TspFlurlClient;

        namespace TestApi;

        @access(Access.internal)
        model Secret {
          value: string;
        }

        model Widget {
          secret: Secret;
        }
      `,
      )
      .toEmitDiagnostics({
        code: "@massivescale/tsp-flurl-client/internal-access-leak",
        message:
          '"secret" is public but its property type "Secret" is marked @access(Access.internal); the generated C# will fail to compile (CS0053: inconsistent accessibility). Mark "Secret" @access(Access.public), or mark the model that declares "secret" @access(Access.internal) as well.',
      });
  });

  it("flags a public model whose inherited property type is @access(Access.internal)", async () => {
    await tester
      .expect(
        `
        import "@massivescale/tsp-flurl-client";
        using MassiveScale.TspFlurlClient;

        namespace TestApi;

        @access(Access.internal)
        model Secret {
          value: string;
        }

        @access(Access.internal)
        model Base {
          secret: Secret;
        }

        model Widget extends Base {
          id: string;
        }
      `,
      )
      .toEmitDiagnostics({
        code: "@massivescale/tsp-flurl-client/internal-access-leak",
      });
  });

  it("is valid when everything is consistently public", async () => {
    await tester
      .expect(
        `
        namespace TestApi;

        model Secret {
          value: string;
        }

        model Widget {
          secret: Secret;
        }

        interface Widgets {
          read(): Widget;
        }
      `,
      )
      .toBeValid();
  });

  it("is valid when everything is consistently internal end-to-end", async () => {
    await tester
      .expect(
        `
        import "@massivescale/tsp-flurl-client";
        using MassiveScale.TspFlurlClient;

        namespace TestApi;

        @access(Access.internal)
        model Secret {
          value: string;
        }

        @access(Access.internal)
        model Widget {
          secret: Secret;
        }

        @access(Access.internal)
        interface Widgets {
          read(): Widget;
        }
      `,
      )
      .toBeValid();
  });

  it("is valid when a public interface's own container access is internal, regardless of referenced types", async () => {
    await tester
      .expect(
        `
        import "@massivescale/tsp-flurl-client";
        using MassiveScale.TspFlurlClient;

        namespace TestApi;

        @access(Access.internal)
        model Secret {
          value: string;
        }

        @access(Access.internal)
        interface Widgets {
          read(): Secret;
        }
      `,
      )
      .toBeValid();
  });

  it("targets the specific parameter, not the whole operation, for a parameter-type leak", async () => {
    await tester
      .expect(
        t.code`
        import "@massivescale/tsp-flurl-client";
        using MassiveScale.TspFlurlClient;

        namespace TestApi;

        @access(Access.internal)
        model Secret {
          value: string;
        }

        interface Widgets {
          read(${t.modelProperty("secretParam")}: Secret): void;
        }
      `,
      )
      .toEmitDiagnostics((res) => {
        const location = getSourceLocation(res.secretParam);
        return {
          code: "@massivescale/tsp-flurl-client/internal-access-leak",
          pos: location.pos,
          end: location.end,
        };
      });
  });

  it("still flags an operation marked @access(Access.internal), because C# interface methods are always public", async () => {
    await tester
      .expect(
        `
        import "@massivescale/tsp-flurl-client";
        using MassiveScale.TspFlurlClient;

        namespace TestApi;

        @access(Access.internal)
        model Secret {
          value: string;
        }

        interface Widgets {
          read(): void;

          @access(Access.internal)
          write(secret: Secret): void;
        }
      `,
      )
      .toEmitDiagnostics({
        code: "@massivescale/tsp-flurl-client/internal-access-leak",
        message:
          '"write" is public but its parameter type "Secret" is marked @access(Access.internal); the generated C# will fail to compile (CS0053: inconsistent accessibility). Mark "Secret" @access(Access.public), or mark the interface that declares "write" @access(Access.internal) as well.',
      });
  });
});
