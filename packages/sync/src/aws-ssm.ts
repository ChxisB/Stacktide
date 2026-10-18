import { z } from "zod";
import type { AwsCreds, AwsDeps } from "./aws";
import { failed, kmsKeySchema, label, OWNER_TAG, prefixSchema, regionSchema } from "./aws-common";
import { AwsApiError, awsJson } from "./aws-json";
import { SyncError } from "./errors";
import { byKeyThenScope } from "./ref";
import {
  ALL_SCOPES,
  type Capabilities,
  type ItemInput,
  type ItemRef,
  type Remote,
  type RemoteItem,
  type SyncAdapter,
} from "./types";

export const AWS_SSM = "aws-ssm";

const SSM = { service: "ssm", target: "AmazonSSM" };

export { OWNER_TAG };

/** The standard tier takes 4 KB. */
const MAX_VALUE = 4096;
/** DescribeParameters pages hold 50 at most, GetParameters takes 10 names. */
const DESCRIBE_PAGE = 50;
const GET_BATCH = 10;
/** More parameters than this under one prefix is not a prefix this platform should manage. */
const MAX_PAGES = 200;

// a name part: no dots-only part (`.` and `..`), the characters SSM allows in one
const part = /^(?!\.+$)[A-Za-z0-9_.-]{1,255}$/;
const configSchema = z.strictObject({
  region: regionSchema,
  prefix: prefixSchema,
  kmsKeyId: kmsKeySchema.optional(),
  protected: z.boolean().optional(),
});

/**
 * Where the parameters are: a region and a path prefix (`/team/app`), with an optional KMS key for
 * secrets (SecureString; left out, the account's `alias/aws/ssm` key). The credential is not here: it
 * is the role of the connection.
 */
export type AwsSsmConfig = z.infer<typeof configSchema>;

export function parseAwsSsmConfig(config: unknown): AwsSsmConfig {
  const parsed = configSchema.safeParse(config);
  if (!parsed.success) {
    throw new SyncError(
      "invalid_config",
      "the config is { region, prefix }, a region such as eu-west-1 and a path such as /team/app, and optionally { kmsKeyId, protected }",
    );
  }
  return parsed.data;
}

const described = z.object({
  Parameters: z.array(z.object({ Name: z.string() })).default([]),
  NextToken: z.string().optional(),
});
const got = z.object({
  Parameters: z
    .array(z.object({ Name: z.string(), Type: z.string(), Value: z.string() }))
    .default([]),
});
const tagged = z.object({ TagList: z.array(z.object({ Key: z.string(), Value: z.string() })) });

/**
 * AWS Systems Manager Parameter Store under one path prefix as a sync target. A key at scope `*` is
 * `<prefix>/<KEY>`, in any other scope `<prefix>/<scope>/<KEY>`. A secret is a SecureString, anything
 * else a String.
 *
 * The platform only ever touches parameters it made: each carries the tag `orch-managed=<prefix>`.
 * `read` lists only those, and `update` and `delete` check the tag first, so a parameter someone made
 * by hand (or another target made under an overlapping prefix) is never listed, overwritten or
 * deleted, whatever a plan says. `create` never overwrites. `session` hands out the credentials of
 * the connection's role.
 *
 * shortcut: standard tier (4 KB values), one extra `ListTagsForResource` per update and delete, and
 * a read that asks for 10 names at a time one after the other; add the advanced tier and bounded
 * concurrency when a prefix holds thousands of parameters.
 */
