// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the strings under test are HCL interpolations, made of `${...}`
import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { listModules, readModule } from "./blueprint-modules";

/**
 * The shipped Terraform (ADR-0024), read as text. These are the plain checks that run everywhere: they fail
 * on a module that opens a door the blueprint promises is shut. `terraform validate` over the same files is
 * the opt-in run in blueprint-modules.e2e.test.ts.
 */

/** A module's Terraform with the comments taken out, so a rule written in a comment is not read as code. */
const hcl = (cloud: string, kind: string, only?: string): string =>
  readModule(cloud, kind)
    .filter((f) => f.name.endsWith(".tf") && (only === undefined || f.name === only))
    .map((f) => f.content)
    .join("\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*(#|\/\/).*$/gm, "")
    .replace(/\s#.*$/gm, "");

/** The top-level resources of a module, as `[type.name, text]`. */
const resources = (code: string): [string, string][] =>
  code
    .split(/^(?=resource\s+")/m)
    .filter((chunk) => /^resource\s+"/.test(chunk))
    .map((chunk) => {
      const [, type, name] = /^resource\s+"([^"]+)"\s+"([^"]+)"/.exec(chunk) ?? [];
      return [`${type}.${name}`, chunk];
    });

/** True when a resource exists only while `var.public` is on. */
const onlyWhenPublic = (chunk: string) => /count\s*=\s*var\.public\s*\?\s*1\s*:\s*0/.test(chunk);

/**
 * The resources that name the whole internet as a source. A route and an egress rule are not doors (they say
 * where outbound traffic may go). A public service's load balancer rule is one, and only when it is switched on
 * by `var.public` and is HTTPS.
 */
const worldOpen = (code: string): string[] =>
  resources(code)
    .filter(([, chunk]) => /0\.0\.0\.0\/0|::\/0/.test(chunk))
    .filter(([id, chunk]) => {
      if (id.startsWith("aws_route.") || id.startsWith("aws_vpc_security_group_egress_rule.")) {
        return false;
      }
      return !(onlyWhenPublic(chunk) && /from_port\s*=\s*443\b/.test(chunk));
    })
    .map(([id]) => id);

/** The `statement` blocks of every IAM policy document in a module, as `{actions, resources}` lists of strings. */
const statements = (code: string) =>
  [...code.matchAll(/^ {2}statement\s*{([\s\S]*?)^ {2}}/gm)].map((m) => {
    const list = (key: string) =>
      [
        ...(new RegExp(`${key}\\s*=\\s*\\[([^\\]]*)\\]`).exec(m[1] ?? "")?.[1] ?? "").matchAll(
          /"([^"]*)"/g,
        ),
      ].map((x) => x[1] ?? "");
    return { actions: list("actions"), resources: list("resources") };
  });

/** The resources that give the internet itself (every user) a role, other than one that only `public` creates. */
const publicGrants = (code: string): string[] =>
  resources(code)
    .filter(([, chunk]) => /allUsers|allAuthenticatedUsers/.test(chunk))
    .filter(([, chunk]) => !onlyWhenPublic(chunk))
    .map(([id]) => id);

describe("every shipped module", () => {
  const all = listModules();
  test("the first cut is being written", () => {
    expect(all.length).toBeGreaterThan(0);
  });
  for (const { cloud, kind, dir } of all) {
    const code = hcl(cloud, kind);
    test(`${cloud}/${kind} has its files, pins its provider and configures none`, () => {
      expect(readdirSync(dir).sort()).toEqual(
        expect.arrayContaining([
          "README.md",
          "main.tf",
          "outputs.tf",
          "variables.tf",
          "versions.tf",
        ]),
      );
      expect(code).toMatch(/required_version\s*=\s*">= 1\.5"/);
      expect(code).toMatch(/version\s*=\s*"~> \d+\.\d+"/);
      // the stack's own main.tf holds the provider, the backend and the project
      expect(code).not.toMatch(/^\s*provider\s+"/m);
      expect(code).not.toMatch(/^\s*backend\s+"/m);
    });
    test(`${cloud}/${kind} lets nothing in from everywhere`, () => {
      expect(worldOpen(code)).toEqual([]);
      expect(publicGrants(code)).toEqual([]);
    });
    test(`${cloud}/${kind} declares the outputs its stack forwards: console_url, and url on a service`, () => {
      const names = [...code.matchAll(/output\s+"([^"]+)"/g)].map((m) => m[1]);
      expect(names).toContain("console_url");
      expect(names.includes("url")).toBe(kind === "service");
    });
    test(`${cloud}/${kind} keeps no literal secret and prints none`, () => {
      expect(code).not.toMatch(/^\s*(password|secret|token|private_key)\s*=\s*"/m);
      // an output that carries a secret would reach the apply summary
      for (const output of code.matchAll(/output\s+"([^"]+)"\s*{([^}]*)}/g)) {
        expect([
          output[1],
          /password|secret_string|secret_data|connection_string/i.test(output[2] ?? ""),
        ]).toEqual([output[1], false]);
      }
    });
  }
});

describe("network, GCP", () => {
  const code = hcl("gcp", "network");
  test("is a custom-mode network with no firewall rule and no external address", () => {
    expect(code).toMatch(/auto_create_subnetworks\s*=\s*false/);
    expect(code).not.toMatch(/google_compute_firewall/);
    expect(code).not.toMatch(/access_config|google_compute_address|EXTERNAL/);
  });
  test("lets Google's APIs be reached from the private subnet, and reserves private service access", () => {
    expect(code).toMatch(/private_ip_google_access\s*=\s*true/);
    expect(code).toMatch(/purpose\s*=\s*"VPC_PEERING"/);
    expect(code).toMatch(/google_service_networking_connection/);
  });
  test("names the network and its subnet after the stack, so a later resource can find them", () => {
    expect(code).toMatch(/id\s*=\s*"\$\{var\.environment\}-\$\{var\.name\}-network"/);
    expect(code).toMatch(/output\s+"network_name"/);
    expect(code).toMatch(/output\s+"subnetwork_name"/);
  });
});

describe("network, AWS", () => {
  const code = hcl("aws", "network");
  test("empties the default security group and opens no ingress rule", () => {
    const sg = /resource\s+"aws_default_security_group"\s+"this"\s*{([^}]*)}/.exec(code)?.[1] ?? "";
    expect(sg).toMatch(/vpc_id/);
    expect(sg).not.toMatch(/ingress|egress/);
    expect(code).not.toMatch(
      /aws_security_group_rule|aws_vpc_security_group_ingress_rule|\bingress\s*{/,
    );
  });
  test("hands out no public address, and 0.0.0.0/0 appears only as a route", () => {
    expect(code).not.toMatch(/map_public_ip_on_launch\s*=\s*true/);
    expect(code).not.toMatch(/associate_public_ip_address\s*=\s*true/);
    const routes = [...code.matchAll(/destination_cidr_block\s*=\s*"0\.0\.0\.0\/0"/g)];
    expect(routes.length).toBe([...code.matchAll(/0\.0\.0\.0\/0/g)].length);
  });
  test("sends private traffic out through the NAT gateway, not the internet gateway", () => {
    const route = /resource\s+"aws_route"\s+"private_nat"\s*{([^}]*)}/.exec(code)?.[1] ?? "";
    expect(route).toMatch(/nat_gateway_id/);
    expect(route).not.toMatch(/gateway_id\s*=\s*aws_internet_gateway/);
  });
  test("tags the VPC and the tiers so a later resource can find them", () => {
    expect(code).toMatch(/Name\s*=\s*local\.id/);
    expect(code).toMatch(/Tier\s*=\s*"private"/);
    expect(code).toMatch(/Tier\s*=\s*"public"/);
    expect(code).toMatch(/id\s*=\s*"\$\{var\.environment\}-\$\{var\.name\}-network"/);
  });
});

describe("service, GCP", () => {
  const code = hcl("gcp", "service");
  test("takes no traffic from the internet unless public, and only that switch grants it", () => {
    expect(code).toMatch(
      /ingress\s*=\s*var\.public\s*\?\s*"INGRESS_TRAFFIC_ALL"\s*:\s*"INGRESS_TRAFFIC_INTERNAL_ONLY"/,
    );
    const grants = resources(code).filter(([, chunk]) => /allUsers/.test(chunk));
    expect(grants.map(([id]) => id)).toEqual(["google_cloud_run_v2_service_iam_member.public"]);
    expect(grants[0]?.[1]).toMatch(/roles\/run\.invoker/);
    expect(onlyWhenPublic(grants[0]?.[1] ?? "")).toBe(true);
    expect(code).toMatch(/variable\s+"public"\s*{[^}]*default\s*=\s*false/);
  });
  test("the service account has no role of its own: only secret access and bucket objects, on named things", () => {
    expect(code).not.toMatch(/google_project_iam|google_organization_iam|google_folder_iam/);
    const grants = resources(code).filter(([id]) => /_iam_member\./.test(id));
    expect(grants.map(([id]) => id).sort()).toEqual([
      "google_cloud_run_v2_service_iam_member.public",
      "google_secret_manager_secret_iam_member.database",
      "google_storage_bucket_iam_member.bucket",
    ]);
    const secret = grants.find(([id]) => id.includes("secret_manager"))?.[1] ?? "";
    expect(secret).toMatch(/role\s*=\s*"roles\/secretmanager\.secretAccessor"/);
    expect(secret).toMatch(/secret_id\s*=\s*each\.value/);
    const bucket = grants.find(([id]) => id.includes("storage_bucket"))?.[1] ?? "";
    expect(bucket).toMatch(/role\s*=\s*"roles\/storage\.objectUser"/);
    expect(bucket).toMatch(/bucket\s*=\s*each\.value/);
    expect([...code.matchAll(/role\s*=\s*"([^"]+)"/g)].map((m) => m[1]).sort()).toEqual([
      "roles/run.invoker",
      "roles/secretmanager.secretAccessor",
      "roles/storage.objectUser",
    ]);
  });
  test("mounts secrets as secret references, never as a value", () => {
    expect(code).toMatch(/secret_key_ref/);
    expect(code).not.toMatch(/google_secret_manager_secret_version|secret_data/);
  });
  test("reaches the network through direct VPC egress, by the network's name, only when it has one", () => {
    expect(code).toMatch(/vpc_access[\s\S]*network_interfaces/);
    expect(code).toMatch(/var\.network\s*==\s*""\s*\?\s*\[\]/);
    expect(code).toMatch(/network_name\s*=\s*"\$\{var\.environment\}-\$\{var\.network\}-network"/);
  });
  test("lets a teardown delete it and leaves the image to deploys", () => {
    expect(code).toMatch(/deletion_protection\s*=\s*false/);
    expect(code).toMatch(/ignore_changes[\s\S]*containers\[0\]\.image/);
  });
});

describe("postgres, GCP", () => {
  const code = hcl("gcp", "postgres");
  test("has a private address only, and TLS", () => {
    expect(code).toMatch(/ipv4_enabled\s*=\s*false/);
    expect(code).toMatch(/private_network\s*=\s*data\.google_compute_network\.this\.id/);
    expect(code).toMatch(/ssl_mode\s*=\s*"ENCRYPTED_ONLY"/);
    expect(code).not.toMatch(/authorized_networks|ipv4_enabled\s*=\s*true/);
  });
  test("is protected from deletion in both places, with backups on", () => {
    expect(code).toMatch(/^\s*deletion_protection\s*=\s*true/m);
    expect(code).toMatch(/deletion_protection_enabled\s*=\s*true/);
    expect(code).not.toMatch(/deletion_protection(_enabled)?\s*=\s*false/);
    expect(code).toMatch(/backup_configuration\s*{[^}]*enabled\s*=\s*true/);
    expect(code).toMatch(/point_in_time_recovery_enabled\s*=\s*true/);
  });
  test("sets the edition, since PostgreSQL 16 and later default to one that the small tiers cannot use", () => {
    expect(code).toMatch(/edition\s*=\s*"ENTERPRISE"/);
  });
  test("writes the connection URL to the secret every service reads, and only there", () => {
    expect(code).toMatch(/secret_id\s*=\s*local\.secret_id/);
    expect(code).toMatch(/secret_id\s*=\s*"\$\{var\.environment\}-\$\{var\.name\}-database-url"/);
    expect([...code.matchAll(/random_password\.database\.result/g)].length).toBe(2);
    const output =
      hcl("gcp", "postgres")
        .match(/output\s+"[^"]+"\s*{[^}]*}/g)
        ?.join("\n") ?? "";
    expect(output).not.toMatch(/random_password|secret_version|secret_data|private_ip_address/);
  });
  test("generates a password that fits in a URL, and keeps none in a variable", () => {
    expect(code).toMatch(/special\s*=\s*false/);
    expect(code).not.toMatch(/variable\s+"[^"]*(password|secret)[^"]*"/);
  });
});

describe("bucket, GCP", () => {
  const code = hcl("gcp", "bucket");
  test("enforces public access prevention and uniform access, and grants nothing", () => {
    expect(code).toMatch(/public_access_prevention\s*=\s*"enforced"/);
    expect(code).toMatch(/uniform_bucket_level_access\s*=\s*true/);
    expect(code).not.toMatch(
      /google_storage_bucket_iam|google_storage_bucket_access_control|google_storage_default_object/,
    );
  });
  test("is not deleted while it holds objects, and versioning follows the input", () => {
    expect(code).toMatch(/force_destroy\s*=\s*false/);
    expect(code).toMatch(/enabled\s*=\s*var\.versioning/);
  });
  test("is named the way a service derives its name", () => {
    const bucket = /bucket_name\s*=\s*("[^"]+")/.exec(code)?.[1];
    const service = /bucket_names\s*=\s*{[^}]*=>\s*("[^"]+")/.exec(hcl("gcp", "service"))?.[1];
    expect(bucket).toBe('"${var.environment}-${var.name}-${substr(sha256(var.project), 0, 8)}"');
    expect(service).toBe('"${var.environment}-${b}-${substr(sha256(var.project), 0, 8)}"');
  });
});

describe("service, AWS", () => {
  const code = hcl("aws", "service");
  test("needs a network, finds it and its subnets by the tags the network module sets", () => {
    expect(code).toMatch(/variable\s+"network"\s*{(?![^}]*default)/);
    expect(code).toMatch(/network_name\s*=\s*"\$\{var\.environment\}-\$\{var\.network\}-network"/);
    expect(code).toMatch(/Name\s*=\s*local\.network_name/);
    expect(code).toMatch(/Tier\s*=\s*"private"/);
    expect(code).toMatch(/Tier\s*=\s*"public"/);
  });
  test("the load balancer serves HTTPS only: one listener, port 443, a policy and a certificate", () => {
    const listeners = resources(code).filter(([id]) => id.startsWith("aws_lb_listener."));
    expect(listeners).toHaveLength(1);
    const listener = listeners[0]?.[1] ?? "";
    expect(listener).toMatch(/port\s*=\s*443/);
    expect(listener).toMatch(/protocol\s*=\s*"HTTPS"/);
    expect(listener).toMatch(/ssl_policy\s*=\s*"ELBSecurityPolicy-TLS13/);
    expect(listener).toMatch(/certificate_arn\s*=\s*var\.certificate_arn/);
    expect(listener).not.toMatch(/port\s*=\s*80\b|protocol\s*=\s*"HTTP"\s*$/m);
    expect(code).toMatch(/drop_invalid_header_fields\s*=\s*true/);
  });
  test("the load balancer is internal unless public, and only the public switch opens it to the world", () => {
    expect(code).toMatch(/internal\s*=\s*!var\.public/);
    expect(code).toMatch(/variable\s+"public"\s*{[^}]*default\s*=\s*false/);
    const world = resources(code).filter(([, chunk]) => /0\.0\.0\.0\/0/.test(chunk));
    const ingress = world.filter(([id]) => id.startsWith("aws_vpc_security_group_ingress_rule."));
    expect(ingress.map(([id]) => id)).toEqual(["aws_vpc_security_group_ingress_rule.alb_public"]);
    expect(onlyWhenPublic(ingress[0]?.[1] ?? "")).toBe(true);
    expect(ingress[0]?.[1]).toMatch(/from_port\s*=\s*443/);
    expect(ingress[0]?.[1]).toMatch(/to_port\s*=\s*443/);
    expect(code).not.toMatch(/\bingress\s*{|\begress\s*{|aws_security_group_rule/);
  });
  test("tasks take traffic only from the load balancer, have no public address, and send out only 443 and the database", () => {
    expect(code).toMatch(/assign_public_ip\s*=\s*false/);
    const task = resources(code).find(
      ([id]) => id === "aws_vpc_security_group_ingress_rule.task",
    )?.[1];
    expect(task).toMatch(/referenced_security_group_id\s*=\s*aws_security_group\.alb\.id/);
    expect(task).not.toMatch(/cidr_ipv4|cidr_ipv6/);
    const egress = resources(code).filter(([id]) =>
      id.startsWith("aws_vpc_security_group_egress_rule.task"),
    );
    const ports = egress.map(([, chunk]) => /to_port\s*=\s*(\S+)/.exec(chunk)?.[1]).sort();
    expect(ports).toEqual(["443", "5432"]);
  });
  test("no role names an action or a resource with a star, except the one login call AWS cannot scope", () => {
    const all = statements(code);
    expect(all.length).toBeGreaterThan(3);
    for (const s of all) {
      expect(s.actions.filter((a) => a.includes("*"))).toEqual([]);
      if (s.resources.includes("*")) expect(s.actions).toEqual(["ecr:GetAuthorizationToken"]);
    }
    expect(code).not.toMatch(/AdministratorAccess|PowerUserAccess|aws_iam_role_policy_attachment/);
    expect(code).not.toMatch(/aws_iam_user|aws_iam_access_key|aws_iam_policy\b/);
  });
  test("secrets are read by the execution role from the named secrets only, and never read into Terraform", () => {
    const secretStatements = statements(code).filter((s) =>
      s.actions.some((a) => a.startsWith("secretsmanager:")),
    );
    expect(secretStatements).toHaveLength(1);
    expect(secretStatements[0]?.actions).toEqual(["secretsmanager:GetSecretValue"]);
    expect(secretStatements[0]?.resources).toEqual([
      "arn:aws:secretsmanager:${var.region}:${data.aws_caller_identity.current.account_id}:secret:${each.value}-??????",
    ]);
    expect(code).toMatch(/valueFrom\s*=/);
    expect(code).not.toMatch(/secretsmanager_secret_version|secretsmanager_random_password/);
  });
  test("the task role reaches objects in the named buckets and nothing else", () => {
    const s3 = statements(code).filter((x) => x.actions.some((a) => a.startsWith("s3:")));
    expect(s3.flatMap((x) => x.actions).sort()).toEqual([
      "s3:DeleteObject",
      "s3:GetObject",
      "s3:ListBucket",
      "s3:PutObject",
    ]);
    for (const x of s3) {
      for (const r of x.resources) expect(r).toMatch(/^arn:aws:s3:::\$\{each\.value\}(\/\*)?$/);
    }
  });
  test("derives other resources' names the way their modules do", () => {
    expect(code).toContain('"${var.environment}-${d}-database-url"');
    expect(code).toContain(
      '"${var.environment}-${b}-${data.aws_caller_identity.current.account_id}"',
    );
  });
  test("lets a teardown delete it, and rolls a bad deploy back", () => {
    expect(code).toMatch(/enable_deletion_protection\s*=\s*false/);
    expect(code).toMatch(
      /deployment_circuit_breaker\s*{[^}]*enable\s*=\s*true[^}]*rollback\s*=\s*true/,
    );
    expect(code).toMatch(/force_delete\s*=\s*true|image_tag_mutability\s*=\s*"IMMUTABLE"/);
  });
  // CLD-6: a deploy registers a new task definition revision; without this the next apply puts the first one back
  test("leaves the task definition to deploys: the service ignores a change to it", () => {
    const service = resources(code).find(([id]) => id === "aws_ecs_service.this")?.[1] ?? "";
    expect(service).toMatch(/lifecycle\s*{\s*ignore_changes\s*=\s*\[\s*task_definition\s*\]\s*}/);
  });
});

describe("postgres, AWS", () => {
  const code = hcl("aws", "postgres");
  test("is private, encrypted, backed up and protected from deletion", () => {
    expect(code).toMatch(/publicly_accessible\s*=\s*false/);
    expect(code).toMatch(/storage_encrypted\s*=\s*true/);
    expect(code).toMatch(/^\s*deletion_protection\s*=\s*true/m);
    expect(code).toMatch(/backup_retention_period\s*=\s*[1-9]/);
    expect(code).toMatch(/skip_final_snapshot\s*=\s*false/);
    expect(code).not.toMatch(
      /publicly_accessible\s*=\s*true|storage_encrypted\s*=\s*false|deletion_protection\s*=\s*false/,
    );
  });
  test("sits in the network's private subnets and takes traffic from inside the VPC on 5432 only", () => {
    expect(code).toMatch(/Tier\s*=\s*"private"/);
    expect(code).toMatch(/Name\s*=\s*local\.network_name/);
    const rules = resources(code).filter(([id]) => id.includes("security_group_"));
    expect(rules.map(([id]) => id)).toEqual(["aws_vpc_security_group_ingress_rule.database"]);
    expect(rules[0]?.[1]).toMatch(/cidr_ipv4\s*=\s*data\.aws_vpc\.this\.cidr_block/);
    expect(rules[0]?.[1]).toMatch(/from_port\s*=\s*5432/);
    expect(rules[0]?.[1]).toMatch(/to_port\s*=\s*5432/);
  });
  test("refuses a connection without TLS", () => {
    expect(code).toMatch(/name\s*=\s*"rds\.force_ssl"[^}]*value\s*=\s*"1"/);
    expect(code).toMatch(/sslmode=require/);
  });
  test("writes the connection URL to the secret every service reads, and only there", () => {
    expect(code).toContain('"${var.environment}-${var.name}-database-url"');
    expect(code).toMatch(/aws_secretsmanager_secret_version/);
    expect(code).toMatch(/recovery_window_in_days\s*=\s*0/);
    expect([...code.matchAll(/random_password\.database\.result/g)].length).toBe(2);
    expect(code).not.toMatch(/manage_master_user_password/);
    const outputs = code.match(/output\s+"[^"]+"\s*{[^}]*}/g)?.join("\n") ?? "";
    expect(outputs).not.toMatch(/random_password|secret_version|secret_string|\.address|endpoint/);
  });
  test("generates a password that fits in a URL, and keeps none in a variable", () => {
    expect(code).toMatch(/special\s*=\s*false/);
    expect(code).not.toMatch(/variable\s+"[^"]*(password|secret)[^"]*"/);
  });
});

describe("bucket, AWS", () => {
  const code = hcl("aws", "bucket");
  test("blocks every kind of public access, and nothing can undo it with a policy or an ACL", () => {
    const block =
      /resource\s+"aws_s3_bucket_public_access_block"\s+"this"\s*{([^}]*)}/.exec(code)?.[1] ?? "";
    for (const key of [
      "block_public_acls",
      "block_public_policy",
      "ignore_public_acls",
      "restrict_public_buckets",
    ]) {
      expect([key, new RegExp(`${key}\\s*=\\s*true`).test(block)]).toEqual([key, true]);
    }
    expect(block).not.toMatch(/=\s*false/);
    expect(code).not.toMatch(/aws_s3_bucket_policy|aws_s3_bucket_acl|acl\s*=\s*"public/);
  });
  test("is encrypted, is not deleted while it holds objects, and versioning follows the input", () => {
    expect(code).toMatch(/aws_s3_bucket_server_side_encryption_configuration/);
    expect(code).toMatch(/sse_algorithm\s*=\s*"AES256"/);
    expect(code).toMatch(/force_destroy\s*=\s*false/);
    expect(code).toMatch(/aws_s3_bucket_versioning/);
    expect(code).toMatch(/count\s*=\s*var\.versioning\s*\?\s*1\s*:\s*0/);
  });
  test("is named the way a service derives its name", () => {
    expect(code).toContain(
      '"${var.environment}-${var.name}-${data.aws_caller_identity.current.account_id}"',
    );
  });
});

// CLD-3/4: the identity a forge's runner signs in as. The modules are read as text, like the others: what these
// tests pin is that the trust names one exact subject and the permissions name one service and one repository.
const SERVICE_ID = '"${var.environment}-${var.service}-service"';

describe("deploy identity, GCP", () => {
  const code = hcl("gcp", "deploy-identity");
  // the variables' own validation regexes hold the characters a pattern check looks for
  const main = hcl("gcp", "deploy-identity", "main.tf");
  const provider =
    resources(code).find(([id]) => id === "google_iam_workload_identity_pool_provider.this")?.[1] ??
    "";

  test("the provider has an attribute condition on the exact subject and the numeric ids, and no way to widen it", () => {
    expect(provider).toMatch(/attribute_condition\s*=\s*local\.condition/);
    const condition =
      /condition\s*=\s*local\.github \? join\(" && ", \[([\s\S]*?)\]\) : join\(" && ", \[([\s\S]*?)\]\)/.exec(
        code,
      );
    expect(condition).not.toBeNull();
    const [, github = "", gitlab = ""] = condition ?? [];
    const terms = (list: string) => [...list.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
    expect(terms(github)).toEqual([
      "assertion.sub == '${local.subject}'",
      "assertion.repository_id == '${var.repository_id}'",
      "assertion.repository_owner_id == '${var.owner_id}'",
    ]);
    expect(terms(gitlab)).toEqual([
      "assertion.sub == '${local.subject}'",
      "assertion.project_id == '${var.repository_id}'",
      "assertion.namespace_id == '${var.owner_id}'",
    ]);
    // no pattern, no alternative, no prefix
    expect(main).not.toMatch(/\|\||startsWith|endsWith|matches\(|contains\(|\*/);
  });
  test("the subject is built from the repository and the environment or branch, never a pattern", () => {
    expect(code).toContain('"repo:${var.repository}:environment:${var.environment}"');
    expect(code).toContain(
      '"repo:${local.owner}@${var.owner_id}/${local.repo}@${var.repository_id}:environment:${var.environment}"',
    );
    expect(code).toContain('"project_path:${var.repository}:ref_type:branch:ref:${var.branch}"');
  });
  test("the audience is Google's default, which is the provider's own address and what the template asks for", () => {
    expect(provider).not.toMatch(/allowed_audiences/);
    expect(provider).toMatch(/issuer_uri\s*=\s*local\.issuer/);
    expect(code).toContain('"https://token.actions.githubusercontent.com"');
    expect(code).toContain('"https://gitlab.com"');
  });
  test("is let in as that one subject, not as a set of identities", () => {
    const grant =
      resources(code).find(([id]) => id === "google_service_account_iam_member.federated")?.[1] ??
      "";
    expect(grant).toMatch(/role\s*=\s*"roles\/iam\.workloadIdentityUser"/);
    expect(grant).toContain(
      "principal://iam.googleapis.com/${google_iam_workload_identity_pool.this.name}/subject/${local.subject}",
    );
    expect(code).not.toMatch(/principalSet|allUsers|allAuthenticatedUsers/);
  });
  test("holds four roles, each on one thing, and none on the project, folder or organization", () => {
    expect(code).not.toMatch(/google_project_iam|google_organization_iam|google_folder_iam/);
    expect(code).not.toMatch(/roles\/(owner|editor|viewer)\b|\.admin\b|serviceAccountTokenCreator/);
    expect([...code.matchAll(/role\s*=\s*"([^"]+)"/g)].map((m) => m[1]).sort()).toEqual([
      "roles/artifactregistry.writer",
      "roles/iam.serviceAccountUser",
      "roles/iam.workloadIdentityUser",
      "roles/run.developer",
    ]);
    expect(
      resources(code)
        .map(([id]) => id)
        .filter((id) => /_iam_member\./.test(id))
        .sort(),
    ).toEqual([
      "google_artifact_registry_repository_iam_member.push",
      "google_cloud_run_v2_service_iam_member.deploy",
      "google_service_account_iam_member.federated",
      "google_service_account_iam_member.runtime",
    ]);
  });
  test("the service, its image repository and its runtime account are the ones named by `service`, derived as the service module does", () => {
    const find = (id: string) => resources(code).find(([x]) => x === id)?.[1] ?? "";
    expect(code).toContain(`service_id = ${SERVICE_ID}`);
    expect(find("google_cloud_run_v2_service_iam_member.deploy")).toMatch(
      /name\s*=\s*local\.service_id/,
    );
    expect(find("google_artifact_registry_repository_iam_member.push")).toMatch(
      /repository\s*=\s*local\.service_id/,
    );
    expect(find("google_service_account_iam_member.runtime")).toContain(
      "projects/${var.project}/serviceAccounts/${local.runtime_sa}",
    );
    expect(code).toContain(
      'runtime_sa = "${var.environment}-${var.service}-sa@${var.project}.iam.gserviceaccount.com"',
    );
    // the service module's own formulas: a rename there must fail here
    const service = hcl("gcp", "service");
    expect(service).toContain('id = "${var.environment}-${var.name}-service"');
    expect(service).toMatch(/repository_id\s*=\s*local\.id/);
    expect(service).toContain('account_id   = "${var.environment}-${var.name}-sa"');
  });
  test("its own names fit what Google caps: a pool id at 32 and an account id at 30", () => {
    expect(code).toContain("workload_identity_pool_id = local.id");
    expect(code).toContain('id = "${var.environment}-${var.name}-deploy"');
    expect(code).toContain('account_id   = "${var.environment}-${var.name}-dep"');
    expect(12 + 1 + 12 + "-deploy".length).toBeLessThanOrEqual(32);
    expect(12 + 1 + 12 + "-dep".length).toBeLessThanOrEqual(30);
  });
  test("the APIs it needs are enabled and left on when it is destroyed", () => {
    const apis = [...code.matchAll(/service\s*=\s*"([a-z]+\.googleapis\.com)"/g)]
      .map((m) => m[1])
      .sort();
    expect(apis).toEqual([
      "iam.googleapis.com",
      "iamcredentials.googleapis.com",
      "sts.googleapis.com",
    ]);
    expect([...code.matchAll(/disable_on_destroy\s*=\s*false/g)]).toHaveLength(3);
  });
});

describe("deploy identity, AWS", () => {
  const code = hcl("aws", "deploy-identity");
  const trust = /data\s+"aws_iam_policy_document"\s+"trust"\s*{([\s\S]*?)^}/m.exec(code)?.[1] ?? "";

  test("trusts the forge's provider for AssumeRoleWithWebIdentity, on the exact subject and the audience", () => {
    expect(trust).toMatch(/actions\s*=\s*\["sts:AssumeRoleWithWebIdentity"\]/);
    expect(trust).toMatch(/type\s*=\s*"Federated"/);
    expect(trust).toMatch(/identifiers\s*=\s*\[local\.provider_arn\]/);
    expect(trust).toMatch(
      /variable\s*=\s*"\$\{local\.issuer_host\}:aud"[\s\S]*?values\s*=\s*\["sts\.amazonaws\.com"\]/,
    );
    expect(trust).toMatch(
      /variable\s*=\s*"\$\{local\.issuer_host\}:sub"[\s\S]*?values\s*=\s*\[local\.subject\]/,
    );
  });
  test("every condition is an exact match: no StringLike, no wildcard, no other principal", () => {
    expect(trust).not.toMatch(/StringLike|ForAnyValue|ForAllValues|\*/);
    const tests = [...trust.matchAll(/test\s*=\s*"([^"]+)"/g)].map((m) => m[1]);
    expect(tests.length).toBeGreaterThanOrEqual(3);
    expect(new Set(tests)).toEqual(new Set(["StringEquals"]));
    expect([...trust.matchAll(/type\s*=\s*"([^"]+)"/g)].map((m) => m[1])).toEqual(["Federated"]);
  });
  test("pins the numeric ids on GitLab, whose provider takes them as condition keys", () => {
    expect(trust).toMatch(
      /for_each\s*=\s*local\.github \? {} : {\s*project_id\s*=\s*var\.repository_id\s*namespace_id\s*=\s*var\.owner_id\s*}/,
    );
    expect(trust).toMatch(/variable\s*=\s*"\$\{local\.issuer_host\}:\$\{condition\.key\}"/);
  });
  test("the subject is built from the repository and the environment or branch, never a pattern", () => {
    expect(code).toContain('"repo:${var.repository}:environment:${var.environment}"');
    expect(code).toContain(
      '"repo:${local.owner}@${var.owner_id}/${local.repo}@${var.repository_id}:environment:${var.environment}"',
    );
    expect(code).toContain('"project_path:${var.repository}:ref_type:branch:ref:${var.branch}"');
  });
  test("makes the OIDC provider for the issuer, or finds the one an earlier identity made", () => {
    expect(code).toMatch(
      /resource\s+"aws_iam_openid_connect_provider"\s+"this"\s*{[^}]*count\s*=\s*var\.existing_oidc_provider \? 0 : 1/,
    );
    expect(code).toMatch(
      /data\s+"aws_iam_openid_connect_provider"\s+"existing"\s*{[^}]*count\s*=\s*var\.existing_oidc_provider \? 1 : 0/,
    );
    expect(code).toMatch(/client_id_list\s*=\s*\["sts\.amazonaws\.com"\]/);
    expect(code).toContain('"token.actions.githubusercontent.com"');
    expect(code).toContain('"gitlab.com"');
  });
  test("no action has a star, and a star resource is only for what AWS cannot scope: the registry login and the task definition calls", () => {
    const all = statements(code).filter(
      (s) => !s.actions.includes("sts:AssumeRoleWithWebIdentity"),
    );
    expect(all.length).toBe(5);
    for (const s of all) {
      expect(s.actions.filter((a) => a.includes("*"))).toEqual([]);
      if (s.resources.includes("*")) {
        expect([s.actions]).toContainEqual(
          s.actions.length === 1
            ? ["ecr:GetAuthorizationToken"]
            : ["ecs:DescribeTaskDefinition", "ecs:RegisterTaskDefinition"],
        );
      }
    }
    expect(all.filter((s) => s.resources.includes("*")).map((s) => s.actions)).toEqual([
      ["ecr:GetAuthorizationToken"],
      ["ecs:DescribeTaskDefinition", "ecs:RegisterTaskDefinition"],
    ]);
    expect(code).not.toMatch(
      /AdministratorAccess|PowerUserAccess|aws_iam_role_policy_attachment|aws_iam_user|aws_iam_access_key|aws_iam_policy\b/,
    );
  });
  test("pushes to one repository and updates one service: the ones named by `service`, derived as the service module does", () => {
    const all = statements(code);
    const on = (action: string) => all.find((s) => s.actions.includes(action));
    expect(on("ecr:PutImage")?.actions).toEqual([
      "ecr:BatchCheckLayerAvailability",
      "ecr:CompleteLayerUpload",
      "ecr:DescribeImages",
      "ecr:InitiateLayerUpload",
      "ecr:PutImage",
      "ecr:UploadLayerPart",
    ]);
    expect(on("ecr:PutImage")?.resources).toEqual([
      "arn:aws:ecr:${var.region}:${local.account}:repository/${local.service_id}",
    ]);
    expect(on("ecs:UpdateService")?.actions).toEqual(["ecs:DescribeServices", "ecs:UpdateService"]);
    expect(on("ecs:UpdateService")?.resources).toEqual([
      "arn:aws:ecs:${var.region}:${local.account}:service/${local.service_id}/${local.service_id}",
    ]);
    expect(code).toContain(`service_id = ${SERVICE_ID}`);
    // the service module's own formulas: a rename there must fail here
    const service = hcl("aws", "service");
    expect(service).toContain('id = "${var.environment}-${var.name}-service"');
    expect(service).toMatch(/resource\s+"aws_ecs_cluster"\s+"this"\s*{\s*name\s*=\s*local\.id/);
    expect(service).toMatch(/resource\s+"aws_ecs_service"\s+"this"\s*{\s*name\s*=\s*local\.id/);
    expect(service).toMatch(/resource\s+"aws_ecr_repository"\s+"this"\s*{\s*name\s*=\s*local\.id/);
  });
  test("may pass the service's two roles to ECS and no others", () => {
    const pass = statements(code).find((s) => s.actions.includes("iam:PassRole"));
    expect(pass?.actions).toEqual(["iam:PassRole"]);
    expect(pass?.resources).toEqual([
      "arn:aws:iam::${local.account}:role/${local.service_id}-exec",
      "arn:aws:iam::${local.account}:role/${local.service_id}-task",
    ]);
    expect(code).toMatch(
      /variable\s*=\s*"iam:PassedToService"[\s\S]*?values\s*=\s*\["ecs-tasks\.amazonaws\.com"\]/,
    );
    const service = hcl("aws", "service");
    expect(service).toContain('name               = "${local.id}-exec"');
    expect(service).toContain('name               = "${local.id}-task"');
  });
  test("its own role is named for the identity and lasts as long as a deploy needs", () => {
    expect(code).toMatch(/resource\s+"aws_iam_role"\s+"this"\s*{\s*name\s*=\s*local\.id/);
    expect(code).toMatch(/\bid\s*=\s*"\$\{var\.environment\}-\$\{var\.name\}-deploy"/);
    expect(code).toMatch(/max_session_duration\s*=\s*3600/);
  });
});
