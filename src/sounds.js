import { readdirSync } from "node:fs";
import { join } from "node:path";

export const SOUND_CATEGORIES = Object.freeze(["fail", "done", "ask", "waiting60s"]);

export function pickRandomWav(dir, random = Math.random) {
  let names;
  try {
    names = readdirSync(dir, { withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith(".wav"))
      .map(entry => entry.name)
      .sort();
  } catch {
    return null;
  }
  if (names.length === 0) return null;
  return join(dir, names[Math.floor(random() * names.length)]);
}
