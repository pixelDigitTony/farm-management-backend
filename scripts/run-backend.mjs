import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const mode = process.argv[2];
if (!["start", "dev"].includes(mode)) throw new Error("Expected start or dev");

const windows = process.platform === "win32";
const executable = windows
  ? join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    )
  : process.execPath;
const args = windows
  ? [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      join(root, "scripts", "images-local.ps1"),
      "start",
    ]
  : mode === "dev"
    ? [join(root, "node_modules", "tsx", "dist", "cli.mjs"), "watch", "src/server.ts"]
    : [join(root, "dist", "server.js")];

if (windows) {
  console.log("Starting the Docker backend with SSIMULACRA2 at http://localhost:4001/api.");
  console.log(
    "Docker Desktop must be running. Changes are rebuilt on each start; Windows dev does not watch files.",
  );
}
const child = spawn(executable, args, { cwd: root, stdio: "inherit", windowsHide: true });
child.on("error", (error) => {
  console.error("Could not launch the backend:", error.message);
  process.exitCode = 1;
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}
child.on("exit", (code, signal) => {
  if (windows && code === 0) {
    console.log(
      "Backend is running in Docker on port 4001. Stop/log commands: deploy/LOCAL-IMAGES.md",
    );
  }
  process.exitCode = code ?? (signal ? 1 : 0);
});
