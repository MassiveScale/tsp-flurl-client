// Client wiring generation: the aggregate client class that exposes one
// strongly-typed property per generated endpoint interface, and the DI
// registration extension class (`Add{Client}(...)`).

import {
  Renderer,
  ExtensionsView,
  InterfaceEntry,
  FileView,
} from "./renderer.js";
import { escapeCsIdentifier, sortUsings } from "./utils.js";

/** An endpoint interface and the class that implements it, as wired into the aggregate client. */
export interface EndpointName {
  /** C# interface name, e.g. `IPets`. */
  interfaceName: string;
  /** C# implementation class name, e.g. `PetsClient`. */
  clientName: string;
}

/**
 * Renders the wiring file for a service: a `{ServiceName}` aggregate client class
 * that surfaces one strongly-typed property per generated endpoint interface, and
 * a `{ServiceName}Extensions` static class exposing `Add{ServiceName}(...)`.
 *
 * @param serviceName - Client/service display name (e.g. `PetStore`); drives the
 *   aggregate client name, the extension class name, and the `Add…` method name.
 * @param csNs - C# namespace the generated file is emitted into.
 * @param endpoints - The endpoint interfaces to register and their implementations;
 *   each interface maps to a client property/parameter with the leading `I` stripped.
 * @param renderer - Handlebars renderer used to produce the file contents.
 * @returns The full C# source of the generated extensions file.
 */
export function buildExtensions(
  serviceName: string,
  csNs: string,
  endpoints: EndpointName[],
  renderer: Renderer,
): string {
  const className = `${serviceName}Extensions`;
  const methodName = `Add${serviceName}`;
  const clientClassName = serviceName;
  const interfaces: InterfaceEntry[] = endpoints.map(
    ({ interfaceName, clientName }) => {
      const propertyName = interfaceName.startsWith("I")
        ? interfaceName.slice(1)
        : interfaceName;
      const paramName = escapeCsIdentifier(
        propertyName.charAt(0).toLowerCase() + propertyName.slice(1),
      );
      return { name: interfaceName, clientName, propertyName, paramName };
    },
  );
  const view: ExtensionsView = {
    className,
    methodName,
    clientClassName,
    httpClientName: `${csNs}.${serviceName}`,
    interfaces,
  };
  const body = renderer.renderExtensions(view);
  const fileView: FileView = {
    namespace: csNs,
    usings: sortUsings([
      "Flurl.Http",
      "Microsoft.Extensions.DependencyInjection",
      "System",
      "System.Net.Http",
    ]),
    body,
    fileName: `${className}.g.cs`,
  };
  return renderer.renderFile(fileView);
}
