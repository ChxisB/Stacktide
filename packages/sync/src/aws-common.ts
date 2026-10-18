import { z } from "zod";
import { AwsApiError } from "./aws-json";
import { SyncError } from "./errors";
import { CloudError } from "./http";
import type { ItemRef } from "./types";

/** The tag that says a parameter or secret was made by this platform for this prefix. Its value is the prefix. */
export const OWNER_TAG = "orch-managed";

export const regionSchema = z.string().regex(/^[a-z]{2}(-[a-z]+)+-\d$/);
// up to 13 levels, so a scope and a key still fit in the 15 SSM allows; the first level may not start with aws or ssm, which SSM reserves
export const prefixSchema = z
  .string()
  .max(200)
  .regex(/^(\/(?!\.+(?=\/|$))[A-Za-z0-9_.-]{1,60}){1,13}$/)
  .refine((p) => !/^\/(aws|ssm)/i.test(p));
export const kmsKeySchema = z.string().regex(/^[A-Za-z0-9:/_-]{1,2048}$/);

export const label = ({ key, scope }: ItemRef) =>
  `${JSON.stringify(key.slice(0, 64))} (${scope.slice(0, 64)})`;

/** Fixed words and AWS's name for the error (a word the service defines), so nothing AWS said can reach one. */
export function failed(what: string, e: unknown) {
  let why = "the request could not be made";
  if (e instanceof AwsApiError) why = `AWS answered ${e.reason}${e.code ? ` (${e.code})` : ""}`;
  else if (e instanceof CloudError) why = `AWS could not be asked (${e.reason})`;
  else if (e instanceof z.ZodError) why = "AWS answered something unexpected";
  return new SyncError("failed", `${what}: ${why}`);
}
