import { describe, expect, it } from "vitest";
import { parseIndexArgs, USAGE } from "./indexArgs.js";
import { INDEX_STORE_DEFAULTS } from "./indexStore.js";

// No database and no server: the whole point of splitting this out of cli.ts is that flag
// parsing is the only part of the entry point testable without infrastructure.

function options(argv: string[]) {
  const parsed = parseIndexArgs(argv);
  if (!parsed.ok) throw new Error(`expected a successful parse, got: ${parsed.message}`);
  return parsed.options;
}

describe("parseIndexArgs", () => {
  it("defaults every knob when given no flags", () => {
    expect(options([])).toEqual({
      help: false,
      dryRun: false,
      readBatchSize: INDEX_STORE_DEFAULTS.readBatchSize,
      writeBatchSize: INDEX_STORE_DEFAULTS.writeBatchSize,
    });
  });

  it("reads --dry-run", () => {
    expect(options(["--dry-run"]).dryRun).toBe(true);
  });

  it("coerces batch sizes to numbers", () => {
    const parsed = options(["--read-batch", "50", "--write-batch", "100"]);

    expect(parsed.readBatchSize).toBe(50);
    expect(parsed.writeBatchSize).toBe(100);
  });

  // The reason zod is here at all: parseArgs hands back the raw string, so without it
  // `--read-batch abc` becomes NaN and surfaces as an empty LIMIT clause much later.
  it("rejects a non-numeric batch size", () => {
    const parsed = parseIndexArgs(["--read-batch", "abc"]);

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.message).toContain("read-batch");
  });

  it("rejects batch sizes outside their bounds", () => {
    expect(parseIndexArgs(["--read-batch", "0"]).ok).toBe(false);
    expect(parseIndexArgs(["--read-batch", "-5"]).ok).toBe(false);
    // A read batch this large pulls the whole corpus's prose into one array, which is
    // exactly what streaming exists to avoid.
    expect(parseIndexArgs(["--read-batch", "100000"]).ok).toBe(false);
    expect(parseIndexArgs(["--write-batch", "100000"]).ok).toBe(false);
  });

  // strict parsing: a rebuild that silently ran with the default the user thought they had
  // overridden is expensive to notice and expensive to repeat.
  it("rejects an unknown flag rather than ignoring it", () => {
    const parsed = parseIndexArgs(["--batch", "500"]);

    expect(parsed.ok).toBe(false);
  });

  it("rejects positional arguments", () => {
    expect(parseIndexArgs(["documents"]).ok).toBe(false);
  });

  it("answers --help before validating anything else", () => {
    const parsed = options(["--help", "--read-batch", "nonsense"]);

    expect(parsed.help).toBe(true);
  });

  it("documents the defaults it actually uses", () => {
    expect(USAGE).toContain(String(INDEX_STORE_DEFAULTS.readBatchSize));
    expect(USAGE).toContain(String(INDEX_STORE_DEFAULTS.writeBatchSize));
  });
});
