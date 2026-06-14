import { createHash, randomUUID } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { analyzeSave, getSaveById, type VAppearancePreset, type VLoadoutPreset } from "./saveStore";

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
      "此 manifest 记录从存档解析出的基础 V 外观映射，以及 WolvenKit/Blender 生成 preview.glb 和 print.stl 的本地工具状态。",
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
  const archivePath = path.join(gameDir, "archive", "pc", "content", "basegame_4_appearance.archive");
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
    "MeshOnly",
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
  const skinColor = appearance.bodyVariant === "pwa" ? [0.78, 0.52, 0.39, 1] : [0.68, 0.42, 0.29, 1];
  const inputsLiteral = JSON.stringify(inputs);
  const optionsLiteral = JSON.stringify(options);
  const skinColorLiteral = JSON.stringify(JSON.stringify(skinColor));
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
    "hair": make_material("V hair base", (0.045, 0.038, 0.035, 1.0), 0.72, 0.0),
    "eyes": make_material("V eye base", (0.18, 0.72, 0.95, 1.0), 0.22, 0.0),
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

def import_source(source):
    path = source["glbPath"]
    if not os.path.exists(path):
        print("skip missing", path)
        return []
    before = set(bpy.context.scene.objects)
    print("import", source["role"], path)
    bpy.ops.import_scene.gltf(filepath=path)
    added = [obj for obj in bpy.context.scene.objects if obj not in before and obj.type == "MESH"]
    mat = material_for_role(source["role"])
    for obj in added:
        obj.name = "${label} " + source["label"] + " " + obj.name
        obj["cp2077_role"] = source["role"]
        obj["cp2077_source"] = source["resourcePath"]
        obj.data.materials.clear()
        obj.data.materials.append(mat)
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

  pushLog(job, `渲染模式：${renderModeLabel(renderOptions.bodyMode)}。`);
  setJob(job, { progress: 50, title: "导出裸身体基础模型" });
  await addMesh("body", "身体/躯干/腿部", resources.bodyMesh, true);

  setJob(job, { progress: 60, title: "导出头部模型" });
  await addMesh("head", "头部", resources.headMesh, true);

  setJob(job, { progress: 68, title: "导出手臂和手" });
  await addMesh("arms", "手臂/手", resources.armsMesh, false);

  for (const hairMesh of resources.hairMeshes || []) {
    await addMesh("hair", "发型", hairMesh, false);
  }
  for (const eyeMesh of resources.eyeMeshes || []) {
    await addMesh("eyes", "眼睛", eyeMesh, false);
  }
  for (const cyberwareMesh of resources.cyberwareMeshes || []) {
    await addMesh("cyberware", "义体外观", cyberwareMesh, false);
  }

  const clothingResources = loadout.clothingSlots.flatMap((slot) => slot.resolvedResourcePaths);
  const weaponResources = loadout.weaponSlots.flatMap((slot) => slot.resolvedResourcePaths);
  const attachmentResources = loadout.attachmentSlots.flatMap((slot) => slot.resolvedResourcePaths);

  if (renderOptions.includeSaveClothing || renderOptions.bodyMode === "save-outfit" || renderOptions.bodyMode === "clothing-only") {
    if (!clothingResources.length) {
      pushLog(job, "已启用存档服装，但当前只能识别槽位/物品线索，还没有解析到可直接导出的服装 mesh。");
    }
    for (const resourcePath of clothingResources) {
      await addMesh("clothing", "存档服装", resourcePath, false);
    }
  }

  if (renderOptions.includeSaveWeapons || renderOptions.bodyMode === "save-outfit" || renderOptions.bodyMode === "weapons-only") {
    if (!weaponResources.length) {
      pushLog(job, "已启用存档武器，但当前只能识别武器线索，还没有解析到可直接导出的武器 mesh。");
    }
    for (const resourcePath of weaponResources) {
      await addMesh("weapon", "存档武器", resourcePath, false);
    }
  }

  if (renderOptions.includeWeaponAttachments) {
    if (!attachmentResources.length) {
      pushLog(job, "已启用武器附件，但当前没有解析到可直接导出的附件 mesh。");
    }
    for (const resourcePath of attachmentResources) {
      await addMesh("weapon", "武器附件", resourcePath, false);
    }
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
  if (!artifacts.hasPreview || !artifacts.hasPrintable || (renderOptions.export3mf && !artifacts.has3mf)) {
    throw new Error("Blender 已运行完成，但没有生成完整的 preview.glb、print.stl 或 print.3mf。");
  }

  pushLog(job, "模型生成完成：preview.glb、print.stl、print.3mf 已写入缓存目录。");
  setJob(job, { progress: 96, title: "模型导出完成", artifacts });
}

async function runBuild(job: ModelBuildJob, force: boolean) {
  setJob(job, { status: "running", progress: 5, title: "读取存档" });
  try {
    const renderOptions = job.renderOptions;
    const save = await getSaveById(job.saveId);
    if (!save) {
      throw new Error("未找到该存档，请重新扫描。");
    }

    const artifacts = getArtifacts(job.saveId);
    const cachedArtifactsReady = artifacts.hasPreview && artifacts.hasPrintable && (!renderOptions.export3mf || artifacts.has3mf);
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
      createBuildManifest(analysis.appearance, analysis.loadout, tools, job.gameDir, renderOptions),
    );

    setJob(job, { progress: 42, title: "检查工具链", artifacts: getArtifacts(job.saveId) });
    const blockers = getToolBlockers(tools);
    if (blockers.length) {
      for (const blocker of blockers) {
        pushLog(job, blocker);
      }
      throw new Error(`模型生成被阻塞：${blockers.join("；")}`);
    }

    await attemptEnhancedExternalBuild(job, analysis.appearance, analysis.loadout, tools, renderOptions);
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
