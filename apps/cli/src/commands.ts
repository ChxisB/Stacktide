import { authCommands } from "./auth";
import { ciCommands } from "./ci";
import type { Command } from "./cli";
import { varsCommands } from "./vars";

/** Every command of `orch`, by name. Each task of the CLI feature adds its own. */
export const commands: Record<string, Command> = {
  ...authCommands(),
  ...ciCommands(),
  ...varsCommands(),
};
