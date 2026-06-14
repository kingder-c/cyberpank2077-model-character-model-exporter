import { createHash, randomUUID } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { analyzeSave, getSaveById, type LoadoutSlot, type VAppearancePreset, type VLoadoutPreset } from "./saveStore";
import { serializeResourceGraph } from "./redResourceResolver";

export const getDefaultGameDir = () => "D:\\Program Files (x86)\\Steam\\steamapps\\common\\Cyberpunk 2077";

export type ToolStatus = {
  wolvenKit: { found: boolean; path: string | null; message: string };
  blender: { found: boolean; path: string | null; message: string };
  redMod: { found: boolean; path: string | null; message: string };
  gameDir: { found: boolean; path: string; message: string };
};

export type ModelArtifactStatus = {
  saveId: string;
  cacheDir: string;
  previewGlb: string | null;
  exportStl: string | null;
  export3mf: string | null;
  exportVisual3mf: string | null;
  manifest: string | null;
  hasPreview: boolean;
  hasPrintable: boolean;
  has3mf: boolean;
  hasVisual3mf: boolean;
};

export type BodyMode = "naked" | "save-outfit" | "clothing-only" | "weapons-only";

export type RenderOptions = {
  bodyMode: BodyMode;
  includeSaveClothing: boolean;
  includeSaveWeapons: boolean;
  includeWeaponAttachments: boolean;
  poseId: string;
  expressionId: string;
  export3mf: boolean;
};

export type ModelBuildJob = {
  id: string;
  saveId: string;
  gameDir: string;
  status: "queued" | "running" | "done" | "error";
  progress: number;
  parallelism: number;
  title: string;
  logs: string[];
  error: string | null;
  createdAt: string;
  updatedAt: string;
  renderOptions: RenderOptions;
  artifacts: ModelArtifactStatus;
};

type BuildRequest = {
  saveId: string;
  gameDir?: string;
  force?: boolean;
  renderOptions?: Partial<RenderOptions>;
  parallelism?: number;
};

const jobs = new Map<string, ModelBuildJob>();
const modelRegistry = new Map<string, string>();

export const SUPPORTED_EXTS = [".glb", ".gltf", ".obj", ".ply", ".stl", ".3mf"] as const;

const DEFAULT_RENDER_OPTIONS: RenderOptions = {
  bodyMode: "naked",
  includeSaveClothing: false,
  includeSaveWeapons: false,
  includeWeaponAttachments: false,
  poseId: "neutral",
  expressionId: "neutral",
  export3mf: true,
};

function normalizeRenderOptions(input?: Partial<RenderOptions>): RenderOptions {
  const bodyMode =
    input?.bodyMode === "save-outfit" ||
    input?.bodyMode === "clothing-only" ||
    input?.bodyMode === "weapons-only" ||
    input?.bodyMode === "naked"
      ? input.bodyMode
      : DEFAULT_RENDER_OPTIONS.bodyMode;

  return {
    bodyMode,
    includeSaveClothing: Boolean(input?.includeSaveClothing),
    includeSaveWeapons: Boolean(input?.includeSaveWeapons),
    includeWeaponAttachments: Boolean(input?.includeWeaponAttachments),
    poseId: typeof input?.poseId === "string" && input.poseId.trim() ? input.poseId.trim() : "neutral",
    expressionId:
      typeof input?.expressionId === "string" && input.expressionId.trim() ? input.expressionId.trim() : "neutral",
    export3mf: input?.export3mf !== false,
  };
}

function workspaceRoot() {
  return process.cwd();
}

function localResourceRoot() {
  return path.resolve(workspaceRoot(), "..", "resource");
}

export function getModelCacheRoot() {
  return path.join(workspaceRoot(), ".cache", "cp2077-v-models");
}

function safePart(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function distinctLimited(values: string[], limit: number) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].slice(0, limit);
}

export function getSaveModelCacheDir(saveId: string) {
  return path.join(getModelCacheRoot(), safePart(saveId));
}

function artifactPath(saveId: string, name: string) {
  return path.join(getSaveModelCacheDir(saveId), name);
}

export function getArtifacts(saveId: string): ModelArtifactStatus {
  const cacheDir = getSaveModelCacheDir(saveId);
  const preview = artifactPath(saveId, "preview.glb");
  const stl = artifactPath(saveId, "print.stl");
  const threeMf = artifactPath(saveId, "print.3mf");
  const visualThreeMf = artifactPath(saveId, "print.visual.3mf");
  const manifest = artifactPath(saveId, "manifest.json");
  return {
    saveId,
    cacheDir,
    previewGlb: existsSync(preview) ? preview : null,
    exportStl: existsSync(stl) ? stl : null,
    export3mf: existsSync(threeMf) ? threeMf : null,
    exportVisual3mf: existsSync(visualThreeMf) ? visualThreeMf : null,
    manifest: existsSync(manifest) ? manifest : null,
    hasPreview: existsSync(preview),
    hasPrintable: existsSync(stl),
    has3mf: existsSync(threeMf),
    hasVisual3mf: existsSync(visualThreeMf),
  };
}

function firstExisting(paths: string[]) {
  return paths.find((candidate) => candidate && existsSync(candidate)) || null;
}

function pathFromEnv(names: string[]) {
  for (const name of names) {
    const value = process.env[name];
    if (value && existsSync(value)) {
      return value;
    }
  }
  return null;
}

