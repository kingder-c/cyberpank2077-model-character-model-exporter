import { spawn } from "node:child_process";
import { openSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const cacheDir = resolve(root, ".cache");
mkdirSync(cacheDir, { recursive: true });

const out = openSync(resolve(cacheDir, "built-server.log"), "a");
const err = openSync(resolve(cacheDir, "built-server.err.log"), "a");

const child = spawn(process.execPath, [resolve(root, ".output", "server", "index.mjs")], {
  cwd: root,
  detached: true,
  windowsHide: true,
  stdio: ["ignore", out, err],
  env: {
    ...process.env,
    PORT: "3001",
    HOST: "127.0.0.1",
    WOLVENKIT_CLI: process.env.WOLVENKIT_CLI || "E:\\2077model\\resource\\WolvenKit.Console\\WolvenKit.CLI.exe",
    BLENDER_EXE:
      process.env.BLENDER_EXE || "E:\\2077model\\resource\\Blender\\blender-4.5.10-windows-x64\\blender.exe",
  },
});

child.unref();
console.log(`pid=${child.pid}`);
