import { readFileSync, renameSync, writeFileSync } from "node:fs";

export function loadState(file) {
  try {
    const data = JSON.parse(readFileSync(file, "utf-8").replace(/^\uFEFF/, ""));
    return { soundEnabled: data?.soundEnabled !== false };
  } catch {
    return { soundEnabled: true };
  }
}

export function saveState(file, state) {
  const temp = `${file}.tmp`;
  writeFileSync(temp, JSON.stringify({ soundEnabled: state.soundEnabled }, null, 2) + "\n", "utf-8");
  renameSync(temp, file);
}
