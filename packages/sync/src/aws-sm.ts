import { z } from "zod";
import type { AwsCreds, AwsDeps } from "./aws";
import { failed, kmsKeySchema, OWNER_TAG, prefixSchema, regionSchema } from "./aws-common";
import { AwsApiError, awsJson } from "./aws-json";
import { SyncError } from "./errors";
import { byKeyThenScope, label } from "./ref";
import {
  ALL_SCOPES,
  type Capabilities,
  type ItemInput,
  type ItemRef,
  type Remote,
  type RemoteItem,
  type SyncAdapter,
} from "./types";

export const AWS_SM = "aws-sm";

const SM = { service: "secretsmanager", target: "secretsmanager" };
/** The tag that says which layout a secret was made in, so a target never reads another layout's secrets as its own. */
export const LAYOUT_TAG = "orch-layout";
/** `orch-plain:KEY` marks a key that is not a secret. Secrets Manager encrypts everything, so being a secret is the default. */
export const PLAIN_TAG = "orch-plain:";

/** A secret holds 65536 bytes. */
const MAX_VALUE = 65536;
/** The scope `*` is the secret named `_` in the per-scope layout. */
const ALL_NAME = "_";
const LIST_PAGE = 100;
/** More secrets than this under one prefix is not a prefix this platform should manage. */
const MAX_PAGES = 100;
/** Secrets Manager keeps a deleted secret this long (its default), so a mistake can be undone in the console. */
const RECOVERY_DAYS = 30;

// a name part; a key is also a tag key (`orch-plain:` and 100 more characters fit the 128 allowed)
const part = /^(?!\.+$)[A-Za-z0-9_.-]{1,100}$/;
// the ARN of a secret ends in a hyphen and six characters, and AWS asks that a name not look like that
const arnLike = /-[A-Za-z0-9]{6}$/;

const configSchema = z.strictObject({
  region: regionSchema,
  prefix: prefixSchema,
  layout: z.enum(["per-key", "per-scope"]).optional(),
  kmsKeyId: kmsKeySchema.optional(),
  protected: z.boolean().optional(),
});

/**
 * Where the secrets are: a region and a name prefix (`/team/app`), and how items map to secrets:
 * `per-key` (the default, and it stays the default) is one secret per item, `per-scope` one secret per
 * scope that holds a JSON object of its keys. The credential is not here: it is the role of the connection.
 */
export type AwsSmConfig = z.infer<typeof configSchema>;

export function parseAwsSmConfig(config: unknown): AwsSmConfig {
  const parsed = configSchema.safeParse(config);
  if (!parsed.success) {
    throw new SyncError(
      "invalid_config",
      "the config is { region, prefix }, a region such as eu-west-1 and a name prefix such as /team/app, and optionally { layout: per-key | per-scope, kmsKeyId, protected }",
    );
  }
  return parsed.data;
}

const tagList = z.array(z.object({ Key: z.string(), Value: z.string() })).default([]);
const entry = z.object({
  Name: z.string(),
  Tags: tagList,
  DeletedDate: z.number().optional(),
});
const listed = z.object({
  SecretList: z.array(entry).default([]),
  NextToken: z.string().optional(),
});
const valued = z.object({ SecretString: z.string().optional() });

/** What a secret is tagged with. */
type Tags = Map<string, string>;
const tagsOf = (list: { Key: string; Value: string }[]): Tags =>
  new Map(list.map((t) => [t.Key, t.Value]));

/** Empty is wrong for any target. */
const checkRef = (ref: ItemRef) => {
  if (!ref.key) throw new SyncError("invalid", "the key is empty");
  if (!ref.scope) throw new SyncError("invalid", `${label(ref)}: the scope is empty`);
};
/** Whether a name can hold the key and the scope, whichever layout they go in (a scope is `*` or a name). */
const nameable = ({ key, scope }: ItemRef) =>
  part.test(key) && (scope === ALL_SCOPES || part.test(scope));
/** Whether the layout can name a secret for the item: the part of the name that ends it may not look like an ARN, and no scope is `_` in the per-scope layout. */
const placeable = (layout: "per-key" | "per-scope", { key, scope }: ItemRef) =>
  !arnLike.test(layout === "per-key" ? key : scope) &&
  !(layout === "per-scope" && scope === ALL_NAME);