function findOnPath(command: string) {
  const pathValue = process.env.PATH || "";
  const extensions = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const dir of pathValue.split(path.delimiter)) {
    for (const ext of extensions) {
      const candidate = path.join(dir, `${command}${ext}`);
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

function findFileUnder(root: string, fileName: string, maxDepth = 10): string | null {
  if (!existsSync(root)) {
    return null;
  }

  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  while (stack.length) {
    const current = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(current.dir, entry.name);
      if (entry.isFile() && entry.name.toLowerCase() === fileName.toLowerCase()) {
        return fullPath;
      }
      if (entry.isDirectory() && current.depth < maxDepth) {
        stack.push({ dir: fullPath, depth: current.depth + 1 });
      }
    }
  }

  return null;
}

export function detectTools(gameDir = getDefaultGameDir()): ToolStatus {
  const resourceRoot = localResourceRoot();
  const localWolvenKit = findFileUnder(resourceRoot, "WolvenKit.CLI.exe");
  const localBlender = findFileUnder(path.join(resourceRoot, "Blender"), "blender.exe");

  const wolvenKit = firstExisting([
    pathFromEnv(["WOLVENKIT_CLI", "WOLVENKIT_CLI_EXE"]) || "",
    localWolvenKit || "",
    path.join(resourceRoot, "WolvenKit.Console", "WolvenKit.CLI.exe"),
    path.join(workspaceRoot(), "tools", "WolvenKit.CLI.exe"),
    path.join(workspaceRoot(), "tools", "WolvenKit", "WolvenKit.CLI.exe"),
    "C:\\Program Files\\WolvenKit\\WolvenKit.CLI.exe",
    "C:\\Program Files\\WolvenKit\\WolvenKit.exe",
    findOnPath("WolvenKit.CLI") || "",
    findOnPath("WolvenKit") || "",
  ]);

  const blender = firstExisting([
    pathFromEnv(["BLENDER_EXE", "BLENDER_PATH"]) || "",
    localBlender || "",
    path.join(resourceRoot, "Blender", "blender.exe"),
    "C:\\Program Files\\Blender Foundation\\Blender 4.5\\blender.exe",
    "C:\\Program Files\\Blender Foundation\\Blender 4.4\\blender.exe",
    "C:\\Program Files\\Blender Foundation\\Blender 4.3\\blender.exe",
    "C:\\Program Files\\Blender Foundation\\Blender 4.2\\blender.exe",
    "C:\\Program Files\\Blender Foundation\\Blender 4.1\\blender.exe",
    "C:\\Program Files\\Blender Foundation\\Blender 4.0\\blender.exe",
    findOnPath("blender") || "",
  ]);

  const redMod = firstExisting([path.join(gameDir, "tools", "redmod", "bin", "redMod.exe")]);
  const hasArchive = existsSync(path.join(gameDir, "archive", "pc", "content", "basegame_4_appearance.archive"));

  return {
    wolvenKit: {
      found: Boolean(wolvenKit),
      path: wolvenKit,
      message: wolvenKit
        ? "已找到 WolvenKit CLI，可用于从游戏 archive 导出 REDengine 模型资源。"
        : "未找到 WolvenKit CLI。请把 WolvenKit.CLI.exe 放到 resource 目录，或设置 WOLVENKIT_CLI。",
    },
    blender: {
      found: Boolean(blender),
      path: blender,
      message: blender
        ? "已找到 Blender，可用于合并模型并导出 GLB/STL。"
        : "未找到 Blender。请把 blender.exe 放到 resource\\Blender 目录，或设置 BLENDER_EXE。",
    },
    redMod: {
      found: Boolean(redMod),
      path: redMod,
      message: redMod ? "已找到游戏自带 REDmod，可作为辅助工具。" : "未找到 REDmod。",
    },
    gameDir: {
      found: existsSync(gameDir) && hasArchive,
      path: gameDir,
      message: existsSync(gameDir)
        ? hasArchive
          ? "游戏目录有效，已检测到核心 appearance archive。"
          : "游戏目录存在，但缺少 basegame_4_appearance.archive。"
        : "游戏目录不存在。",
    },
  };
}

function setJob(job: ModelBuildJob, patch: Partial<ModelBuildJob>) {
  Object.assign(job, patch, { updatedAt: new Date().toISOString() });
  jobs.set(job.id, job);
}

function pushLog(job: ModelBuildJob, message: string) {
  if (!message.trim()) {
    return;
  }
  job.logs.push(message.trim());
  job.updatedAt = new Date().toISOString();
}

function createJob(saveId: string, gameDir: string, renderOptions: RenderOptions, parallelism: number): ModelBuildJob {
  const id = randomUUID();
  const job: ModelBuildJob = {
    id,
    saveId,
    gameDir,
    status: "queued",
    progress: 0,
    parallelism,
    title: "等待生成",
    logs: [],
    error: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    renderOptions,
    artifacts: getArtifacts(saveId),
  };
  jobs.set(id, job);
  return job;
}

export function getJob(id: string) {
  return jobs.get(id) || null;
}

async function writeJson(filePath: string, data: unknown) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function createManifest(appearance: VAppearancePreset, tools: ToolStatus, gameDir: string) {
  return {
    generatedAt: new Date().toISOString(),
    gameDir,
    appearance,
    tools,
    note:
      "此 manifest 记录从存档解析出的基础 V 外观映射，以及 WolvenKit/Blender 生成 preview.glb 和 print.stl 的本地工具状态。",
  };
}

function createBuildManifest(
  appearance: VAppearancePreset,
  loadout: VLoadoutPreset,
  tools: ToolStatus,
  gameDir: string,
  renderOptions: RenderOptions,
  parallelism: number,
) {
  return {
    generatedAt: new Date().toISOString(),
    gameDir,
    renderOptions,
    parallelism,
    appearance,
    loadout,
    tools,
    note:
      "此 manifest 记录从存档解析出的 V 外观、装备识别、渲染选项，以及 WolvenKit/Blender 生成 preview.glb、print.stl、print.3mf 的本地工具状态。",
  };
}

function getToolBlockers(tools: ToolStatus) {
  const blockers: string[] = [];
  if (!tools.gameDir.found) {
    blockers.push(tools.gameDir.message);
  }
  if (!tools.wolvenKit.found) {
    blockers.push("缺少 WolvenKit CLI，无法从 .archive 导出 .mesh 资源。");
  }
  if (!tools.blender.found) {
    blockers.push("缺少 Blender，无法合并模型并导出 GLB/STL。");
  }
  return blockers;
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
        reject(new Error(`${path.basename(exe)} 退出码 ${code}`));
      }
    });
  });
}

