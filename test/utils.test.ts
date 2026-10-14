import { strictEqual, deepStrictEqual } from "node:assert";
import { describe, it } from "node:test";
import {
  capitalize,
  toCsMethodName,
  toCsParamName,
  toCsPropName,
  escapeXml,
  sanitizeVersionForNs,
  sortUsings,
} from "../src/utils.js";

describe("utils", () => {
  describe("capitalize", () => {
    it("upper-cases the first character", () =>
      strictEqual(capitalize("widget"), "Widget"));
    it("leaves an already-capitalized string unchanged", () =>
      strictEqual(capitalize("Widget"), "Widget"));
    it("handles the empty string", () => strictEqual(capitalize(""), ""));
  });

  describe("toCsMethodName", () => {
    it("capitalizes and appends Async", () =>
      strictEqual(toCsMethodName("list"), "ListAsync"));
    it("keeps an already-capitalized name", () =>
      strictEqual(toCsMethodName("GetPet"), "GetPetAsync"));
  });

  describe("toCsParamName", () => {
    it("lower-cases the first character (camelCase)", () =>
      strictEqual(toCsParamName("PetId"), "petId"));
    it("leaves an already-camelCase name unchanged", () =>
      strictEqual(toCsParamName("petId"), "petId"));
  });

  describe("toCsPropName", () => {
    it("upper-cases the first character (PascalCase)", () =>
      strictEqual(toCsPropName("name"), "Name"));
    it("leaves an already-PascalCase name unchanged", () =>
      strictEqual(toCsPropName("Name"), "Name"));
  });

  describe("escapeXml", () => {
    it("escapes &, <, and >", () =>
      strictEqual(escapeXml("a & b < c > d"), "a &amp; b &lt; c &gt; d"));
    it("escapes & before < and > (no double-escaping)", () =>
      strictEqual(escapeXml("<&>"), "&lt;&amp;&gt;"));
    it("leaves plain text unchanged", () =>
      strictEqual(escapeXml("plain text"), "plain text"));
  });

  describe("sanitizeVersionForNs", () => {
    it("prefixes V and replaces dots with underscores", () =>
      strictEqual(sanitizeVersionForNs("2.0"), "V2_0"));
    it("strips a leading lowercase v", () =>
      strictEqual(sanitizeVersionForNs("v1.3"), "V1_3"));
    it("strips a leading uppercase V", () =>
      strictEqual(sanitizeVersionForNs("V1.3"), "V1_3"));
  });

  describe("sortUsings", () => {
    it("orders System namespaces before non-System ones", () =>
      deepStrictEqual(
        sortUsings(["Flurl.Http", "System.Threading", "System"]),
        ["System", "System.Threading", "Flurl.Http"],
      ));
    it("sorts alphabetically within each group", () =>
      deepStrictEqual(
        sortUsings([
          "System.Text.Json.Serialization",
          "System.Collections.Generic",
          "Microsoft.Extensions.DependencyInjection",
          "Flurl.Http",
        ]),
        [
          "System.Collections.Generic",
          "System.Text.Json.Serialization",
          "Flurl.Http",
          "Microsoft.Extensions.DependencyInjection",
        ],
      ));
    it("does not mutate the input array", () => {
      const input = ["Flurl.Http", "System"];
      sortUsings(input);
      deepStrictEqual(input, ["Flurl.Http", "System"]);
    });
  });
});
