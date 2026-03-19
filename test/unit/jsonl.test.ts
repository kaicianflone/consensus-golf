import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { appendJsonl, readJsonl } from "../../src/persistence/jsonl.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jsonl-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("appendJsonl / readJsonl", () => {
  it("appends and reads back entries", () => {
    const file = path.join(tmpDir, "entries.jsonl");
    appendJsonl(file, { id: 1, value: "hello" });
    appendJsonl(file, { id: 2, value: "world" });

    const entries = readJsonl<{ id: number; value: string }>(file);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({ id: 1, value: "hello" });
    expect(entries[1]).toEqual({ id: 2, value: "world" });
  });

  it("returns empty array for nonexistent file", () => {
    const file = path.join(tmpDir, "nonexistent.jsonl");
    const entries = readJsonl(file);
    expect(entries).toEqual([]);
  });

  it("skips corrupt lines and warns", () => {
    const file = path.join(tmpDir, "mixed.jsonl");
    fs.writeFileSync(file, `{"valid":1}\nnot-json\n{"valid":2}\n`, "utf8");

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const entries = readJsonl<{ valid: number }>(file);

    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({ valid: 1 });
    expect(entries[1]).toEqual({ valid: 2 });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toMatch(/skipping corrupt line/);

    warnSpy.mockRestore();
  });

  it("handles empty file", () => {
    const file = path.join(tmpDir, "empty.jsonl");
    fs.writeFileSync(file, "", "utf8");
    const entries = readJsonl(file);
    expect(entries).toEqual([]);
  });
});
