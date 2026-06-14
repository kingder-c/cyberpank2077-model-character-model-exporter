import { existsSync, statSync } from "node:fs";
import { promises as fsp } from "node:fs";
import path from "node:path";

type RuntimeFlat = {
  flat?: string;
  ok?: boolean;
  value?: string;
  valueType?: string;
  error?: string;
};

type RuntimeSlot = {
  slot?: string;
  itemRecord?: string;
  activeItemRecord?: string;
  objectItemRecord?: string;
  objectAppearance?: string;
  objectColorVariant?: string;
};

type RuntimeEquipArea = {
  area?: string;
  slotIndex?: string | number;
  itemRecord?: string;
  activeRecord?: string;
  visualRecord?: string;
  itemObjectAppearance?: string;
  activeObjectAppearance?: string;
  visualObjectAppearance?: string;
  itemObjectColorVariant?: string;
  activeObjectColorVariant?: string;
  visualObjectColorVariant?: string;
};

type RuntimeDump = {
  generatedAt?: string;
  slots?: RuntimeSlot[];
  equipAreas?: RuntimeEquipArea[];
  sampleFlats?: RuntimeFlat[];
};

export type RuntimeLoadoutItem = {
  record: string;
  source: "equipArea" | "slot";
  area: string;
  slot: string;
  entityName: string;
  appearanceName: string;
  equipArea: string;
  itemType: string;
  itemCategory: string;
  quality: string;
  objectAppearance: string;
  objectColorVariant: string;
};

export type RuntimeLoadout = {
  path: string;
  generatedAt: string;
  items: RuntimeLoadoutItem[];
  warnings: string[];
};

function workspaceRoot() {
  return process.cwd();
}

function defaultGameDir() {
  return "D:\\Program Files (x86)\\Steam\\steamapps\\common\\Cyberpunk 2077";
}

function runtimeDumpCandidates() {
  const gameDir = process.env["CP2077_GAME_DIR"] || defaultGameDir();
  return [
    process.env["CP2077_CET_RUNTIME_DUMP"] || "",
    path.join(
      gameDir,
      "bin",
      "x64",
      "plugins",
      "cyber_engine_tweaks",
      "mods",
      "cp2077_v_dump",
      "runtime-dump.json",
    ),
    path.join(workspaceRoot(), ".cache", "cet-v-runtime-dump.json"),
  ].filter(Boolean);
}

function findRuntimeDumpPath() {
  return runtimeDumpCandidates()
    .filter((candidate) => existsSync(candidate))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
}

function extractComment(value: string | undefined) {
  const text = String(value || "");
  const match = text.match(/--\[\[\s*([^\]]+?)\s*\]\]/);
  const result = (match?.[1] || text).replace(/\s+--$/, "").trim();
  return result === "None" ? "" : result;
}

function getFlatMap(flats: RuntimeFlat[] | undefined) {
  const map = new Map<string, string>();
  for (const flat of flats || []) {
    if (flat.flat && flat.ok) {
      map.set(flat.flat, extractComment(flat.value));
    }
  }
  return map;
}

function flatFor(map: Map<string, string>, record: string, field: string) {
  return map.get(`${record}.${field}`) || "";
}

function slotLabelFromRuntime(item: { area?: string; slot?: string; equipArea?: string; itemType?: string }) {
  const text = `${item.area || ""} ${item.slot || ""} ${item.equipArea || ""} ${item.itemType || ""}`;
  if (/Face|Clo_Face|FaceArmor/i.test(text)) {
    return "Face";
  }
  if (/Head|Clo_Head|HeadArmor/i.test(text)) {
    return "Head";
  }
  if (/InnerChest|Clo_InnerChest/i.test(text)) {
    return "InnerChest";
  }
  if (/ChestArmor|OuterChest|Clo_OuterChest/i.test(text)) {
    return "OuterChest";
  }
  if (/Legs|LegArmor|Clo_Legs/i.test(text)) {
    return "Legs";
  }
  if (/Feet|Clo_Feet/i.test(text)) {
    return "Feet";
  }
  if (/Outfit/i.test(text)) {
    return "Outfit";
  }
  if (/ArmsCW|StrongArms|Cyb_StrongArms/i.test(text)) {
    return "Melee";
  }
  if (/QuickSlot|Grenade|Gadget/i.test(text)) {
    return "QuickSlot";
  }
  if (/Weapon|Handgun|Rifle|Shotgun|SMG|Katana|Knife|Blade/i.test(text)) {
    return "PrimaryWeapon";
  }
  return "Runtime";
}