/** What no config changes: the layout-bound rules are `placeable`, and are met when the item is written. */
function check(item: ItemInput) {
  checkRef(item);
  if (item.file) {
    throw new SyncError("unsupported", `${label(item)}: Secrets Manager has no file values`);
  }
  if (!nameable(item)) {
    throw new SyncError(
      "invalid",
      `${label(item)}: a key and a scope are 1-100 letters, digits or _ . - (a scope may also be *)`,
    );
  }
  // the limit is in bytes; a per-scope secret also holds its other keys, which is checked when it is written
  const size = Buffer.byteLength(item.value);
  if (size < 1 || size > MAX_VALUE) {
    throw new SyncError("invalid", `${label(item)}: Secrets Manager takes 1-${MAX_VALUE} bytes`);
  }
}

/**
 * AWS Secrets Manager under one name prefix as a sync target.
 *
 * Layout `per-key`: a key at scope `*` is the secret `<prefix>/<KEY>`, in any other scope
 * `<prefix>/<scope>/<KEY>`, and the secret is the value. Layout `per-scope`: the secret
 * `<prefix>/<scope>` (`<prefix>/_` for `*`) holds `{"KEY": "value", ...}`; a write reads that object
 * and puts it back with only its own key changed, so keys that someone else put there stay.
 *
 * Everything in Secrets Manager is encrypted, so the `secret` flag is kept as a tag, `orch-plain:KEY`
 * on a key that is not a secret. Secrets are the default and carry no tag. A new value is a new
 * version that takes `AWSCURRENT` (the old one keeps `AWSPREVIOUS`); a read asks for `AWSCURRENT` only.
 *
 * The platform only ever touches secrets it made: each carries `orch-managed=<prefix>` and
 * `orch-layout=<layout>`. `read` lists only those, and `update` and `delete` check the tags first,
 * so a secret someone made by hand, another target made under an overlapping prefix, or the other
 * layout made, is never listed, overwritten or deleted. `create` never overwrites. A delete is a
 * scheduled deletion with a 30 day recovery window, not an immediate one; creating the key again inside
 * the window restores the secret (per-key) and puts the new value in it.
 *
 * shortcut: one GetSecretValue per secret, one DescribeSecret before each write, text secrets only,
 * no rotation, replication or resource policies, and the object of a per-scope secret is read, changed
 * and put back with nothing to stop two writers at once (the last put wins); add BatchGetSecretValue
 * and a version check when a prefix holds thousands of secrets or has two writers.
 */
