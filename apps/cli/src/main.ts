#!/usr/bin/env bun
import { homedir } from "node:os";
import pkg from "../package.json" with { type: "json" };
import { runCli } from "./cli";
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
  version: pkg.version,
  commands,
});
