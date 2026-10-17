#!/usr/bin/env bun
import { homedir } from "node:os";
import { createInterface } from "node:readline/promises";
import pkg from "../package.json" with { type: "json" };
import { CliError, runCli } from "./cli";
import { commands } from "./commands";
import { openCommand } from "./open";

process.exitCode = await runCli(process.argv.slice(2), {
  io: {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  },
  env: process.env,
  cwd: process.cwd(),
  home: homedir(),
  stdin: () => Bun.stdin.text(),
  open: async (url) => {
    await Bun.spawn([...openCommand(process.platform), url], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    }).exited;
  },
  confirm: async (question) => {
    if (!process.stdin.isTTY || !process.stderr.isTTY) {
      throw new CliError("cannot ask for confirmation without a terminal; pass --yes", 2);
    }
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    try {
      return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim());
    } finally {
      rl.close();
    }
  },
  version: pkg.version,
  commands,
});
