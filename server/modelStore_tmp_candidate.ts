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
  manifest: string | null;
  hasPreview: boolean;
  hasPrintable: boolean;
  has3mf: boolean;
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
  const manifest = artifactPath(saveId, "manifest.json");
  return {
    saveId,
    cacheDir,
    previewGlb: existsSync(preview) ? preview : null,
    exportStl: existsSync(stl) ? stl : null,
    export3mf: existsSync(threeMf) ? threeMf : null,
    manifest: existsSync(manifest) ? manifest : null,
    hasPreview: existsSync(preview),
    hasPrintable: existsSync(stl),
    has3mf: existsSync(threeMf),
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
        ? "�Ѽ�⵽ WolvenKit CLI�������ڴ� .archive �е��� REDengine ģ����Դ��"
        : "δ��⵽ WolvenKit CLI���뽫 WolvenKit.CLI.exe ���� resource Ŀ¼�������� WOLVENKIT_CLI ����������",
    },
    blender: {
      found: Boolean(blender),
      path: blender,
      message: blender
        ? "�Ѽ�⵽ Blender�������ںϳɲ���� GLB / STL / 3MF��"
        : "δ��⵽ Blender���뽫 blender.exe ���� resource\\Blender Ŀ¼�������� BLENDER_EXE ����������",
    },
    redMod: {
      found: Boolean(redMod),
      path: redMod,
      message: redMod
        ? "�Ѽ�⵽ REDmod����ѡ���������ڲ��ָ߼���Դ�޸���"
        : "δ��⵽ REDmod��",
    },
    gameDir: {
      found: existsSync(gameDir) && hasArchive,
      path: gameDir,
    message: existsSync(gameDir)
      ? hasArchive
          ? "��ϷĿ¼���������ҵ� basegame_4_appearance.archive��"
          : "��ϷĿ¼���ڣ���ȱ�� basegame_4_appearance.archive��"
        : "��ϷĿ¼�����ڡ�",
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

function createJob(saveId: string, gameDir: string, renderOptions: RenderOptions): ModelBuildJob {
  const id = randomUUID();
  const job: ModelBuildJob = {
    id,
    saveId,
    gameDir,
    status: "queued",
    progress: 0,
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
      "manifest ��¼�����ڸ��� V ��ɫ���εĲ�������Դӳ�䡣�� WolvenKit/Blender ���� preview.glb �� print.stl��",
  };
}

function createBuildManifest(
  appearance: VAppearancePreset,
  loadout: VLoadoutPreset,
  tools: ToolStatus,
  gameDir: string,
  renderOptions: RenderOptions,
) {
  return {
    generatedAt: new Date().toISOString(),
    gameDir,
    renderOptions,
    appearance,
    loadout,
    tools,
    note:
      "manifest ��¼�����ڸ��� V ��ɫ����봩��/�������á��� WolvenKit/Blender ���� preview.glb��print.stl��print.3mf��",
  };
}

function getToolBlockers(tools: ToolStatus) {
  const blockers: string[] = [];
  if (!tools.gameDir.found) {
    blockers.push(tools.gameDir.message);
  }
  if (!tools.wolvenKit.found) {
    blockers.push("ȱ�� WolvenKit CLI���޷��� .archive ���� .mesh ��Դ��");
  }
  if (!tools.blender.found) {
    blockers.push("ȱ�� Blender���޷��ϲ������� GLB / STL / 3MF��");
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
    return "��ԭ�浵����";
  }
  if (mode === "clothing-only") {
    return "����װ";
  }
  if (mode === "weapons-only") {
    return "������";
  }
  return "������";
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

  throw new Error(`WolvenKit δ�ܵ��� ${resourceFileName(resourcePath)}��`);
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
    onLog(`��Ϊ ${itemName} �ҵ���ѡ mesh��${ranked[0]}`);
  } else {
    onLog(`δ��Ϊ ${itemName} �ҵ���ƥ��� mesh��`);
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
    pushLog(job, `${hint.record || hint.entityName} ��֧�ֵ�ʵ��: entityName=${hint.entityName}`);
    return null;
  }

  const json = await readSerializedResourceJson(tools.wolvenKit.path, job.gameDir, job.saveId, entityPath, (line) =>
    pushLog(job, line),
  );
  const appearances = json?.Data?.RootChunk?.appearances;
  if (!Array.isArray(appearances)) {
    pushLog(job, `${entityPath} ȱ�� appearances ����`);
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
    pushLog(job, `${hint.record || hint.appearanceName} �� ${entityPath} δ���� appearance=${hint.appearanceName}`);
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
    pushLog(job, `${match.appPath} ȱ�� appearances ����`);
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
    pushLog(job, `${match.appPath} δ�ҵ� appearance=${match.appAppearanceName} �� mesh`);
    return [];
  }

  const meshes = [...collectMeshPaths(best.data)];
  if (meshes.length) {
    pushLog(job, `${match.appAppearanceName} ������ ${meshes.length} �� mesh`);
  } else {
    pushLog(job, `${match.appAppearanceName} δ������ mesh`);
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
    pushLog(job, `${hint.record || "StrongArms"} ʹ����֫��������${meshes.join(", ")}`);
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
    const roleName = role === "clothing" ? "��װ" : "����";
    pushLog(
      job,
      `
      `��⵽ ${roleName} �� TweakDB ��ѡ��${names
        .slice(0, 6)
        .map((item) => item.replace(/^Items\./i, ""))
        .join(", ")}�������δ�����������˵� .ent/.app -> ʵ�� mesh ���̡�
      `,
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
      pushLog(job, `${name} 的候选资源不是角色服�?mesh，已跳过。`);
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
    "skin": make_material("V skin base", SKIN_COLOR, 0.68, 0.0),
    "hair": make_material("V hair base", HAIR_COLOR, 0.72, 0.0),
    "eyes": make_material("V eye base", EYE_COLOR, 0.22, 0.0),
    "cyberware": make_material("V cyberware base", (0.46, 0.50, 0.55, 1.0), 0.36, 0.65),
    "clothing": make_material("Save clothing base", (0.055, 0.075, 0.105, 1.0), 0.82, 0.0),
    "weapon": make_material("Save weapon base", (0.36, 0.37, 0.38, 1.0), 0.42, 0.7),
    "fallback": make_material("Neutral fallback", (0.62, 0.64, 0.66, 1.0), 0.7, 0.0),
}

ROLE_TO_MATERIAL = {
    "body": "skin",
    "head": "skin",
    "arms": "skin",
    "hair": "hair",
    "eyes": "eyes",
    "cyberware": "cyberware",
    "clothing": "clothing",
    "weapon": "weapon",
}

def material_for_role(role):
    return MATERIALS.get(ROLE_TO_MATERIAL.get(role, "fallback"), MATERIALS["fallback"])

def ensure_material(source, obj):
    has_material = any(slot.material is not None for slot in obj.material_slots)
    if has_material:
        return
    obj.data.materials.append(material_for_role(source["role"]))

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
        ensure_material(source, obj)
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
    ("Cyberware", "#747F8CFF"),
    ("Clothing", "#0E1320FF"),
    ("Weapon", "#5C5F62FF"),
    ("Fallback", "#9EA3A8FF"),
]

ROLE_INDEX = {
    "body": 0,
    "head": 0,
    "arms": 0,
    "hair": 1,
    "eyes": 2,
    "cyberware": 3,
    "clothing": 4,
    "weapon": 5,
}

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
                triangles.append(f'<triangle v1="{v0}" v2="{v1}" v3="{v2}"/>')
            role = obj.get("cp2077_role", "fallback")
            pindex = ROLE_INDEX.get(role, 6)
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
    export_3mf(r"${threeMf}", mesh_objects)
`;
  await fsp.writeFile(scriptPath, script, "utf8");
  return scriptPath;
}

async function attemptExternalBuild(job: ModelBuildJob, appearance: VAppearancePreset, tools: ToolStatus) {
  if (!tools.wolvenKit.path || !tools.blender.path) {
    throw new Error("缺少 WolvenKit �?Blender�?);
  }

  const resources =
    "resourcePaths" in appearance
      ? appearance.resourcePaths
      : (appearance as VAppearancePreset & { mappedResources?: VAppearancePreset["resourcePaths"] }).mappedResources;
  const bodyMesh = resources?.bodyMesh;
  const headMesh = resources?.headMesh;
  if (!bodyMesh || !headMesh) {
    throw new Error("存档外观没有映射到可导出�?body/head 资源�?);
  }

  const cacheDir = getSaveModelCacheDir(job.saveId);
  const exportDir = path.join(cacheDir, "wolvenkit-export");
  await fsp.rm(exportDir, { recursive: true, force: true });
  await fsp.mkdir(exportDir, { recursive: true });

  pushLog(job, "开始用 WolvenKit 从游戏资源导出基础身体模型�?);
  setJob(job, { progress: 52, title: "导出身体模型" });
  const bodyGlb = await uncookMeshResource(tools.wolvenKit.path, job.gameDir, bodyMesh, exportDir, (line) =>
    pushLog(job, line),
  );

  pushLog(job, "开始用 WolvenKit 从游戏资源导出基础头部模型�?);
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

  pushLog(job, "开始用 Blender 合并 body/head，并导出预览 GLB 与打�?STL�?);
  setJob(job, { progress: 82, title: "合并并导出模�? });
  const scriptPath = await writeBlenderAssemblyScript(job.saveId, appearance, sourceGlbs);
  await runProcess(tools.blender.path, ["--background", "--python", scriptPath], cacheDir, (line) => pushLog(job, line));

  const artifacts = getArtifacts(job.saveId);
  if (!artifacts.hasPreview || !artifacts.hasPrintable) {
    throw new Error("Blender 运行完成，但没有生成 preview.glb �?print.stl�?);
  }

  pushLog(job, "模型生成完成：preview.glb �?print.stl 已写入缓存目录�?);
  setJob(job, { progress: 96, title: "模型导出完成", artifacts });
}

async function attemptEnhancedExternalBuild(
  job: ModelBuildJob,
  appearance: VAppearancePreset,
  loadout: VLoadoutPreset,
  tools: ToolStatus,
  renderOptions: RenderOptions,
) {
  if (!tools.wolvenKit.path || !tools.blender.path) {
    throw new Error("ȱ�� WolvenKit �� Blender��");
  }

  const resources = appearance.resourcePaths;
  if (!resources.bodyMesh || !resources.headMesh) {
    throw new Error("�浵��ɫδ�ҵ��ɵ����� body/head ��Դ��");
  }

  const cacheDir = getSaveModelCacheDir(job.saveId);
  const exportDir = path.join(cacheDir, "wolvenkit-export");
  await fsp.rm(exportDir, { recursive: true, force: true });
  await fsp.mkdir(exportDir, { recursive: true });

  const sources: ModelSource[] = [];
  const missingOptional: string[] = [];
  const parallelism = getUncookParallelism();

  async function addMesh(role: ModelSourceRole, label: string, resourcePath: string, required: boolean) {
    if (!resourcePath) {
      if (!required) {
        missingOptional.push(`${label} û�п��õ���Դ·��`);
      }
      return;
    }
    try {
      const glbPath = await uncookMeshResource(tools.wolvenKit.path!, job.gameDir, resourcePath, exportDir, (line) =>
        pushLog(job, line),
      );
      sources.push({ role, label, resourcePath, glbPath });
      pushLog(job, `�����ɹ� ${label}��${resourcePath}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (required) {
        throw new Error(`${label} ����ʧ�ܣ�${message}`);
      }
      missingOptional.push(`${label} ����ʧ�ܣ�${message}`);
      pushLog(job, `${label} ������${message}`);
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

    await runWithConcurrency(taskEntries, parallelism, (done, total) => {
      const progress = total ? startProgress + (done / total) * (endProgress - startProgress) : endProgress;
      setJob(job, { progress: Math.round(progress), title });
    });
  };

  pushLog(job, `��Ⱦģʽ��${renderModeLabel(renderOptions.bodyMode)}����ʼ����...`);
  await runMeshBatch(
    "�������������ģ��",
    50,
    68,
    [
      () => addMesh("body", "����/����/����", resources.bodyMesh, true),
      () => addMesh("head", "ͷ��", resources.headMesh, true),
      () => addMesh("arms", "�ֱۺ���", resources.armsMesh, true),
    ],
  );

  await runMeshBatch(
    "����ͷ��/�۾�/��֫",
    68,
    70,
    [
      ...distinctPaths(resources.hairMeshes).map((resourcePath) => () => addMesh("hair", "ͷ��", resourcePath, false)),
      ...distinctPaths(resources.eyeMeshes).map((resourcePath) => () => addMesh("eyes", "�۾�", resourcePath, false)),
      ...distinctPaths(resources.cyberwareMeshes).map((resourcePath) =>
        () => addMesh("cyberware", "��֫", resourcePath, false),
      ),
    ],
  );

  let clothingResources: string[] = [];
  let weaponResources: string[] = [];
  const attachmentResources = loadout.attachmentSlots.flatMap((slot) => slot.resolvedResourcePaths);

  if (renderOptions.includeSaveClothing || renderOptions.bodyMode === "save-outfit" || renderOptions.bodyMode === "clothing-only") {
    setJob(job, { progress: 72, title: "�����������浵��װ" });
    clothingResources = await resolveLoadoutResources("clothing", loadout.clothingSlots, job, appearance, tools);
    if (!clothingResources.length && renderOptions.bodyMode === "save-outfit") {
      throw new Error(
        "δ�ҵ��ɵ����Ĵ浵��װ��Դ��.ent/.app/.mesh������ȷ�Ϸ�װ��λʶ����ȷ����رա������浵��װ����",
      );
    }
    await runMeshBatch(
      "�����浵��װ",
      72,
      80,
      distinctPaths(clothingResources).map((resourcePath) => () => addMesh("clothing", "�浵��װ", resourcePath, false)),
    );
  }

  if (renderOptions.includeSaveWeapons || renderOptions.bodyMode === "save-outfit" || renderOptions.bodyMode === "weapons-only") {
    setJob(job, { progress: 80, title: "�����������浵����" });
    weaponResources = await resolveLoadoutResources("weapon", loadout.weaponSlots, job, appearance, tools);
    if (!weaponResources.length && renderOptions.bodyMode === "save-outfit") {
      throw new Error("δ�ҵ��ɵ����Ĵ浵������Դ��.ent/.app/.mesh������ȷ��������λʶ����ȷ����رա������浵��������");
    }
    await runMeshBatch(
      "�����浵����",
      80,
      86,
      distinctPaths(weaponResources).map((resourcePath) => () => addMesh("weapon", "�浵����", resourcePath, false)),
    );
  }

  if (renderOptions.includeWeaponAttachments) {
    if (!attachmentResources.length) {
      pushLog(job, "��ǰװ��������λδ��⵽��ʶ�𸽼���Դ����������");
    }
    await runMeshBatch(
      "������������",
      86,
      90,
      distinctPaths(attachmentResources).map((resourcePath) => () => addMesh("weapon", "��������", resourcePath, false)),
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

  pushLog(job, "���� Blender �ϲ�������ģ�ͣ����Ա��� PBR ��ɫ���������� GLB/STL/3MF��");
  setJob(job, { progress: 92, title: "Blender �ϲ�������ģ��" });
  const scriptPath = await writeEnhancedBlenderAssemblyScript(job.saveId, appearance, sources, renderOptions);
  await runProcess(tools.blender.path, ["--background", "--python", scriptPath], cacheDir, (line) => pushLog(job, line));

  const artifacts = getArtifacts(job.saveId);
  if (!artifacts.hasPreview || !artifacts.hasPrintable || (renderOptions.export3mf && !artifacts.has3mf)) {
    throw new Error("Blender ִ����ɣ���δ����Ԥ�ڵ� preview.glb��print.stl �� print.3mf��");
  }

  pushLog(job, "ģ�͵�����ɣ�����Ԥ�����鿴 review.glb������ GLB/STL/3MF��");
  setJob(job, { progress: 96, title: "ģ�͵������", artifacts });
}

async function runBuild(job: ModelBuildJob, force: boolean) {
  setJob(job, { status: "running", progress: 5, title: "读取存档" });
  try {
    const renderOptions = job.renderOptions;
    const save = await getSaveById(job.saveId);
    if (!save) {
      throw new Error("未找到该存档，请重新扫描�?);
    }

    const artifacts = getArtifacts(job.saveId);
    const cachedArtifactsReady = artifacts.hasPreview && artifacts.hasPrintable && (!renderOptions.export3mf || artifacts.has3mf);
    if (!force && cachedArtifactsReady) {
      pushLog(job, "已存在缓存模型，直接复用�?);
      setJob(job, { status: "done", progress: 100, title: "模型已缓�?, artifacts });
      return;
    }

    const analysis = await analyzeSave(job.saveId);
    if (!analysis) {
      throw new Error("无法分析存档�?);
    }

    setJob(job, { progress: 24, title: "解析外观" });
    pushLog(job, `已识别基础模型�?{analysis.appearance.bodyVariant.toUpperCase()}。`);

    const tools = detectTools(job.gameDir);
    const cacheDir = getSaveModelCacheDir(job.saveId);
    await fsp.mkdir(cacheDir, { recursive: true });
    await writeJson(artifactPath(job.saveId, "appearance.json"), analysis.appearance);
    await writeJson(artifactPath(job.saveId, "loadout.json"), analysis.loadout);
    await writeJson(artifactPath(job.saveId, "render-options.json"), renderOptions);
    await writeJson(
      artifactPath(job.saveId, "manifest.json"),
      createBuildManifest(analysis.appearance, analysis.loadout, tools, job.gameDir, renderOptions),
    );

    setJob(job, { progress: 42, title: "检查工具链", artifacts: getArtifacts(job.saveId) });
    const blockers = getToolBlockers(tools);
    if (blockers.length) {
      for (const blocker of blockers) {
        pushLog(job, blocker);
      }
      throw new Error(`模型生成被阻塞：${blockers.join("�?)}`);
    }

    await attemptEnhancedExternalBuild(job, analysis.appearance, analysis.loadout, tools, renderOptions);
    setJob(job, { status: "done", progress: 100, title: "模型生成完成", artifacts: getArtifacts(job.saveId) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "模型生成失败�?;
    pushLog(job, message);
    setJob(job, {
      status: "error",
      progress: Math.max(job.progress, 50),
      title: "模型生成未完�?,
      error: message,
      artifacts: getArtifacts(job.saveId),
    });
  }
}

export function startModelBuild(request: BuildRequest) {
  const gameDir = request.gameDir?.trim() || getDefaultGameDir();
  const renderOptions = normalizeRenderOptions(request.renderOptions);
  const job = createJob(request.saveId, gameDir, renderOptions);
  void runBuild(job, Boolean(request.force));
  return job;
}

export function getArtifactFile(saveId: string, kind: "preview" | "stl" | "3mf" | "manifest") {
  const fileName =
    kind === "preview" ? "preview.glb" : kind === "stl" ? "print.stl" : kind === "3mf" ? "print.3mf" : "manifest.json";
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


