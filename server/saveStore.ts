import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { getRuntimeLoadout, type RuntimeLoadoutItem } from "./cetRuntimeStore";

export type SaveSummary = {
  id: string;
  name: string;
  dir: string;
  savPath: string;
  screenshotPath: string | null;
  metadataPath: string | null;
  modifiedAt: string;
  size: number;
  meta: Record<string, unknown>;
};

export type SaveNode = {
  id: number | null;
  name: string;
  nextId: number;
  childId: number;
  offset: number;
  size: number;
  dataSize?: number;
};

export type SaveHeader = {
  magic: string;
  saveVersion: number;
  gameVersion: number;
  archiveVersion: number;
  savedAt: string;
};

export type VAppearancePreset = {
  saveId: string;
  bodyGender: "Male" | "Female" | "Unknown";
  brainGender: "Male" | "Female" | "Unknown";
  bodyVariant: "pma" | "pwa" | "unknown";
  gameVersion: string;
  buildPatch: string;
  appearanceNode: SaveNode | null;
  rawAppearanceBytes: number;
  parsedFields: Array<{ key: string; label: string; value: string | number | boolean }>;
  resourcePaths: {
    bodyMesh: string;
    headMesh: string;
    headMorphTarget: string;
    armsMesh: string;
    hairMeshes: string[];
    eyeMeshes: string[];
    cyberwareMeshes: string[];
    hairSearchRoot: string;
    skinMaterialRoot: string;
  };
  warnings: string[];
};

export type LoadoutSlot = {
  slot: string;
  label: string;
  detected: boolean;
  rawHints: string[];
  resolvedResourcePaths: string[];
  warnings: string[];
};

export type VLoadoutPreset = {
  saveId: string;
  clothingSlots: LoadoutSlot[];
  weaponSlots: LoadoutSlot[];
  attachmentSlots: LoadoutSlot[];
  unresolvedItems: string[];
  resourceCandidates: string[];
  warnings: string[];
};

export type SaveAnalysis = {
  save: SaveSummary;
  header: SaveHeader | null;
  footer: {
    infoStart: number;
    endMagic: string;
    nodeCountApprox: number;
  } | null;
  appearanceNodes: SaveNode[];
  relevantNodes: SaveNode[];
  inferredAppearance: Array<{ label: string; value: string }>;
  appearance: VAppearancePreset;
  loadout: VLoadoutPreset;
  pipeline: Array<{ title: string; state: "done" | "blocked" | "next"; detail: string }>;
};

const saveRegistry = new Map<string, SaveSummary>();
type CyberCatItem = {
  name?: string;
  gameName?: string;
  nodeName?: string;
  dataType?: string;
  quantity?: number;
  rootName?: string;
  slotName?: string;
};

type CyberCatAppearanceEntry = {
  first?: string;
  second?: string;
  hashHex?: string;
};

type CyberCatAppearanceSection = {
  name?: string;
  mainList?: CyberCatAppearanceEntry[];
  additionalList?: CyberCatAppearanceEntry[];
};

type CyberCatInspection = {
  inspector?: {
    ok?: boolean;
    error?: string;
    namesPath?: string;
    resolverReady?: boolean;
  };
  save?: {
    parsedItemCount?: number;
    parsedAppearanceCount?: number;
  };
  appearance?: {
    firstSection?: { appearanceSections?: CyberCatAppearanceSection[] };
    secondSection?: { appearanceSections?: CyberCatAppearanceSection[] };
    thirdSection?: { appearanceSections?: CyberCatAppearanceSection[] };
    strings?: string[];
    stringTriples?: Array<{ first?: string; second?: string; third?: string }>;
  };
  items?: CyberCatItem[];
  likelyPlayerItems?: CyberCatItem[];
  rawLikelyPlayerItems?: Array<{ name?: string; category?: string; nodeName?: string; count?: number }>;
};

type CyberCatResult = {
  data: CyberCatInspection | null;
  warnings: string[];
};

const cyberCatCache = new Map<string, Promise<CyberCatResult>>();

export const getDefaultSaveDir = () =>
  path.join(process.env["USERPROFILE"] || "", "Saved Games", "CD Projekt Red", "Cyberpunk 2077");

function workspaceRoot() {
  return process.cwd();
}

function localResourceRoot() {
  return path.resolve(workspaceRoot(), "..", "resource");
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
      entries = statSync(current.dir).isDirectory() ? readdirSync(current.dir, { withFileTypes: true }) : [];
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

function findCyberCatInspectorDll() {
  const resourceRoot = localResourceRoot();
  const expected = path.join(resourceRoot, "Cp2077SaveInspector", "bin", "Release", "net8.0", "Cp2077SaveInspector.dll");
  return process.env["CP2077_SAVE_INSPECTOR_DLL"] || (existsSync(expected) ? expected : findFileUnder(resourceRoot, "Cp2077SaveInspector.dll"));
}

function findCyberCatNamesJson() {
  const resourceRoot = localResourceRoot();
  return (
    process.env["CYBERCAT_NAMES_JSON"] ||
    path.join(resourceRoot, "CyberCAT", "CyberCAT.Forms", "Names.json") ||
    findFileUnder(resourceRoot, "Names.json")
  );
}

function runDotnetJson(args: string[], timeoutMs = 120_000): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const dotnet = process.env["DOTNET_EXE"] || "dotnet";
    const child = spawn(dotnet, args, {
      cwd: workspaceRoot(),
      windowsHide: true,
      env: {
        ...process.env,
        DOTNET_CLI_HOME: process.env["DOTNET_CLI_HOME"] || path.resolve(workspaceRoot(), "..", ".dotnet"),
        DOTNET_SKIP_FIRST_TIME_EXPERIENCE: "1",
        DOTNET_CLI_TELEMETRY_OPTOUT: "1",
      },
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("CyberCAT inspector 执行超时。"));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
  });
}

