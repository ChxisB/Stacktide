import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { renderBlueprint } from "./blueprint-render";
import { CASES, input, othersOf } from "./fixtures/blueprint-cases";

/**
 * The opt-in Terraform check of what the renderer writes (BLP-12): every kind on both clouds is written to a
 * directory, and its stack is formatted (`fmt -check`), initialised without a backend and validated. That is the
 * only thing that proves `main.tf` names the module's variables and the module's path rightly. ORCH_E2E_TERRAFORM=1
 * turns it on (see blueprint-modules.e2e.test.ts); nothing is planned or applied and no credential is read.
 */
const on = process.env.ORCH_E2E_TERRAFORM === "1";

if (!on) {
  test.skip("terraform validate of rendered blueprints (set ORCH_E2E_TERRAFORM=1 to run it)", () => {});
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

  for (const which of Object.keys(CASES)) {
    test(`terraform fmt and validate: ${which}`, async () => {
      const r = renderBlueprint(input(which), "gitlab", "infra", othersOf(which));
      if (!r.ok) throw new Error(r.errors.join("; "));
      const work = await mkdtemp(join(tmpdir(), "orch-render-"));
      try {
        for (const f of r.files) {
          await mkdir(dirname(join(work, f.path)), { recursive: true });
          await writeFile(join(work, f.path), f.content);
        }
        const stack = join(work, r.dir);
        const fmt = await run(stack, ["fmt", "-check", "-diff"]);
        expect([fmt.code, fmt.out]).toEqual([0, ""]);
        const init = await run(stack, ["init", "-backend=false", "-input=false"]);
        expect([init.code, init.out.slice(-600)]).toEqual([0, init.out.slice(-600)]);
        const validate = await run(stack, ["validate"]);
        expect([validate.code, validate.out]).toEqual([0, validate.out]);
      } finally {
        await rm(work, { recursive: true, force: true });
      }
    }, 240_000);
  }
}