function captureProcess(exe: string, args: string[], cwd: string, onLog: (line: string) => void, timeoutMs = 120_000) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(exe, args, { cwd, windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${path.basename(exe)} 执行超时`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      const text = String(chunk);
      stdout += text;
      text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !/^\d+%$/.test(line))
        .forEach(onLog);
    });
    child.stderr.on("data", (chunk) => {
      const text = String(chunk);
      stderr += text;
      text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .forEach(onLog);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`${path.basename(exe)} 退出码 ${code}`));
      }
    });
  });
}

function parsePositiveInt(value: string | undefined, fallback: number) {
  const parsed = Number.parseInt(value || "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function clampParallelism(value: number | undefined, fallback: number) {
  return Math.max(1, Math.min(16, parsePositiveInt(String(value), fallback)));
}

function getUncookParallelism() {
  const parallelism = parsePositiveInt(process.env.CP2077_UNCOOK_PARALLELISM, 3);
  return Math.max(1, Math.min(16, parallelism));
}

async function runWithConcurrency<T>(
  taskFactories: Array<() => Promise<T>>,
  limit: number,
  onProgress?: (done: number, total: number) => void,
): Promise<T[]> {
  if (!taskFactories.length) {
    return [];
  }

  const total = taskFactories.length;
  const concurrency = Math.max(1, Math.floor(limit));
  const results = new Array<T>(total);
  let nextIndex = 0;
  let active = 0;
  let done = 0;

  return new Promise((resolve, reject) => {
    const runNext = () => {
      if (done >= total) {
        resolve(results);
        return;
      }

      while (active < concurrency && nextIndex < total) {
        const current = nextIndex++;
        const task = taskFactories[current];
        active++;
        Promise.resolve()
          .then(task)
          .then((value) => {
            results[current] = value;
          })
          .catch(reject)
          .finally(() => {
            active--;
            done++;
            onProgress?.(done, total);
            runNext();
          });
      }
    };

    runNext();
  });
}

function distinctPaths(values: Array<string | undefined>) {
  return [...new Set(values.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim()))];
}

function glbPathForResource(exportDir: string, resourcePath: string) {
  const normalized = resourcePath.replace(/\\/g, "/").replace(/\.mesh$/i, ".glb");
  return path.join(exportDir, ...normalized.split("/"));
}

function resourceFileName(resourcePath: string) {
  return path.basename(resourcePath).replace(/\.mesh$/i, ".glb");
}

type ModelSourceRole = "body" | "head" | "arms" | "hair" | "eyes" | "cyberware" | "clothing" | "weapon";

type ModelSource = {
  role: ModelSourceRole;
  label: string;
  resourcePath: string;
  glbPath: string;
};

function renderModeLabel(mode: BodyMode) {
  if (mode === "save-outfit") {
    return "还原存档穿搭";
  }
  if (mode === "clothing-only") {
    return "仅服装无武器";
  }
  if (mode === "weapons-only") {
    return "仅武器展示";
  }
  return "裸身体";
}

async function uncookMeshResource(
  wolvenKitExe: string,
  gameDir: string,
  resourcePath: string,
  exportDir: string,
  onLog: (line: string) => void,
) {
  const archivePath = path.join(gameDir, "archive", "pc", "content");
  const args = [
    "uncook",
    archivePath,
    "--outpath",
    exportDir,
    "--gamepath",
    gameDir,
    "--pattern",
    resourcePath,
    "--mesh-exporter-type",
    "Default",
    "--mesh-export-type",
    "WithMaterials",
    "--mesh-export-material-repo",
    exportDir,
    "--mesh-export-lod-filter",
    "--verbosity",
    "Minimal",
  ];

  await runProcess(wolvenKitExe, args, workspaceRoot(), onLog);

  const exactGlb = glbPathForResource(exportDir, resourcePath);
  if (existsSync(exactGlb)) {
    return exactGlb;
  }

  const fallback = findFileUnder(exportDir, resourceFileName(resourcePath));
  if (fallback) {
    return fallback;
  }

  throw new Error(`WolvenKit 没有生成 ${resourceFileName(resourcePath)}。`);
}

const archiveSearchCache = new Map<string, Promise<string[]>>();

function itemNameTokens(name: string) {
  return name
    .replace(/^Items\./i, "")
    .replace(/^Preset_/i, "")
    .split(/[^A-Za-z0-9]+/)
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean)
    .filter((part) => !/^(q|sq|mq|ep|dlc)\d+$/i.test(part))
    .filter((part) => !/^(items?|basic|rich|old|common|rare|epic|legendary)$/i.test(part));
}

function meshSearchPatternsForItem(name: string) {
  const tokens = itemNameTokens(name);
  const patterns: string[] = [];
  if (tokens.length >= 2) {
    patterns.push(`*${tokens.join("*")}*.mesh`);
  }
  const garmentWord = tokens.find((token) =>
    /jacket|coat|vest|shirt|tshirt|pants|shorts|boots|shoes|glasses|mask|helmet|hat|outfit|spacesuit|samurai|katana|knife|pistol|revolver|rifle|shotgun|smg|sniper/.test(
      token,
    ),
  );
  if (garmentWord) {
    const descriptive = tokens.filter((token) => token !== garmentWord && !/^\d+$/.test(token));
    if (descriptive.length) {
      patterns.push(`*${garmentWord}*${descriptive.join("*")}*.mesh`);
      patterns.push(`*${descriptive.join("*")}*${garmentWord}*.mesh`);
    }
    patterns.push(`*${garmentWord}*.mesh`);
  }
  return distinctLimited(patterns, 5);
}

function scoreResourcePath(resourcePath: string, itemName: string, variant: VAppearancePreset["bodyVariant"]) {
  const lower = resourcePath.toLowerCase();
  const tokens = itemNameTokens(itemName);
  let score = 0;
  for (const token of tokens) {
    if (lower.includes(token)) {
      score += token.length > 2 ? 4 : 1;
    }
  }
  if (variant === "pma" && /[_\\](ma|mm|mb|m)_/i.test(resourcePath)) {
    score += /_ma_/i.test(resourcePath) ? 8 : 4;
  }
  if (variant === "pwa" && /[_\\](wa|wf|wb|w)_/i.test(resourcePath)) {
    score += /_wa_/i.test(resourcePath) ? 8 : 4;
  }
  if (/shadow|proxy|lod|fpp/i.test(resourcePath)) {
    score -= 6;
  }
  return score;
}

async function searchArchiveMeshesForItem(
  wolvenKitExe: string,
  gameDir: string,
  itemName: string,
  variant: VAppearancePreset["bodyVariant"],
  onLog: (line: string) => void,
) {
  const archiveDir = path.join(gameDir, "archive", "pc", "content");
  const patterns = meshSearchPatternsForItem(itemName);
  const found = new Set<string>();
  for (const pattern of patterns) {
    const cacheKey = `${archiveDir}|${pattern}`;
    if (!archiveSearchCache.has(cacheKey)) {
      archiveSearchCache.set(
        cacheKey,
        captureProcess(
          wolvenKitExe,
          ["archive", archiveDir, "--list", "--pattern", pattern, "--verbosity", "Minimal"],
          workspaceRoot(),
          () => undefined,
        ).then((result) =>
          result.stdout
            .split(/\r?\n|\r/)
            .map((line) => line.trim())
            .filter((line) => /\.mesh$/i.test(line)),
        ),
      );
    }
    const matches = await archiveSearchCache.get(cacheKey)!;
    matches.forEach((match) => found.add(match));
    if (found.size) {
      break;
    }
  }

  const ranked = [...found]
    .map((resourcePath) => ({ resourcePath, score: scoreResourcePath(resourcePath, itemName, variant) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((item) => item.resourcePath);

  if (ranked.length) {
    onLog(`已为 ${itemName} 找到候选 mesh：${ranked[0]}`);
  } else {
    onLog(`未能为 ${itemName} 找到可导出的 mesh。`);
  }
  return ranked.slice(0, 1);
}

type RuntimeResourceHint = {
  record: string;
  entityName: string;
  appearanceName: string;
  itemType: string;
  equipArea: string;
};

type EntityAppearanceMatch = {
  entityPath: string;
  appPath: string;
  entityAppearanceName: string;
  appAppearanceName: string;
};

const ENTITY_RESOURCE_BY_NAME: Record<string, string> = {
  player_face_item: "base\\gameplay\\items\\equipment\\face\\player_face_item.ent",
  player_head_item: "base\\gameplay\\items\\equipment\\hat\\player_head_item.ent",
  player_inner_torso_item: "base\\gameplay\\items\\equipment\\torso\\player_inner_torso_item.ent",
  player_outer_torso_item: "base\\gameplay\\items\\equipment\\torso\\player_outer_torso_item.ent",
  player_legs_item: "base\\gameplay\\items\\equipment\\legs\\player_legs_item.ent",
  player_feet_item: "base\\gameplay\\items\\equipment\\feet\\player_feet_item.ent",
  player_outfit_item: "base\\gameplay\\items\\equipment\\outfit\\player_outfit_item.ent",
};

function getJsonString(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value && typeof value === "object" && "$value" in value) {
    return String((value as { $value?: unknown }).$value || "");
  }
  return "";
}

function hintValue(slot: LoadoutSlot, key: string) {
  const prefix = `${key}:`;
  const match = slot.rawHints.find((hint) => hint.toLowerCase().startsWith(prefix.toLowerCase()));
  return match ? match.slice(prefix.length).trim() : "";
}

function slotRuntimeHint(slot: LoadoutSlot): RuntimeResourceHint | null {
  const entityName = hintValue(slot, "entityName");
  const appearanceName = hintValue(slot, "appearanceName");
  const itemType = hintValue(slot, "itemType");
  const equipArea = hintValue(slot, "equipArea");
  const records = slot.rawHints.filter((hint) => /^Items\./i.test(hint));
  const record =
    records.find((hint) => /StrongArms|Cyberware|Cyb_/i.test(`${hint} ${entityName} ${itemType} ${equipArea}`)) ||
    records[0] ||
    "";
  if (!record && !entityName && !appearanceName) {
    return null;
  }
  return { record, entityName, appearanceName, itemType, equipArea };
}

function resourceJsonOutDir(saveId: string) {
  return path.join(getSaveModelCacheDir(saveId), "serialized-resources");
}

async function readSerializedResourceJson(
  wolvenKitExe: string,
  gameDir: string,
  saveId: string,
  resourcePath: string,
  onLog: (line: string) => void,
) {
  const graph = await serializeResourceGraph(wolvenKitExe, gameDir, resourcePath, resourceJsonOutDir(saveId), onLog);
  if (!graph.jsonPath || !existsSync(graph.jsonPath)) {
    return null;
  }
  return JSON.parse(await fsp.readFile(graph.jsonPath, "utf8"));
}

function collectMeshPaths(value: unknown, result = new Set<string>()) {
  if (!value || typeof value !== "object") {
    return result;
  }

  if (
    "$type" in value &&
    "$value" in value &&
    String((value as { $type?: unknown }).$type).toLowerCase() === "resourcepath"
  ) {
    const resourcePath = String((value as { $value?: unknown }).$value || "").replace(/\//g, "\\");
    if (/\.mesh$/i.test(resourcePath) && !/\\shadow_meshes\\/i.test(resourcePath)) {
      result.add(resourcePath);
    }
  }

  if (Array.isArray(value)) {
    value.forEach((item) => collectMeshPaths(item, result));
  } else {
    Object.values(value).forEach((item) => collectMeshPaths(item, result));
  }

  return result;
}

function scoreEntityAppearance(
  item: { name: string; appAppearanceName: string },
  hint: RuntimeResourceHint,
  appearance: VAppearancePreset,
) {
  const wanted = hint.appearanceName.toLowerCase();
  const name = item.name.toLowerCase();
  const appName = item.appAppearanceName.toLowerCase();
  let score = 0;
  if (wanted && name === wanted) score += 80;
  if (wanted && name.startsWith(wanted)) score += 60;
  if (wanted && name.includes(wanted)) score += 40;
  if (wanted && appName.includes(wanted.replace(/^set_01/, ""))) score += 20;
  if (appearance.bodyGender === "Female" && name.includes("&female")) score += 12;
  if (appearance.bodyGender === "Male" && name.includes("&male")) score += 12;
  if (name.includes("&tpp")) score += 6;
  if (name.includes("&fpp")) score -= 10;
  if (appName.includes("_fpp")) score -= 10;
  return score;
}

async function resolveEntityAppearance(
  hint: RuntimeResourceHint,
  job: ModelBuildJob,
  appearance: VAppearancePreset,
  tools: ToolStatus,
): Promise<EntityAppearanceMatch | null> {
  if (!tools.wolvenKit.path || !hint.entityName || !hint.appearanceName) {
    return null;
  }

  const entityPath = ENTITY_RESOURCE_BY_NAME[hint.entityName];
  if (!entityPath) {
    pushLog(job, `${hint.record || hint.entityName} 暂不支持 entityName=${hint.entityName} 的自动实体解析。`);
    return null;
  }

  const json = await readSerializedResourceJson(tools.wolvenKit.path, job.gameDir, job.saveId, entityPath, (line) =>
    pushLog(job, line),
  );
  const appearances = json?.Data?.RootChunk?.appearances;
  if (!Array.isArray(appearances)) {
    pushLog(job, `${entityPath} 未找到 appearances 列表。`);
    return null;
  }

  const candidates = appearances
    .map((entry: unknown) => {
      const data = (entry as { Data?: unknown })?.Data || entry;
      const appPath = getJsonString((data as { appearanceResource?: { DepotPath?: unknown } })?.appearanceResource?.DepotPath);
      const name = getJsonString((data as { name?: unknown })?.name);
      const appAppearanceName = getJsonString((data as { appearanceName?: unknown })?.appearanceName);
      return {
        appPath,
        name,
        appAppearanceName,
        score: scoreEntityAppearance({ name, appAppearanceName }, hint, appearance),
      };
    })
    .filter((item) => item.appPath && item.appAppearanceName && item.score > 0)
    .sort((a, b) => b.score - a.score);

  const best = candidates[0];
  if (!best) {
    pushLog(job, `${hint.record || hint.appearanceName} 未在 ${entityPath} 中匹配到 ${hint.appearanceName}。`);
    return null;
  }

  pushLog(job, `${hint.record || hint.appearanceName} -> ${best.name} -> ${best.appPath} / ${best.appAppearanceName}`);
  return {
    entityPath,
    appPath: best.appPath,
    entityAppearanceName: best.name,
    appAppearanceName: best.appAppearanceName,
  };
}

function scoreAppAppearance(name: string, target: string) {
  const current = name.toLowerCase();
  const wanted = target.toLowerCase();
  let score = 0;
  if (current === wanted) score += 100;
  if (current.includes(wanted)) score += 80;
  if (current.includes(wanted.replace(/_fpp$/i, ""))) score += 30;
  if (current.includes("_fpp")) score -= 20;
  return score;
}

async function resolveAppAppearanceMeshes(match: EntityAppearanceMatch, job: ModelBuildJob, tools: ToolStatus) {
  if (!tools.wolvenKit.path) {
    return [];
  }
  const json = await readSerializedResourceJson(tools.wolvenKit.path, job.gameDir, job.saveId, match.appPath, (line) =>
    pushLog(job, line),
  );
  const appearances = json?.Data?.RootChunk?.appearances;
  if (!Array.isArray(appearances)) {
    pushLog(job, `${match.appPath} 未找到 appearances 列表。`);
    return [];
  }

  const candidates = appearances
    .map((entry: unknown) => {
      const data = (entry as { Data?: unknown })?.Data || entry;
      const name = getJsonString((data as { name?: unknown })?.name);
      return {
        name,
        data,
        score: scoreAppAppearance(name, match.appAppearanceName),
      };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);

  const best = candidates[0];
  if (!best) {
    pushLog(job, `${match.appPath} 未找到 appearance=${match.appAppearanceName} 的 mesh 分支。`);
    return [];
  }

  const meshes = [...collectMeshPaths(best.data)];
  if (meshes.length) {
    pushLog(job, `${match.appAppearanceName} 解析到 ${meshes.length} 个 mesh。`);
  } else {
    pushLog(job, `${match.appAppearanceName} 没有解析到 mesh。`);
  }
  return meshes;
}

function strongArmsMeshes(variant: VAppearancePreset["bodyVariant"]) {
  const prefix =
    variant === "pma"
      ? "base\\characters\\cyberware\\player\\a0_005__strongarms\\entities\\meshes\\a0_005_ma__strongarms"
      : "base\\characters\\cyberware\\player\\a0_005__strongarms\\entities\\meshes\\a0_005_wa__strongarms";
  return [`${prefix}_l.mesh`, `${prefix}_r.mesh`, `${prefix}_cyberware_l.mesh`, `${prefix}_cyberware_r.mesh`];
}

async function resolveRuntimeSlotMeshes(
  role: "clothing" | "weapon",
  slot: LoadoutSlot,
  job: ModelBuildJob,
  appearance: VAppearancePreset,
  tools: ToolStatus,
) {
  const hint = slotRuntimeHint(slot);
  if (!hint) {
    return [];
  }

  const text = `${hint.record} ${hint.entityName} ${hint.itemType} ${hint.equipArea}`;
  if (role === "weapon" && /StrongArms|Cyb_StrongArms|ArmsCW|a0_005__strongarms/i.test(text)) {
    const meshes = strongArmsMeshes(appearance.bodyVariant);
    pushLog(job, `${hint.record || "StrongArms"} 使用大猩猩手臂 mesh：${meshes.join("、")}`);
    return meshes;
  }

  if (role !== "clothing") {
    return [];
  }

  const match = await resolveEntityAppearance(hint, job, appearance, tools);
  if (!match) {
    return [];
  }
  return resolveAppAppearanceMeshes(match, job, tools);
}

async function resolveLoadoutResources(
  role: "clothing" | "weapon",
  slots: LoadoutSlot[],
  job: ModelBuildJob,
  appearance: VAppearancePreset,
  tools: ToolStatus,
) {
  const explicit = slots
    .flatMap((slot) => slot.resolvedResourcePaths)
    .filter((resourcePath) => /\.mesh$/i.test(resourcePath));
  if (!tools.wolvenKit.path) {
    return explicit;
  }

  const slotOrder =
    role === "clothing"
      ? ["OuterChest", "InnerChest", "Legs", "Feet", "Face", "Head", "Outfit"]
      : ["PrimaryWeapon", "Sidearm", "Melee", "QuickSlot"];
  const names: string[] = [];
  for (const slotId of slotOrder) {
    const slot = slots.find((item) => item.slot === slotId);
    if (!slot) {
      continue;
    }
    const slotNames = slot.rawHints.filter((hint) => /^Items\./i.test(hint));
    if (role === "clothing" && slotId !== "Outfit") {
      names.push(...slotNames.filter((name) => !/Outfit|Spacesuit/i.test(name)).slice(0, 1));
    } else {
      names.push(...slotNames.slice(0, 1));
    }
  }

  if (names.length) {
    pushLog(
      job,
      `已识别到 ${role === "clothing" ? "服装" : "武器"} TweakDB 线索：${names
        .slice(0, 6)
        .join("、")}。严格还原模式不会再用文件名猜测 mesh，下一步需要解析 TweakDB -> .ent/.app -> 组件 mesh 的真实链路。`,
    );
  }

  const resolved: string[] = [...explicit];
  for (const slotId of slotOrder) {
    const slot = slots.find((item) => item.slot === slotId);
    if (!slot?.detected) {
      continue;
    }
    const meshes = await resolveRuntimeSlotMeshes(role, slot, job, appearance, tools);
    resolved.push(...meshes);
  }

  return distinctLimited(resolved, role === "clothing" ? 18 : 10);
}

async function probeHeuristicLoadoutCandidates(
  role: "clothing" | "weapon",
  slots: LoadoutSlot[],
  job: ModelBuildJob,
  appearance: VAppearancePreset,
  tools: ToolStatus,
) {
  const discovered: string[] = [];
  if (!tools.wolvenKit.path) {
    return discovered;
  }

  const slotOrder =
    role === "clothing"
      ? ["OuterChest", "InnerChest", "Legs", "Feet", "Face", "Head", "Outfit"]
      : ["PrimaryWeapon", "Sidearm", "Melee", "QuickSlot"];
  const names: string[] = [];
  for (const slotId of slotOrder) {
    const slot = slots.find((item) => item.slot === slotId);
    if (!slot) {
      continue;
    }
    const slotNames = slot.rawHints.filter((hint) => /^Items\./i.test(hint));
    names.push(...slotNames.slice(0, 1));
  }

  for (const name of names) {
    const matches = await searchArchiveMeshesForItem(
      tools.wolvenKit.path,
      job.gameDir,
      name,
      appearance.bodyVariant,
      (line) => pushLog(job, line),
    );
    const usable =
      role === "clothing" ? matches.filter((resourcePath) => /\\characters\\garment\\/i.test(resourcePath)) : matches;
    if (role === "clothing" && matches.length && !usable.length) {
      pushLog(job, `${name} 的候选资源不是角色服装 mesh，已跳过。`);
    }
    discovered.push(...usable);
  }

  return distinctLimited(discovered, role === "clothing" ? 7 : 4);
}

async function writeBlenderAssemblyScript(saveId: string, appearance: VAppearancePreset, sourceGlbs: string[]) {
  const scriptPath = artifactPath(saveId, "assemble_v_model.py");
  const preview = artifactPath(saveId, "preview.glb").replace(/\\/g, "\\\\");
  const stl = artifactPath(saveId, "print.stl").replace(/\\/g, "\\\\");
  const label = `${appearance.bodyVariant.toUpperCase()} ${appearance.bodyGender} V`;
  const inputs = JSON.stringify(sourceGlbs.map((item) => item.replace(/\\/g, "\\\\")), null, 2);
  const script = `import bpy
import os
from mathutils import Vector

bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete()

INPUTS = ${inputs}

def import_glb(path):
    if os.path.exists(path):
        bpy.ops.import_scene.gltf(filepath=path)
        return True
    return False

loaded = False
for item in INPUTS:
    print("import", item)
    loaded = import_glb(item) or loaded

if not loaded:
    raise SystemExit("No GLB files were available for Blender import.")

mesh_objects = [obj for obj in bpy.context.scene.objects if obj.type == 'MESH']
if not mesh_objects:
    raise SystemExit("No mesh objects were imported.")

for obj in mesh_objects:
    obj.name = "${label} " + obj.name
    obj.select_set(True)

coords = []
for obj in mesh_objects:
    coords.extend([obj.matrix_world @ Vector(corner) for corner in obj.bound_box])

min_x = min(point.x for point in coords)
max_x = max(point.x for point in coords)
min_y = min(point.y for point in coords)
max_y = max(point.y for point in coords)
min_z = min(point.z for point in coords)
offset = Vector(((min_x + max_x) / 2.0, (min_y + max_y) / 2.0, min_z))

for obj in bpy.context.scene.objects:
    if obj.parent is None:
        obj.location -= offset

bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
bpy.ops.export_scene.gltf(filepath=r"${preview}", export_format='GLB')

bpy.ops.object.select_all(action='DESELECT')
for obj in mesh_objects:
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj

try:
    bpy.ops.export_mesh.stl(filepath=r"${stl}", use_selection=True)
except Exception:
    bpy.ops.wm.stl_export(filepath=r"${stl}", export_selected_objects=True)
`;
  await fsp.writeFile(scriptPath, script, "utf8");
  return scriptPath;
}

async function writeEnhancedBlenderAssemblyScript(
  saveId: string,
  appearance: VAppearancePreset,
  sources: ModelSource[],
  renderOptions: RenderOptions,
) {
  const scriptPath = artifactPath(saveId, "assemble_v_model.py");
  const preview = artifactPath(saveId, "preview.glb").replace(/\\/g, "\\\\");
  const stl = artifactPath(saveId, "print.stl").replace(/\\/g, "\\\\");
  const threeMf = artifactPath(saveId, "print.3mf").replace(/\\/g, "\\\\");
  const visualThreeMf = artifactPath(saveId, "print.visual.3mf").replace(/\\/g, "\\\\");
  const label = `${appearance.bodyVariant.toUpperCase()} ${appearance.bodyGender} V`;
  const inputs = JSON.stringify(
    sources.map((source) => ({
      ...source,
      glbPath: source.glbPath.replace(/\\/g, "\\\\"),
    })),
    null,
    2,
  );
  const options = JSON.stringify(renderOptions, null, 2);
  const traitText = appearance.parsedFields.map((field) => `${field.key}:${field.value}`).join(" ").toLowerCase();
  const skinColor = /limestone/.test(traitText)
    ? [0.72, 0.52, 0.40, 1]
    : appearance.bodyVariant === "pwa"
      ? [0.78, 0.52, 0.39, 1]
      : [0.68, 0.42, 0.29, 1];
  const hairColor = /teal/.test(traitText)
    ? [0.02, 0.42, 0.46, 1]
    : /brown/.test(traitText)
      ? [0.18, 0.10, 0.055, 1]
      : [0.045, 0.038, 0.035, 1];
  const eyeColor = /green/.test(traitText)
    ? [0.22, 0.75, 0.36, 1]
    : /brown/.test(traitText)
      ? [0.36, 0.20, 0.10, 1]
      : [0.18, 0.72, 0.95, 1];
  const inputsLiteral = JSON.stringify(inputs);
  const optionsLiteral = JSON.stringify(options);
  const skinColorLiteral = JSON.stringify(JSON.stringify(skinColor));
  const hairColorLiteral = JSON.stringify(JSON.stringify(hairColor));
  const eyeColorLiteral = JSON.stringify(JSON.stringify(eyeColor));
  const script = `import bpy
import os
import json
import zipfile
import bmesh
from mathutils import Vector
from xml.sax.saxutils import escape

bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete()

INPUTS = json.loads(${inputsLiteral})
OPTIONS = json.loads(${optionsLiteral})
SKIN_COLOR = json.loads(${skinColorLiteral})
HAIR_COLOR = json.loads(${hairColorLiteral})
EYE_COLOR = json.loads(${eyeColorLiteral})

def make_material(name, color, roughness=0.62, metallic=0.0):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if bsdf:
        bsdf.inputs["Base Color"].default_value = color
        bsdf.inputs["Roughness"].default_value = roughness
        bsdf.inputs["Metallic"].default_value = metallic
    mat.diffuse_color = color
    return mat

MATERIALS = {
    "skin": make_material("V skin warm base", SKIN_COLOR, 0.68, 0.0),
    "hair": make_material("V hair near black", HAIR_COLOR, 0.72, 0.0),
    "eyes": make_material("V eye blue emissive", EYE_COLOR, 0.22, 0.0),
    "cyberware": make_material("Cyberware gunmetal", (0.50, 0.54, 0.58, 1.0), 0.34, 0.55),
    "shirt": make_material("Q203 shirt charcoal", (0.13, 0.15, 0.18, 1.0), 0.80, 0.0),
    "pants": make_material("Q203 pants dark graphite", (0.08, 0.085, 0.095, 1.0), 0.86, 0.0),
    "shoes": make_material("Q203 shoes worn brown", (0.19, 0.145, 0.105, 1.0), 0.78, 0.0),
    "glasses": make_material("Q203 glasses smoked metal", (0.035, 0.04, 0.05, 1.0), 0.32, 0.35),
    "clothing": make_material("Save clothing neutral cloth", (0.18, 0.19, 0.21, 1.0), 0.82, 0.0),
    "weapon": make_material("Weapon dark metal", (0.30, 0.31, 0.32, 1.0), 0.42, 0.7),
    "fallback": make_material("Neutral fallback", (0.62, 0.64, 0.66, 1.0), 0.7, 0.0),
}

def material_key_for_source(source):
    role = source.get("role", "fallback")
    resource = source.get("resourcePath", "").lower().replace("/", "\\\\")
    if role in ("body", "head", "arms"):
        return "skin"
    if role == "hair":
        return "hair"
    if role == "eyes":
        return "eyes"
    if role == "cyberware":
        return "cyberware"
    if role == "weapon":
        if "strongarms" in resource:
            return "cyberware"
        return "weapon"
    if role == "clothing":
        if "\\\\torso\\\\" in resource or "tshirt" in resource or "tank" in resource or "shirt" in resource:
            return "shirt"
        if "\\\\legs\\\\" in resource or "pants" in resource or "shorts" in resource:
            return "pants"
        if "\\\\feet\\\\" in resource or "shoe" in resource or "boots" in resource:
            return "shoes"
        if "\\\\head\\\\" in resource or "glasses" in resource or "specs" in resource or "mask" in resource:
            return "glasses"
        return "clothing"
    return "fallback"

def material_for_source(source):
    return MATERIALS.get(material_key_for_source(source), MATERIALS["fallback"])

def assign_material(source, obj):
    mat = material_for_source(source)
    obj.data.materials.clear()
    obj.data.materials.append(mat)
    for poly in obj.data.polygons:
        poly.material_index = 0
    obj["cp2077_material_key"] = material_key_for_source(source)

def import_source(source):
    path = source["glbPath"]
    if not os.path.exists(path):
        print("skip missing", path)
        return []
    before = set(bpy.context.scene.objects)
    print("import", source["role"], path)
    bpy.ops.import_scene.gltf(filepath=path)
    added = [obj for obj in bpy.context.scene.objects if obj not in before and obj.type == "MESH"]
    for obj in added:
        obj.name = "${label} " + source["label"] + " " + obj.name
        obj["cp2077_role"] = source["role"]
        obj["cp2077_source"] = source["resourcePath"]
        assign_material(source, obj)
        obj.select_set(True)
    return added

mesh_objects = []
for source in INPUTS:
    mesh_objects.extend(import_source(source))

if not mesh_objects:
    raise SystemExit("No mesh objects were imported.")

coords = []
for obj in mesh_objects:
    coords.extend([obj.matrix_world @ Vector(corner) for corner in obj.bound_box])

min_x = min(point.x for point in coords)
max_x = max(point.x for point in coords)
min_y = min(point.y for point in coords)
max_y = max(point.y for point in coords)
min_z = min(point.z for point in coords)
offset = Vector(((min_x + max_x) / 2.0, (min_y + max_y) / 2.0, min_z))

for obj in bpy.context.scene.objects:
    if obj.parent is None:
        obj.location -= offset

bpy.ops.object.select_all(action='DESELECT')
for obj in mesh_objects:
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj

bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
bpy.ops.export_scene.gltf(filepath=r"${preview}", export_format='GLB', export_materials='EXPORT')

try:
    bpy.ops.export_mesh.stl(filepath=r"${stl}", use_selection=True)
except Exception:
    bpy.ops.wm.stl_export(filepath=r"${stl}", export_selected_objects=True)

BASE_MATERIALS = [
    ("Skin", "#AD6B4AFF"),
    ("Hair", "#0B0909FF"),
    ("Eyes", "#2EB8F2FF"),
    ("Cyberware", "#808A94FF"),
    ("Shirt", "#22262EFF"),
    ("Pants", "#151820FF"),
    ("Shoes", "#30251BFF"),
    ("Glasses", "#090B0EFF"),
    ("Clothing", "#2E3035FF"),
    ("Weapon", "#4D5052FF"),
    ("Fallback", "#9EA3A8FF"),
]

MATERIAL_INDEX = {
    "skin": 0,
    "hair": 1,
    "eyes": 2,
    "cyberware": 3,
    "shirt": 4,
    "pants": 5,
    "shoes": 6,
    "glasses": 7,
    "clothing": 8,
    "weapon": 9,
    "fallback": 10,
}

def material_index_for_object(obj):
    return MATERIAL_INDEX.get(obj.get("cp2077_material_key", "fallback"), MATERIAL_INDEX["fallback"])

def mesh_open_edge_count(mesh):
    edge_counts = {}
    for poly in mesh.polygons:
        vertices = list(poly.vertices)
        for i, start in enumerate(vertices):
            end = vertices[(i + 1) % len(vertices)]
            edge = tuple(sorted((int(start), int(end))))
            edge_counts[edge] = edge_counts.get(edge, 0) + 1
    return sum(1 for count in edge_counts.values() if count == 1)

def mesh_nonmanifold_edge_count(mesh):
    edge_counts = {}
    for poly in mesh.polygons:
        vertices = list(poly.vertices)
        for i, start in enumerate(vertices):
            end = vertices[(i + 1) % len(vertices)]
            edge = tuple(sorted((int(start), int(end))))
            edge_counts[edge] = edge_counts.get(edge, 0) + 1
    return sum(1 for count in edge_counts.values() if count != 2)

def object_mesh_copy(obj, name_suffix):
    depsgraph = bpy.context.evaluated_depsgraph_get()
    eval_obj = obj.evaluated_get(depsgraph)
    mesh = bpy.data.meshes.new_from_object(eval_obj, depsgraph=depsgraph)
    mesh.transform(obj.matrix_world)
    mesh.update()
    copy = bpy.data.objects.new(obj.name + name_suffix, mesh)
    copy["cp2077_role"] = obj.get("cp2077_role", "fallback")
    copy["cp2077_source"] = obj.get("cp2077_source", "")
    copy["cp2077_material_key"] = obj.get("cp2077_material_key", "fallback")
    bpy.context.collection.objects.link(copy)
    return copy

def repair_mesh_object(obj):
    mesh = obj.data
    before_open = mesh_open_edge_count(mesh)
    before_nonmanifold = mesh_nonmanifold_edge_count(mesh)
    bm = bmesh.new()
    bm.from_mesh(mesh)
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_edges], context='VERTS')
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=0.00035)
    degenerate_edges = [edge for edge in bm.edges if edge.calc_length() < 0.00001]
    if degenerate_edges:
        bmesh.ops.delete(bm, geom=degenerate_edges, context='EDGES')
    boundary_edges = [edge for edge in bm.edges if edge.is_boundary]
    if boundary_edges:
        try:
            bmesh.ops.holes_fill(bm, edges=boundary_edges, sides=0)
        except Exception as error:
            print("3MF hole fill warning", obj.name, error)
    if bm.faces:
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        bmesh.ops.triangulate(bm, faces=bm.faces)
    bm.to_mesh(mesh)
    bm.free()
    mesh.update()
    after_open = mesh_open_edge_count(mesh)
    after_nonmanifold = mesh_nonmanifold_edge_count(mesh)
    print(
        "3MF repair",
        obj.name,
        "open_edges",
        before_open,
        "->",
        after_open,
        "nonmanifold_edges",
        before_nonmanifold,
        "->",
        after_nonmanifold,
    )
    return after_open, after_nonmanifold