async function inspectSaveWithCyberCat(save: SaveSummary): Promise<CyberCatResult> {
  const cacheKey = `${save.savPath}:${save.size}:${save.modifiedAt}`;
  if (cyberCatCache.has(cacheKey)) {
    return cyberCatCache.get(cacheKey)!;
  }

  const task = (async (): Promise<CyberCatResult> => {
    const warnings: string[] = [];
    const inspectorDll = findCyberCatInspectorDll();
    if (!inspectorDll || !existsSync(inspectorDll)) {
      return {
        data: null,
        warnings: ["未找到 Cp2077SaveInspector.dll，暂时只能使用基础存档扫描结果。"],
      };
    }

    const namesJson = findCyberCatNamesJson();
    const args = namesJson && existsSync(namesJson) ? [inspectorDll, save.savPath, namesJson] : [inspectorDll, save.savPath];
    if (!namesJson || !existsSync(namesJson)) {
      warnings.push("未找到 CyberCAT Names.json，装备 TweakDB ID 只能显示为哈希。");
    }

    try {
      const result = await runDotnetJson(args);
      const output = result.stdout.trim().replace(/^\uFEFF/, "");
      const jsonStart = output.indexOf("{");
      if (jsonStart < 0) {
        warnings.push(`CyberCAT inspector 没有返回 JSON：${result.stderr || "无 stderr"}`);
        return { data: null, warnings };
      }
      const data = JSON.parse(output.slice(jsonStart)) as CyberCatInspection;
      if (data.inspector?.ok === false) {
        warnings.push(`CyberCAT inspector 解析失败：${data.inspector.error || "未知错误"}`);
      }
      if (result.code && result.code !== 0 && !data.inspector?.error) {
        warnings.push(`CyberCAT inspector 退出码 ${result.code}：${result.stderr || "无 stderr"}`);
      }
      return { data, warnings };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        data: null,
        warnings: [`CyberCAT inspector 执行失败：${message}`],
      };
    }
  })();

  cyberCatCache.set(cacheKey, task);
  return task;
}

function createId(value: string): string {
  return createHash("sha1").update(value).digest("hex").slice(0, 16);
}

function asString(value: unknown): string {
  if (value === null || value === undefined || value === "") {
    return "-";
  }
  if (typeof value === "number") {
    return Number.isInteger(value) ? String(value) : value.toFixed(2);
  }
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value);
}

async function readJson(filePath: string | null): Promise<Record<string, unknown>> {
  if (!filePath) {
    return {};
  }
  try {
    return JSON.parse(await fsp.readFile(filePath, "utf8"));
  } catch {
    return {};
  }
}

