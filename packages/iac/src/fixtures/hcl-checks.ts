/** The plain-text checks over a shipped module's Terraform, shared by the module tests and the defaults test. */
import { readModule } from "../blueprint-modules";

/** A module's Terraform with the comments taken out, so a rule written in a comment is not read as code. */
export const hcl = (cloud: string, kind: string): string =>
  readModule(cloud, kind)
    .filter((f) => f.name.endsWith(".tf"))
    .map((f) => f.content)
    .join("\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*(#|\/\/).*$/gm, "")
    .replace(/\s#.*$/gm, "");

/** The top-level resources of a module, as `[type.name, text]`. */
export const resources = (code: string): [string, string][] =>
  code
    .split(/^(?=resource\s+")/m)
    .filter((chunk) => /^resource\s+"/.test(chunk))
    .map((chunk) => {
      const [, type, name] = /^resource\s+"([^"]+)"\s+"([^"]+)"/.exec(chunk) ?? [];
      return [`${type}.${name}`, chunk];
    });

/** True when a resource exists only while `var.public` is on. */
export const onlyWhenPublic = (chunk: string) =>
  /count\s*=\s*var\.public\s*\?\s*1\s*:\s*0/.test(chunk);

/**
 * The resources that name the whole internet as a source. A route and an egress rule are not doors (they say
 * where outbound traffic may go). A public service's load balancer rule is one, and only when it is switched on
 * by `var.public` and is HTTPS.
 */
export const worldOpen = (code: string): string[] =>
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
export const statements = (code: string) =>
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
export const publicGrants = (code: string): string[] =>
  resources(code)
    .filter(([, chunk]) => /allUsers|allAuthenticatedUsers/.test(chunk))
    .filter(([, chunk]) => !onlyWhenPublic(chunk))
    .map(([id]) => id);
