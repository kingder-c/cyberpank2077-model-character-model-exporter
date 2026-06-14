import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { promises as fsp } from "node:fs";
import path from "node:path";

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

export const getDefaultSaveDir = () =>
  path.join(process.env["USERPROFILE"] || "", "Saved Games", "CD Projekt Red", "Cyberpunk 2077");

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
        "base\\characters\\common\\player_base_bodies\\player_female_average\\arms_hq\\a0_001_pwa_base_hq__full.mesh",
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

function createAppearancePreset(
  save: SaveSummary,
  header: SaveHeader | null,
  appearanceNode: SaveNode | null,
  decompressed: Buffer | null,
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
    ],
    resourcePaths: buildResourcePaths(variant),
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

function createLoadoutPreset(saveId: string, raw: Buffer, decompressed: Buffer | null, nodes: SaveNode[]): VLoadoutPreset {
  const strings = extractAsciiStrings([decompressed, raw]).filter((value) =>
    /Items\.|Attachment|Weapon|Cloth|Head|Face|Chest|Leg|Feet|Outfit|Armor|Slot|Cyberware|Equip|Inventory/i.test(value),
  );
  const candidates = resourceCandidates(strings);
  const items = itemCandidates(strings);

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

  const nodeHints = nodes
    .map((node) => node.name)
    .filter((name) => /inventory|equipment|loadout|item|weapon|clothing/i.test(name));
  const unresolvedItems = distinctLimited([...items, ...nodeHints], 150);
  const warnings = [
    "当前版本已做存档装备槽字符串识别；CP2077 的物品 ID 到实体/外观/mesh 的完整映射仍是实验功能。",
  ];
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
  const relevantNodes = nodes.filter((node) =>
    /appear|custom|player|gender|body|skin|hair|inventory|equipment|loadout|weapon|clothing|item/i.test(node.name),
  );
  const appearanceNodes = nodes.filter((node) => /charac.*custom.*appear|appearance/i.test(node.name));
  const appearance = createAppearancePreset(save, header, appearanceNodes[0] || null, decompressed);
  const loadout = createLoadoutPreset(save.id, buffer, decompressed, nodes);
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
