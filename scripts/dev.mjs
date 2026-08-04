import { spawn } from "node:child_process";

const children = [
  spawn(process.execPath, ["--watch", "src/server/index.js"], { stdio: "inherit" }),
  spawn(process.platform === "win32" ? "pnpm.cmd" : "pnpm", ["dev:web"], {
    stdio: "inherit",
    shell: process.platform === "win32",
  }),
];

let stopping = false;
function stop(signal = "SIGTERM") {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill(signal);
}

process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));
for (const child of children) {
  child.on("exit", (code) => {
    if (!stopping) {
      stop();
      process.exitCode = code || 0;
    }
  });
}
