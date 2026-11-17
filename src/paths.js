import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The app folder (next to package.json), independent of the working directory. */
export const APP_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const CONFIG_FILE = join(APP_ROOT, "config.json");
export const STATE_FILE = join(APP_ROOT, "state.json");
