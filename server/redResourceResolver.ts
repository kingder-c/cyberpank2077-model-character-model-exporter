import { existsSync } from "node:fs";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

export type SerializedResourceGraph = {
  resourcePath: string;
  jsonPath: string | null;
  meshPaths: string[];
  resourcePaths: string[];
};

function workspaceRoot() {
  return process.cwd();
}

function runProcess(exe: string, args: string[], cwd: string, onLog: (line: string) => void) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(exe, args, { cwd, windowsHide: true });
    child.stdout.on("data", (chunk) => {
      String(chunk)
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .forEach(onLog);
    });
    child.stderr.on("data", (chunk) => {
      String(chunk)
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .forEach(onLog);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${path.basename(exe)} exited with code ${code}`));
      }
    });
  });
}

function jsonPathForResource(outDir: string, resourcePath: string) {
  const normalized = resourcePath.replace(/\\/g, "/");
  return path.join(outDir, ...`${normalized}.json`.split("/"));
}

function collectResourcePaths(value: unknown, result = new Set<string>()) {
  if (!value || typeof value !== "object") {
    return result;
  }

  if (
    "$type" in value &&
    "$value" in value &&
    String((value as { $type?: unknown }).$type).toLowerCase() === "resourcepath"
  ) {
    const resourcePath = String((value as { $value?: unknown }).$value || "").replace(/\//g, "\\");
    if (resourcePath) {
      result.add(resourcePath);
    }
  }

  if (Array.isArray(value)) {
    value.forEach((item) => collectResourcePaths(item, result));
  } else {
    Object.values(value).forEach((item) => collectResourcePaths(item, result));
  }

  return result;
}

export async function serializeResourceGraph(
  wolvenKitExe: string,
  gameDir: string,
  resourcePath: string,
  outDir: string,
  onLog: (line: string) => void,
): Promise<SerializedResourceGraph> {
  const archivePath = path.join(gameDir, "archive", "pc", "content");
  await fsp.mkdir(outDir, { recursive: true });
  await runProcess(
    wolvenKitExe,
    [
      "uncook",
      archivePath,
      "--outpath",
      outDir,
      "--gamepath",
      gameDir,
      "--pattern",
      resourcePath,
      "--serialize",
      "--verbosity",
      "Minimal",
    ],
    workspaceRoot(),
    onLog,
  );

  const jsonPath = jsonPathForResource(outDir, resourcePath);
  if (!existsSync(jsonPath)) {
    return { resourcePath, jsonPath: null, meshPaths: [], resourcePaths: [] };
  }

  const json = JSON.parse(await fsp.readFile(jsonPath, "utf8"));
  const resourcePaths = [...collectResourcePaths(json)].sort();
  return {
    resourcePath,
    jsonPath,
    resourcePaths,
    meshPaths: resourcePaths.filter((item) => /\.mesh$/i.test(item)),
  };
}
