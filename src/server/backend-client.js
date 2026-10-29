import { Sub2ApiClient } from "./sub2api-client.js";
import { CprClient } from "./cpr-client.js";

export function createBackendClient(config) {
  if ((config?.provider || "sub2api") === "cpr") return new CprClient(config);
  return new Sub2ApiClient(config);
}