def make_print_objects(objects):
    print_objects = []
    for source in objects:
        role = source.get("cp2077_role", "fallback")
        material_key = source.get("cp2077_material_key", "fallback")
        copy = object_mesh_copy(source, "_print")
        print_objects.append(copy)
        repair_mesh_object(copy)
        if role in ("clothing", "weapon") or material_key in ("shoes", "pants", "cyberware"):
            modifier = copy.modifiers.new("print shell thickness", "SOLIDIFY")
            modifier.thickness = 0.0018
            modifier.offset = 0.0
            modifier.use_quality_normals = True
            bpy.context.view_layer.objects.active = copy
            copy.select_set(True)
            try:
                bpy.ops.object.modifier_apply(modifier=modifier.name)
                repair_mesh_object(copy)
            except Exception as error:
                print("3MF solidify warning", copy.name, error)
            copy.select_set(False)
    return print_objects

def export_3mf(filepath, objects):
    depsgraph = bpy.context.evaluated_depsgraph_get()
    object_xml = []
    build_xml = []
    object_id = 2

    for obj in objects:
        eval_obj = obj.evaluated_get(depsgraph)
        mesh = bpy.data.meshes.new_from_object(eval_obj, depsgraph=depsgraph)
        try:
            mesh.calc_loop_triangles()
            if not mesh.vertices or not mesh.loop_triangles:
                continue
            vertices = []
            for vertex in mesh.vertices:
                co = obj.matrix_world @ vertex.co
                vertices.append(f'<vertex x="{co.x:.6f}" y="{co.y:.6f}" z="{co.z:.6f}"/>')
            triangles = []
            for tri in mesh.loop_triangles:
                v0, v1, v2 = tri.vertices
                triangles.append(f'<triangle v1="{v0}" v2="{v1}" v3="{v2}" pid="1" pindex="{material_index_for_object(obj)}"/>')
            pindex = material_index_for_object(obj)
            safe_name = escape(obj.name)
            object_xml.append(
                f'<object id="{object_id}" type="model" name="{safe_name}" pid="1" pindex="{pindex}"><mesh><vertices>'
                + "".join(vertices)
                + "</vertices><triangles>"
                + "".join(triangles)
                + "</triangles></mesh></object>"
            )
            build_xml.append(f'<item objectid="{object_id}"/>')
            object_id += 1
        finally:
            bpy.data.meshes.remove(mesh)

    if not object_xml:
        raise SystemExit("No printable mesh data for 3MF export.")

    materials = "".join([f'<base name="{escape(name)}" displaycolor="{color}"/>' for name, color in BASE_MATERIALS])
    model_xml = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<model unit="meter" xml:lang="zh-CN" '
        'xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" '
        'xmlns:m="http://schemas.microsoft.com/3dmanufacturing/material/2015/02" requiredextensions="m">'
        '<resources><basematerials id="1">'
        + materials
        + '</basematerials>'
        + "".join(object_xml)
        + '</resources><build>'
        + "".join(build_xml)
        + '</build></model>'
    )
    content_types = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>'
        '</Types>'
    )
    rels = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Target="/3D/3dmodel.model" Id="rel0" '
        'Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>'
        '</Relationships>'
    )
    with zipfile.ZipFile(filepath, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", content_types)
        archive.writestr("_rels/.rels", rels)
        archive.writestr("3D/3dmodel.model", model_xml)

if OPTIONS.get("export3mf", True):
    export_3mf(r"${visualThreeMf}", mesh_objects)
    print_objects = make_print_objects(mesh_objects)
    try:
        export_3mf(r"${threeMf}", print_objects)
    finally:
        for obj in print_objects:
            mesh = obj.data
            bpy.data.objects.remove(obj, do_unlink=True)
            bpy.data.meshes.remove(mesh, do_unlink=True)
`;
  await fsp.writeFile(scriptPath, script, "utf8");
  return scriptPath;
}

async function attemptExternalBuild(job: ModelBuildJob, appearance: VAppearancePreset, tools: ToolStatus) {
  if (!tools.wolvenKit.path || !tools.blender.path) {
    throw new Error("缺少 WolvenKit 或 Blender。");
  }

  const resources =
    "resourcePaths" in appearance
      ? appearance.resourcePaths
      : (appearance as VAppearancePreset & { mappedResources?: VAppearancePreset["resourcePaths"] }).mappedResources;
  const bodyMesh = resources?.bodyMesh;
  const headMesh = resources?.headMesh;
  if (!bodyMesh || !headMesh) {
    throw new Error("存档外观没有映射到可导出的 body/head 资源。");
  }

  const cacheDir = getSaveModelCacheDir(job.saveId);
  const exportDir = path.join(cacheDir, "wolvenkit-export");
  await fsp.rm(exportDir, { recursive: true, force: true });
  await fsp.mkdir(exportDir, { recursive: true });

  pushLog(job, "开始用 WolvenKit 从游戏资源导出基础身体模型。");
  setJob(job, { progress: 52, title: "导出身体模型" });
  const bodyGlb = await uncookMeshResource(tools.wolvenKit.path, job.gameDir, bodyMesh, exportDir, (line) =>
    pushLog(job, line),
  );

  pushLog(job, "开始用 WolvenKit 从游戏资源导出基础头部模型。");
  setJob(job, { progress: 68, title: "导出头部模型" });
  const headGlb = await uncookMeshResource(tools.wolvenKit.path, job.gameDir, headMesh, exportDir, (line) =>
    pushLog(job, line),
  );

  const sourceGlbs = [bodyGlb, headGlb];
  await writeJson(artifactPath(job.saveId, "model-sources.json"), {
    generatedAt: new Date().toISOString(),
    bodyMesh,
    headMesh,
    sourceGlbs,
  });

  pushLog(job, "开始用 Blender 合并 body/head，并导出预览 GLB 与打印 STL。");
  setJob(job, { progress: 82, title: "合并并导出模型" });
  const scriptPath = await writeBlenderAssemblyScript(job.saveId, appearance, sourceGlbs);
  await runProcess(tools.blender.path, ["--background", "--python", scriptPath], cacheDir, (line) => pushLog(job, line));

  const artifacts = getArtifacts(job.saveId);
  if (!artifacts.hasPreview || !artifacts.hasPrintable) {
    throw new Error("Blender 运行完成，但没有生成 preview.glb 或 print.stl。");
  }

  pushLog(job, "模型生成完成：preview.glb 与 print.stl 已写入缓存目录。");
  setJob(job, { progress: 96, title: "模型导出完成", artifacts });
}

async function attemptEnhancedExternalBuild(
  job: ModelBuildJob,
  appearance: VAppearancePreset,
  loadout: VLoadoutPreset,
  tools: ToolStatus,
  renderOptions: RenderOptions,
  parallelism?: number,
) {
  if (!tools.wolvenKit.path || !tools.blender.path) {
    throw new Error("缺少 WolvenKit 或 Blender。");
  }

  const resources = appearance.resourcePaths;
  if (!resources.bodyMesh || !resources.headMesh) {
    throw new Error("存档外观没有映射到可导出的 body/head 资源。");
  }

  const cacheDir = getSaveModelCacheDir(job.saveId);
  const exportDir = path.join(cacheDir, "wolvenkit-export");
  await fsp.rm(exportDir, { recursive: true, force: true });
  await fsp.mkdir(exportDir, { recursive: true });

  const sources: ModelSource[] = [];
  const missingOptional: string[] = [];
  const effectiveParallelism = clampParallelism(parallelism, getUncookParallelism());
  pushLog(job, `使用并行任务数：${effectiveParallelism}。`);

  async function addMesh(role: ModelSourceRole, label: string, resourcePath: string, required: boolean) {
    if (!resourcePath) {
      if (!required) {
        missingOptional.push(`${label} 没有可用资源路径`);
      }
      return;
    }
    try {
      const glbPath = await uncookMeshResource(tools.wolvenKit.path!, job.gameDir, resourcePath, exportDir, (line) =>
        pushLog(job, line),
      );
      sources.push({ role, label, resourcePath, glbPath });
      pushLog(job, `已导出 ${label}：${resourcePath}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (required) {
        throw new Error(`${label} 导出失败：${message}`);
      }
      missingOptional.push(`${label} 导出失败：${message}`);
      pushLog(job, `${label} 未合并：${message}`);
    }
  }

  const runMeshBatch = async (
    title: string,
    startProgress: number,
    endProgress: number,
    taskEntries: Array<() => Promise<void>>,
  ) => {
    if (!taskEntries.length) {
      setJob(job, { progress: endProgress, title });
      return;
    }

    await runWithConcurrency(taskEntries, effectiveParallelism, (done, total) => {
      const progress = total ? startProgress + (done / total) * (endProgress - startProgress) : endProgress;
      setJob(job, { progress: Math.round(progress), title });
    });
  };

  pushLog(job, `渲染模式：${renderModeLabel(renderOptions.bodyMode)}。`);
  await runMeshBatch(
    "导出裸身体基础模型",
    50,
    68,
    [
      () => addMesh("body", "身体/躯干/腿部", resources.bodyMesh, true),
      () => addMesh("head", "头部", resources.headMesh, true),
      () => addMesh("arms", "手臂/手", resources.armsMesh, true),
    ],
  );

  await runMeshBatch(
    "导出头发/眼睛/义体",
    68,
    70,
    [
      ...distinctPaths(resources.hairMeshes).map((resourcePath) => () => addMesh("hair", "发型", resourcePath, false)),
      ...distinctPaths(resources.eyeMeshes).map((resourcePath) => () => addMesh("eyes", "眼睛", resourcePath, false)),
      ...distinctPaths(resources.cyberwareMeshes).map((resourcePath) =>
        () => addMesh("cyberware", "义体外观", resourcePath, false),
      ),
    ],
  );

  let clothingResources: string[] = [];
  let weaponResources: string[] = [];
  const attachmentResources = loadout.attachmentSlots.flatMap((slot) => slot.resolvedResourcePaths);

  if (renderOptions.includeSaveClothing || renderOptions.bodyMode === "save-outfit" || renderOptions.bodyMode === "clothing-only") {
    setJob(job, { progress: 72, title: "搜索并导出存档服装" });
    clothingResources = await resolveLoadoutResources("clothing", loadout.clothingSlots, job, appearance, tools);
    if (!clothingResources.length) {
      throw new Error(
        "已启用存档服装，但当前还没有从存档解析出精确的服装 .ent/.app/.mesh 资源链路。为避免生成错误穿搭，已停止构建；下一步需要完成 TweakDB -> entity/app -> mesh 解析，或从游戏运行时导出当前装备状态。",
      );
    }
    await runMeshBatch(
      "搜索并导出存档服装",
      72,
      80,
      distinctPaths(clothingResources).map((resourcePath) => () => addMesh("clothing", "存档服装", resourcePath, false)),
    );
  }

  if (renderOptions.includeSaveWeapons || renderOptions.bodyMode === "save-outfit" || renderOptions.bodyMode === "weapons-only") {
    setJob(job, { progress: 76, title: "搜索并导出存档武器" });
    weaponResources = await resolveLoadoutResources("weapon", loadout.weaponSlots, job, appearance, tools);
    if (!weaponResources.length) {
      throw new Error(
        "已启用存档武器，但当前还没有从存档解析出精确的武器 .ent/.app/.mesh 资源链路。为避免生成错误武器，已停止构建；下一步需要完成 TweakDB -> entity/app -> mesh 解析，或从游戏运行时导出当前装备状态。",
      );
    }
    await runMeshBatch(
      "搜索并导出存档武器",
      80,
      86,
      distinctPaths(weaponResources).map((resourcePath) => () => addMesh("weapon", "存档武器", resourcePath, false)),
    );
  }

  if (renderOptions.includeWeaponAttachments) {
    if (!attachmentResources.length) {
      pushLog(job, "已启用武器附件，但当前没有解析到可直接导出的附件 mesh。");
    }
    await runMeshBatch(
      "导出武器附件",
      86,
      90,
      distinctPaths(attachmentResources).map((resourcePath) => () => addMesh("weapon", "武器附件", resourcePath, false)),
    );
  }

  if (missingOptional.length) {
    await writeJson(artifactPath(job.saveId, "missing-resources.json"), missingOptional);
  }

  await writeJson(artifactPath(job.saveId, "model-sources.json"), {
    generatedAt: new Date().toISOString(),
    renderOptions,
    sources,
    missingOptional,
  });

  pushLog(job, "开始用 Blender 合并模型、套用基础 PBR 颜色，并导出 GLB/STL/3MF。");
  setJob(job, { progress: 82, title: "合并并导出模型" });
  const scriptPath = await writeEnhancedBlenderAssemblyScript(job.saveId, appearance, sources, renderOptions);
  await runProcess(tools.blender.path, ["--background", "--python", scriptPath], cacheDir, (line) => pushLog(job, line));

  const artifacts = getArtifacts(job.saveId);
  if (!artifacts.hasPreview || !artifacts.hasPrintable || (renderOptions.export3mf && (!artifacts.has3mf || !artifacts.hasVisual3mf))) {
    throw new Error("Blender 已运行完成，但没有生成完整的 preview.glb、print.stl、print.3mf 或 print.visual.3mf。");
  }

  pushLog(job, "模型生成完成：preview.glb、print.stl、print.3mf、print.visual.3mf 已写入缓存目录。");
  setJob(job, { progress: 96, title: "模型导出完成", artifacts });
}

