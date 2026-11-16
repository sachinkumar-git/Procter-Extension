// Runs `dotnet build|test` for the Windows agent from the root npm scripts.
// A missing SDK is reported as SKIPPED, never as a pass. Set REQUIRE_DOTNET=1
// (for example in CI) to make a missing SDK fail the command.
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const command = process.argv[2];
if (!["build", "test", "publish"].includes(command)) {
  console.error("Usage: node scripts/agent.mjs <build|test|publish>");
  process.exit(2);
}

const probe = spawnSync("dotnet", ["--version"], { encoding: "utf8" });
if (probe.error || probe.status !== 0) {
  console.warn(
    `\n*** SKIPPED: Windows agent ${command} - the .NET 10 SDK was not found on PATH. ***\n`,
  );
  process.exit(process.env.REQUIRE_DOTNET === "1" ? 1 : 0);
}

const agentDir = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../apps/windows-agent",
);
const solution = "ExamGuard.WindowsAgent.slnx";
// `dotnet test` on the Microsoft Testing Platform requires the named option.
const target = {
  build: [solution],
  test: ["--solution", solution],
  publish: [
    "src/ExamGuard.Agent/ExamGuard.Agent.csproj",
    "--runtime",
    "win-x64",
    "--self-contained",
    "-p:PublishSingleFile=true",
    "--output",
    "publish",
  ],
}[command];
const result = spawnSync(
  "dotnet",
  [command, ...target, "--configuration", "Release"],
  { cwd: agentDir, stdio: "inherit" },
);
process.exit(result.status ?? 1);
