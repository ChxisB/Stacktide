import { describe, expect, test } from "bun:test";
import { renderBlueprint } from "./blueprint-render";
import { CASES, input, othersOf } from "./fixtures/blueprint-cases";
import { hcl, publicGrants, worldOpen } from "./fixtures/hcl-checks";

/**
 * BLP-18. No policy pack ships with the platform: a policy set is the organization's own Rego, run by `conftest`
 * on the plan in the project's pipeline (POL-3), so there is nothing to evaluate here and no plan JSON to build
 * without a cloud. What can be proved offline is the part a pack would judge: a resource asked for with nothing
 * special is shut, and the plain checks that say so can fail. A pack run on a real plan is a task of its own.
 */

const render = (which: string, over: Record<string, unknown> = {}) =>
  renderBlueprint(input(which, over), "gitlab", "infra", othersOf(which));

describe("the checks that say a module is shut can fail", () => {
  test("a public grant is found in a bucket, unless only `public` creates it", () => {
    const grant = `
resource "google_storage_bucket_iam_member" "everyone" {
  bucket = google_storage_bucket.this.name
  role   = "roles/storage.objectViewer"
  member = "allUsers"
}
`;
    const code = hcl("gcp", "bucket");
    expect(publicGrants(code)).toEqual([]);
    expect(publicGrants(code + grant)).toEqual(["google_storage_bucket_iam_member.everyone"]);
    expect(publicGrants(code + grant.replace("{\n", "{\n  count = var.public ? 1 : 0\n"))).toEqual(
      [],
    );
  });

  test("an ingress from everywhere is found, a route and an HTTPS rule behind `public` are not", () => {
    const rule = (extra: string, port: number) => `
resource "aws_vpc_security_group_ingress_rule" "world" {
${extra}  security_group_id = aws_security_group.this.id
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = ${port}
  to_port           = ${port}
  ip_protocol       = "tcp"
}
`;
    const code = hcl("aws", "postgres");
    expect(worldOpen(code)).toEqual([]);
    expect(worldOpen(code + rule("", 5432))).toEqual(["aws_vpc_security_group_ingress_rule.world"]);
    expect(worldOpen(code + rule("", 443))).toEqual(["aws_vpc_security_group_ingress_rule.world"]);
    expect(worldOpen(code + rule("  count = var.public ? 1 : 0\n", 443))).toEqual([]);
    expect(worldOpen(code + rule("  count = var.public ? 1 : 0\n", 5432))).toEqual([
      "aws_vpc_security_group_ingress_rule.world",
    ]);
  });
});

describe("a resource asked for with nothing special is shut", () => {
  for (const which of Object.keys(CASES)) {
    test(`${which}: the stack's own files open nothing, and \`public\` is written down`, () => {
      const r = render(which);
      if (!r.ok) throw new Error(r.errors.join("; "));
      const own = r.files.filter((f) => f.path.startsWith(`${r.dir}/`));
      const text = own.map((f) => f.content).join("\n");
      expect(text).not.toMatch(/0\.0\.0\.0\/0|::\/0|allUsers|allAuthenticatedUsers/);

      const asked = which.startsWith("service") ? String(CASES[which]?.public ?? false) : undefined;
      const written = /^\s+public\s+= (.*)$/m.exec(text)?.[1];
      expect(written).toBe(asked);
    });
  }

  test("only a service can be asked to be public: a bucket, a database or a network refuses the key by name", () => {
    for (const which of Object.keys(CASES).filter((w) => !w.startsWith("service"))) {
      const r = render(which, { public: true });
      expect([which, r.ok]).toEqual([which, false]);
      if (!r.ok) expect(r.errors.join("; ")).toContain("public");
    }
  });
});