export function awsSsmAdapter(
  session: () => Promise<AwsCreds>,
  d: AwsDeps,
): SyncAdapter<AwsSsmConfig> {
  const capabilities: Capabilities = {
    canReadValues: true,
    supportsMasking: true,
    supportsScopes: true,
    supportsFiles: false,
  };

  /** Empty is wrong for any target. */
  const checkRef = (ref: ItemRef) => {
    if (!ref.key) throw new SyncError("invalid", "the key is empty");
    if (!ref.scope) throw new SyncError("invalid", `${label(ref)}: the scope is empty`);
  };
  /** Whether SSM can hold a parameter by this key in this scope (a scope is `*` or a name). */
  const nameable = ({ key, scope }: ItemRef) =>
    part.test(key) && (scope === ALL_SCOPES || part.test(scope));
  const check = (item: ItemInput) => {
    checkRef(item);
    if (item.file) throw new SyncError("unsupported", `${label(item)}: SSM has no file values`);
    if (!nameable(item)) {
      throw new SyncError(
        "invalid",
        `${label(item)}: a key and a scope are 1-255 letters, digits or _ . - (a scope may also be *)`,
      );
    }
    // the limit is 4 KB, so bytes, not characters
    const size = Buffer.byteLength(item.value);
    if (size < 1 || size > MAX_VALUE) {
      throw new SyncError("invalid", `${label(item)}: SSM takes 1-${MAX_VALUE} bytes`);
    }
    // SSM reads {{ }} in a value as a reference to another parameter and refuses it
    if (/\{\{.*\}\}/s.test(item.value)) {
      throw new SyncError("invalid", `${label(item)}: SSM refuses a value that contains {{ }}`);
    }
  };

  return {
    type: AWS_SSM,
    capabilities,
    check,
    validate: parseAwsSsmConfig,
    connect(config): Remote {
      const call = async (action: string, body: unknown) =>
        awsJson(d, await session(), SSM, config.region, action, body);
      const nameOf = ({ key, scope }: ItemRef) =>
        scope === ALL_SCOPES ? `${config.prefix}/${key}` : `${config.prefix}/${scope}/${key}`;
      // a tagged parameter of a shape this adapter never writes (deeper, or odd characters) is left alone
      const itemOf = (name: string): ItemRef | undefined => {
        if (!name.startsWith(`${config.prefix}/`)) return undefined;
        const parts = name.slice(config.prefix.length + 1).split("/");
        const [a, b] = parts;
        if (parts.length === 1 && a !== undefined && part.test(a)) {
          return { key: a, scope: ALL_SCOPES };
        }
        if (
          parts.length === 2 &&
          a !== undefined &&
          b !== undefined &&
          part.test(a) &&
          part.test(b)
        ) {
          return { key: b, scope: a };
        }
        return undefined;
      };
      const put = (item: ItemInput, extra: Record<string, unknown>) =>
        call("PutParameter", {
          Name: nameOf(item),
          Value: item.value,
          Type: item.secret ? "SecureString" : "String",
          ...(item.secret && config.kmsKeyId ? { KeyId: config.kmsKeyId } : {}),
          ...extra,
        });
      /** What an update or delete of a parameter that is missing, or is not ours to change, answers. */
      const absent = (ref: ItemRef) =>
        new SyncError(
          "not_found",
          `${label(ref)} is not there, or is not tagged ${OWNER_TAG}=${config.prefix}`,
        );
      /** Whether this platform made the parameter for this prefix: nothing else is ours to change. */
      const ours = async (ref: ItemRef) => {
        // a name SSM cannot hold is not there (and SSM would call asking about it a validation error)
        if (!nameable(ref)) return false;
        try {
          const tags = tagged.parse(
            await call("ListTagsForResource", {
              ResourceType: "Parameter",
              ResourceId: nameOf(ref),
            }),
          );
          return tags.TagList.some((t) => t.Key === OWNER_TAG && t.Value === config.prefix);
        } catch (e) {
          if (e instanceof AwsApiError && e.code === "InvalidResourceId") return false;
          throw failed(label(ref), e);
        }
      };

      return {
        async read() {
          const names: string[] = [];
          const items: RemoteItem[] = [];
          try {
            let next: string | undefined;
            for (let page = 0; ; page++) {
              if (page === MAX_PAGES) {
                throw new SyncError(
                  "failed",
                  "reading the parameters: more than 10000 under the prefix",
                );
              }
              const r = described.parse(
                await call("DescribeParameters", {
                  ParameterFilters: [
                    { Key: "Path", Option: "Recursive", Values: [config.prefix] },
                    { Key: `tag:${OWNER_TAG}`, Values: [config.prefix] },
                  ],
                  MaxResults: DESCRIBE_PAGE,
                  ...(next ? { NextToken: next } : {}),
                }),
              );
              names.push(...r.Parameters.map((p) => p.Name));
              next = r.NextToken;
              if (!next) break;
            }
            for (let i = 0; i < names.length; i += GET_BATCH) {
              const r = got.parse(
                await call("GetParameters", {
                  Names: names.slice(i, i + GET_BATCH),
                  WithDecryption: true,
                }),
              );
              for (const p of r.Parameters) {
                const ref = itemOf(p.Name);
                if (!ref) continue;
                items.push({
                  ...ref,
                  value: p.Value,
                  secret: p.Type === "SecureString",
                  file: false,
                });
              }
            }
          } catch (e) {
            if (e instanceof SyncError) throw e;
            throw failed("reading the parameters", e);
          }
          return items.sort(byKeyThenScope);
        },
        async create(item) {
          check(item);
          try {
            // no Overwrite: it cannot be combined with Tags, and a parameter that is there is not ours to replace
            await put(item, { Tags: [{ Key: OWNER_TAG, Value: config.prefix }] });
          } catch (e) {
            if (e instanceof AwsApiError && e.code === "ParameterAlreadyExists") {
              throw new SyncError(
                "exists",
                `${label(item)} is already there; a parameter this platform did not make is only managed once it carries the tag ${OWNER_TAG}=${config.prefix}`,
              );
            }
            throw failed(label(item), e);
          }
        },
        async update(item) {
          check(item);
          if (!(await ours(item))) throw absent(item);
          try {
            // overwriting a name that is not there would create it, hence the check above
            await put(item, { Overwrite: true });
          } catch (e) {
            throw failed(label(item), e);
          }
        },
        async delete(ref) {
          // a key or scope SSM cannot name is not there, so `not_found`; update and create say `invalid`
          checkRef(ref);
          if (!(await ours(ref))) throw absent(ref);
          try {
            await call("DeleteParameter", { Name: nameOf(ref) });
          } catch (e) {
            if (e instanceof AwsApiError && e.code === "ParameterNotFound") {
              throw new SyncError("not_found", `${label(ref)} is not there`);
            }
            throw failed(label(ref), e);
          }
        },
      };
    },
  };
}
