import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const workspaceRoot = path.resolve(projectRoot, "..");
const resourceRoot = path.join(workspaceRoot, "resource");

function findExecutable(root, executableName, maxDepth = 5) {
  if (!existsSync(root)) {
    return null;
  }

  const stack = [{ dir: root, depth: 0 }];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = readdirSync(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(current.dir, entry.name);
      if (entry.isFile() && entry.name.toLowerCase() === executableName.toLowerCase()) {
        return fullPath;
      }
      if (entry.isDirectory() && current.depth < maxDepth) {
        stack.push({ dir: fullPath, depth: current.depth + 1 });
      }
    }
  }

  return null;
}

function prependPath(...dirs) {
  const existing = process.env.PATH || "";
  const filtered = dirs.filter(Boolean).filter((dir) => existsSync(dir));
  process.env.PATH = [...filtered, existing].join(path.delimiter);
}

const wolvenKit = process.env.WOLVENKIT_CLI || findExecutable(resourceRoot, "WolvenKit.CLI.exe");
const blender = process.env.BLENDER_EXE || findExecutable(path.join(resourceRoot, "Blender"), "blender.exe");

if (wolvenKit) {
  process.env.WOLVENKIT_CLI = wolvenKit;
}

if (blender) {
  process.env.BLENDER_EXE = blender;
}

prependPath(
  wolvenKit ? path.dirname(wolvenKit) : null,
  blender ? path.dirname(blender) : null,
);

const [command, ...args] = process.argv.slice(2);
if (!command) {
  console.error("Usage: node scripts/run-with-local-tools.mjs <command> [...args]");
  process.exit(1);
}

console.log(`[local-tools] WOLVENKIT_CLI=${process.env.WOLVENKIT_CLI || "not found"}`);
console.log(`[local-tools] BLENDER_EXE=${process.env.BLENDER_EXE || "not found"}`);

const child = spawn(command, args, {
  cwd: projectRoot,
  env: process.env,
  shell: process.platform === "win32",
  stdio: "inherit",
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

