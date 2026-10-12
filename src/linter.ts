import { defineLinter } from "@typespec/compiler";
import { internalAccessLeakRule } from "./rules/internal-access-leak.js";

/**
 * The emitter's linter definition: its rules and the rule sets that enable them.
 * Enable it from `tspconfig.yaml` with
 * `linter: { extends: ["@massivescale/tsp-flurl-client/recommended"] }`.
 */
export const $linter = defineLinter({
  rules: [internalAccessLeakRule],
  ruleSets: {
    recommended: {
      enable: { "@massivescale/tsp-flurl-client/internal-access-leak": true },
    },
    all: {
      enable: { "@massivescale/tsp-flurl-client/internal-access-leak": true },
    },
  },
});