function metadataFile(dir: string): string | null {
  for (const name of ["metadata.9.json", "metadata.json"]) {
    const candidate = path.join(dir, name);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function screenshotFile(dir: string): string | null {
  const candidate = path.join(dir, "screenshot.png");
  return existsSync(candidate) ? candidate : null;
}

function publicMeta(raw: Record<string, unknown>): Record<string, unknown> {
  const data = raw["Data"];
  const metadata =
    data && typeof data === "object" && "metadata" in data
      ? (data as { metadata?: Record<string, unknown> }).metadata || {}
      : {};

  return {
    trackedQuest: metadata["trackedQuest"],
    mainQuest: metadata["mainQuest"],
    locationName: metadata["locationName"],
    lifePath: metadata["lifePath"],
    bodyGender: metadata["bodyGender"],
    brainGender: metadata["brainGender"],
    level: metadata["level"],
    streetCred: metadata["streetCred"],
    buildPatch: metadata["buildPatch"],
    difficulty: metadata["difficulty"],
    playTime: metadata["playTime"],
  };
}

export async function scanSaves(saveDir = getDefaultSaveDir()): Promise<SaveSummary[]> {
  saveRegistry.clear();
  if (!existsSync(saveDir)) {
    return [];
  }

  const entries = await fsp.readdir(saveDir, { withFileTypes: true });
  const saves: SaveSummary[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const dir = path.join(saveDir, entry.name);
    const savPath = path.join(dir, "sav.dat");
    if (!existsSync(savPath)) {
      continue;
    }

    const metadataPath = metadataFile(dir);
    const rawMeta = await readJson(metadataPath);
    const stats = statSync(savPath);
    const item: SaveSummary = {
      id: createId(dir),
      name: entry.name,
      dir,
      savPath,
      screenshotPath: screenshotFile(dir),
      metadataPath,
      modifiedAt: stats.mtime.toISOString(),
      size: stats.size,
      meta: publicMeta(rawMeta),
    };
    saves.push(item);
    saveRegistry.set(item.id, item);
  }

  saves.sort((a, b) => new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime());
  return saves;
}

export async function getSaveById(id: string): Promise<SaveSummary | null> {
  if (saveRegistry.has(id)) {
    return saveRegistry.get(id) || null;
  }
  await scanSaves();
  return saveRegistry.get(id) || null;
}

function decodeSaveTime(clock: number, date: number): string {
  const hour = clock >> 22;
  const minutes = (clock >> 16) & 63;
  const seconds = (clock >> 10) & 63;
  const year = date >> 20;
  const month = 1 + ((date >> 15) % (1 << 5));
  const day = 1 + ((date >> 10) % (1 << 5));
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")} ${String(hour).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function parseHeader(buffer: Buffer): SaveHeader | null {
  if (buffer.length < 25) {
    return null;
  }
  return {
    magic: buffer.subarray(0, 4).toString("ascii"),
    saveVersion: buffer.readUInt32LE(4),
    gameVersion: buffer.readUInt32LE(8),
    archiveVersion: buffer.readUInt32LE(21),
    savedAt: decodeSaveTime(buffer.readUInt32LE(13), buffer.readUInt32LE(17)),
  };
}

function readPackedInt(buffer: Buffer, cursor: { value: number }): number {
  let result = 0;
  let shift = 0;
  while (cursor.value < buffer.length) {
    const byte = buffer[cursor.value++];
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      return result;
    }
    shift += 7;
    if (shift > 28) {
      throw new Error("Packed int is too large.");
    }
  }
  throw new Error("Unexpected end of packed int.");
}

function readPackedString(buffer: Buffer, cursor: { value: number }): string {
  const length = readPackedInt(buffer, cursor);
  if (length < 0 || cursor.value + length > buffer.length) {
    throw new Error("Invalid packed string length.");
  }
  const value = buffer.subarray(cursor.value, cursor.value + length).toString("utf8").replace(/\0+$/g, "");
  cursor.value += length;
  return value;
}

function lz4DecodeBlock(input: Buffer, expectedSize: number): Buffer {
  const output = Buffer.alloc(expectedSize);
  let ip = 0;
  let op = 0;

  while (ip < input.length) {
    const token = input[ip++];
    let literalLength = token >> 4;
    if (literalLength === 15) {
      let next = 255;
      while (next === 255) {
        next = input[ip++];
        literalLength += next;
      }
    }

    if (literalLength > 0) {
      input.copy(output, op, ip, ip + literalLength);
      ip += literalLength;
      op += literalLength;
    }
    if (ip >= input.length) {
      break;
    }

    const offset = input[ip] | (input[ip + 1] << 8);
    ip += 2;
    if (offset <= 0) {
      throw new Error("Invalid LZ4 offset.");
    }

    let matchLength = token & 0x0f;
    if (matchLength === 15) {
      let next = 255;
      while (next === 255) {
        next = input[ip++];
        matchLength += next;
      }
    }
    matchLength += 4;

    for (let i = 0; i < matchLength; i++) {
      output[op] = output[op - offset];
      op++;
    }
  }

  return output.subarray(0, op);
}

function decompressSaveData(buffer: Buffer): Buffer | null {
  const tableStart = buffer.indexOf(Buffer.from("FZLC", "ascii"), 25);
  if (tableStart < 0 || tableStart + 8 > buffer.length) {
    return null;
  }

  const count = buffer.readInt32LE(tableStart + 4);
  if (count <= 0 || count > 4096) {
    return null;
  }

  let cursor = tableStart + 8;
  const chunks: Array<{ offset: number; compressedSize: number; decompressedSize: number }> = [];
  for (let i = 0; i < count; i++) {
    chunks.push({
      offset: buffer.readInt32LE(cursor),
      compressedSize: buffer.readInt32LE(cursor + 4),
      decompressedSize: buffer.readInt32LE(cursor + 8),
    });
    cursor += 12;
  }

  const parts: Buffer[] = [];
  for (const chunk of chunks) {
    if (chunk.offset < 0 || chunk.offset + chunk.compressedSize > buffer.length) {
      return null;
    }
    const magic = buffer.subarray(chunk.offset, chunk.offset + 4).toString("ascii");
    if (magic === "4ZLX") {
      const size = buffer.readInt32LE(chunk.offset + 4);
      const payload = buffer.subarray(chunk.offset + 8, chunk.offset + chunk.compressedSize);
      parts.push(lz4DecodeBlock(payload, size || chunk.decompressedSize));
    } else {
      parts.push(buffer.subarray(chunk.offset, chunk.offset + chunk.compressedSize));
    }
  }

  return Buffer.concat(parts);
}

function parseFooter(buffer: Buffer) {
  if (buffer.length < 33) {
    return null;
  }
  const infoStart = buffer.readInt32LE(buffer.length - 8);
  const endMagic = buffer.subarray(buffer.length - 4).toString("ascii");
  if (infoStart < 0 || infoStart >= buffer.length || infoStart + 4 >= buffer.length) {
    return null;
  }
  const startMagic = buffer.subarray(infoStart, infoStart + 4).toString("ascii");
  if (startMagic !== "EDON") {
    return null;
  }

  const nodes: SaveNode[] = [];
  const cursor = { value: infoStart + 4 };
  try {
    const length = readPackedInt(buffer, cursor);
    for (let i = 0; i < length; i++) {
      const name = readPackedString(buffer, cursor);
      nodes.push({
        id: null,
        name,
        nextId: buffer.readInt32LE(cursor.value),
        childId: buffer.readInt32LE(cursor.value + 4),
        offset: buffer.readInt32LE(cursor.value + 8),
        size: buffer.readInt32LE(cursor.value + 12),
      });
      cursor.value += 16;
    }
  } catch {
    return null;
  }

  return { infoStart, endMagic, nodes };
}

function extractPrintableNodes(buffer: Buffer, infoStart: number): SaveNode[] {
  const footerEnd = buffer.length - 8;
  const nodes: SaveNode[] = [];
  let text = "";
  let textStart = -1;

  function flush(index: number) {
    if (text.length >= 4) {
      const after = index;
      if (after + 16 <= footerEnd) {
        const nextId = buffer.readInt32LE(after);
        const childId = buffer.readInt32LE(after + 4);
        const offset = buffer.readInt32LE(after + 8);
        const size = buffer.readInt32LE(after + 12);
        const saneIds = nextId >= -1 && nextId < 100000 && childId >= -1 && childId < 100000;
        const saneData = offset >= 0 && offset < 512 * 1024 * 1024 && size >= 0 && size < 128 * 1024 * 1024;
        if (saneIds && saneData) {
          nodes.push({
            id: null,
            name: text,
            nextId,
            childId,
            offset,
            size,
          });
        }
      }
    }
    text = "";
    textStart = -1;
  }

  for (let i = infoStart + 4; i < footerEnd; i++) {
    const byte = buffer[i];
    if (byte >= 32 && byte < 127) {
      if (!text) {
        textStart = i;
      }
      text += String.fromCharCode(byte);
    } else {
      flush(i);
    }
  }
  flush(footerEnd);

  const unique = new Map<string, SaveNode>();
  for (const node of nodes) {
    unique.set(`${node.name}:${node.offset}:${node.size}:${textStart}`, node);
  }
  return [...unique.values()];
}

function parseFooterWithFallback(buffer: Buffer) {
  if (buffer.length < 33) {
    return null;
  }
  const infoStart = buffer.readInt32LE(buffer.length - 8);
  const endMagic = buffer.subarray(buffer.length - 4).toString("ascii");
  const startMagic =
    infoStart >= 0 && infoStart + 4 < buffer.length ? buffer.subarray(infoStart, infoStart + 4).toString("ascii") : "";
  if (startMagic !== "EDON") {
    return null;
  }

  const parsed = parseFooter(buffer);
  const parsedNodes = parsed?.nodes || [];
  const hasAppearance = parsedNodes.some((node) => /charac.*custom.*appear|appearance/i.test(node.name));
  if (hasAppearance) {
    return parsed;
  }

  const fallbackNodes = extractPrintableNodes(buffer, infoStart);
  if (!fallbackNodes.length) {
    return parsed || { infoStart, endMagic, nodes: [] };
  }

  const merged = new Map<string, SaveNode>();
  for (const node of parsedNodes) {
    merged.set(`${node.name}:${node.offset}:${node.size}`, node);
  }
  for (const node of fallbackNodes) {
    merged.set(`${node.name}:${node.offset}:${node.size}`, node);
  }

  return {
    infoStart,
    endMagic,
    nodes: [...merged.values()],
  };
}

function attachNodeIds(nodes: SaveNode[], decompressed: Buffer | null): SaveNode[] {
  if (!decompressed) {
    return nodes;
  }
  return nodes.map((node) => {
    if (node.offset < 0 || node.offset + 4 > decompressed.length) {
      return node;
    }
    return {
      ...node,
      id: decompressed.readInt32LE(node.offset),
      dataSize: Math.min(node.size, Math.max(0, decompressed.length - node.offset)),
    };
  });
}

function inferAppearanceFields(save: SaveSummary): Array<{ label: string; value: string }> {
  return [
    { label: "出身", value: asString(save.meta.lifePath) },
    { label: "身体性别", value: asString(save.meta.bodyGender) },
    { label: "声音/脑性别", value: asString(save.meta.brainGender) },
    { label: "等级", value: asString(save.meta.level) },
    { label: "街头声望", value: asString(save.meta.streetCred) },
    { label: "游戏版本", value: asString(save.meta.buildPatch) },
    { label: "难度", value: asString(save.meta.difficulty) },
  ];
}

function bodyVariant(bodyGender: unknown): VAppearancePreset["bodyVariant"] {
  return bodyGender === "Female" ? "pwa" : bodyGender === "Male" ? "pma" : "unknown";
}

function buildResourcePaths(variant: VAppearancePreset["bodyVariant"]) {
  if (variant === "pwa") {
    return {
      bodyMesh: "base\\characters\\common\\player_base_bodies\\player_female_average\\t0_000_pwa_base__full.mesh",
      headMesh:
        "base\\characters\\head\\player_base_heads\\player_female_average\\h0_000_pwa_c__basehead\\h0_000_pwa_c__basehead.mesh",
      headMorphTarget: "base\\characters\\head\\player_base_heads\\player_female_average\\h0_000_pwa__morphs.morphtarget",
      armsMesh:
        "base\\characters\\common\\player_base_bodies\\player_female_average\\arms_hq\\a0_000_pwa_base_hq__full.mesh",
      hairMeshes: [],
      eyeMeshes: [],
      cyberwareMeshes: [],
      hairSearchRoot: "base\\characters\\head\\player_base_heads\\player_female_average",
      skinMaterialRoot: "base\\characters\\common\\skin\\character_mat_instance\\female\\body",
    };
  }
  if (variant === "pma") {
    return {
      bodyMesh: "base\\characters\\common\\player_base_bodies\\player_man_average\\t0_000_pma_base__full.mesh",
      headMesh:
        "base\\characters\\head\\player_base_heads\\player_man_average\\h0_000_pma_c__basehead\\h0_000_pma_c__basehead.mesh",
      headMorphTarget: "base\\characters\\head\\player_base_heads\\player_man_average\\h0_000_pma__morphs.morphtarget",
      armsMesh:
        "base\\characters\\common\\player_base_bodies\\player_man_average\\arms_hq\\a0_001_pma_base_hq__full.mesh",
      hairMeshes: [],
      eyeMeshes: [],
      cyberwareMeshes: [],
      hairSearchRoot: "base\\characters\\head\\player_base_heads\\player_man_average",
      skinMaterialRoot: "base\\characters\\common\\skin\\character_mat_instance\\male\\body",
    };
  }
  return {
    bodyMesh: "",
    headMesh: "",
    headMorphTarget: "",
    armsMesh: "",
    hairMeshes: [],
    eyeMeshes: [],
    cyberwareMeshes: [],
    hairSearchRoot: "",
    skinMaterialRoot: "",
  };
}

function allAppearanceSections(cybercat: CyberCatInspection | null): CyberCatAppearanceSection[] {
  const appearance = cybercat?.appearance;
  if (!appearance) {
    return [];
  }
  return [
    ...(appearance.firstSection?.appearanceSections || []),
    ...(appearance.secondSection?.appearanceSections || []),
    ...(appearance.thirdSection?.appearanceSections || []),
  ];
}

function allAppearanceEntries(cybercat: CyberCatInspection | null): Array<CyberCatAppearanceEntry & { section: string }> {
  const entries: Array<CyberCatAppearanceEntry & { section: string }> = [];
  for (const section of allAppearanceSections(cybercat)) {
    for (const item of section.mainList || []) {
      entries.push({ ...item, section: section.name || "" });
    }
    for (const item of section.additionalList || []) {
      entries.push({ ...item, section: section.name || "" });
    }
  }
  return entries;
}

function findAppearanceValue(cybercat: CyberCatInspection | null, patterns: RegExp[]) {
  const entry = allAppearanceEntries(cybercat).find((item) => {
    const text = `${item.first || ""} ${item.second || ""} ${item.section || ""}`;
    return patterns.some((pattern) => pattern.test(text));
  });
  return entry ? [entry.first, entry.second].filter(Boolean).join(" / ") : "";
}

function enrichResourcePathsFromCyberCat(
  paths: VAppearancePreset["resourcePaths"],
  variant: VAppearancePreset["bodyVariant"],
  cybercat: CyberCatInspection | null,
) {
  const next: VAppearancePreset["resourcePaths"] = {
    ...paths,
    hairMeshes: [...paths.hairMeshes],
    eyeMeshes: [...paths.eyeMeshes],
    cyberwareMeshes: [...paths.cyberwareMeshes],
  };

  if (variant === "pma") {
    next.eyeMeshes.push(
      "base\\characters\\head\\player_base_heads\\player_man_average\\h0_000_pma_c__basehead\\he_000_pma_c__basehead.mesh",
    );
  }
  if (variant === "pwa") {
    next.eyeMeshes.push(
      "base\\characters\\head\\player_base_heads\\player_female_average\\h0_000_pwa_c__basehead\\he_000_pwa_c__basehead.mesh",
    );
  }

  const appearanceStrings = cybercat?.appearance?.strings || [];
  const hairHint = `${findAppearanceValue(cybercat, [/hair/i])} ${appearanceStrings.join(" ")}`;
  if (/short/i.test(hairHint) && variant === "pma") {
    next.hairMeshes.push("base\\characters\\common\\hair\\hh_045_ma__short_spiked\\hh_045_ma__short_spiked.mesh");
  }
  if (/short/i.test(hairHint) && variant === "pwa") {
    next.hairMeshes.push("base\\characters\\common\\hair\\hh_040_wa__pixie_bob\\hh_040_wa__pixie_bob.mesh");
  }

  next.hairMeshes = distinctLimited(next.hairMeshes, 6);
  next.eyeMeshes = distinctLimited(next.eyeMeshes, 4);
  next.cyberwareMeshes = distinctLimited(next.cyberwareMeshes, 8);
  return next;
}

function cyberCatAppearanceFields(cybercat: CyberCatInspection | null): VAppearancePreset["parsedFields"] {
  if (!cybercat?.appearance) {
    return [];
  }

  const fields: VAppearancePreset["parsedFields"] = [];
  const add = (key: string, label: string, value: string) => {
    if (value && value !== " / ") {
      fields.push({ key, label, value });
    }
  };

  add("skin", "肤色/皮肤材质", findAppearanceValue(cybercat, [/skin_type|body_color/i]));
  add("eyes", "眼睛颜色", findAppearanceValue(cybercat, [/eyes_color/i]));
  add("hair", "发色/发型线索", findAppearanceValue(cybercat, [/hair_color|hairs/i]) || (cybercat.appearance.strings || []).join(", "));
  add("cyberware", "面部义体", findAppearanceValue(cybercat, [/cyberware/i]));
  add("tattoo", "纹身", findAppearanceValue(cybercat, [/tattoo/i]));
  add("piercing", "穿孔/饰品", findAppearanceValue(cybercat, [/piercing|earring/i]));
  add("makeup", "妆容", findAppearanceValue(cybercat, [/makeup/i]));
  add("teeth", "牙齿", findAppearanceValue(cybercat, [/teeth/i]));

  for (const part of ["eyes", "nose", "mouth", "jaw", "ear"]) {
    add(`morph-${part}`, `五官形变 ${part}`, findAppearanceValue(cybercat, [new RegExp(`\\b${part}\\b`, "i")]));
  }

  return fields;
}

function createAppearancePreset(
  save: SaveSummary,
  header: SaveHeader | null,
  appearanceNode: SaveNode | null,
  decompressed: Buffer | null,
  cybercat: CyberCatInspection | null,
  cybercatWarnings: string[],
): VAppearancePreset {
  const variant = bodyVariant(save.meta.bodyGender);
  const warnings: string[] = [];
  if (!decompressed) {
    warnings.push("未能解压 sav.dat 的 LZ4 数据，当前只能使用 metadata 和节点目录推断基础模型。");
  }
  if (!appearanceNode) {
    warnings.push("未找到 CharacterCustomization_Appearances 节点，无法读取完整捏脸参数。");
  }
  if (variant === "unknown") {
    warnings.push("metadata 中没有可识别的身体性别，无法确定 pma/pwa 基础模型。");
  }
  warnings.push(...cybercatWarnings);
  if (cybercat?.inspector?.ok && cybercat.save?.parsedAppearanceCount) {
    warnings.push("已使用 CyberCAT 解析捏脸/外观节点，构建时会尽量应用肤色、眼睛、发色、义体和五官线索。");
  }

  const rawAppearanceBytes =
    appearanceNode && decompressed && appearanceNode.offset >= 0 && appearanceNode.offset < decompressed.length
      ? Math.min(appearanceNode.size, decompressed.length - appearanceNode.offset)
      : 0;

  return {
    saveId: save.id,
    bodyGender: save.meta.bodyGender === "Male" || save.meta.bodyGender === "Female" ? save.meta.bodyGender : "Unknown",
    brainGender:
      save.meta.brainGender === "Male" || save.meta.brainGender === "Female" ? save.meta.brainGender : "Unknown",
    bodyVariant: variant,
    gameVersion: header ? String(header.gameVersion) : "-",
    buildPatch: asString(save.meta.buildPatch),
    appearanceNode,
    rawAppearanceBytes,
    parsedFields: [
      { key: "bodyGender", label: "身体模型", value: variant === "pwa" ? "女性 V / pwa" : variant === "pma" ? "男性 V / pma" : "未知" },
      { key: "brainGender", label: "声音/脑性别", value: asString(save.meta.brainGender) },
      { key: "appearanceBlobBytes", label: "外观数据块", value: rawAppearanceBytes },
      ...cyberCatAppearanceFields(cybercat),
    ],
    resourcePaths: enrichResourcePathsFromCyberCat(buildResourcePaths(variant), variant, cybercat),
    warnings,
  };
}

function extractAsciiStrings(buffers: Array<Buffer | null>, minLength = 4, maxLength = 220): string[] {
  const values = new Set<string>();

  for (const buffer of buffers) {
    if (!buffer) {
      continue;
    }

    let text = "";
    const flush = () => {
      const value = text.trim();
      if (value.length >= minLength && value.length <= maxLength) {
        values.add(value);
      }
      text = "";
    };

    for (const byte of buffer) {
      if (byte >= 32 && byte <= 126) {
        text += String.fromCharCode(byte);
        if (text.length > maxLength) {
          flush();
        }
      } else {
        flush();
      }
    }
    flush();
  }

  return [...values];
}

function distinctLimited(values: string[], limit: number) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].slice(0, limit);
}