export function awsSmAdapter(
  session: () => Promise<AwsCreds>,
  d: AwsDeps,
): SyncAdapter<AwsSmConfig> {
  const capabilities: Capabilities = {
    canReadValues: true,
    supportsMasking: true,
    supportsScopes: true,
    supportsFiles: false,
  };

  return {
    type: AWS_SM,
    capabilities,
    check,
    validate: parseAwsSmConfig,
    connect(config): Remote {
      const layout = config.layout ?? "per-key";
      const call = async (action: string, body: unknown) =>
        awsJson(d, await session(), SM, config.region, action, body);
      const nameOf = ({ key, scope }: ItemRef) => {
        if (layout === "per-scope") {
          return `${config.prefix}/${scope === ALL_SCOPES ? ALL_NAME : scope}`;
        }
        return scope === ALL_SCOPES
          ? `${config.prefix}/${key}`
          : `${config.prefix}/${scope}/${key}`;
      };
      /** What a secret of this name holds the place of: one key in a scope, or (per-scope) a whole scope. */
      const shapeOf = (name: string): { scope: string; key?: string } | undefined => {
        if (!name.startsWith(`${config.prefix}/`)) return undefined;
        const parts = name.slice(config.prefix.length + 1).split("/");
        const [a, b] = parts;
        if (a === undefined || !part.test(a)) return undefined;
        if (layout === "per-scope") {
          return parts.length === 1 && !arnLike.test(a)
            ? { scope: a === ALL_NAME ? ALL_SCOPES : a }
            : undefined;
        }
        if (parts.length === 1) return arnLike.test(a) ? undefined : { scope: ALL_SCOPES, key: a };
        return parts.length === 2 && b !== undefined && part.test(b) && !arnLike.test(b)
          ? { scope: a, key: b }
          : undefined;
      };
      const tagged = (tags: Tags) =>
        tags.get(OWNER_TAG) === config.prefix && tags.get(LAYOUT_TAG) === layout;
      const ownerTags = () => [
        { Key: OWNER_TAG, Value: config.prefix },
        { Key: LAYOUT_TAG, Value: layout },
      ];
      const plainTag = (key: string) => `${PLAIN_TAG}${key}`;
      const absent = (ref: ItemRef) =>
        new SyncError(
          "not_found",
          `${label(ref)} is not there, or is not tagged ${OWNER_TAG}=${config.prefix} and ${LAYOUT_TAG}=${layout}`,
        );
      const exists = (ref: ItemRef) =>
        new SyncError(
          "exists",
          `${label(ref)} is already there; a secret this platform did not make is only managed once it carries the tags ${OWNER_TAG}=${config.prefix} and ${LAYOUT_TAG}=${layout}`,
        );

      /** The secret's tags and whether it is scheduled for deletion, or undefined when there is no such secret. */
      const lookup = async (name: string) => {
        try {
          const r = entry.parse(await call("DescribeSecret", { SecretId: name }));
          return { tags: tagsOf(r.Tags), deleted: r.DeletedDate !== undefined };
        } catch (e) {
          if (e instanceof AwsApiError && e.code === "ResourceNotFoundException") return undefined;
          throw e;
        }
      };
      const describe = async (name: string, ref: ItemRef) => {
        try {
          return await lookup(name);
        } catch (e) {
          throw failed(label(ref), e);
        }
      };
      const text = async (name: string, ref: ItemRef) => {
        try {
          return valued.parse(await call("GetSecretValue", { SecretId: name })).SecretString;
        } catch (e) {
          throw failed(label(ref), e);
        }
      };
      /** The object of a per-scope secret, in a Map so that no key can be mistaken for `__proto__`. */
      const objectOf = (json: string | undefined, name: string) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(json ?? "");
        } catch {
          parsed = undefined;
        }
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          throw new SyncError(
            "failed",
            `the secret ${name} is tagged for this target but does not hold a JSON object`,
          );
        }
        return new Map(Object.entries(parsed));
      };
      /** What a per-scope secret holds is the JSON of all its keys, which is bigger than any one value. */
      const sized = (ref: ItemRef, value: string) => {
        if (Buffer.byteLength(value) > MAX_VALUE) {
          throw new SyncError(
            "invalid",
            `${label(ref)}: the scope's secret would pass ${MAX_VALUE} bytes`,
          );
        }
        return value;
      };
      const putText = async (name: string, ref: ItemRef, value: string) => {
        sized(ref, value);
        try {
          // a new token each time: a version made again with the same token would not take AWSCURRENT back
          await call("PutSecretValue", {
            SecretId: name,
            SecretString: value,
            ClientRequestToken: crypto.randomUUID(),
          });
        } catch (e) {
          throw failed(label(ref), e);
        }
      };
      /** Marks the key as plain, or not, to match the item; only calls when the tags differ. */
      const flag = async (name: string, item: ItemInput, tags: Tags) => {
        const tag = plainTag(item.key);
        if (item.secret === !tags.has(tag)) return;
        try {
          if (item.secret) await call("UntagResource", { SecretId: name, TagKeys: [tag] });
          else await call("TagResource", { SecretId: name, Tags: [{ Key: tag, Value: "1" }] });
        } catch (e) {
          throw failed(label(item), e);
        }
      };

      /** Create and update are the same walk: look at the secret, and the object in it for a per-scope layout. */
      async function write(item: ItemInput, mode: "create" | "update") {
        check(item);
        if (!placeable(layout, item)) {
          throw new SyncError(
            "invalid",
            `${label(item)}: the name of a secret does not end in a hyphen and six characters, and in the per-scope layout no scope is ${ALL_NAME}`,
          );
        }
        const name = nameOf(item);
        const there = await describe(name, item);
        if (there?.deleted) {
          // the recovery window keeps the name taken: a create of a key this platform deleted brings the secret back
          if (mode === "update" || !tagged(there.tags)) {
            throw mode === "create" ? exists(item) : absent(item);
          }
          if (layout === "per-scope") {
            throw new SyncError(
              "failed",
              `${label(item)}: the secret ${name} is scheduled for deletion; restore it in AWS, or wait out the recovery window`,
            );
          }
          try {
            await call("RestoreSecret", { SecretId: name });
          } catch (e) {
            throw failed(label(item), e);
          }
          await flag(name, item, there.tags);
          await putText(name, item, item.value);
          return;
        }
        if (there && !tagged(there.tags)) throw mode === "create" ? exists(item) : absent(item);
        if (!there && mode === "update") throw absent(item);

        if (!there) {
          const first =
            layout === "per-key"
              ? item.value
              : sized(item, JSON.stringify({ [item.key]: item.value }));
          try {
            await call("CreateSecret", {
              Name: name,
              SecretString: first,
              ClientRequestToken: crypto.randomUUID(),
              Tags: [
                ...ownerTags(),
                ...(item.secret ? [] : [{ Key: plainTag(item.key), Value: "1" }]),
              ],
              ...(config.kmsKeyId ? { KmsKeyId: config.kmsKeyId } : {}),
            });
          } catch (e) {
            if (e instanceof AwsApiError && e.code === "ResourceExistsException")
              throw exists(item);
            throw failed(label(item), e);
          }
          return;
        }
        if (layout === "per-key") {
          if (mode === "create") throw exists(item);
          await flag(name, item, there.tags);
          await putText(name, item, item.value);
          return;
        }
        const object = objectOf(await text(name, item), name);
        if (object.has(item.key) === (mode === "create")) {
          throw mode === "create" ? exists(item) : absent(item);
        }
        object.set(item.key, item.value);
        await flag(name, item, there.tags);
        await putText(name, item, JSON.stringify(Object.fromEntries(object)));
      }

      return {
        async read() {
          const items: RemoteItem[] = [];
          const secrets: { name: string; tags: Tags }[] = [];
          try {
            let next: string | undefined;
            for (let page = 0; ; page++) {
              if (page === MAX_PAGES) {
                throw new SyncError(
                  "failed",
                  "reading the secrets: more than 10000 under the prefix",
                );
              }
              const r = listed.parse(
                await call("ListSecrets", {
                  // both filters are prefix matches, and the tags are checked again below
                  Filters: [
                    { Key: "name", Values: [`${config.prefix}/`] },
                    { Key: "tag-key", Values: [OWNER_TAG] },
                  ],
                  MaxResults: LIST_PAGE,
                  ...(next ? { NextToken: next } : {}),
                }),
              );
              for (const s of r.SecretList) {
                const tags = tagsOf(s.Tags);
                if (s.DeletedDate === undefined && tagged(tags) && shapeOf(s.Name)) {
                  secrets.push({ name: s.Name, tags });
                }
              }
              next = r.NextToken;
              if (!next) break;
            }
            for (const { name, tags } of secrets) {
              const at = shapeOf(name);
              let value: string | undefined;
              try {
                value = valued.parse(await call("GetSecretValue", { SecretId: name })).SecretString;
              } catch (e) {
                // deleted between the listing and the read is gone (a secret scheduled for deletion refuses
                // the read with InvalidRequestException, so that answer is only believed after a look); anything else fails
                if (e instanceof AwsApiError && e.code === "ResourceNotFoundException") continue;
                if (e instanceof AwsApiError && e.code === "InvalidRequestException") {
                  const now = await lookup(name);
                  if (!now || now.deleted) continue;
                }
                throw e;
              }
              if (!at || value === undefined) continue;
              if (at.key !== undefined) {
                items.push({
                  key: at.key,
                  scope: at.scope,
                  value,
                  secret: !tags.has(plainTag(at.key)),
                  file: false,
                });
                continue;
              }
              for (const [key, v] of objectOf(value, name)) {
                if (typeof v !== "string" || !part.test(key)) continue;
                items.push({
                  key,
                  scope: at.scope,
                  value: v,
                  secret: !tags.has(plainTag(key)),
                  file: false,
                });
              }
            }
          } catch (e) {
            if (e instanceof SyncError) throw e;
            throw failed("reading the secrets", e);
          }
          return items.sort(byKeyThenScope);
        },
        create: (item) => write(item, "create"),
        update: (item) => write(item, "update"),
        async delete(ref) {
          // a key or scope that cannot be named is not there, so `not_found`; update and create say `invalid`
          checkRef(ref);
          if (!nameable(ref) || !placeable(layout, ref)) throw absent(ref);
          const name = nameOf(ref);
          const there = await describe(name, ref);
          if (!there || there.deleted || !tagged(there.tags)) throw absent(ref);
          if (layout === "per-key") {
            try {
              await call("DeleteSecret", { SecretId: name, RecoveryWindowInDays: RECOVERY_DAYS });
            } catch (e) {
              if (e instanceof AwsApiError && e.code === "ResourceNotFoundException") {
                throw new SyncError("not_found", `${label(ref)} is not there`);
              }
              throw failed(label(ref), e);
            }
            return;
          }
          // a key out of the object; the secret stays, empty, so that the scope can be filled again at once
          const object = objectOf(await text(name, ref), name);
          if (!object.delete(ref.key)) throw absent(ref);
          await putText(name, ref, JSON.stringify(Object.fromEntries(object)));
          if (there.tags.has(plainTag(ref.key))) {
            try {
              await call("UntagResource", { SecretId: name, TagKeys: [plainTag(ref.key)] });
            } catch (e) {
              throw failed(label(ref), e);
            }
          }
        },
      };
    },
  };
}
