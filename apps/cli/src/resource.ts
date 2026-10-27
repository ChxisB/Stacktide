import {
  BLUEPRINT_CLOUDS,
  BLUEPRINT_KINDS,
  BLUEPRINT_PROFILES,
  type BlueprintKind,
} from "@orch/core";
import { call, session } from "./api";
import { CliError, type Command, type Context, parse, say } from "./cli";
import { every, resolveProject } from "./target";

const USAGE =
  "usage: orch resource blueprints | ls [--env <environment>] | show <stack> | add <kind> --env <environment> --cloud gcp|aws --name <name> --region <region> [--gcp-project <id>] [--profile small|medium|large] [--uses <kind:name>...] [<kind's flags>] [--dry-run] | change <stack> [flags to change] [--dry-run]  (kinds: network, service, postgres, bucket, deploy-identity; a resource is a merge or pull request, never a cloud call)";

/** A value from the API or a forge is shown to someone's terminal: a control character in it is not. */
const plain = (text: string) => text.replace(/[\p{Cc}\p{Cf}]/gu, " ");

/** The flags of each kind, besides the ones every kind takes. A flag that does nothing is a mistake, not a no-op. */
const KIND_FLAGS: Record<BlueprintKind, readonly string[]> = {
  network: ["cidr"],
  service: ["image", "port", "public", "certificate-arn"],
  postgres: ["version"],
  bucket: ["versioning"],
  "deploy-identity": [
    "forge",
    "repository",
    "repository-id",
    "owner-id",
    "branch",
    "immutable-subject",
    "existing-oidc-provider",
  ],
};
const SHARED = ["region", "gcp-project", "profile", "uses", "dry-run"] as const;
const ADD_ONLY = ["env", "cloud", "name"] as const;

const usage = (why: string) => new CliError(`${why}\n${USAGE}`, 2);
const oneOf = <T extends string>(flag: string, value: string, allowed: readonly T[]): T => {
  if (!(allowed as readonly string[]).includes(value)) {
    throw usage(`--${flag} must be one of ${allowed.join(", ")}`);
  }
  return value as T;
};
const truth = (flag: string, value: string) => oneOf(flag, value, ["true", "false"]) === "true";

type Values = Record<string, string | boolean | string[] | undefined>;

/** The inputs the flags give, by the names the closed schema uses. Only the words are checked here: the API checks the values. */
function inputsOf(values: Values): Record<string, unknown> {
  const text = (k: string) => values[k] as string | undefined;
  const out: Record<string, unknown> = {};
  const set = (key: string, v: unknown) => {
    if (v !== undefined) out[key] = v;
  };
  set("region", text("region"));
  set("project", text("gcp-project"));
  const profile = text("profile");
  set("profile", profile === undefined ? undefined : oneOf("profile", profile, BLUEPRINT_PROFILES));
  set("uses", values.uses);
  set("cidr", text("cidr"));
  set("image", text("image"));
  const port = text("port");
  if (port !== undefined) {
    if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
      throw usage("--port must be a whole number from 1 to 65535");
    }
    out.port = Number(port);
  }
  const pub = text("public");
  if (pub !== undefined) out.public = truth("public", pub);
  set("certificateArn", text("certificate-arn"));
  set("version", text("version"));
  const versioning = text("versioning");
  if (versioning !== undefined) out.versioning = truth("versioning", versioning);
  const forge = text("forge");
  set("forge", forge === undefined ? undefined : oneOf("forge", forge, ["github", "gitlab"]));
  set("repository", text("repository"));
  for (const [flag, key] of [
    ["repository-id", "repositoryId"],
    ["owner-id", "ownerId"],
  ] as const) {
    const id = text(flag);
    if (id === undefined) continue;
    if (!/^\d{1,15}$/.test(id) || Number(id) < 1)
      throw usage(`--${flag} must be a whole number above 0`);
    out[key] = Number(id);
  }
  set("branch", text("branch"));
  const immutable = text("immutable-subject");
  if (immutable !== undefined) out.immutableSubject = truth("immutable-subject", immutable);
  const existing = text("existing-oidc-provider");
  if (existing !== undefined) out.existingOidcProvider = truth("existing-oidc-provider", existing);
  return out;
}

