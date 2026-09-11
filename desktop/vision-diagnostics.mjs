import { mkdir, lstat, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { atomicJson } from "./storage.mjs";

export async function saveVisionDiagnostic(directory, record) {
  if (!/^[0-9a-f-]{36}$/.test(record.id)) throw Error("Invalid diagnostic ID");
  await mkdir(directory, { recursive: true });
  if ((await lstat(directory)).isSymbolicLink()) throw Error("Diagnostic directory must not be a link");
  await atomicJson(join(directory, `${record.id}.json`), record);
  const files = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    if (item.isFile() && /^[0-9a-f-]{36}\.json$/.test(item.name)) files.push({ name: item.name, time: (await lstat(join(directory, item.name))).mtimeMs });
  }
  files.sort((a, b) => b.time - a.time);
  for (const item of files.slice(100)) await rm(join(directory, item.name));
}
