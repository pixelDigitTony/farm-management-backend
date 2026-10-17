import { type ChildProcess, spawn } from "node:child_process";

// Only image/tool runtime settings cross the boundary. Never pass application secrets.
export function imageChildEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (
      /^(PATH|SystemRoot|WINDIR|TEMP|TMP|TMPDIR|LD_LIBRARY_PATH|DYLD_LIBRARY_PATH|NODE_OPTIONS|TSX_TSCONFIG_PATH|SSIMULACRA2_BIN|IMAGE_[A-Z_]+)$/i.test(
        key,
      )
    )
      env[key] = value;
  }
  return { ...env, VIPS_CONCURRENCY: "1", RAYON_NUM_THREADS: "1", MALLOC_ARENA_MAX: "2" };
}

export function killImageTree(child: ChildProcess) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    killer.on("error", () => child.kill("SIGKILL"));
    killer.on("exit", (code) => {
      if (code !== 0) child.kill("SIGKILL");
    });
  } else {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }
}

export function runImageBinary(
  binary: string,
  args: string[],
  input: unknown,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<unknown> {
  if (signal.aborted) return Promise.reject(new Error("Processing cancelled"));
  const request = input === undefined ? "" : JSON.stringify(input);
  if (Buffer.byteLength(request) > 16384)
    return Promise.reject(new Error("Image request too large"));
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      detached: true,
      shell: false,
      windowsHide: true,
      env: imageChildEnv(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    let outputBytes = 0;
    let stderrBytes = 0;
    let stopped = false;
    const stop = () => {
      stopped = true;
      killImageTree(child);
    };
    const timer = setTimeout(stop, timeoutMs);
    signal.addEventListener("abort", stop, { once: true });
    child.stdout.on("data", (data: Buffer) => {
      outputBytes += data.length;
      if (outputBytes > 65536) stop();
      else output += data.toString("utf8");
    });
    child.stderr.on("data", (data: Buffer) => {
      stderrBytes += data.length;
      if (stderrBytes > 65536) stop();
    });
    let error: Error | undefined;
    child.on("error", (cause) => {
      error = cause;
    });
    child.stdin.on("error", (cause) => {
      error = cause;
    });
    child.once("exit", () => {
      // A crashed native leader can leave metric descendants behind in its process group.
      if (process.platform !== "win32") killImageTree(child);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      if (error || stopped || signal.aborted || code !== 0)
        return reject(new Error("Image processor failed, was cancelled or exceeded its limit"));
      try {
        resolve(JSON.parse(output));
      } catch {
        reject(new Error("Invalid image processor response"));
      }
    });
    child.stdin.end(request);
    if (signal.aborted) stop();
  });
}
