// Client wiring generation: the client class, with one method per request builder
// (`client.Pets()`, `client.Pets(id)`), and the DI registration extension class
// (`Add{Client}(...)`).

import {
  Renderer,
  ExtensionsView,
  ClientBuilderEntry,
  FileView,
} from "./renderer.js";
import { sortUsings } from "./utils.js";

/**
 * Renders the wiring file for a service: a `{ServiceName}` client class that starts
 * every request through a method named after its endpoint group, and a
 * `{ServiceName}Extensions` static class exposing `Add{ServiceName}(...)`, which
 * registers that client alone.
 *
 * @param serviceName - Client/service display name (e.g. `PetStore`); drives the
 *   client name, the extension class name, and the `Add…` method name.
 * @param csNs - C# namespace the generated file is emitted into.
 * @param builders - The client methods, one per request builder, in order. Methods of
 *   one endpoint group share its name and differ in the path parameters they take.
 * @param renderer - Handlebars renderer used to produce the file contents.
 * @param additionalUsings - Extra `using` directives from the `additional-usings`
 *   option, which apply to every emitted file.
 * @returns The full C# source of the generated extensions file.
 */
export function buildExtensions(
  serviceName: string,
  csNs: string,
  builders: ClientBuilderEntry[],
  renderer: Renderer,
  additionalUsings: Iterable<string> = [],
): string {
  const className = `${serviceName}Extensions`;
  const view: ExtensionsView = {
    className,
    methodName: `Add${serviceName}`,
    clientClassName: serviceName,
    httpClientName: `${csNs}.${serviceName}`,
    builders,
  };
  const fileView: FileView = {
    namespace: csNs,
    usings: sortUsings([
      ...new Set([
        "Flurl.Http",
        "Microsoft.Extensions.DependencyInjection",
        "System",
        // A builder method takes the path parameters, which can be a List<T> or a JsonElement.
        "System.Collections.Generic",
        "System.Net.Http",
        "System.Text.Json",
        ...additionalUsings,
      ]),
    ]),
    body: renderer.renderExtensions(view),
    fileName: `${className}.g.cs`,
  };
  return renderer.renderFile(fileView);
}
