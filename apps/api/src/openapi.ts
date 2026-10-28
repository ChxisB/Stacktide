import { openapi } from "@elysiajs/openapi";
import { z } from "zod";

// uuid / date-time carry long regexes zod adds on top of `format`: noise in a document people read.
const plain = (schema: z.ZodType) =>
  z.toJSONSchema(schema, {
    io: "input",
    unrepresentable: "any", // `z.undefined()` marks the empty body of a 204
    override: ({ jsonSchema }) => {
      jsonSchema.$schema = undefined;
      if (jsonSchema.format === "uuid" || jsonSchema.format === "date-time") {
        jsonSchema.pattern = undefined;
      }
    },
  });

export const openapiPlugin = () =>
  openapi({
    provider: null, // the bundled docs UI loads scripts from a CDN
    path: "/openapi",
    specPath: "/openapi/json",
    mapJsonSchema: { zod: plain },
    documentation: { info: { title: "Stacktide API", version: "0.1.0" } },
  });
