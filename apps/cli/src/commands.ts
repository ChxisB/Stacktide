import type { Command } from "./cli";

/** Every command of `orch`, by name. Each task of the CLI feature adds its own. */
export const commands: Record<string, Command> = {};