const filesText = (files: string[]) => files.map((f) => `  ${plain(f)}`).join("\n");

export const resourceCommands = (): Record<string, Command> => ({
  resource: {
    summary:
      "resources from the blueprint catalog (a network, a service, a Postgres, a bucket, a deploy identity on GCP or AWS), proposed as a merge or pull request: orch resource blueprints|ls|show|add|change",
    async run(ctx, args) {
      const { values, positionals } = parse(args, {
        "api-url": { type: "string" },
        org: { type: "string" },
        project: { type: "string" },
        env: { type: "string" },
        cloud: { type: "string" },
        name: { type: "string" },
        region: { type: "string" },
        "gcp-project": { type: "string" },
        profile: { type: "string" },
        uses: { type: "string", multiple: true },
        cidr: { type: "string" },
        image: { type: "string" },
        port: { type: "string" },
        public: { type: "string" },
        "certificate-arn": { type: "string" },
        version: { type: "string" },
        versioning: { type: "string" },
        forge: { type: "string" },
        repository: { type: "string" },
        "repository-id": { type: "string" },
        "owner-id": { type: "string" },
        branch: { type: "string" },
        "immutable-subject": { type: "string" },
        "existing-oidc-provider": { type: "string" },
        "dry-run": { type: "boolean" },
      });
      const [step, ref, ...extra] = positionals;
      const given = Object.keys(values).filter((k) => k !== "api-url");
      const only = (allowed: readonly string[]) => {
        const stray = given.filter((k) => !allowed.includes(k));
        if (stray.length > 0)
          throw usage(`${stray.map((k) => `--${k}`).join(", ")} does not belong here`);
      };

      if (step === "blueprints") {
        if (ref !== undefined) throw usage("blueprints takes no name");
        only(["org", "project"]);
      } else if (step === "ls") {
        if (ref !== undefined) throw usage("ls takes no name");
        only(["org", "project", "env"]);
      } else if (step === "show") {
        if (ref === undefined || extra.length > 0) throw usage("show takes one stack name");
        only(["org", "project"]);
      } else if (step === "add") {
        if (ref === undefined || extra.length > 0) throw usage("add takes one kind");
        const kind = oneOf("kind", ref, BLUEPRINT_KINDS);
        only(["org", "project", ...ADD_ONLY, ...SHARED, ...KIND_FLAGS[kind]]);
        for (const need of ["env", "cloud", "name", "region"] as const) {
          if (values[need] === undefined) throw usage(`add needs --${need}`);
        }
        oneOf("cloud", values.cloud as string, BLUEPRINT_CLOUDS);
        inputsOf(values);
      } else if (step === "change") {
        if (ref === undefined || extra.length > 0) throw usage("change takes one stack name");
        only(["org", "project", ...SHARED, ...Object.values(KIND_FLAGS).flat()]);
        if (given.every((k) => k === "org" || k === "project" || k === "dry-run")) {
          throw usage("change needs at least one flag to change");
        }
        inputsOf(values);
      } else {
        throw new CliError(USAGE, 2);
      }

      const { apiUrl, client } = await session(ctx, values["api-url"]);
      if (step === "blueprints") {
        const catalog = await call(apiUrl, () => client.blueprints.get());
        const lines = catalog.kinds.flatMap((k) => [
          `${k.kind}  uses ${k.uses.length > 0 ? k.uses.join(", ") : "nothing"}`,
          ...k.clouds.map((c) => `  ${c.cloud}  ${c.version}  idle: ${plain(c.idleCost)}`),
        ]);
        say(ctx, lines.join("\n"), catalog);
        return;
      }

      const target = await resolveProject(ctx, apiUrl, client, values);
      const scope = client
        .organizations({ orgId: target.orgId })
        .projects({ projectId: target.projectId }).resources;
      const all = () => every(apiUrl, (cursor) => scope.get({ query: { limit: 100, cursor } }));
      const byStack = async (stack: string) => {
        const found = (await all()).find((r) => r.stack === stack || r.id === stack);
        if (!found) throw new CliError(`no resource ${plain(stack)} in ${target.label}`, 2);
        return found;
      };

      if (step === "ls") {
        const items = (await all()).filter(
          (r) => values.env === undefined || r.environment === values.env,
        );
        const lines = items.map(
          (r) =>
            `${r.stack}  ${r.kind}  ${r.cloud}  ${r.environment}  ${r.state}${r.url ? `  ${plain(r.url)}` : ""}`,
        );
        say(ctx, lines.length > 0 ? lines.join("\n") : `no resources in ${target.label}`, {
          project: target.label,
          resources: items,
        });
      } else if (step === "show" && ref) {
        const r = await byStack(ref);
        const lines = [
          `${r.stack}  ${r.kind} on ${r.cloud} in ${r.environment}  ${r.state}`,
          `files  ${plain(r.path)}`,
          `request  ${r.proposalUrl ? plain(r.proposalUrl) : "-"}`,
          `url  ${r.url ? plain(r.url) : "-"}`,
          `console  ${r.consoleUrl ? plain(r.consoleUrl) : "-"}`,
          ...Object.entries(r.inputs).map(([k, v]) => `  ${plain(k)} ${plain(JSON.stringify(v))}`),
        ];
        say(ctx, lines.join("\n"), r);
      } else if (step === "add" && ref) {
        const body = {
          kind: ref,
          environment: values.env,
          cloud: values.cloud,
          name: values.name,
          ...inputsOf(values),
        };
        await finish(
          ctx,
          values["dry-run"] === true
            ? await call(apiUrl, () => scope.preview.post(body))
            : await call(apiUrl, () => scope.post(body)),
          target.label,
          values["dry-run"] === true,
        );
      } else if (step === "change" && ref) {
        const current = await byStack(ref);
        const ofKinds = Object.values(KIND_FLAGS).flat();
        const stray = given.filter(
          (k) => ofKinds.includes(k) && !KIND_FLAGS[current.kind].includes(k),
        );
        if (stray.length > 0) {
          throw usage(
            `${stray.map((k) => `--${k}`).join(", ")} is not a flag of a ${current.kind}`,
          );
        }
        // shortcut: --uses replaces the list and cannot empty it; drop a dependency by editing the merge request
        const body = {
          environment: current.environment,
          kind: current.kind,
          cloud: current.cloud,
          name: current.name,
          ...current.inputs,
          ...inputsOf(values),
        };
        await finish(
          ctx,
          values["dry-run"] === true
            ? await call(apiUrl, () => scope.preview.post(body))
            : await call(apiUrl, () => scope({ id: current.id }).patch(body)),
          target.label,
          values["dry-run"] === true,
        );
      }
    },
  },
});

