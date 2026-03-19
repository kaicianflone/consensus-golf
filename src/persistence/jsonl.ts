import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export function appendJsonl(filePath: string, entry: unknown): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  const newLine = JSON.stringify(entry) + "\n";
  let existing = "";
  if (fs.existsSync(filePath)) {
    existing = fs.readFileSync(filePath, "utf8");
  }

  const combined = existing + newLine;
  const tmp = path.join(os.tmpdir(), `jsonl-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
  fs.writeFileSync(tmp, combined, "utf8");
  fs.renameSync(tmp, filePath);
}

export function readJsonl<T>(filePath: string): T[] {
  if (!fs.existsSync(filePath)) {
    return [];
  }

  const content = fs.readFileSync(filePath, "utf8");
  if (!content.trim()) {
    return [];
  }

  const lines = content.split("\n");
  const results: T[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    try {
      results.push(JSON.parse(line) as T);
    } catch {
      console.warn(`jsonl: skipping corrupt line ${i + 1} in ${filePath}`);
    }
  }

  return results;
}
