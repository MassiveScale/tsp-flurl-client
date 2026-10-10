import { defineLinter } from "@typespec/compiler";
import { internalAccessLeakRule } from "./rules/internal-access-leak.js";

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
