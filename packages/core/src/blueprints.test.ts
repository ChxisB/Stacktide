import { describe, expect, test } from "bun:test";
import {
  BLUEPRINT_PART_MAX,
  BLUEPRINT_SIZES,
  BLUEPRINT_USES,
  type Blueprint,
  BlueprintSchema,
  checkBlueprintWiring,
  stackNameOf,
  useOf,
} from "./blueprints";

const CERT = "arn:aws:acm:eu-west-2:123456789012:certificate/12345678-1234-1234-1234-123456789012";

/** What a deploy identity says about the repository it trusts, besides where it is (ADR-0025). */
const IDENTITY = {
  kind: "deploy-identity",
  forge: "github",
  repository: "acme/web",
  repositoryId: 123456789,
  ownerId: 987654,
  uses: ["service:web"],
};

/** One valid input of every kind on both clouds. */
const VALID: Record<string, Record<string, unknown>> = {
  "network gcp": { kind: "network", cloud: "gcp", region: "us-central1", project: "my-proj-123" },
  "network aws": { kind: "network", cloud: "aws", region: "eu-west-2" },
  "service gcp": { kind: "service", cloud: "gcp", region: "us-central1", project: "my-proj-123" },
  "service aws": {
    kind: "service",
    cloud: "aws",
    region: "eu-west-2",
    certificateArn: CERT,
    uses: ["network:main"],
  },
  "postgres gcp": {
    kind: "postgres",
    cloud: "gcp",
    region: "us-central1",
    project: "my-proj-123",
    uses: ["network:main"],
  },
  "postgres aws": { kind: "postgres", cloud: "aws", region: "eu-west-2", uses: ["network:main"] },
  "bucket gcp": { kind: "bucket", cloud: "gcp", region: "us-central1", project: "my-proj-123" },
  "bucket aws": { kind: "bucket", cloud: "aws", region: "eu-west-2" },
  "deploy-identity gcp": {
    ...IDENTITY,
    cloud: "gcp",
    region: "us-central1",
    project: "my-proj-123",
  },
  "deploy-identity aws": { ...IDENTITY, cloud: "aws", region: "eu-west-2" },
};
const valid = (which: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  environment: "staging",
  name: "main",
  ...VALID[which],
  ...over,
});
const issues = (input: unknown) => {
  const r = BlueprintSchema.safeParse(input);
  return r.success ? [] : r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
};