function createRuntimeItem(
  record: string,
  source: RuntimeLoadoutItem["source"],
  area: string,
  slot: string,
  flatMap: Map<string, string>,
  objectAppearance = "",
  objectColorVariant = "",
): RuntimeLoadoutItem {
  const item = {
    record,
    source,
    area,
    slot,
    entityName: flatFor(flatMap, record, "entityName"),
    appearanceName: flatFor(flatMap, record, "appearanceName"),
    equipArea: flatFor(flatMap, record, "equipArea"),
    itemType: flatFor(flatMap, record, "itemType"),
    itemCategory: flatFor(flatMap, record, "itemCategory"),
    quality: flatFor(flatMap, record, "quality"),
    objectAppearance: extractComment(objectAppearance),
    objectColorVariant: extractComment(objectColorVariant),
  };
  return { ...item, slot: slotLabelFromRuntime(item) };
}

export async function getRuntimeLoadout(): Promise<RuntimeLoadout | null> {
  const dumpPath = findRuntimeDumpPath();
  if (!dumpPath) {
    return null;
  }

  let parsed: RuntimeDump;
  try {
    parsed = JSON.parse(await fsp.readFile(dumpPath, "utf8")) as RuntimeDump;
  } catch {
    return null;
  }

  const flatMap = getFlatMap(parsed.sampleFlats);
  const byKey = new Map<string, RuntimeLoadoutItem>();

  for (const area of parsed.equipAreas || []) {
    const record = area.itemRecord || area.visualRecord || area.activeRecord || "";
    if (!record || !/^Items\./i.test(record)) {
      continue;
    }
    const item = createRuntimeItem(
      record,
      "equipArea",
      String(area.area || ""),
      String(area.slotIndex ?? ""),
      flatMap,
      area.itemObjectAppearance || area.visualObjectAppearance || area.activeObjectAppearance,
      area.itemObjectColorVariant || area.visualObjectColorVariant || area.activeObjectColorVariant,
    );
    byKey.set(`${item.area}|${item.slot}|${item.record}`, item);
  }

  for (const slot of parsed.slots || []) {
    const record = slot.objectItemRecord || slot.activeItemRecord || slot.itemRecord || "";
    if (!record || !/^Items\./i.test(record)) {
      continue;
    }
    const item = createRuntimeItem(
      record,
      "slot",
      String(slot.slot || ""),
      String(slot.slot || ""),
      flatMap,
      slot.objectAppearance,
      slot.objectColorVariant,
    );
    byKey.set(`${item.area}|${item.slot}|${item.record}`, item);
  }

  const items = [...byKey.values()].filter((item) => item.itemCategory !== "ItemCategory.Gadget");
  if (!items.length) {
    return null;
  }

  const missing = items
    .filter((item) => !item.entityName || !item.appearanceName)
    .map((item) => item.record);

  return {
    path: dumpPath,
    generatedAt: parsed.generatedAt || new Date(statSync(dumpPath).mtimeMs).toISOString(),
    items,
    warnings: [
      `已读取 CET 运行时装备快照：${path.basename(dumpPath)}。`,
      "运行时装备快照只代表当前游戏里已加载的角色；请确保 WebUI 选择的是同一个最新存档。",
      ...(missing.length ? [`以下运行时物品缺少 entityName 或 appearanceName：${missing.join("、")}`] : []),
    ],
  };
}
