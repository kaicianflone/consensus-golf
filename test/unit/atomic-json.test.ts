import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { writeAtomicJson, readAtomicJson } from "../../src/persistence/atomic-json.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-json-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("writeAtomicJson / readAtomicJson", () => {
  it("writes and reads back JSON", () => {
    const file = path.join(tmpDir, "data.json");
    writeAtomicJson(file, { name: "test", count: 42 });

    const result = readAtomicJson<{ name: string; count: number }>(file);
    expect(result).toEqual({ name: "test", count: 42 });
  });

  it("creates .bak on second write containing first version", () => {
    const file = path.join(tmpDir, "data.json");
    writeAtomicJson(file, { version: 1 });
    writeAtomicJson(file, { version: 2 });

    const bakPath = file + ".bak";
    expect(fs.existsSync(bakPath)).toBe(true);

    const bakContent = JSON.parse(fs.readFileSync(bakPath, "utf8"));
    expect(bakContent).toEqual({ version: 1 });

    const current = readAtomicJson<{ version: number }>(file);
    expect(current).toEqual({ version: 2 });
  });

  it("falls back to .bak if main file is corrupt", () => {
    const file = path.join(tmpDir, "data.json");
    writeAtomicJson(file, { value: "original" });
    writeAtomicJson(file, { value: "second" });

    // Corrupt the main file
    fs.writeFileSync(file, "not-valid-json", "utf8");

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = readAtomicJson<{ value: string }>(file);
    expect(result).toEqual({ value: "original" });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toMatch(/corrupt/);

    warnSpy.mockRestore();
  });

  it("returns null if file does not exist", () => {
    const file = path.join(tmpDir, "nonexistent.json");
    const result = readAtomicJson(file);
    expect(result).toBeNull();
  });

  it("throws if both main and .bak are corrupt", () => {
    const file = path.join(tmpDir, "data.json");
    writeAtomicJson(file, { value: "original" });
    writeAtomicJson(file, { value: "second" });

    // Corrupt both files
    fs.writeFileSync(file, "bad-json", "utf8");
    fs.writeFileSync(file + ".bak", "also-bad-json", "utf8");

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(() => readAtomicJson(file)).toThrow(/corrupt/);

    warnSpy.mockRestore();
  });
});
