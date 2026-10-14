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
  /** C# implementation class name, e.g. `PetsEndpoint`. */
  clientName: string;
  /** C# access modifier of the interface: `"public"` or `"internal"`. */
  access: string;
}

/**
 * Renders the wiring file for a service: a `{ServiceName}` aggregate client class
 * that surfaces one strongly-typed property per generated endpoint interface, and
 * a `{ServiceName}Extensions` static class exposing `Add{ServiceName}(...)`.
 *
 * @param serviceName - Client/service display name (e.g. `PetStore`); drives the
 *   aggregate client name, the extension class name, and the `Add…` method name.
 * @param csNs - C# namespace the generated file is emitted into.
 * @param endpoints - The endpoint interfaces to register, their implementations, and
 *   their access; each interface maps to a client property/parameter with the leading
 *   `I` stripped. An internal interface becomes an internal property, and any internal
 *   interface makes the aggregate client's constructor internal.
 * @param renderer - Handlebars renderer used to produce the file contents.
 * @param additionalUsings - Extra `using` directives from the `additional-usings`
 *   option, which apply to every emitted file.
 * @returns The full C# source of the generated extensions file.
 */
export function buildExtensions(
  serviceName: string,
  csNs: string,
  endpoints: EndpointName[],
  renderer: Renderer,
  additionalUsings: Iterable<string> = [],
): string {
  const className = `${serviceName}Extensions`;
  const methodName = `Add${serviceName}`;
  const clientClassName = serviceName;
  // Each endpoint is a constructor parameter beside `flurlClient`. Two endpoint
  // names that differ only in the case of their first letter, or one that becomes
  // `flurlClient`, would declare the same parameter twice (CS0100).
  const takenParams = new Set(["flurlClient"]);
  const interfaces: InterfaceEntry[] = endpoints.map(
    ({ interfaceName, clientName, access }) => {
      const propertyName = interfaceName.startsWith("I")
        ? interfaceName.slice(1)
        : interfaceName;
      const base = propertyName.charAt(0).toLowerCase() + propertyName.slice(1);
      let unescaped = base;
      for (let n = 1; takenParams.has(unescaped); n++) {
        unescaped = n === 1 ? `${base}Endpoint` : `${base}Endpoint${n}`;
      }
      takenParams.add(unescaped);
      return {
        name: interfaceName,
        clientName,
        propertyName,
        paramName: escapeCsIdentifier(unescaped),
        docParamName: unescaped,
        access,
      };
    },
  );
  const view: ExtensionsView = {
    className,
    methodName,
    clientClassName,
    httpClientName: `${csNs}.${serviceName}`,
    // A public constructor cannot take an internal parameter type (CS0051).
    constructorAccess: interfaces.some((i) => i.access !== "public")
      ? "internal"
      : "public",
    interfaces,
  };
  const body = renderer.renderExtensions(view);
  const fileView: FileView = {
    namespace: csNs,
    usings: sortUsings([
      ...new Set([
        "Flurl.Http",
        "Microsoft.Extensions.DependencyInjection",
        "System",
        "System.Net.Http",
        ...additionalUsings,
      ]),
    ]),
    body,
    fileName: `${className}.g.cs`,
  };
  return renderer.renderFile(fileView);
}
