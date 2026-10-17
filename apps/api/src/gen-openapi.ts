import { buildSpec } from "./spec";

await Bun.write(new URL("../../../docs/openapi.json", import.meta.url), await buildSpec());