function pickHints(strings: string[], patterns: RegExp[], limit = 12) {
  return distinctLimited(
    strings.filter((value) => patterns.some((pattern) => pattern.test(value))),
    limit,
  );
}

function resourceCandidates(strings: string[]) {
  const candidates: string[] = [];
  for (const value of strings) {
    const matches = value.match(/[a-z0-9_./\\-]+\.(?:mesh|ent|app|mi|xbm|mlsetup)\b/gi) || [];
    candidates.push(...matches.map((match) => match.replace(/\//g, "\\")));
  }
  return distinctLimited(candidates, 80);
}

function itemCandidates(strings: string[]) {
  const candidates: string[] = [];
  for (const value of strings) {
    const matches =
      value.match(/\b(?:Items|AttachmentSlots|WeaponScopes|WeaponMuzzles|WeaponMods)\.[A-Za-z0-9_.:-]+/g) || [];
    candidates.push(...matches);
  }
  return distinctLimited(candidates, 120);
}

function createSlot(slot: string, label: string, strings: string[], patterns: RegExp[], candidates: string[]): LoadoutSlot {
  const rawHints = pickHints(strings, patterns);
  const resolvedResourcePaths = candidates.filter((candidate) => patterns.some((pattern) => pattern.test(candidate)));
  const detected = rawHints.length > 0 || resolvedResourcePaths.length > 0;
  return {
    slot,
    label,
    detected,
    rawHints,
    resolvedResourcePaths: distinctLimited(resolvedResourcePaths, 12),
    warnings:
      detected && resolvedResourcePaths.length === 0
        ? ["已在存档中识别到槽位线索，但还没有解析到可直接 uncook 的 .mesh/.ent/.app 资源路径。"]
        : [],
  };
}

function cleanItemName(value: unknown) {
  return typeof value === "string" && value.startsWith("Items.") && !value.startsWith("Unknown_") ? value : "";
}

function isClothingItemName(name: string) {
  return /Helmet|Hat|Cap|Mask|Glasses|Visor|Jacket|Coat|Vest|Shirt|TShirt|Top|Bra|Pants|Shorts|Skirt|Boots|Shoes|Dress|Outfit|Spacesuit|Underwear/i.test(
    name,
  );
}

function isWeaponItemName(name: string) {
  return /Weapon|Preset_|Katana|Knife|Blade|Bat|Hammer|Pistol|Revolver|Rifle|Shotgun|SMG|Sniper|Launcher|Machete|Melee|Cyberware|StrongArms|Cyb_/i.test(
    name,
  );
}

function clothingSlotForItem(name: string) {
  if (/Outfit|Spacesuit|Dress/i.test(name)) {
    return "Outfit";
  }
  if (/Helmet|Hat|Cap/i.test(name)) {
    return "Head";
  }
  if (/Mask|Glasses|Visor/i.test(name)) {
    return "Face";
  }
  if (/Jacket|Coat|Vest/i.test(name)) {
    return "OuterChest";
  }
  if (/Shirt|TShirt|Top|Bra/i.test(name)) {
    return "InnerChest";
  }
  if (/Pants|Shorts|Skirt/i.test(name)) {
    return "Legs";
  }
  if (/Boots|Shoes/i.test(name)) {
    return "Feet";
  }
  return "";
}

function weaponSlotForItem(name: string) {
  if (/StrongArms|Cyb_StrongArms|Cyberware/i.test(name)) {
    return "Melee";
  }
  if (/Katana|Knife|Blade|Bat|Hammer|Machete|Melee/i.test(name)) {
    return "Melee";
  }
  if (/Pistol|Revolver|Handgun/i.test(name)) {
    return "Sidearm";
  }
  if (/Rifle|Shotgun|SMG|Sniper|Launcher|Weapon|Preset_/i.test(name)) {
    return "PrimaryWeapon";
  }
  return "QuickSlot";
}

function mergeCyberCatItemsIntoSlots(
  slots: LoadoutSlot[],
  items: CyberCatItem[],
  classifySlot: (name: string) => string,
  filter: (name: string) => boolean,
) {
  const bySlot = new Map(slots.map((slot) => [slot.slot, slot]));
  for (const item of items) {
    const name = cleanItemName(item.name);
    if (!name || !filter(name)) {
      continue;
    }
    const slotId = classifySlot(name);
    const slot = bySlot.get(slotId);
    if (!slot) {
      continue;
    }
    slot.detected = true;
    slot.rawHints = distinctLimited([...slot.rawHints, name], 24);
  }
}

function runtimeHints(item: RuntimeLoadoutItem) {
  return distinctLimited(
    [
      item.record,
      item.entityName ? `entityName:${item.entityName}` : "",
      item.appearanceName ? `appearanceName:${item.appearanceName}` : "",
      item.objectAppearance ? `objectAppearance:${item.objectAppearance}` : "",
      item.objectColorVariant ? `objectColorVariant:${item.objectColorVariant}` : "",
      item.itemType ? `itemType:${item.itemType}` : "",
      item.equipArea ? `equipArea:${item.equipArea}` : "",
    ],
    12,
  );
}

function mergeRuntimeItemsIntoSlots(clothingSlots: LoadoutSlot[], weaponSlots: LoadoutSlot[], items: RuntimeLoadoutItem[]) {
  const clothingBySlot = new Map(clothingSlots.map((slot) => [slot.slot, slot]));
  const weaponBySlot = new Map(weaponSlots.map((slot) => [slot.slot, slot]));

  for (const item of items) {
    const typeText = `${item.itemCategory} ${item.itemType} ${item.equipArea} ${item.record}`;
    const isClothing = /Clothing|Clo_|Armor/i.test(typeText);
    const isWeapon = /Weapon|Cyb_|ArmsCW|StrongArms/i.test(typeText);
    const slot = isClothing ? clothingBySlot.get(item.slot) : isWeapon ? weaponBySlot.get(item.slot) : null;
    if (!slot) {
      continue;
    }

    slot.detected = true;
    slot.rawHints = distinctLimited([...slot.rawHints, ...runtimeHints(item)], 32);
    slot.warnings = distinctLimited(
      [
        ...slot.warnings,
        item.appearanceName
          ? `CET 运行时识别到 ${item.record}，entityName=${item.entityName || "未知"}，appearanceName=${item.appearanceName}。`
          : `CET 运行时识别到 ${item.record}，但还缺少可解析的 appearanceName。`,
      ],
      12,
    );
  }
}

function buildCyberCatItemPool(cybercat: CyberCatInspection | null) {
  const items = [...(cybercat?.likelyPlayerItems || []), ...(cybercat?.items || [])];
  const seen = new Set<string>();
  const result: CyberCatItem[] = [];
  for (const item of items) {
    const key = `${item.name || ""}|${item.nodeName || ""}|${item.rootName || ""}|${item.slotName || ""}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(item);
  }
  return result;
}

async function createLoadoutPreset(
  saveId: string,
  raw: Buffer,
  decompressed: Buffer | null,
  nodes: SaveNode[],
  cybercat: CyberCatInspection | null,
  cybercatWarnings: string[],
): Promise<VLoadoutPreset> {
  const strings = extractAsciiStrings([decompressed, raw]).filter((value) =>
    /Items\.|Attachment|Weapon|Cloth|Head|Face|Chest|Leg|Feet|Outfit|Armor|Slot|Cyberware|Equip|Inventory/i.test(value),
  );
  const candidates = resourceCandidates(strings);
  const items = itemCandidates(strings);
  const cybercatItemPool = buildCyberCatItemPool(cybercat);

  const clothingSlots = [
    createSlot("Head", "头部", strings, [/HeadArmor/i, /\bHead\b/i, /Helmet|Hat|Cap/i], candidates),
    createSlot("Face", "面部", strings, [/\bFace\b/i, /Mask|Glasses|Visor/i], candidates),
    createSlot("OuterChest", "外套", strings, [/OuterChest/i, /ChestArmor/i, /Jacket|Coat|Vest/i], candidates),
    createSlot("InnerChest", "内搭", strings, [/InnerChest/i, /TShirt|Shirt|Top/i], candidates),
    createSlot("Legs", "腿部", strings, [/\bLegs?\b/i, /LegArmor/i, /Pants|Skirt/i], candidates),
    createSlot("Feet", "脚部", strings, [/\bFeet\b/i, /Boots|Shoes/i], candidates),
    createSlot("Outfit", "套装", strings, [/Outfit/i, /QuestClothingSet/i], candidates),
  ];

  const weaponSlots = [
    createSlot("PrimaryWeapon", "主武器", strings, [/PrimaryWeapon/i, /WeaponSlot|Weapon/i, /Rifle|Shotgun|SMG/i], candidates),
    createSlot("Sidearm", "副武器", strings, [/Sidearm|Handgun|Pistol|Revolver/i], candidates),
    createSlot("Melee", "近战武器", strings, [/Melee|Katana|Knife|Blade|Bat|Hammer/i], candidates),
    createSlot("QuickSlot", "快捷栏武器", strings, [/QuickSlot|Hotkey|EquipmentAreaWeapon/i], candidates),
  ];

  const attachmentSlots = [
    createSlot("Scope", "瞄具", strings, [/Scope|Sight|Optic/i], candidates),
    createSlot("Muzzle", "枪口", strings, [/Muzzle|Silencer|Suppressor|Brake/i], candidates),
    createSlot("Mod", "武器插件", strings, [/WeaponMod|ModSlot|Attachment/i], candidates),
  ];
  mergeCyberCatItemsIntoSlots(clothingSlots, cybercatItemPool, clothingSlotForItem, isClothingItemName);
  mergeCyberCatItemsIntoSlots(weaponSlots, cybercatItemPool, weaponSlotForItem, isWeaponItemName);
  const runtimeLoadout = await getRuntimeLoadout();
  if (runtimeLoadout) {
    mergeRuntimeItemsIntoSlots(clothingSlots, weaponSlots, runtimeLoadout.items);
  }

  const nodeHints = nodes
    .map((node) => node.name)
    .filter((name) => /inventory|equipment|loadout|item|weapon|clothing/i.test(name));
  const cybercatNames = cybercatItemPool.map((item) => cleanItemName(item.name)).filter(Boolean);
  const runtimeNames = runtimeLoadout?.items.map((item) => item.record).filter(Boolean) || [];
  const unresolvedItems = distinctLimited([...runtimeNames, ...cybercatNames, ...items, ...nodeHints], 240);
  const warnings = [
    "当前版本已接入 CyberCAT itemData 解析；装备名会用于后续资源搜索，但部分槽位哈希在 Names.json 中仍可能无法命名。",
    ...(runtimeLoadout
      ? [
          `CET 运行时快照已合并：${runtimeLoadout.items.map((item) => item.record).join("、")}。`,
          ...runtimeLoadout.warnings,
        ]
      : ["未读取到 CET 运行时装备快照；若要高还原当前穿戴，请在游戏里载入同一存档并 Reload cp2077_v_dump。"]),
    ...cybercatWarnings,
  ];
  if (cybercat?.save?.parsedItemCount) {
    warnings.push(`CyberCAT 已解析 ${cybercat.save.parsedItemCount} 个 itemData 节点。`);
  }
  if (!clothingSlots.some((slot) => slot.detected) && !weaponSlots.some((slot) => slot.detected)) {
    warnings.push("没有从该存档中识别到明确的穿戴或武器槽，可能需要补充此存档版本的节点解析规则。");
  }

  return {
    saveId,
    clothingSlots,
    weaponSlots,
    attachmentSlots,
    unresolvedItems,
    resourceCandidates: candidates,
    warnings,
  };
}

export async function analyzeSave(id: string): Promise<SaveAnalysis | null> {
  const save = await getSaveById(id);
  if (!save) {
    return null;
  }

  const buffer = await fsp.readFile(save.savPath);
  const header = parseHeader(buffer);
  const footerData = parseFooterWithFallback(buffer);
  const decompressed = decompressSaveData(buffer);
  const nodes = attachNodeIds(footerData?.nodes || [], decompressed);
  const cybercat = await inspectSaveWithCyberCat(save);
  const relevantNodes = nodes.filter((node) =>
    /appear|custom|player|gender|body|skin|hair|inventory|equipment|loadout|weapon|clothing|item/i.test(node.name),
  );
  const appearanceNodes = nodes.filter((node) => /charac.*custom.*appear|appearance/i.test(node.name));
  const appearance = createAppearancePreset(
    save,
    header,
    appearanceNodes[0] || null,
    decompressed,
    cybercat.data,
    cybercat.warnings,
  );
  const loadout = await createLoadoutPreset(save.id, buffer, decompressed, nodes, cybercat.data, cybercat.warnings);
  const hasAppearanceBlob = Boolean(appearance.appearanceNode);

  return {
    save,
    header,
    footer: footerData
      ? {
          infoStart: footerData.infoStart,
          endMagic: footerData.endMagic,
          nodeCountApprox: nodes.length,
        }
      : null,
    appearanceNodes,
    relevantNodes,
    inferredAppearance: inferAppearanceFields(save),
    appearance,
    loadout,
    pipeline: [
      {
        title: "读取存档列表",
        state: "done",
        detail: "已从 Windows 默认存档目录读取 sav.dat、metadata 和截图。",
      },
      {
        title: "解压 sav.dat",
        state: decompressed ? "done" : "blocked",
        detail: decompressed
          ? `已解压 LZ4 数据，得到 ${(decompressed.length / 1024 / 1024).toFixed(2)} MB 节点数据。`
          : "未能解压 LZ4 数据，模型构建会退回到基础 pma/pwa 资源映射。",
      },
      {
        title: "定位捏脸数据节点",
        state: hasAppearanceBlob ? "done" : "blocked",
        detail: hasAppearanceBlob
          ? "已在 sav.dat 节点目录中找到 CharacterCustomization_Appearances 外观数据块。"
          : "没有在节点目录中找到外观数据块，可能是存档格式差异或解析规则需要补充。",
      },
      {
        title: "映射基础模型资源",
        state: appearance.bodyVariant === "unknown" ? "blocked" : "done",
        detail:
          appearance.bodyVariant === "unknown"
            ? "无法从 metadata 判断使用 pma 还是 pwa 基础模型。"
            : `已映射 ${appearance.bodyVariant} 的 body、head、morphtarget 和材质根目录。`,
      },
      {
        title: "装配可预览模型",
        state: "next",
        detail: "下一步由模型构建任务调用 WolvenKit/Blender，把本地游戏资源转换为 GLB 和 STL。",
      },
    ],
  };
}

export async function getSaveScreenshotPath(id: string): Promise<string | null> {
  const save = await getSaveById(id);
  return save?.screenshotPath || null;
}

export async function getSaveLoadout(id: string): Promise<VLoadoutPreset | null> {
  const analysis = await analyzeSave(id);
  return analysis?.loadout || null;
}
