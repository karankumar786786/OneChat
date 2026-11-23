/**
 * Writes contracts/openapi.json from the route definitions.
 * Clients in any language generate their REST types from this file.
 */
import { buildApp, openApiInfo } from "../src/app.ts";

const { api } = buildApp();
const doc = api.getOpenAPI31Document(openApiInfo);
const out = new URL("../contracts/openapi.json", import.meta.url);
await Bun.write(out, JSON.stringify(doc, null, 2) + "\n");
console.log(`Wrote ${Object.keys(doc.paths ?? {}).length} paths to contracts/openapi.json`);
process.exit(0);
