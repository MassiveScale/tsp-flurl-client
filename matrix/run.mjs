/**
 * The compile matrix. Generates a spec from `cases.mjs`, prunes the cases TypeSpec
 * itself rejects, emits the rest, and then holds the emitter to its promise: for
 * everything TypeSpec accepts, the emitter either reports it or writes C# that
 * builds with warnings as errors and whose every model round-trips through the
 * client's serializer.
 *
 * The cases the emitter reports for their names, and the operations it leaves out
 * as unsupported, are compared with `left-out.txt`, so a supported case that
 * starts being reported or left out fails the run. Pass `--update` to accept a
 * change to that list.
 *
 * The whole run is repeated for every `client-shape`, each with its own list
 * (`left-out.txt` for `flat`, `left-out.path.txt`, `left-out.interface.txt`).
 * `--shape=path` runs one shape only.
 *
 * Run from the repository root after `npm run build`: `npm run matrix`.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FRAMEWORK_TYPES } from "../dist/src/framework.js";
import { buildCases, SHARED } from "./cases.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SHAPES = ["flat", "path", "interface"];
const shapeArg = process.argv.find((a) => a.startsWith("--shape="));
if (shapeArg === undefined) {
  for (const each of SHAPES) {
    console.log(`${each === SHAPES[0] ? "" : "\n"}== client-shape: ${each}`);
    const child = spawnSync(
      process.execPath,
      [
        fileURLToPath(import.meta.url),
        ...process.argv.slice(2),
        `--shape=${each}`,
      ],
      { stdio: "inherit" },
    );
    if (child.status !== 0) process.exit(child.status ?? 1);
  }
  process.exit(0);
}
const shape = shapeArg.slice("--shape=".length);
if (!SHAPES.includes(shape)) {
  console.error(`Unknown --shape "${shape}"; use one of ${SHAPES.join(", ")}.`);
  process.exit(1);
}
const MAIN = resolve(HERE, "main.tsp");
const LEFT_OUT = resolve(
  HERE,
  shape === "flat" ? "left-out.txt" : `left-out.${shape}.txt`,
);
const PROJECT = resolve(HERE, "tsp-output", "MatrixClient.csproj");
const SMOKE = resolve(HERE, "Smoke", "Smoke.csproj");
const OURS = "@massivescale/tsp-flurl-client/";
const NEWLINE = "\n";
const update = process.argv.includes("--update");
// `--skip=Shadowing,Names` leaves groups out, to look at one failure without the rest.
const skipped = new Set(
  (process.argv.find((a) => a.startsWith("--skip=")) ?? "--skip=")
    .slice("--skip=".length)
    .split(",")
    .filter(Boolean),
);
const restore = process.env.MATRIX_RESTORE_SOURCES
  ? [`-p:RestoreSources=${process.env.MATRIX_RESTORE_SOURCES}`]
  : [];

/**
 * A case the emitter reports with one of these must be renamed by the user, so the
 * code it generates is not expected to build. It is recorded and left out of the
 * build, as TypeSpec's own rejections are. Every other case must build, including
 * one whose operation the emitter leaves out as unsupported.
 */
const NAME_ERRORS = new Set(
  [
    "name-collision",
    "output-name-collision",
    "invalid-name",
    "invalid-client-name",
  ].map((code) => `${OURS}${code}`),
);

/** An ANSI colour sequence, stripped in case a tool ignores NO_COLOR. */
const COLOUR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

/**
 * Runs a command in the matrix folder and returns its combined output.
 *
 * @param {string} command - The program.
 * @param {string[]} args - Its arguments.
 * @returns {{ status: number | null, output: string }} How it ended.
 */
