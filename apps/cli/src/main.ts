#!/usr/bin/env bun
import pkg from "../package.json" with { type: "json" };
import { runCli } from "./cli";
import { commands } from "./commands";

process.exitCode = await runCli(process.argv.slice(2), {
  io: {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  },
  env: process.env,
  cwd: process.cwd(),
  version: pkg.version,
  commands,
});