interface Preview {
  verb: "add" | "change";
  cloud: string;
  stack: string;
  path: string;
  files: string[];
  idleCost: string;
}
interface Proposal {
  stack: string;
  path: string;
  files: string[];
  outcome: "opened" | "updated" | "unchanged" | "in_place";
  proposalUrl: string | null;
}

const OUTCOME = {
  opened: "opened",
  updated: "updated",
  unchanged: "nothing to change in",
  in_place: "the files are already on the default branch, as in",
} as const;

function finish(ctx: Context, answer: Preview | Proposal, label: string, dry: boolean) {
  if (dry) {
    const p = answer as Preview;
    say(
      ctx,
      [
        `dry run: ${p.verb} ${plain(p.stack)} in ${label} (${p.cloud}): files in ${plain(p.path)}`,
        filesText(p.files),
        `idle cost: ${plain(p.idleCost)}`,
        "nothing was written",
      ].join("\n"),
      { dryRun: true, ...p },
    );
    return;
  }
  const r = answer as Proposal;
  say(
    ctx,
    [
      `${plain(r.stack)}: ${OUTCOME[r.outcome]} ${r.proposalUrl ? plain(r.proposalUrl) : "its request"}`,
      "nothing exists in the cloud until the request is merged and the project's pipeline applies it",
    ].join("\n"),
    { dryRun: false, ...r },
  );
}
