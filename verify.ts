// verify.ts — self-check for the token-radar-01 entry.
//
// What it does:
//   1. Runs main.ts twice into two fresh temporary output directories, using
//      the sealed DefiLlama snapshot as input.
//   2. Verifies the two runs are byte-identical (determinism).
//   3. Checks the seven gate rows the entry is graded on, against the
//      generated outputs:
//        - exactly 178 board rows;
//        - ranks exactly 1..178 in order down the board;
//        - implied values strictly non-increasing down the board and all
//          178 distinct (rank 1 is $597,999,688, rank 178 is $727,032);
//        - all 40 watchlist slugs present in the board;
//        - every board slug exists in the sealed snapshot (758 protocols);
//        - every row's farm plan has 3-12 steps, each step 20-600 chars, and
//          every implied value a positive safe integer;
//        - the dashboard files contain zero external http(s) references and
//          no fetch/XHR calls.
//   4. Runs extra consistency checks of its own: snapshot integrity, the
//      dossier shape, the data.js payload against board.json, the live
//      protocols set aside, and a from-spec recomputation of the model
//      (radar-2, as described in README.md) for every row.
//
// How to run:
//   node verify.ts            (from anywhere; the script locates the entry
//                              from its own file path)
//
// Exit code: 0 when every check passes, 1 otherwise. On success the two
// temporary output directories are removed; on failure they are left in
// place and their paths are printed so the outputs can be inspected.
//
// Scope note: this script only reads data — the sealed snapshot and the
// files main.ts itself writes into the temporary output directories — and
// it runs main.ts as a subprocess. It never reads the entry's own source
// files. The dashboard scan below reads the dashboard copies main.ts wrote
// into the temporary output directory, i.e. generated output, not source.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { homedir, tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NODE_BIN =
  "/home/hatch/workspace/makefun/.local/node-v22.23.5-linux-x64/bin/node";
const ENTRY_ROOT = path.dirname(fileURLToPath(import.meta.url));
const MAIN_TS = path.join(ENTRY_ROOT, "main.ts");

// The sealed snapshot: prefer the v18 kit, fall back to the original kit.
const SNAPSHOT_CANDIDATES: string[] = [
  path.join(
    homedir(),
    "workspace/makefun/kits/token-radar-01-kit-v18/token-radar-01-kit/input/snapshot.json",
  ),
  path.join(
    homedir(),
    "workspace/makefun/kits/token-radar-01-kit/token-radar-01-kit/input/snapshot.json",
  ),
];

// Reference values for this entry, from the verified board and the snapshot.
const EXPECTED = {
  protocols: 758,
  watchlist: 40,
  boardRows: 178,
  earlyRows: 138,
  liveRows: 24,
  floorUsd: 50_000_000,
  rank1ImpliedUsd: 597_999_688,
  rank178ImpliedUsd: 727_032,
  modelVersion: "radar-2",
  baseMultiple: 0.25,
  dossierSchema: "makefun/dossier/v1",
  dossierImages: 3,
};

// Model parameters (radar-2), as described in README.md:
//   implied = round(tvl_usd * 0.25 * growth * maturity * chains)
//   growth    = 1 + 0.5 * clamp(change_7d, -60, +120) / 100
//   maturity  = 0.6 + 0.4 * min(age_days, 1095) / 1095   (365 when unknown)
//   chains    = 1 + 0.02 * min(chains - 1, 5)
const MODEL = {
  baseMultiple: 0.25,
  growthWeight: 0.5,
  growthFloor: -60,
  growthCap: 120,
  maturityFloor: 0.6,
  maturityRange: 0.4,
  maturityDays: 1095,
  unknownAgeDays: 365,
  chainStep: 0.02,
  chainCap: 5,
};

// Files whose bytes must be identical across the two runs.
const DETERMINISM_FILES = ["board.json", "data.js", "dossier.json"];

// Dashboard files (copies written by main.ts into the output directory)
// that must contain no external network reference and no network call.
const DASHBOARD_FILES = [
  "dashboard/index.html",
  "dashboard/app.js",
  "dashboard/app.css",
];

// ---------------------------------------------------------------------------
// Types for the data this script reads (snapshot + generated outputs only)
// ---------------------------------------------------------------------------

interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

interface BoardModel {
  base_multiple: number;
  growth_pct: number | null;
  growth_multiplier: number;
  maturity_multiplier: number;
  chain_multiplier: number;
  age_days: number | null;
}

interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: string;
  age_days: number | null;
  implied_value_usd: number;
  model: BoardModel;
  farm_steps: string[];
}

interface BoardFile {
  rows: BoardRow[];
}

interface DataRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  growth_multiplier: number;
  maturity_multiplier: number;
  chain_multiplier: number;
}

interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

interface RadarPayload {
  as_of: string;
  source: string;
  floor_usd: number;
  model: Record<string, number>;
  model_version: string;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  above_floor_left_out: number;
  excluded_below: Record<string, number>;
  rows: DataRow[];
  live: LiveRow[];
}

interface DossierFile {
  cover: number;
  images: unknown[];
  schema: string;
  text: string;
}

interface CheckResult {
  name: string;
  passed: boolean;
  details: string[];
}

interface TextMatch {
  line: number;
  column: number;
  text: string;
}

interface NetworkFinding {
  file: string;
  line: number;
  kind: string;
  text: string;
}

// ---------------------------------------------------------------------------
// Check framework: each check prints PASS/FAIL as it runs and is collected
// for the final summary. A check fails when it calls fail() or throws.
// ---------------------------------------------------------------------------

const results: CheckResult[] = [];

type FailFn = (message: string) => void;
type NoteFn = (message: string) => void;

function check(
  name: string,
  fn: (fail: FailFn, note: NoteFn) => void,
): void {
  const details: string[] = [];
  let failed = false;
  const fail: FailFn = (message) => {
    failed = true;
    details.push(`  FAIL: ${message}`);
  };
  const note: NoteFn = (message) => {
    details.push(`  ${message}`);
  };
  try {
    fn(fail, note);
  } catch (err) {
    failed = true;
    details.push(
      `  FAIL: threw ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  results.push({ name, passed: !failed, details });
  console.log(`${failed ? "FAIL" : "PASS"}  ${name}`);
  for (const line of details) {
    console.log(line);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha256File(filePath: string): string {
  const hash = createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

function usd(n: number): string {
  return `$${n.toLocaleString("en-US")}`;
}

function resolveSnapshot(): string {
  for (const candidate of SNAPSHOT_CANDIDATES) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(
    `snapshot.json not found in either kit input directory: ${SNAPSHOT_CANDIDATES.join(", ")}`,
  );
}

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runMain(outDir: string, snapshotPath: string): RunResult {
  const res = spawnSync(NODE_BIN, ["main.ts", "--input", snapshotPath], {
    cwd: ENTRY_ROOT,
    env: { ...process.env, MAKEFUN_OUTPUT_DIR: outDir },
    encoding: "utf8",
    timeout: 180_000,
  });
  if (res.error) {
    throw new Error(`failed to run main.ts: ${res.error.message}`);
  }
  return {
    status: res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

// data.js is `window.RADAR=<json>;` — strip the wrapper and parse the payload.
function parseRadarDataJs(filePath: string): RadarPayload {
  const text = fs.readFileSync(filePath, "utf8");
  const prefix = "window.RADAR=";
  if (!text.startsWith(prefix)) {
    throw new Error(`data.js does not start with ${prefix}`);
  }
  const jsonText = text.slice(prefix.length).replace(/;\s*$/, "");
  return JSON.parse(jsonText) as RadarPayload;
}

// Find every match of a global regex, with 1-based line and column numbers.
function findMatches(text: string, pattern: RegExp): TextMatch[] {
  const matches: TextMatch[] = [];
  pattern.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(text)) !== null) {
    const before = text.slice(0, m.index);
    const line = before.split("\n").length;
    const lastNewline = before.lastIndexOf("\n");
    const column = m.index - lastNewline;
    matches.push({ line, column, text: m[0] });
    // Guard against zero-length matches looping forever.
    if (m[0].length === 0) {
      pattern.lastIndex += 1;
    }
  }
  return matches;
}

// --- Model recomputation, from the README description (radar-2). ----------

function growthMultiplier(change7d: number | null): number {
  const clamped = Math.max(
    MODEL.growthFloor,
    Math.min(MODEL.growthCap, change7d ?? 0),
  );
  return 1 + MODEL.growthWeight * (clamped / 100);
}

function maturityMultiplier(ageDays: number | null): number {
  const age = ageDays ?? MODEL.unknownAgeDays;
  return (
    MODEL.maturityFloor +
    MODEL.maturityRange * (Math.min(age, MODEL.maturityDays) / MODEL.maturityDays)
  );
}

function chainMultiplier(chainCount: number): number {
  return (
    1 + MODEL.chainStep * Math.min(Math.max(chainCount - 1, 0), MODEL.chainCap)
  );
}

function impliedValue(
  tvlUsd: number,
  change7d: number | null,
  ageDays: number | null,
  chainCount: number,
): number {
  return Math.round(
    tvlUsd *
      MODEL.baseMultiple *
      growthMultiplier(change7d) *
      maturityMultiplier(ageDays) *
      chainMultiplier(chainCount),
  );
}

// --- Dashboard network scan -------------------------------------------------

const URL_PATTERN = /https?:\/\/[^\s"'<>)\]]+/g;

// Network-call tokens: fetch/XHR plus the other browser network APIs.
const NETWORK_CALL_PATTERNS: Array<[RegExp, string]> = [
  [/\bfetch\s*\(/g, "fetch()"],
  [/XMLHttpRequest/g, "XMLHttpRequest"],
  [/\bWebSocket\s*\(/g, "WebSocket()"],
  [/\bEventSource\s*\(/g, "EventSource()"],
  [/sendBeacon\s*\(/g, "sendBeacon()"],
  [/\$\.ajax\s*\(/g, "$.ajax()"],
];

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

function scanDashboardFile(
  relPath: string,
  absPath: string,
  findings: NetworkFinding[],
): { bytes: number; lines: number } {
  const text = fs.readFileSync(absPath, "utf8");

  for (const match of findMatches(text, URL_PATTERN)) {
    const cleaned = match.text.replace(/[.,;]+$/, "");
    let host = "?";
    try {
      host = new URL(cleaned).hostname;
    } catch {
      host = "?";
    }
    findings.push({
      file: relPath,
      line: match.line,
      kind: LOCAL_HOSTS.has(host) ? "local-url" : "external-url",
      text: cleaned.slice(0, 120),
    });
  }

  for (const [pattern, kind] of NETWORK_CALL_PATTERNS) {
    for (const match of findMatches(text, pattern)) {
      findings.push({
        file: relPath,
        line: match.line,
        kind,
        text: match.text,
      });
    }
  }

  // Protocol-relative src/href (//host/...) is an external reference too.
  for (const match of findMatches(text, /(?:src|href)\s*=\s*["']\/\//g)) {
    findings.push({
      file: relPath,
      line: match.line,
      kind: "protocol-relative-url",
      text: match.text.slice(0, 120),
    });
  }

  return { bytes: Buffer.byteLength(text, "utf8"), lines: text.split("\n").length };
}

// ---------------------------------------------------------------------------
// Main flow
// ---------------------------------------------------------------------------

function main(): number {
  console.log("token-radar verify: self-check for the token-radar-01 entry");
  console.log(`entry root: ${ENTRY_ROOT}`);
  console.log(`node: ${NODE_BIN}`);

  // --- Snapshot ------------------------------------------------------------
  let snapshotPath: string;
  try {
    snapshotPath = resolveSnapshot();
  } catch (err) {
    console.log(
      `FAIL  snapshot: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }
  console.log(`snapshot: ${snapshotPath}`);
  const snapshot = readJson<Snapshot>(snapshotPath);
  const snapshotBySlug = new Map(
    snapshot.protocols.map((p) => [p.slug, p]),
  );

  check("snapshot integrity (758 protocols, 40 watchlist, $50M floor)", (fail, note) => {
    if (snapshot.protocols.length !== EXPECTED.protocols) {
      fail(
        `protocols: expected ${EXPECTED.protocols}, got ${snapshot.protocols.length}`,
      );
    }
    if (snapshot.watchlist.length !== EXPECTED.watchlist) {
      fail(
        `watchlist: expected ${EXPECTED.watchlist}, got ${snapshot.watchlist.length}`,
      );
    }
    if (snapshot.floor_usd !== EXPECTED.floorUsd) {
      fail(
        `floor_usd: expected ${EXPECTED.floorUsd}, got ${snapshot.floor_usd}`,
      );
    }
    const slugs = new Set<string>();
    let duplicates = 0;
    for (const p of snapshot.protocols) {
      if (slugs.has(p.slug)) duplicates += 1;
      slugs.add(p.slug);
    }
    if (duplicates > 0) {
      fail(`snapshot has ${duplicates} duplicate protocol slug(s)`);
    }
    const missingWatchlist = snapshot.watchlist.filter((s) => !slugs.has(s));
    if (missingWatchlist.length > 0) {
      fail(
        `watchlist slugs missing from protocols: ${missingWatchlist.join(", ")}`,
      );
    }
    if (!snapshot.as_of || !snapshot.source) {
      fail("snapshot is missing as_of or source");
    }
    note(
      `snapshot: ${snapshot.protocols.length} protocols, ` +
        `${snapshot.watchlist.length} watchlist slugs, floor ${usd(snapshot.floor_usd)}, ` +
        `as_of ${snapshot.as_of}`,
    );
  });

  // --- Run main.ts twice ----------------------------------------------------
  const dirA = fs.mkdtempSync(path.join(tmpdir(), "token-radar-verify-a-"));
  const dirB = fs.mkdtempSync(path.join(tmpdir(), "token-radar-verify-b-"));
  console.log(`run A output dir: ${dirA}`);
  console.log(`run B output dir: ${dirB}`);

  let runA: RunResult;
  let runB: RunResult;
  try {
    runA = runMain(dirA, snapshotPath);
    runB = runMain(dirB, snapshotPath);
  } catch (err) {
    console.log(
      `FAIL  run main.ts twice: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }

  check("main.ts runs twice, exit 0, 178 rows scored", (fail, note) => {
    for (const [label, run] of [
      ["A", runA],
      ["B", runB],
    ] as const) {
      if (run.status !== 0) {
        fail(`run ${label} exited with status ${run.status}`);
        if (run.stderr) {
          fail(`run ${label} stderr (tail): ${run.stderr.trim().slice(-500)}`);
        }
        continue;
      }
      const firstLine = run.stdout.trim().split("\n")[0] ?? "";
      if (!firstLine.includes("178 rows scored")) {
        fail(`run ${label} stdout does not report 178 rows scored: ${firstLine}`);
      } else {
        note(`run ${label}: ${firstLine}`);
      }
    }
  });

  // --- Determinism ----------------------------------------------------------
  const hashesA = new Map<string, string>();
  const hashesB = new Map<string, string>();
  check("determinism: board.json, data.js, dossier.json byte-identical", (fail, note) => {
    for (const file of DETERMINISM_FILES) {
      const fileA = path.join(dirA, file);
      const fileB = path.join(dirB, file);
      if (!fs.existsSync(fileA)) {
        fail(`run A did not write ${file}`);
        continue;
      }
      if (!fs.existsSync(fileB)) {
        fail(`run B did not write ${file}`);
        continue;
      }
      const hashA = sha256File(fileA);
      const hashB = sha256File(fileB);
      hashesA.set(file, hashA);
      hashesB.set(file, hashB);
      if (hashA !== hashB) {
        fail(`${file} differs between runs:\n  A: ${hashA}\n  B: ${hashB}`);
      } else {
        note(`${file}: sha256 ${hashA.slice(0, 16)}... (identical in both runs)`);
      }
    }
  });

  // --- Read the generated outputs of run A ----------------------------------
  let board: BoardFile | null = null;
  let radar: RadarPayload | null = null;
  let dossier: DossierFile | null = null;
  try {
    board = readJson<BoardFile>(path.join(dirA, "board.json"));
  } catch (err) {
    console.log(
      `FAIL  read board.json: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  try {
    radar = parseRadarDataJs(path.join(dirA, "data.js"));
  } catch (err) {
    console.log(
      `FAIL  read data.js: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  try {
    dossier = readJson<DossierFile>(path.join(dirA, "dossier.json"));
  } catch (err) {
    console.log(
      `FAIL  read dossier.json: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const rows: BoardRow[] = board?.rows ?? [];
  const boardSlugs = new Set(rows.map((r) => r.slug));

  // --- Gate 1: exactly 178 board rows ---------------------------------------
  check("gate 1: exactly 178 board rows", (fail, note) => {
    if (!board) {
      fail("board.json could not be read");
      return;
    }
    if (!Array.isArray(board.rows)) {
      fail("board.json has no rows array");
      return;
    }
    if (board.rows.length !== EXPECTED.boardRows) {
      fail(`rows: expected ${EXPECTED.boardRows}, got ${board.rows.length}`);
    }
    note(`rows: ${board.rows.length}`);
  });

  // --- Gate 2: ranks exactly 1..178 in order --------------------------------
  check("gate 2: ranks exactly 1..178 in order down the board", (fail, note) => {
    if (rows.length === 0) {
      fail("no rows to check");
      return;
    }
    const bad: string[] = [];
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].rank !== i + 1) {
        bad.push(`position ${i + 1} has rank ${rows[i].rank} (${rows[i].slug})`);
      }
    }
    if (bad.length > 0) {
      fail(`${bad.length} rank error(s), first: ${bad.slice(0, 5).join("; ")}`);
    }
    note(`ranks 1..${rows.length} in order, first ${rows[0].slug}, last ${rows[rows.length - 1].slug}`);
  });

  // --- Gate 3: implied values strictly decreasing, distinct, endpoints -----
  check("gate 3: implied values strictly decreasing, all distinct, endpoints $597,999,688 / $727,032", (fail, note) => {
    if (rows.length === 0) {
      fail("no rows to check");
      return;
    }
    const values = rows.map((r) => r.implied_value_usd);
    const distinct = new Set(values);
    if (distinct.size !== values.length) {
      fail(`implied values: ${values.length - distinct.size} duplicate(s)`);
    }
    const rises: string[] = [];
    for (let i = 1; i < rows.length; i++) {
      if (values[i] >= values[i - 1]) {
        rises.push(
          `rank ${rows[i].rank} (${rows[i].slug}) ${usd(values[i])} is not below rank ${rows[i - 1].rank} ${usd(values[i - 1])}`,
        );
      }
    }
    if (rises.length > 0) {
      fail(`not strictly decreasing at ${rises.length} place(s), first: ${rises.slice(0, 3).join("; ")}`);
    }
    if (values[0] !== EXPECTED.rank1ImpliedUsd) {
      fail(
        `rank 1 implied value: expected ${usd(EXPECTED.rank1ImpliedUsd)}, got ${usd(values[0])}`,
      );
    }
    if (values[values.length - 1] !== EXPECTED.rank178ImpliedUsd) {
      fail(
        `rank 178 implied value: expected ${usd(EXPECTED.rank178ImpliedUsd)}, got ${usd(values[values.length - 1])}`,
      );
    }
    note(
      `rank 1 ${rows[0].slug} ${usd(values[0])} down to rank ${rows.length} ${rows[rows.length - 1].slug} ${usd(values[values.length - 1])}, ${distinct.size} distinct values`,
    );
  });

  // --- Gate 4: all 40 watchlist slugs present --------------------------------
  check("gate 4: all 40 watchlist slugs present in the board", (fail, note) => {
    const missing = snapshot.watchlist.filter((s) => !boardSlugs.has(s));
    if (missing.length > 0) {
      fail(`watchlist slugs missing from the board: ${missing.join(", ")}`);
    }
    const present = snapshot.watchlist.length - missing.length;
    note(`watchlist coverage: ${present}/${snapshot.watchlist.length}`);
  });

  // --- Gate 5: every board slug exists in the snapshot -----------------------
  check("gate 5: every board slug exists in the sealed snapshot (758 protocols)", (fail, note) => {
    const unknown = rows.filter((r) => !snapshotBySlug.has(r.slug));
    if (unknown.length > 0) {
      fail(
        `board slugs not in the snapshot: ${unknown.map((r) => r.slug).join(", ")}`,
      );
    }
    note(`all ${rows.length} board slugs found among the ${snapshot.protocols.length} snapshot protocols`);
  });

  // --- Gate 6: farm plans well-formed, implied values safe integers -----------
  check("gate 6: farm plans 3-12 steps of 20-600 chars, implied values positive safe integers", (fail, note) => {
    if (rows.length === 0) {
      fail("no rows to check");
      return;
    }
    const problems: string[] = [];
    let totalSteps = 0;
    let minStep = Infinity;
    let maxStep = 0;
    for (const row of rows) {
      if (!Number.isSafeInteger(row.implied_value_usd) || row.implied_value_usd <= 0) {
        problems.push(
          `rank ${row.rank} (${row.slug}) implied value is not a positive safe integer: ${row.implied_value_usd}`,
        );
      }
      if (!Array.isArray(row.farm_steps)) {
        problems.push(`rank ${row.rank} (${row.slug}) has no farm_steps array`);
        continue;
      }
      totalSteps += row.farm_steps.length;
      if (row.farm_steps.length < 3 || row.farm_steps.length > 12) {
        problems.push(
          `rank ${row.rank} (${row.slug}) has ${row.farm_steps.length} farm steps (need 3-12)`,
        );
      }
      row.farm_steps.forEach((step, i) => {
        if (typeof step !== "string") {
          problems.push(`rank ${row.rank} (${row.slug}) step ${i + 1} is not a string`);
          return;
        }
        minStep = Math.min(minStep, step.length);
        maxStep = Math.max(maxStep, step.length);
        if (step.length < 20 || step.length > 600) {
          problems.push(
            `rank ${row.rank} (${row.slug}) step ${i + 1} is ${step.length} chars (need 20-600)`,
          );
        }
      });
    }
    if (problems.length > 0) {
      fail(`${problems.length} problem(s), first: ${problems.slice(0, 5).join("; ")}`);
    }
    note(
      `${totalSteps} farm steps across ${rows.length} rows, ` +
        `shortest ${minStep} chars, longest ${maxStep} chars, ` +
        `all implied values positive safe integers`,
    );
  });

  // --- Gate 7: dashboard files contain no external network reference ---------
  check("gate 7: dashboard files have zero external http(s) references and no fetch/XHR calls", (fail, note) => {
    const findings: NetworkFinding[] = [];
    let scanned = 0;
    for (const rel of DASHBOARD_FILES) {
      const abs = path.join(dirA, rel);
      if (!fs.existsSync(abs)) {
        fail(`run A did not write ${rel}`);
        continue;
      }
      const info = scanDashboardFile(rel, abs, findings);
      scanned += 1;
      note(`${rel}: ${info.bytes} bytes, ${info.lines} lines scanned`);
    }
    const external = findings.filter((f) => f.kind === "external-url" || f.kind === "protocol-relative-url");
    const calls = findings.filter((f) => f.kind !== "external-url" && f.kind !== "protocol-relative-url" && f.kind !== "local-url");
    const local = findings.filter((f) => f.kind === "local-url");
    for (const f of external) {
      fail(`external reference in ${f.file}:${f.line} (${f.kind}): ${f.text}`);
    }
    for (const f of calls) {
      fail(`network call in ${f.file}:${f.line} (${f.kind}): ${f.text}`);
    }
    if (local.length > 0) {
      note(`${local.length} local-only URL(s) found (localhost), not external`);
    }
    if (scanned === DASHBOARD_FILES.length && external.length === 0 && calls.length === 0) {
      note(`0 external http(s) references, 0 network calls across ${scanned} dashboard files`);
    }
  });

  // --- Extra: dossier shape ---------------------------------------------------
  check("extra: dossier.json shape (schema, 3 images, cover 0, non-empty text)", (fail, note) => {
    if (!dossier) {
      fail("dossier.json could not be read");
      return;
    }
    if (dossier.schema !== EXPECTED.dossierSchema) {
      fail(`dossier schema: expected ${EXPECTED.dossierSchema}, got ${dossier.schema}`);
    }
    if (!Array.isArray(dossier.images) || dossier.images.length !== EXPECTED.dossierImages) {
      fail(
        `dossier images: expected ${EXPECTED.dossierImages}, got ${Array.isArray(dossier.images) ? dossier.images.length : "not an array"}`,
      );
    }
    if (dossier.cover !== 0) {
      fail(`dossier cover: expected 0, got ${dossier.cover}`);
    }
    if (typeof dossier.text !== "string" || dossier.text.length === 0) {
      fail("dossier text is missing or empty");
    }
    note(
      `dossier: schema ${dossier.schema}, ${dossier.images.length} images, cover ${dossier.cover}, text ${dossier.text.length} chars`,
    );
  });

  // --- Extra: data.js payload agrees with board.json ---------------------------
  check("extra: data.js payload agrees with board.json (counts, rows, live set-aside)", (fail, note) => {
    if (!radar) {
      fail("data.js could not be read");
      return;
    }
    if (radar.model_version !== EXPECTED.modelVersion) {
      fail(`model_version: expected ${EXPECTED.modelVersion}, got ${radar.model_version}`);
    }
    const counts: Array<[string, number, number]> = [
      ["board_size", radar.board_size, EXPECTED.boardRows],
      ["watchlist_size", radar.watchlist_size, EXPECTED.watchlist],
      ["early_size", radar.early_size, EXPECTED.earlyRows],
      ["live_size", radar.live_size, EXPECTED.liveRows],
    ];
    for (const [label, actual, expected] of counts) {
      if (actual !== expected) {
        fail(`${label}: expected ${expected}, got ${actual}`);
      }
    }
    if (radar.board_size !== radar.early_size + radar.watchlist_size) {
      fail(
        `board_size ${radar.board_size} != early_size ${radar.early_size} + watchlist_size ${radar.watchlist_size}`,
      );
    }
    if (!Array.isArray(radar.rows) || radar.rows.length !== EXPECTED.boardRows) {
      fail(
        `data.js rows: expected ${EXPECTED.boardRows}, got ${Array.isArray(radar.rows) ? radar.rows.length : "not an array"}`,
      );
    } else {
      const mismatches: string[] = [];
      for (let i = 0; i < rows.length; i++) {
        const a = rows[i];
        const b = radar.rows[i];
        if (!b) {
          mismatches.push(`position ${i + 1}: missing in data.js`);
          continue;
        }
        if (a.rank !== b.rank || a.slug !== b.slug || a.implied_value_usd !== b.implied_value_usd) {
          mismatches.push(
            `position ${i + 1}: board (${a.rank}, ${a.slug}, ${a.implied_value_usd}) vs data.js (${b.rank}, ${b.slug}, ${b.implied_value_usd})`,
          );
        }
        if (
          Math.abs(a.model.growth_multiplier - b.growth_multiplier) > 0.000051 ||
          Math.abs(a.model.maturity_multiplier - b.maturity_multiplier) > 0.000051 ||
          Math.abs(a.model.chain_multiplier - b.chain_multiplier) > 0.000051
        ) {
          mismatches.push(`position ${i + 1} (${a.slug}): multipliers differ between board.json and data.js`);
        }
      }
      if (mismatches.length > 0) {
        fail(`${mismatches.length} board/data.js mismatch(es), first: ${mismatches.slice(0, 3).join("; ")}`);
      }
    }
    if (!Array.isArray(radar.live) || radar.live.length !== EXPECTED.liveRows) {
      fail(
        `live set-aside: expected ${EXPECTED.liveRows}, got ${Array.isArray(radar.live) ? radar.live.length : "not an array"}`,
      );
    } else {
      const noToken = radar.live.filter((x) => x.mcap_usd === null || x.mcap_usd === undefined);
      if (noToken.length > 0) {
        fail(
          `live set-aside has ${noToken.length} row(s) without a market cap: ${noToken.map((x) => x.slug).join(", ")}`,
        );
      }
      const liveInBoard = radar.live.filter((x) => boardSlugs.has(x.slug));
      if (liveInBoard.length > 0) {
        fail(
          `live set-aside overlaps the board: ${liveInBoard.map((x) => x.slug).join(", ")}`,
        );
      }
    }
    const nonWatchlist = rows.filter((r) => !snapshot.watchlist.includes(r.slug));
    if (nonWatchlist.length !== EXPECTED.earlyRows) {
      fail(
        `non-watchlist board rows: expected ${EXPECTED.earlyRows}, got ${nonWatchlist.length}`,
      );
    }
    note(
      `data.js: board ${radar.board_size} = early ${radar.early_size} + watchlist ${radar.watchlist_size}, ` +
        `live ${radar.live.length} set aside, model ${radar.model_version}`,
    );
  });

  // --- Extra: model recomputation from the README formula -----------------------
  check("extra: model recomputation from the README formula matches every row exactly", (fail, note) => {
    if (rows.length === 0) {
      fail("no rows to check");
      return;
    }
    const problems: string[] = [];
    let worstMultiplierDiff = 0;
    let worstImpliedDiff = 0;
    for (const row of rows) {
      const protocol = snapshotBySlug.get(row.slug);
      if (!protocol) {
        continue; // already reported by gate 5
      }
      if (row.model.base_multiple !== EXPECTED.baseMultiple) {
        problems.push(
          `rank ${row.rank} (${row.slug}) base_multiple ${row.model.base_multiple} != ${EXPECTED.baseMultiple}`,
        );
      }
      const growth = growthMultiplier(protocol.change_7d);
      const maturity = maturityMultiplier(row.model.age_days);
      const chains = chainMultiplier(protocol.chains.length);
      const diffs = [
        Math.abs(growth - row.model.growth_multiplier),
        Math.abs(maturity - row.model.maturity_multiplier),
        Math.abs(chains - row.model.chain_multiplier),
      ];
      worstMultiplierDiff = Math.max(worstMultiplierDiff, ...diffs);
      if (Math.max(...diffs) > 0.0001) {
        problems.push(
          `rank ${row.rank} (${row.slug}) multiplier mismatch: ` +
            `growth ${growth} vs ${row.model.growth_multiplier}, ` +
            `maturity ${maturity} vs ${row.model.maturity_multiplier}, ` +
            `chains ${chains} vs ${row.model.chain_multiplier}`,
        );
      }
      const expected = impliedValue(
        protocol.tvl_usd,
        protocol.change_7d,
        row.model.age_days,
        protocol.chains.length,
      );
      const impliedDiff = Math.abs(expected - row.implied_value_usd);
      worstImpliedDiff = Math.max(worstImpliedDiff, impliedDiff);
      if (expected !== row.implied_value_usd) {
        problems.push(
          `rank ${row.rank} (${row.slug}) implied value: recomputed ${usd(expected)}, stored ${usd(row.implied_value_usd)}`,
        );
      }
    }
    if (problems.length > 0) {
      fail(`${problems.length} problem(s), first: ${problems.slice(0, 5).join("; ")}`);
    }
    note(
      `recomputed all ${rows.length} implied values from the README formula: ` +
        `max multiplier deviation ${worstMultiplierDiff.toFixed(6)} (4-decimal rounding), ` +
        `max implied deviation ${usd(worstImpliedDiff)}`,
    );
  });

  // --- Extra: row shape (unique slugs, pre-token, required fields) ---------------
  check("extra: row shape — unique slugs, all pre-token, required fields present", (fail, note) => {
    if (rows.length === 0) {
      fail("no rows to check");
      return;
    }
    const seen = new Set<string>();
    let duplicates = 0;
    const problems: string[] = [];
    for (const row of rows) {
      if (seen.has(row.slug)) duplicates += 1;
      seen.add(row.slug);
      if (row.token_status !== "pre-token") {
        problems.push(`rank ${row.rank} (${row.slug}) token_status is ${row.token_status}, not pre-token`);
      }
      const required: Array<[string, unknown]> = [
        ["rank", row.rank],
        ["slug", row.slug],
        ["name", row.name],
        ["chains", row.chains],
        ["tvl_usd", row.tvl_usd],
        ["implied_value_usd", row.implied_value_usd],
        ["farm_steps", row.farm_steps],
        ["model", row.model],
      ];
      for (const [field, value] of required) {
        if (value === null || value === undefined) {
          problems.push(`rank ${row.rank} (${row.slug}) is missing ${field}`);
        }
      }
      if (typeof row.name !== "string" || row.name.length === 0) {
        problems.push(`rank ${row.rank} (${row.slug}) has an empty name`);
      }
      if (!Array.isArray(row.chains) || row.chains.length === 0) {
        problems.push(`rank ${row.rank} (${row.slug}) has no chains`);
      }
      if (typeof row.tvl_usd !== "number" || row.tvl_usd <= 0) {
        problems.push(`rank ${row.rank} (${row.slug}) has tvl_usd ${row.tvl_usd}`);
      }
    }
    if (duplicates > 0) {
      fail(`${duplicates} duplicate slug(s) in the board`);
    }
    if (problems.length > 0) {
      fail(`${problems.length} problem(s), first: ${problems.slice(0, 5).join("; ")}`);
    }
    note(`${rows.length} rows, all unique slugs, all pre-token, all required fields present`);
  });

  // --- Summary ------------------------------------------------------------------
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed);
  console.log(`\nverify.ts: ${passed}/${results.length} checks passed`);
  if (failed.length > 0) {
    console.log(`failed checks: ${failed.map((r) => r.name).join("; ")}`);
    console.log("temporary output directories kept for inspection:");
    console.log(`  run A: ${dirA}`);
    console.log(`  run B: ${dirB}`);
    return 1;
  }
  fs.rmSync(dirA, { recursive: true, force: true });
  fs.rmSync(dirB, { recursive: true, force: true });
  console.log("ALL PASS — temporary output directories removed");
  return 0;
}

process.exitCode = main();