function run(command, args) {
  // On Windows, npm and npx are .cmd scripts, which only a shell can start. The
  // arguments are this script's own constants and paths, so they are quoted here
  // rather than handed to the shell as a list it would not escape.
  const windows = process.platform === "win32";
  const quote = (a) => (/[\s"]/.test(a) ? `"${a}"` : a);
  const result = spawnSync(
    windows ? [command, ...args].map(quote).join(" ") : command,
    windows ? [] : args,
    {
      cwd: HERE,
      encoding: "utf-8",
      shell: windows,
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
      maxBuffer: 256 * 1024 * 1024,
    },
  );
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}${result.error ? String(result.error) : ""}`;
  return { status: result.status, output: output.replace(COLOUR, "") };
}

/**
 * Writes the spec for some cases, recording which case each line belongs to.
 *
 * @param {import("./cases.mjs").Case[]} cases - The cases.
 * @returns {Map<number, string>} The case id of each 1-based line.
 */
function writeSpec(cases) {
  const lines = [
    `import "@typespec/http";`,
    `import "@massivescale/tsp-flurl-client";`,
    `using Http;`,
    `using MassiveScale.TspFlurlClient;`,
    ``,
    `@service(#{ title: "Matrix" })`,
    `namespace Matrix;`,
    ...SHARED.split(NEWLINE),
  ];
  const owners = new Map();
  const push = (line, id) => {
    lines.push(line);
    if (id) owners.set(lines.length, id);
  };
  for (const c of cases) for (const d of c.decls) push(d, c.id);
  const groups = [...new Set(cases.map((c) => c.group))];
  for (const group of groups) {
    push(`@route("/${group.toLowerCase()}")`);
    push(`interface ${group} {`);
    for (const c of cases.filter((x) => x.group === group)) {
      for (const op of c.ops) push(`  ${op}`, c.id);
    }
    push(`}`);
  }
  writeFileSync(MAIN, `${lines.join(NEWLINE)}${NEWLINE}`);
  return owners;
}

/**
 * The diagnostics `tsp compile` printed.
 *
 * @param {string} output - The compiler's output.
 * @returns {{ line: number | undefined, code: string, severity: string, message: string }[]} The diagnostics.
 */
function parseDiagnostics(output) {
  const found = [];
  for (const match of output.matchAll(
    /^(?:(.*?):(\d+):\d+ - )?(error|warning) ([^:\s]+(?::[^:\s]+)?): (.*)$/gm,
  )) {
    const [, file, line, severity, code, message] = match;
    found.push({
      line: file && file.endsWith("main.tsp") ? Number(line) : undefined,
      code,
      severity,
      message,
    });
  }
  return found;
}

/**
 * Lists diagnostics, one per line, for a failure message.
 *
 * @param {{ line?: number, code: string, message: string }[]} diagnostics - The diagnostics.
 * @returns {string} The list.
 */
function listed(diagnostics) {
  return diagnostics
    .map((d) => `  ${d.line ?? "-"}: ${d.code}: ${d.message}`)
    .join(NEWLINE);
}

/**
 * Fails the run with a message.
 *
 * @param {string} message - What went wrong.
 */
function fail(message) {
  console.error(`${NEWLINE}MATRIX FAILED: ${message}`);
  process.exit(1);
}

let cases = buildCases().filter((c) => !skipped.has(c.group));
console.log(`${cases.length} cases generated.`);

if (!existsSync(resolve(HERE, "node_modules"))) {
  const install = run("npm", ["install", "--no-audit", "--no-fund"]);
  if (install.status !== 0)
    fail(`npm install failed:${NEWLINE}${install.output}`);
}

const rejected = new Map();
for (let pass = 1; ; pass++) {
  const owners = writeSpec(cases);
  const { output } = run("npx", ["tsp", "compile", ".", "--no-emit"]);
  const foreign = parseDiagnostics(output).filter(
    (d) => d.severity === "error" && !d.code.startsWith(OURS),
  );
  if (foreign.length === 0) break;
  const orphans = foreign.filter((d) => !owners.has(d.line));
  if (orphans.length > 0) {
    fail(
      `TypeSpec rejected lines that belong to no case:${NEWLINE}${listed(orphans)}`,
    );
  }
  for (const d of foreign) {
    const id = owners.get(d.line);
    if (!rejected.has(id)) rejected.set(id, `${d.code}: ${d.message}`);
  }
  cases = cases.filter((c) => !rejected.has(c.id));
  if (pass > 10) fail("pruning what TypeSpec rejects did not settle");
}
console.log(`${rejected.size} cases rejected by TypeSpec itself:`);
const rejectedBy = new Map();
for (const [id, reason] of rejected) {
  const code = reason.slice(0, reason.indexOf(":"));
  rejectedBy.set(code, [...(rejectedBy.get(code) ?? []), id]);
}
for (const [code, ids] of [...rejectedBy].sort()) {
  console.log(`  ${code}: ${ids.join(", ")}`);
}

const reported = new Map();
let diagnostics = [];
for (let pass = 1; ; pass++) {
  const owners = writeSpec(cases);
  const emit = run("npx", [
    "tsp",
    "compile",
    ".",
    "--option",
    `@massivescale/tsp-flurl-client.client-shape=${shape}`,
  ]);
  if (/Internal compiler error|TypeError|ReferenceError/.test(emit.output)) {
    fail(`the emitter crashed:${NEWLINE}${emit.output}`);
  }
  diagnostics = parseDiagnostics(emit.output);
  const foreign = diagnostics.filter(
    (d) => d.severity === "error" && !d.code.startsWith(OURS),
  );
  if (foreign.length > 0) {
    fail(
      `errors from outside the emitter after pruning:${NEWLINE}${listed(foreign)}`,
    );
  }
  const naming = diagnostics.filter((d) => NAME_ERRORS.has(d.code));
  const orphans = naming.filter((d) => !owners.has(d.line));
  if (orphans.length > 0) {
    fail(`naming errors that point at no case:${NEWLINE}${listed(orphans)}`);
  }
  const fresh = naming.filter((d) => !reported.has(owners.get(d.line)));
  if (fresh.length === 0) break;
  for (const d of fresh) {
    reported.set(owners.get(d.line), d.code.slice(OURS.length));
  }
  cases = cases.filter((c) => !reported.has(c.id));
  if (pass > 10) fail("leaving out the reported cases did not settle");
}
if (!existsSync(PROJECT)) fail("no project was written");
console.log(`${cases.length} cases emitted into the build.`);

const byCode = new Map();
for (const d of diagnostics.filter((x) => x.code.startsWith(OURS))) {
  byCode.set(d.code, (byCode.get(d.code) ?? 0) + 1);
}
console.log("Emitter diagnostics in the build:");
for (const [code, count] of [...byCode].sort()) {
  console.log(`  ${code.slice(OURS.length)}: ${count}`);
}

const leftOut = [
  ...new Set(
    diagnostics
      .filter((d) => d.code === `${OURS}unsupported-feature`)
      .map((d) => /in operation "([^"]+)"/.exec(d.message)?.[1])
      .filter(Boolean),
  ),
];
console.log(
  `${reported.size} cases reported for their names; ${leftOut.length} operations left out as unsupported.`,
);
const snapshotLines = [
  ...[...reported].map(([id, code]) => `reported ${id} ${code}`),
  ...leftOut.map((op) => `left out ${op}`),
].sort();
const snapshot = `${snapshotLines.join(NEWLINE)}${NEWLINE}`;
if (skipped.size > 0) {
  console.log(
    `Groups skipped, so ${basename(LEFT_OUT)} is neither checked nor updated.`,
  );
} else if (update) {
  writeFileSync(LEFT_OUT, snapshot);
  console.log(`${basename(LEFT_OUT)} updated.`);
} else {
  const expected = existsSync(LEFT_OUT) ? readFileSync(LEFT_OUT, "utf-8") : "";
  if (expected !== snapshot) {
    const before = new Set(expected.split(NEWLINE).filter(Boolean));
    const after = new Set(snapshotLines);
    const changes = [
      ...[...after].filter((x) => !before.has(x)).map((x) => `  + ${x}`),
      ...[...before].filter((x) => !after.has(x)).map((x) => `  - ${x}`),
    ];
    fail(
      `the cases reported or left out changed (run with --update to accept):${NEWLINE}${changes.join(NEWLINE)}`,
    );
  }
}

