import { authCommands } from "./auth";
import { ciCommands } from "./ci";
import type { Command } from "./cli";
import { deployCommands } from "./deploy";
import { dnsCommands } from "./dns";
import { findingsCommands } from "./findings";
import { leaseCommands } from "./lease";
import { pipelineCommands } from "./pipeline";
import { poolCommands } from "./pool";
import { rotationCommands } from "./rotation";
import { stateCommands } from "./state";
import { syncCommands } from "./sync";
import { templateCommands } from "./template";
import { varsCommands } from "./vars";

/** Every command of `orch`, by name. Each task of the CLI feature adds its own. */
export const commands: Record<string, Command> = {
  ...authCommands(),
  ...ciCommands(),
  ...deployCommands(),
  ...dnsCommands(),
  ...findingsCommands(),
  ...leaseCommands(),
  ...pipelineCommands(),
  ...poolCommands(),
  ...stateCommands(),
  ...rotationCommands(),
  ...syncCommands(),
  ...templateCommands(),
  ...varsCommands(),
};