async function runBuild(job: ModelBuildJob, force: boolean, parallelism: number) {
  setJob(job, { status: "running", progress: 5, title: "读取存档" });
  try {
    const renderOptions = job.renderOptions;
    const save = await getSaveById(job.saveId);
    if (!save) {
      throw new Error("未找到该存档，请重新扫描。");
    }

    const artifacts = getArtifacts(job.saveId);
    const cachedArtifactsReady =
      artifacts.hasPreview && artifacts.hasPrintable && (!renderOptions.export3mf || (artifacts.has3mf && artifacts.hasVisual3mf));
    if (!force && cachedArtifactsReady) {
      pushLog(job, "已存在缓存模型，直接复用。");
      setJob(job, { status: "done", progress: 100, title: "模型已缓存", artifacts });
      return;
    }

    const analysis = await analyzeSave(job.saveId);
    if (!analysis) {
      throw new Error("无法分析存档。");
    }

    setJob(job, { progress: 24, title: "解析外观" });
    pushLog(job, `已识别基础模型：${analysis.appearance.bodyVariant.toUpperCase()}。`);

    const tools = detectTools(job.gameDir);
    const cacheDir = getSaveModelCacheDir(job.saveId);
    await fsp.mkdir(cacheDir, { recursive: true });
    await writeJson(artifactPath(job.saveId, "appearance.json"), analysis.appearance);
    await writeJson(artifactPath(job.saveId, "loadout.json"), analysis.loadout);
    await writeJson(artifactPath(job.saveId, "render-options.json"), renderOptions);
    await writeJson(
      artifactPath(job.saveId, "manifest.json"),
      createBuildManifest(analysis.appearance, analysis.loadout, tools, job.gameDir, renderOptions, parallelism),
    );

    setJob(job, { progress: 42, title: "检查工具链", artifacts: getArtifacts(job.saveId) });
    const blockers = getToolBlockers(tools);
    if (blockers.length) {
      for (const blocker of blockers) {
        pushLog(job, blocker);
      }
      throw new Error(`模型生成被阻塞：${blockers.join("；")}`);
    }

    await attemptEnhancedExternalBuild(job, analysis.appearance, analysis.loadout, tools, renderOptions, parallelism);
    setJob(job, { status: "done", progress: 100, title: "模型生成完成", artifacts: getArtifacts(job.saveId) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "模型生成失败。";
    pushLog(job, message);
    setJob(job, {
      status: "error",
      progress: Math.max(job.progress, 50),
      title: "模型生成未完成",
      error: message,
      artifacts: getArtifacts(job.saveId),
    });
  }
}

export function startModelBuild(request: BuildRequest) {
  const gameDir = request.gameDir?.trim() || getDefaultGameDir();
  const renderOptions = normalizeRenderOptions(request.renderOptions);
  const parallelism = clampParallelism(request.parallelism, getUncookParallelism());
  const job = createJob(request.saveId, gameDir, renderOptions, parallelism);
  void runBuild(job, Boolean(request.force), parallelism);
  return job;
}

export function getArtifactFile(saveId: string, kind: "preview" | "stl" | "3mf" | "visual3mf" | "manifest") {
  const fileName =
    kind === "preview"
      ? "preview.glb"
      : kind === "stl"
        ? "print.stl"
        : kind === "3mf"
          ? "print.3mf"
          : kind === "visual3mf"
            ? "print.visual.3mf"
            : "manifest.json";
  const filePath = artifactPath(saveId, fileName);
  return existsSync(filePath) ? filePath : null;
}

export function registerModel(pathValue: string): string {
  const existing = [...modelRegistry.entries()].find(([, value]) => value === pathValue);
  if (existing) {
    return existing[0];
  }
  const id = createHash("sha1").update(pathValue).digest("hex").slice(0, 16);
  modelRegistry.set(id, pathValue);
  return id;
}

export function getModelPath(id: string): string | null {
  return modelRegistry.get(id) || null;
}

export async function scanAndRegister(gameDir: string, query: string) {
  const roots = [getSaveModelCacheDir(query), path.join(gameDir, "archive")].filter((item) => existsSync(item));
  const items: Array<{
    id: string;
    path: string;
    filename: string;
    extension: string;
    size: number;
    v_hint: number;
    source_root: string;
  }> = [];

  for (const root of roots) {
    const stack = [root];
    while (stack.length && items.length < 200) {
      const dir = stack.pop()!;
      let entries;
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          stack.push(full);
          continue;
        }
        const ext = path.extname(entry.name).toLowerCase();
        if (!SUPPORTED_EXTS.includes(ext as (typeof SUPPORTED_EXTS)[number])) {
          continue;
        }
        items.push({
          id: registerModel(full),
          path: full,
          filename: entry.name,
          extension: ext,
          size: statSync(full).size,
          v_hint: entry.name.toLowerCase().includes("v") ? 10 : 0,
          source_root: root,
        });
      }
    }
  }
  return items;
}

export { runProcess };

