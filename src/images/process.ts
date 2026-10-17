import { fork } from "node:child_process";
import { imageChildEnv, killImageTree } from "./child.js";
import { imageConfig as c, type ImageProfile, processorConfig } from "./config.js";
import { encodeRust } from "./rust.js";
export function encodeInProcess(
  source: string,
  profile: string,
  directory: string,
  signal: AbortSignal,
): Promise<unknown> {
  return processorConfig.engine === "rust"
    ? encodeRust(source, profile as ImageProfile, directory, signal)
    : encodeSharp(source, profile, directory, signal);
}
function encodeSharp(source: string, profile: string, directory: string, signal: AbortSignal) {
  return new Promise<{ mime: string; width: number; height: number; score: number }>(
    (resolve, reject) => {
      if (signal.aborted) return reject(new Error("Processing cancelled"));
      const entry = new URL(
        import.meta.url.endsWith(".ts") ? "./encode-process.ts" : "./encode-process.js",
        import.meta.url,
      );
      const child = fork(entry, [source, profile, directory], {
        detached: true,
        env: imageChildEnv(),
        stdio: ["ignore", "inherit", "inherit", "ipc"],
      });
      let result: any;
      let terminated = false;
      const kill = () => {
        terminated = true;
        killImageTree(child);
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
      child.once("exit", () => {
        if (process.platform !== "win32") killImageTree(child);
      });
      child.once("close", (code) => {
        clean();
        if (code === 0 && result?.ok && !signal.aborted && !terminated) resolve(result);
        else
          reject(new Error("Image validation, quality assessment or processing time limit failed"));
      });
      if (signal.aborted) kill();
    },
  );
}