describe("blueprint inputs", () => {
  test("every kind on both clouds parses, with safe defaults", () => {
    for (const which of Object.keys(VALID)) {
      const r = BlueprintSchema.safeParse(valid(which));
      expect([which, r.success]).toEqual([which, true]);
    }
    const service = BlueprintSchema.parse(valid("service gcp"));
    expect(service).toMatchObject({ profile: "small", uses: [], public: false, port: 8080 });
    expect(BlueprintSchema.parse(valid("bucket aws"))).toMatchObject({ versioning: false });
    expect(BlueprintSchema.parse(valid("postgres aws"))).toMatchObject({ version: "16" });
    expect(BlueprintSchema.parse(valid("network aws"))).toMatchObject({ cidr: "10.20.0.0/16" });
  });

  test("a key the schema does not know is refused, so no new way in is open by accident", () => {
    for (const which of Object.keys(VALID)) {
      expect(issues(valid(which, { password: "hunter2" }))).not.toEqual([]);
    }
    expect(issues(valid("bucket aws", { forceDestroy: true }))).not.toEqual([]);
  });

  test("GCP needs a project and a GCP region; AWS takes neither a project nor a GCP region", () => {
    const { project: _p, ...noProject } = valid("network gcp");
    expect(issues(noProject)).toContain("project: is required on GCP");
    expect(issues(valid("network gcp", { region: "eu-west-2" }))).toContain(
      "region: must be a GCP region, like us-central1",
    );
    expect(issues(valid("network aws", { region: "us-central1" }))).toContain(
      "region: must be an AWS region, like eu-west-2",
    );
    expect(issues(valid("network aws", { project: "my-proj-123" }))).toContain(
      "project: is for GCP: an AWS account is the runner's",
    );
  });

  test("names are lowercase words, at most 12 characters, and a stack name fits in 63", () => {
    for (const bad of ["", "A", "1a", "a_b", "a--b", "a-", "-a", "a b", "x".repeat(13), "é"]) {
      expect([bad, issues(valid("bucket aws", { name: bad })).length > 0]).toEqual([bad, true]);
      expect([bad, issues(valid("bucket aws", { environment: bad })).length > 0]).toEqual([
        bad,
        true,
      ]);
    }
    const longest = BlueprintSchema.parse(
      valid("postgres aws", { name: "x".repeat(12), environment: "y".repeat(12) }),
    );
    expect(stackNameOf(longest)).toHaveLength(12 + 1 + 12 + 1 + "postgres".length);
    expect(stackNameOf(longest).length).toBeLessThanOrEqual(63);
    expect(BLUEPRINT_PART_MAX).toBe(12);
    expect(stackNameOf(valid("service gcp") as never)).toBe("staging-main-service");
    expect(useOf({ kind: "postgres", name: "main" })).toBe("postgres:main");
  });

  test("an AWS service needs a certificate, a GCP service must not have one", () => {
    const { certificateArn: _c, ...none } = valid("service aws");
    expect(issues(none)).toContain(
      "certificateArn: is required on AWS: the load balancer serves HTTPS only",
    );
    expect(issues(valid("service aws", { certificateArn: "arn:aws:acm:x" }))).toContain(
      "certificateArn: must be an ACM certificate ARN",
    );
    expect(issues(valid("service gcp", { certificateArn: CERT }))).toContain(
      "certificateArn: is for AWS: Cloud Run serves HTTPS itself",
    );
  });

  test("the network range is a private IPv4 range from /16 to /24", () => {
    for (const ok of [
      "10.0.0.0/16",
      "10.20.0.0/16",
      "172.16.0.0/16",
      "172.31.0.0/16",
      "192.168.1.0/24",
      "10.0.0.0/24",
    ]) {
      expect([ok, issues(valid("network aws", { cidr: ok }))]).toEqual([ok, []]);
    }
    for (const bad of [
      "8.8.8.0/24",
      "172.32.0.0/16",
      "192.169.0.0/16",
      "10.0.0.0/25",
      "10.0.0.0/15",
      "10.0.0.0/8",
      "172.16.0.0/12",
      "10.0.0.256/16",
      "10.0.0.0",
      "10.0.0.0/16\n",
      "0.0.0.0/0",
    ]) {
      expect([bad, issues(valid("network aws", { cidr: bad })).length > 0]).toEqual([bad, true]);
    }
  });

  test("uses: a kind may list only what it can reach, never itself, never twice", () => {
    expect(
      issues(valid("service gcp", { uses: ["network:main", "postgres:main", "bucket:files"] })),
    ).toEqual([]);
    expect(issues(valid("service gcp", { uses: ["service:main"] }))).toContain(
      "uses: service:main is the resource itself",
    );
    expect(issues(valid("service gcp", { uses: ["service:other"] }))).toContain(
      "uses: a service cannot use a service (service:other)",
    );
    expect(issues(valid("bucket gcp", { uses: ["network:main"] }))).toContain(
      "uses: a bucket cannot use a network (network:main)",
    );
    expect(issues(valid("postgres gcp", { uses: ["bucket:files"] }))).toContain(
      "uses: a postgres cannot use a bucket (bucket:files)",
    );
    expect(issues(valid("service gcp", { uses: ["postgres:main", "postgres:main"] }))).toContain(
      "uses: postgres:main is listed twice",
    );
    expect(issues(valid("service gcp", { uses: [`postgres:${"x".repeat(13)}`] }))).not.toEqual([]);
    for (const bad of [
      "postgres",
      "postgres:",
      ":main",
      "cache:main",
      "postgres:Main",
      "postgres:a b",
    ]) {
      expect([bad, issues(valid("service gcp", { uses: [bad] })).length > 0]).toEqual([bad, true]);
    }
  });

  test("a database needs a network, and so does a service on AWS; a service on GCP may go without", () => {
    for (const which of ["postgres gcp", "postgres aws"]) {
      expect(issues(valid(which, { uses: [] }))).toContain(
        "uses: a postgres needs a network: add network:<name> to uses",
      );
    }
    expect(issues(valid("service aws", { uses: ["postgres:main"] }))).toContain(
      "uses: a service on AWS needs a network: add network:<name> to uses",
    );
    expect(issues(valid("service gcp", { uses: [] }))).toEqual([]);
  });

  test("a GCP service that uses a database needs a network, since the database has a private address only", () => {
    expect(issues(valid("service gcp", { uses: ["postgres:main"] }))).toContain(
      "uses: a service that uses a postgres needs a network: add network:<name> to uses",
    );
    expect(issues(valid("service gcp", { uses: ["network:main", "postgres:main"] }))).toEqual([]);
    expect(issues(valid("service gcp", { uses: ["bucket:files"] }))).toEqual([]);
  });

  test("only one network can be used", () => {
    expect(issues(valid("service gcp", { uses: ["network:main", "network:other"] }))).toContain(
      "uses: only one network can be used",
    );
  });

  test("a service image is a reference without credentials", () => {
    expect(issues(valid("service gcp", { image: "europe-docker.pkg.dev/p/r/app:1.2.3" }))).toEqual(
      [],
    );
    for (const bad of [
      "user:pw@host/app",
      "app image",
      "app\n",
      'app"',
      "app$(id)",
      "x".repeat(300),
    ]) {
      expect([bad, issues(valid("service gcp", { image: bad })).length > 0]).toEqual([bad, true]);
    }
    for (const bad of [0, 65536, 1.5, -1, "80"]) {
      expect([bad, issues(valid("service gcp", { port: bad })).length > 0]).toEqual([bad, true]);
    }
  });

  test("no kind can reach itself through what it may use, so a cycle cannot be written", () => {
    const loops = (kind: string, path: string[]): string[] | undefined => {
      if (path.includes(kind)) return [...path, kind];
      for (const next of BLUEPRINT_USES[kind as keyof typeof BLUEPRINT_USES]) {
        const found = loops(next, [...path, kind]);
        if (found) return found;
      }
      return undefined;
    };
    for (const kind of Object.keys(BLUEPRINT_USES))
      expect([kind, loops(kind, [])]).toEqual([kind, undefined]);
  });

  describe("wiring to the project's other resources", () => {
    const parse = (which: string, over: Record<string, unknown> = {}) =>
      BlueprintSchema.parse(valid(which, over));
    const wiring = (b: Blueprint, others: Blueprint[]) => checkBlueprintWiring(b, others);
    const service = parse("service gcp", {
      uses: ["network:main", "postgres:main", "bucket:files"],
    });
    const rest = (): Blueprint[] => [
      parse("network gcp"),
      parse("postgres gcp"),
      parse("bucket gcp", { name: "files" }),
    ];

    test("a resource whose uses all exist, on its cloud and its network, has nothing to say", () => {
      expect(wiring(service, rest())).toEqual([]);
      expect(wiring(parse("bucket gcp"), [])).toEqual([]);
    });

    test("a resource that is not there is refused by name, in the same environment only", () => {
      expect(wiring(service, rest().slice(0, 2))).toEqual([
        "uses: bucket:files is not a resource of staging",
      ]);
      const elsewhere = rest().map((o) => ({ ...o, environment: "prod" }));
      expect(wiring(service, elsewhere)).toEqual([
        "uses: network:main is not a resource of staging",
        "uses: postgres:main is not a resource of staging",
        "uses: bucket:files is not a resource of staging",
      ]);
    });

    test("a kind with another name does not stand in for it", () => {
      const others = rest().map((o) => (o.kind === "postgres" ? { ...o, name: "other" } : o));
      expect(wiring(service, others)).toEqual(["uses: postgres:main is not a resource of staging"]);
    });

    test("a resource on another cloud is refused by name", () => {
      const others = rest().map((o) =>
        o.kind === "bucket" ? parse("bucket aws", { name: "files" }) : o,
      );
      expect(wiring(service, others)).toEqual(["uses: bucket:files is on aws, not gcp"]);
    });

    test("a service and its database on different networks are refused by name", () => {
      const others = [
        parse("network gcp"),
        parse("network gcp", { name: "other" }),
        parse("postgres gcp", { uses: ["network:other"] }),
        parse("bucket gcp", { name: "files" }),
      ];
      expect(wiring(service, others)).toEqual([
        "uses: postgres:main is on network:other, but this service uses network:main",
      ]);
    });

    test("two resources whose stack names come out the same are refused, since the name is the state key", () => {
      // a dash in an environment or a name runs into the next part: dev-eu + main and dev + eu-main
      const eu = parse("bucket gcp", { environment: "dev-eu", name: "main" });
      const dev = parse("bucket gcp", { environment: "dev", name: "eu-main" });
      expect(stackNameOf(eu)).toBe(stackNameOf(dev));
      expect(wiring(dev, [eu])).toEqual([
        "name: dev-eu-main-bucket is already the stack of dev-eu/main, since a dash runs two names together",
      ]);
      // an earlier version of the resource itself is no clash, and neither is another kind
      expect(wiring(dev, [dev])).toEqual([]);
      expect(wiring(dev, [parse("postgres gcp", { environment: "dev-eu", name: "main" })])).toEqual(
        [],
      );
    });

    test("every problem is reported at once", () => {
      expect(wiring(service, [])).toHaveLength(3);
    });
  });

  // CLD-3/4: the identity a forge's runner signs in as, to deploy one service and nothing else
  describe("a deploy identity", () => {
    const parse = (which: string, over: Record<string, unknown> = {}) =>
      BlueprintSchema.parse(valid(which, over));
    const gitlab = { forge: "gitlab", repository: "acme/team/web", branch: "main" };

    test("has safe defaults: the ref form of the subject, and its own OIDC provider", () => {
      expect(parse("deploy-identity gcp")).toMatchObject({ immutableSubject: false });
      expect(parse("deploy-identity aws")).toMatchObject({ existingOidcProvider: false });
      expect(stackNameOf(parse("deploy-identity aws"))).toBe("staging-main-deploy-identity");
      expect(issues(valid("deploy-identity gcp", gitlab))).toEqual([]);
      expect(issues(valid("deploy-identity aws", { ...gitlab, repository: "acme/web" }))).toEqual(
        [],
      );
    });

    test("the repository is owner/repo on GitHub, a path of two or more on GitLab, and has no character of the subject's own syntax", () => {
      for (const bad of ["web", "acme/team/web", "acme/", "/web", "acme//web"]) {
        expect([bad, issues(valid("deploy-identity aws", { repository: bad })).length > 0]).toEqual(
          [bad, true],
        );
      }
      expect(issues(valid("deploy-identity aws", { ...gitlab, repository: "web" }))).not.toEqual(
        [],
      );
      // a colon, an at sign or a percent would let a value write the rest of the subject, or a second one
      for (const bad of [
        "acme/web:ref:refs/heads/main",
        "acme@1/web@2",
        "acme/web%3Aref",
        "acme/web*",
        "acme/web ",
        "acme/we\nb",
        `acme/${"x".repeat(200)}`,
      ]) {
        for (const forge of [{}, gitlab]) {
          expect([
            bad,
            issues(valid("deploy-identity gcp", { ...forge, repository: bad })).length > 0,
          ]).toEqual([bad, true]);
        }
      }
    });

    test("both numeric ids are required and must be whole numbers above zero", () => {
      for (const field of ["repositoryId", "ownerId"]) {
        const input = valid("deploy-identity gcp");
        delete input[field];
        expect([field, issues(input).length > 0]).toEqual([field, true]);
        for (const bad of [0, -1, 1.5, "12", 2 ** 53, null]) {
          expect([
            field,
            bad,
            issues(valid("deploy-identity gcp", { [field]: bad })).length > 0,
          ]).toEqual([field, bad, true]);
        }
      }
    });

    test("a GitLab identity names the branch it trusts, and a GitHub one has none (its job names an environment)", () => {
      const { branch: _b, ...noBranch } = valid("deploy-identity gcp", gitlab);
      expect(issues(noBranch)).toContain("branch: is required on GitLab: the subject names it");
      expect(issues(valid("deploy-identity gcp", { branch: "main" }))).toContain(
        "branch: is for GitLab: a GitHub job that names an environment has no ref in its subject",
      );
      for (const bad of ["", "a b", "a:b", "-x", "a*", "refs/heads/main\n", "x".repeat(101)]) {
        expect([
          bad,
          issues(valid("deploy-identity gcp", { ...gitlab, branch: bad })).length > 0,
        ]).toEqual([bad, true]);
      }
      expect(issues(valid("deploy-identity gcp", { ...gitlab, branch: "release/1.x" }))).toEqual(
        [],
      );
    });

    test("the immutable subject is a GitHub choice, and an existing OIDC provider an AWS one", () => {
      expect(issues(valid("deploy-identity gcp", { immutableSubject: true }))).toEqual([]);
      expect(issues(valid("deploy-identity gcp", { ...gitlab, immutableSubject: true }))).toContain(
        "immutableSubject: is for GitHub: GitLab's subject has no immutable form",
      );
      expect(issues(valid("deploy-identity aws", { existingOidcProvider: true }))).toEqual([]);
      expect(issues(valid("deploy-identity gcp", { existingOidcProvider: true }))).toContain(
        "existingOidcProvider: is for AWS: a workload identity pool is made by this stack",
      );
    });

    test("it deploys exactly one service, of its own environment, and uses nothing else", () => {
      expect(issues(valid("deploy-identity gcp", { uses: [] }))).toContain(
        "uses: a deploy-identity deploys one service: add service:<name> to uses",
      );
      expect(
        issues(valid("deploy-identity gcp", { uses: ["service:web", "service:api"] })),
      ).toContain("uses: a deploy-identity deploys one service: add service:<name> to uses");
      expect(
        issues(valid("deploy-identity gcp", { uses: ["service:web", "network:main"] })),
      ).toContain("uses: a deploy-identity cannot use a network (network:main)");
      expect(issues(valid("deploy-identity gcp", { uses: ["bucket:files"] }))).not.toEqual([]);
    });

    test("no other kind can use an identity, so one is never a dependency", () => {
      for (const uses of Object.values(BLUEPRINT_USES))
        expect(uses).not.toContain("deploy-identity");
      expect(issues(valid("service gcp", { uses: ["deploy-identity:main"] }))).not.toEqual([]);
    });

    test("the longest stack name still fits where a name is capped", () => {
      const longest = parse("deploy-identity aws", {
        environment: "y".repeat(12),
        name: "x".repeat(12),
      });
      expect(stackNameOf(longest)).toHaveLength(12 + 1 + 12 + 1 + "deploy-identity".length);
      expect(stackNameOf(longest).length).toBeLessThanOrEqual(63);
    });

    describe("wiring", () => {
      const identity = parse("deploy-identity gcp");
      const web = (over: Record<string, unknown> = {}) =>
        parse("service gcp", { name: "web", ...over });

      test("the service is there, on this cloud, in this region and project", () => {
        expect(checkBlueprintWiring(identity, [web()])).toEqual([]);
        expect(checkBlueprintWiring(identity, [])).toEqual([
          "uses: service:web is not a resource of staging",
        ]);
        expect(checkBlueprintWiring(identity, [parse("service aws", { name: "web" })])).toEqual([
          "uses: service:web is on aws, not gcp",
        ]);
      });

      test("a service somewhere else is refused: the identity's names are built from where it is", () => {
        const where =
          "uses: service:web is not where this deploy identity is: region and project must match";
        expect(checkBlueprintWiring(identity, [web({ region: "europe-west2" })])).toEqual([where]);
        expect(checkBlueprintWiring(identity, [web({ project: "other-proj-456" })])).toEqual([
          where,
        ]);
        const aws = parse("deploy-identity aws");
        expect(
          checkBlueprintWiring(aws, [
            parse("service aws", { name: "web", region: "eu-west-1", uses: ["network:main"] }),
          ]),
        ).toEqual([where]);
      });
    });
  });

  // The renderer writes these values into HCL. A string that could end a literal or open an
  // interpolation must never get past the schema, whichever field it is put in.
  const HOSTILE = [
    'a"b',
    "a\nb",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the point is a HCL interpolation, not a JS template
    "a${b}",
    "a%{b}",
    "a\\b",
    "a'b",
    "a`b",
    "a#b",
    "a b",
    "/*",
    "a;b",
    "a\u0000b",
    "\u202e",
  ];
  for (const which of Object.keys(VALID)) {
    test(`no hostile string passes any field of ${which}`, () => {
      const base = valid(which);
      const fields = Object.entries(base).filter(([, v]) => typeof v === "string");
      // fields a kind does not list are probed too, since a strict schema must refuse the key
      const probes = new Set([
        ...fields.map(([k]) => k),
        "image",
        "cidr",
        "version",
        "certificateArn",
      ]);
      for (const field of probes) {
        for (const h of HOSTILE) {
          const pre = field === "uses" ? [h] : h;
          const r = BlueprintSchema.safeParse({ ...base, [field]: pre });
          expect([which, field, h, r.success]).toEqual([which, field, h, false]);
        }
      }
      const r = BlueprintSchema.safeParse({ ...base, uses: HOSTILE.map((h) => `postgres:${h}`) });
      expect(r.success).toBe(false);
    });
  }

  test("the profile table has every profile of every sized kind in both clouds", () => {
    for (const cloud of ["gcp", "aws"] as const) {
      for (const kind of ["service", "postgres"] as const) {
        expect(Object.keys(BLUEPRINT_SIZES[cloud][kind])).toEqual(["small", "medium", "large"]);
      }
    }
    expect(issues(valid("bucket aws", { profile: "huge" }))).not.toEqual([]);
  });
});
