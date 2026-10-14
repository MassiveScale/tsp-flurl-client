/**
 * The compile matrix. Generates a spec from `cases.mjs`, prunes the cases TypeSpec
 * itself rejects, emits the rest, and then holds the emitter to its promise: for
 * everything TypeSpec accepts, the emitter either reports it or writes C# that
 * builds with warnings as errors and whose every model round-trips through the
 * client's serializer.
 *
 * The operations the emitter leaves out are compared with `left-out.txt`, so a
 * supported case that starts being left out fails the run. Pass `--update` to
 * accept a change to that list.
 *
 * Run from the repository root after `npm run build`: `npm run matrix`.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCases, SHARED } from "./cases.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const MAIN = resolve(HERE, "main.tsp");
const LEFT_OUT = resolve(HERE, "left-out.txt");
const PROJECT = resolve(HERE, "tsp-output", "MatrixClient.csproj");
const OURS = "@massivescale/tsp-flurl-client/";
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
  const result = spawnSync(
    windows
      ? [command, ...args]
          .map((a) => (/[\s"]/.test(a) ? `"${a}"` : a))
          .join(" ")
      : command,
    windows ? [] : args,
    {
      cwd: HERE,
      encoding: "utf-8",
      shell: windows,
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
      maxBuffer: 256 * 1024 * 1024,
    },
  );
  return {
    status: result.status,
    // Colour codes are stripped in case a tool ignores NO_COLOR.
    output:
      `${result.stdout ?? ""}${result.stderr ?? ""}${result.error ? String(result.error) : ""}`.replace(
        // eslint-disable-next-line no-control-regex
        /[[0-9;]*m/g,
        "",
      ),
  };
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
    ...SHARED.split("\n"),
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
  writeFileSync(MAIN, `${lines.join("\n")}\n`);
  return owners;
}

/**
 * The diagnostics `tsp compile` printed, as `{ line, code, message }`.
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
 * Fails the run with a message.
 *
 * @param {string} message - What went wrong.
 */
function fail(message) {
  console.error(`\nMATRIX FAILED: ${message}`);
  process.exit(1);
}

let cases = buildCases().filter((c) => !skipped.has(c.group));
const total = cases.length;
console.log(`${total} cases generated.`);

if (!existsSync(resolve(HERE, "node_modules"))) {
  const install = run("npm", ["install", "--no-audit", "--no-fund"]);
  if (install.status !== 0) fail(`npm install failed:\n${install.output}`);
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
      `TypeSpec rejected lines that belong to no case:\n${orphans.map((d) => `  ${d.line}: ${d.code}: ${d.message}`).join("\n")}`,
    );
  }
  for (const d of foreign) {
    const id = owners.get(d.line);
    if (!rejected.has(id)) rejected.set(id, `${d.code}: ${d.message}`);
  }
  cases = cases.filter((c) => !rejected.has(c.id));
  if (pass > 10) fail("pruning did not settle");
}
console.log(
  `${rejected.size} cases rejected by TypeSpec itself; ${cases.length} cases emitted.`,
);

writeSpec(cases);
const emit = run("npx", ["tsp", "compile", "."]);
if (/Internal compiler error|TypeError|ReferenceError/.test(emit.output)) {
  fail(`the emitter crashed:\n${emit.output}`);
}
const diagnostics = parseDiagnostics(emit.output);
const foreign = diagnostics.filter(
  (d) => d.severity === "error" && !d.code.startsWith(OURS),
);
if (foreign.length > 0) {
  fail(
    `errors from outside the emitter after pruning:\n${foreign.map((d) => `  ${d.code}: ${d.message}`).join("\n")}`,
  );
}
if (!existsSync(PROJECT)) fail(`no project was written:\n${emit.output}`);

const byCode = new Map();
for (const d of diagnostics.filter((x) => x.code.startsWith(OURS))) {
  byCode.set(d.code, (byCode.get(d.code) ?? 0) + 1);
}
console.log("Emitter diagnostics:");
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
].sort();
console.log(`${leftOut.length} operations left out by the emitter.`);
const snapshot = `${leftOut.join("\n")}\n`;
if (skipped.size > 0) {
  console.log(
    "Groups skipped, so left-out.txt is neither checked nor updated.",
  );
} else if (update) {
  writeFileSync(LEFT_OUT, snapshot);
  console.log("left-out.txt updated.");
} else {
  const expected = existsSync(LEFT_OUT) ? readFileSync(LEFT_OUT, "utf-8") : "";
  if (expected !== snapshot) {
    const before = new Set(expected.split("\n").filter(Boolean));
    const after = new Set(leftOut);
    const newly = [...after].filter((x) => !before.has(x));
    const restored = [...before].filter((x) => !after.has(x));
    fail(
      `the operations left out changed (run with --update to accept):\n` +
        newly.map((x) => `  + ${x}`).join("\n") +
        (newly.length && restored.length ? "\n" : "") +
        restored.map((x) => `  - ${x}`).join("\n"),
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
        .split("\n")
        .filter((l) => /: (error|warning) /.test(l))
        .map((l) => l.replace(/\s*\[[^\]]*\]\s*$/, "").trim()),
    ),
  ];
  fail(
    `the generated C# does not build (${errors.length} distinct):\n${errors.slice(0, 80).join("\n")}`,
  );
}
console.log("Generated C# builds with warnings as errors.");

const smoke = run("dotnet", [
  "run",
  "--project",
  resolve(HERE, "Smoke", "Smoke.csproj"),
  ...restore,
]);
if (smoke.status !== 0)
  fail(`the serializer smoke test failed:\n${smoke.output}`);
console.log(smoke.output.trim().split("\n").slice(-1)[0]);
console.log("Matrix passed.");
