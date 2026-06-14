import { spawn } from "node:child_process";
import { openSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const cacheDir = resolve(root, ".cache");
mkdirSync(cacheDir, { recursive: true });

const out = openSync(resolve(cacheDir, "dev-server.log"), "a");
const err = openSync(resolve(cacheDir, "dev-server.err.log"), "a");

const child = spawn("C:\\nvm4w\\nodejs\\npm.cmd", ["run", "dev", "--", "--port", "3001", "--host", "127.0.0.1"], {
  cwd: root,
  detached: true,
  shell: true,
  windowsHide: true,
  stdio: ["ignore", out, err],
});

child.unref();
console.log(`pid=${child.pid}`);
