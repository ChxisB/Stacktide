import { expect, test } from "bun:test";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listModules } from "./blueprint-modules";

/**
 * The opt-in `terraform validate` of every shipped module (BLP-4..11), each in a copy of its own so no `.terraform`
 * lands in the repository. Setting ORCH_E2E_TERRAFORM=1 turns it on; the binary is TERRAFORM_BIN or `terraform` on
 * the path. `terraform init` downloads the pinned providers from the registry (set TF_PLUGIN_CACHE_DIR to keep them
 * between runs). Nothing is planned or applied and no cloud credential is read: validate checks the arguments the
 * provider schemas know, which is what the modules were written without being able to try.
 */
const on = process.env.ORCH_E2E_TERRAFORM === "1";

if (!on) {
  test.skip("terraform validate of the shipped modules (set ORCH_E2E_TERRAFORM=1 to run it)", () => {});
} else {
  const bin = process.env.TERRAFORM_BIN || Bun.which("terraform");
  if (!bin) throw new Error("ORCH_E2E_TERRAFORM=1 needs terraform (or TERRAFORM_BIN)");

  const run = async (cwd: string, args: string[]) => {
    const p = Bun.spawn([bin, ...args, "-no-color"], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    });
    const [out, err, code] = await Promise.all([p.stdout.text(), p.stderr.text(), p.exited]);
    return { out: out + err, code };
  };

  for (const { cloud, kind, dir } of listModules()) {
    test(`terraform validate: ${cloud}/${kind}`, async () => {
      const work = await mkdtemp(join(tmpdir(), "orch-blueprint-"));
      try {
        await cp(dir, work, { recursive: true });
        const init = await run(work, ["init", "-backend=false", "-input=false"]);
        expect([init.code, init.out.slice(-600)]).toEqual([0, init.out.slice(-600)]);
        const validate = await run(work, ["validate"]);
        expect([validate.code, validate.out]).toEqual([0, validate.out]);
      } finally {
        await rm(work, { recursive: true, force: true });
      }
    }, 240_000);
  }
}
