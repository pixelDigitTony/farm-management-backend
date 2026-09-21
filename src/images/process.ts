import { fork, spawn } from "node:child_process";
import { imageConfig as c } from "./config.js";
export function encodeInProcess(
  source: string,
  profile: string,
  directory: string,
  signal: AbortSignal,
) {
  return new Promise<{ mime: string; width: number; height: number; score: number }>(
    (resolve, reject) => {
      if (signal.aborted) return reject(new Error("Processing cancelled"));
      const entry = new URL(
        import.meta.url.endsWith(".ts") ? "./encode-process.ts" : "./encode-process.js",
        import.meta.url,
      );
      const child = fork(entry, [source, profile, directory], {
        detached: true,
        stdio: ["ignore", "inherit", "inherit", "ipc"],
      });
      let result: any;
      let terminated = false;
      const kill = () => {
        terminated = true;
        if (child.pid) {
          if (process.platform === "win32") {
            const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
              windowsHide: true,
              stdio: "ignore",
            });
            killer.on("error", () => child.kill("SIGKILL"));
            killer.on("exit", (code) => {
              if (code !== 0) child.kill("SIGKILL");
            });
            return;
          }
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
        }
      };
      const timeout = setTimeout(kill, c.timeoutMs);
      signal.addEventListener("abort", kill, { once: true });
      const clean = () => {
        clearTimeout(timeout);
        signal.removeEventListener("abort", kill);
      };
      child.once("message", (message) => {
        result = message;
      });
      child.once("error", (error) => {
        clean();
        reject(error);
      });
      child.once("exit", (code) => {
        clean();
        if (code === 0 && result?.ok && !signal.aborted && !terminated) resolve(result);
        else
          reject(new Error("Image validation, quality assessment or processing time limit failed"));
      });
    },
  );
}
