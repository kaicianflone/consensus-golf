import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export function writeAtomicJson(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  if (fs.existsSync(filePath)) {
    fs.copyFileSync(filePath, filePath + ".bak");
  }

  const tmp = path.join(os.tmpdir(), `atomic-json-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmp, filePath);
}

export function readAtomicJson<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  const content = fs.readFileSync(filePath, "utf8");
  try {
    return JSON.parse(content) as T;
  } catch {
    console.warn(`atomic-json: main file corrupt at ${filePath}, trying .bak`);
  }

  const bakPath = filePath + ".bak";
  if (!fs.existsSync(bakPath)) {
    throw new Error(`atomic-json: corrupt file and no .bak available at ${filePath}`);
  }

  const bakContent = fs.readFileSync(bakPath, "utf8");
  try {
    return JSON.parse(bakContent) as T;
  } catch {
    throw new Error(`atomic-json: corrupt main and corrupt .bak at ${filePath}`);
  }
}