const build = run("dotnet", [
  "build",
  PROJECT,
  "-warnaserror",
  "-nologo",
  "-v",
  "q",
  ...restore,
]);
if (build.status !== 0) {
  const errors = [
    ...new Set(
      build.output
        .split(NEWLINE)
        .filter((l) => /: (error|warning) /.test(l))
        .map((l) => l.replace(/\s*\[[^\]]*\]\s*$/, "").trim()),
    ),
  ];
  fail(
    `the generated C# does not build (${errors.length} distinct):${NEWLINE}${errors.slice(0, 80).join(NEWLINE)}`,
  );
}
console.log("Generated C# builds with warnings as errors.");

// Every framework type the generated code names must be in the emitter's registry,
// or a generated type of the same name would hide it with nothing to qualify it.
const names = run("dotnet", [
  "run",
  "--project",
  SMOKE,
  ...restore,
  "--",
  "--framework-names",
  resolve(HERE, "tsp-output"),
]);
if (names.status !== 0)
  fail(`listing framework names failed:${NEWLINE}${names.output}`);
const unregistered = names.output
  .split(NEWLINE)
  .map((line) => line.trim().split(" "))
  .filter((parts) => parts.length === 3 && !(parts[0] in FRAMEWORK_TYPES))
  .map((parts) => `  ${parts.join(" ")}`);
if (unregistered.length > 0) {
  fail(
    `the generated C# names framework types the emitter does not qualify; add them to FRAMEWORK_TYPES in src/framework.ts:${NEWLINE}${unregistered.join(NEWLINE)}`,
  );
}
console.log("Every framework type the generated C# names is registered.");

const smoke = run("dotnet", ["run", "--project", SMOKE, ...restore]);
if (smoke.status !== 0)
  fail(`the serializer smoke test failed:${NEWLINE}${smoke.output}`);
console.log(smoke.output.trim().split(NEWLINE).slice(-1)[0]);
console.log("Matrix passed.");
