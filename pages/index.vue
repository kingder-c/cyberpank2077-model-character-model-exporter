<template>
  <main class="app-shell">
    <aside class="sidebar">
      <header class="title-block">
        <p class="eyebrow">Cyberpunk 2077</p>
        <h1>V 真实 3D 预览</h1>
      </header>

      <div class="field">
        <label for="gameDir">游戏目录</label>
        <input id="gameDir" v-model="gameDir" type="text" @change="refreshTools" />
      </div>

      <div class="field">
        <label for="saveDir">存档目录</label>
        <input id="saveDir" v-model="saveDir" type="text" />
      </div>

      <button class="primary-button" :disabled="loadingSaves" @click="loadSaves">
        {{ loadingSaves ? "正在扫描存档..." : "重新扫描存档" }}
      </button>

      <p class="status">{{ status }}</p>

      <div class="save-list">
        <button
          v-for="save in saves"
          :key="save.id"
          class="save-item"
          :class="{ active: selectedSave?.id === save.id }"
          @click="selectSave(save)"
        >
          <img v-if="save.screenshotPath" class="thumb" :src="`/api/save/${save.id}/screenshot`" alt="" />
          <div v-else class="thumb empty">无图</div>
          <span class="save-name">{{ save.name }}</span>
          <span class="save-meta">{{ formatDate(save.modifiedAt) }}</span>
          <span class="save-meta">{{ metaLine(save) }}</span>
        </button>
      </div>
    </aside>

    <section class="content">
      <section v-if="selectedSave" class="summary-bar">
        <div class="summary-title">
          <p class="eyebrow">当前存档</p>
          <h2>{{ summary?.saveName || selectedSave.name }}</h2>
        </div>
        <div class="summary-chip" :class="buildTone">{{ buildLabel }}</div>
        <div class="summary-item">
          <span>身体模型</span>
          <strong>{{ summary?.bodyVariant?.toUpperCase() || "-" }}</strong>
        </div>
        <div class="summary-item">
          <span>身体性别</span>
          <strong>{{ genderLabel(summary?.bodyGender || selectedSave.meta.bodyGender) }}</strong>
        </div>
        <div class="summary-item">
          <span>游戏版本</span>
          <strong>{{ summary?.buildPatch || selectedSave.meta.buildPatch || "-" }}</strong>
        </div>
      </section>

      <section v-if="selectedSave" class="viewer-panel">
        <div class="viewer-toolbar">
          <div>
            <p class="eyebrow">3D 视口</p>
            <h3>{{ viewerTitle }}</h3>
          </div>
          <div class="viewer-actions">
            <button class="ghost-button" @click="resetCamera">重置视角</button>
            <button class="ghost-button" :class="{ active: wireframe }" @click="toggleWireframe">
              {{ wireframe ? "实体显示" : "线框显示" }}
            </button>
          </div>
        </div>

        <div ref="viewerEl" class="viewer">
          <div v-if="viewerMessage" class="viewer-overlay">
            <strong>{{ viewerMessage }}</strong>
            <p>{{ viewerHint }}</p>
          </div>
        </div>
      </section>

      <section v-if="selectedSave" class="action-panel">
        <div class="control-strip">
          <div class="mode-group">
            <span class="control-label">模型模式</span>
            <div class="mode-grid">
              <button
                v-for="mode in bodyModes"
                :key="mode.value"
                class="mode-button"
                :class="{ active: renderOptions.bodyMode === mode.value }"
                @click="applyMode(mode.value)"
              >
                {{ mode.label }}
              </button>
            </div>
          </div>

          <div class="switch-grid">
            <label class="check-line">
              <input v-model="renderOptions.includeSaveClothing" type="checkbox" />
              <span>包含存档服装</span>
            </label>
            <label class="check-line">
              <input v-model="renderOptions.includeSaveWeapons" type="checkbox" />
              <span>包含存档武器</span>
            </label>
            <label class="check-line">
              <input v-model="renderOptions.includeWeaponAttachments" type="checkbox" />
              <span>包含武器附件</span>
            </label>
            <label class="check-line">
              <input v-model="renderOptions.export3mf" type="checkbox" />
              <span>同时生成 3MF</span>
            </label>
          </div>

          <div class="select-grid">
            <label>
              <span class="control-label">动作</span>
              <select v-model="renderOptions.poseId">
                <option value="neutral">中性站姿</option>
                <option value="combat-ready">战斗准备</option>
                <option value="katana-idle">武士刀待机</option>
                <option value="photo-mode">拍照模式</option>
              </select>
            </label>
            <label>
              <span class="control-label">表情</span>
              <select v-model="renderOptions.expressionId">
                <option value="neutral">自然表情</option>
                <option value="confident">自信</option>
                <option value="serious">严肃</option>
                <option value="smirk">轻微笑</option>
              </select>
            </label>
          </div>
        </div>

        <div class="action-row">
          <button class="primary-button build-button" :disabled="!canBuild" @click="startBuild(true)">
            {{ building ? "正在生成模型..." : "生成/刷新模型" }}
          </button>
          <a
            class="secondary-button"
            :class="{ disabled: !summary?.artifacts?.hasPreview }"
            :href="summary?.artifacts?.hasPreview ? `/api/model/${selectedSave.id}/export.glb` : undefined"
          >
            导出 GLB
          </a>
          <a
            class="secondary-button"
            :class="{ disabled: !summary?.artifacts?.hasPrintable }"
            :href="summary?.artifacts?.hasPrintable ? `/api/model/${selectedSave.id}/export.stl` : undefined"
          >
            导出 STL
          </a>
          <a
            class="secondary-button"
            :class="{ disabled: !summary?.artifacts?.has3mf }"
            :href="summary?.artifacts?.has3mf ? `/api/model/${selectedSave.id}/export.3mf` : undefined"
          >
            导出 3MF
          </a>
          <button class="secondary-button" @click="openCacheDir">打开缓存目录</button>
        </div>

        <div class="loadout-panel">
          <div>
            <strong>存档穿戴识别</strong>
            <p>{{ loadoutSummary }}</p>
          </div>
          <div class="slot-grid">
            <span
              v-for="slot in visibleSlots"
              :key="`${slot.slot}-${slot.label}`"
              class="slot-pill"
              :class="{ detected: slot.detected }"
            >
              {{ slot.label }}：{{ slot.detected ? "已识别" : "未识别" }}
            </span>
          </div>
        </div>

        <div class="tool-grid">
          <div class="tool-card" :class="{ ok: tools?.gameDir.found }">
            <span>游戏资源</span>
            <strong>{{ tools?.gameDir.message || "正在检测..." }}</strong>
          </div>
          <div class="tool-card" :class="{ ok: tools?.wolvenKit.found }">
            <span>WolvenKit</span>
            <strong>{{ tools?.wolvenKit.message || "正在检测..." }}</strong>
          </div>
          <div class="tool-card" :class="{ ok: tools?.blender.found }">
            <span>Blender</span>
            <strong>{{ tools?.blender.message || "正在检测..." }}</strong>
          </div>
        </div>

        <div v-if="allWarnings.length" class="warning-box">
          <strong>解析提示</strong>
          <p v-for="warning in allWarnings" :key="warning">{{ warning }}</p>
        </div>

        <div class="log-box">
          <div class="log-title">
            <strong>生成日志</strong>
            <span>{{ activeJob?.progress ?? 0 }}%</span>
          </div>
          <p v-if="!activeJob?.logs.length">
            等待生成任务。模型会从本地游戏资源读取并写入项目缓存目录，不会修改游戏目录或存档。
          </p>
          <p v-for="line in activeJob?.logs || []" :key="line">{{ line }}</p>
        </div>
      </section>

      <section v-else class="empty-panel">
        <h2>请选择一个存档</h2>
        <p>左侧扫描完成后选择存档，右侧会显示 V 的真实 3D 模型生成状态与预览。</p>
      </section>
    </section>
  </main>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

type SaveSummary = {
  id: string;
  name: string;
  dir: string;
  screenshotPath: string | null;
  modifiedAt: string;
  size: number;
  meta: Record<string, unknown>;
};

type ArtifactStatus = {
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

type SaveSummaryResponse = {
  saveId: string;
  saveName: string;
  modifiedAt: string;
  buildPatch: string;
  gameVersion: string;
  bodyGender: string;
  brainGender: string;
  bodyVariant: string;
  appearanceNodeFound: boolean;
  artifacts: ArtifactStatus;
};

type AppearancePreset = {
  saveId: string;
  bodyGender: string;
  brainGender: string;
  bodyVariant: string;
  rawAppearanceBytes: number;
  parsedFields: Array<{ key: string; label: string; value: string | number | boolean }>;
  resourcePaths: Record<string, string | string[]>;
  warnings: string[];
};

type ToolStatus = {
  gameDir: { found: boolean; path: string; message: string };
  wolvenKit: { found: boolean; path: string | null; message: string };
  blender: { found: boolean; path: string | null; message: string };
  redMod: { found: boolean; path: string | null; message: string };
};

type BodyMode = "naked" | "save-outfit" | "clothing-only" | "weapons-only";

type RenderOptions = {
  bodyMode: BodyMode;
  includeSaveClothing: boolean;
  includeSaveWeapons: boolean;
  includeWeaponAttachments: boolean;
  poseId: string;
  expressionId: string;
  export3mf: boolean;
};

type LoadoutSlot = {
  slot: string;
  label: string;
  detected: boolean;
  rawHints: string[];
  resolvedResourcePaths: string[];
  warnings: string[];
};

type LoadoutPreset = {
  saveId: string;
  clothingSlots: LoadoutSlot[];
  weaponSlots: LoadoutSlot[];
  attachmentSlots: LoadoutSlot[];
  unresolvedItems: string[];
  resourceCandidates: string[];
  warnings: string[];
};

type BuildJob = {
  id: string;
  saveId: string;
  gameDir: string;
  status: "queued" | "running" | "done" | "error";
  progress: number;
  title: string;
  logs: string[];
  error: string | null;
  renderOptions: RenderOptions;
  artifacts: ArtifactStatus;
};

const defaultGameDir = "D:\\Program Files (x86)\\Steam\\steamapps\\common\\Cyberpunk 2077";
const gameDir = ref(defaultGameDir);
const saveDir = ref("");
const saves = ref<SaveSummary[]>([]);
const selectedSave = ref<SaveSummary | null>(null);
const summary = ref<SaveSummaryResponse | null>(null);
const appearance = ref<AppearancePreset | null>(null);
const loadout = ref<LoadoutPreset | null>(null);
const tools = ref<ToolStatus | null>(null);
const activeJob = ref<BuildJob | null>(null);
const loadingSaves = ref(false);
const loadingSelection = ref(false);
const building = ref(false);
const status = ref("准备就绪。");
const viewerEl = ref<HTMLDivElement | null>(null);
const viewerMessage = ref("还没有生成真实 3D 模型");
const viewerHint = ref("点击底部“生成/刷新模型”，生成完成后这里会加载 GLB 预览。");
const wireframe = ref(false);

const renderOptions = reactive<RenderOptions>({
  bodyMode: "naked",
  includeSaveClothing: false,
  includeSaveWeapons: false,
  includeWeaponAttachments: false,
  poseId: "neutral",
  expressionId: "neutral",
  export3mf: true,
});

const bodyModes: Array<{ value: BodyMode; label: string }> = [
  { value: "naked", label: "裸身体" },
  { value: "save-outfit", label: "还原存档穿搭" },
  { value: "clothing-only", label: "仅服装无武器" },
  { value: "weapons-only", label: "仅武器展示" },
];

let renderer: THREE.WebGLRenderer | null = null;
let scene: THREE.Scene | null = null;
let camera: THREE.PerspectiveCamera | null = null;
let controls: OrbitControls | null = null;
let currentModel: THREE.Object3D | null = null;
let animationFrame = 0;
let resizeObserver: ResizeObserver | null = null;
let pollTimer: ReturnType<typeof setTimeout> | null = null;

const buildTone = computed(() => {
  if (activeJob.value?.status === "done" || summary.value?.artifacts?.hasPreview) {
    return "done";
  }
  if (activeJob.value?.status === "running" || activeJob.value?.status === "queued") {
    return "running";
  }
  if (activeJob.value?.status === "error") {
    return "error";
  }
  return "idle";
});

const buildLabel = computed(() => {
  if (activeJob.value?.status === "running" || activeJob.value?.status === "queued") {
    return activeJob.value.title || "生成中";
  }
  if (activeJob.value?.status === "error") {
    return "生成失败";
  }
  if (summary.value?.artifacts?.hasPreview) {
    return summary.value.artifacts.has3mf ? "模型已生成" : "模型已生成，缺少 3MF";
  }
  return "等待生成";
});

const viewerTitle = computed(() => {
  const mode = bodyModes.find((item) => item.value === renderOptions.bodyMode)?.label || "裸身体";
  return `${mode} V`;
});

const visibleSlots = computed(() => {
  if (!loadout.value) {
    return [];
  }
  return [...loadout.value.clothingSlots, ...loadout.value.weaponSlots, ...loadout.value.attachmentSlots];
});

const loadoutSummary = computed(() => {
  if (!loadout.value) {
    return "正在读取存档穿戴信息。";
  }
  const clothingCount = loadout.value.clothingSlots.filter((slot) => slot.detected).length;
  const weaponCount = loadout.value.weaponSlots.filter((slot) => slot.detected).length;
  const candidateCount = loadout.value.resourceCandidates.length;
  return `识别到 ${clothingCount} 个服装槽、${weaponCount} 个武器槽，资源候选 ${candidateCount} 条。`;
});

const allWarnings = computed(() => {
  const warnings = new Set<string>();
  appearance.value?.warnings?.forEach((warning) => warnings.add(warning));
  loadout.value?.warnings?.forEach((warning) => warnings.add(warning));
  visibleSlots.value.flatMap((slot) => slot.warnings || []).forEach((warning) => warnings.add(warning));
  return [...warnings];
});

const canBuild = computed(() => {
  return Boolean(
    selectedSave.value &&
      !building.value &&
      tools.value?.gameDir.found &&
      tools.value?.wolvenKit.found &&
      tools.value?.blender.found,
  );
});

function genderLabel(value: unknown) {
  if (value === "Male") {
    return "男性";
  }
  if (value === "Female") {
    return "女性";
  }
  return "-";
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "-";
  }
  return date.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function metaLine(save: SaveSummary): string {
  const body = save.meta.bodyGender ? `身体：${genderLabel(save.meta.bodyGender)}` : "身体：-";
  const level = save.meta.level ? `等级：${save.meta.level}` : "等级：-";
  return `${body} / ${level}`;
}

function applyMode(mode: BodyMode) {
  renderOptions.bodyMode = mode;
  if (mode === "naked") {
    renderOptions.includeSaveClothing = false;
    renderOptions.includeSaveWeapons = false;
    renderOptions.includeWeaponAttachments = false;
  }
  if (mode === "save-outfit") {
    renderOptions.includeSaveClothing = true;
    renderOptions.includeSaveWeapons = true;
  }
  if (mode === "clothing-only") {
    renderOptions.includeSaveClothing = true;
    renderOptions.includeSaveWeapons = false;
    renderOptions.includeWeaponAttachments = false;
  }
  if (mode === "weapons-only") {
    renderOptions.includeSaveClothing = false;
    renderOptions.includeSaveWeapons = true;
  }
}

function initViewer() {
  if (!viewerEl.value || renderer) {
    return;
  }

  scene = new THREE.Scene();
  scene.background = new THREE.Color("#05070c");
  camera = new THREE.PerspectiveCamera(38, 1, 0.01, 1000);
  camera.position.set(0, 1.45, 4.2);

  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  viewerEl.value.appendChild(renderer.domElement);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 1.25, 0);
  controls.enableDamping = true;

  const hemi = new THREE.HemisphereLight(0xffffff, 0x243044, 2.4);
  scene.add(hemi);
  const key = new THREE.DirectionalLight(0xfff0c4, 2.1);
  key.position.set(3, 5, 4);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0x66e3ff, 0.8);
  fill.position.set(-4, 2, -3);
  scene.add(fill);

  resizeObserver = new ResizeObserver(resizeViewer);
  resizeObserver.observe(viewerEl.value);
  resizeViewer();
  animate();
}

function resizeViewer() {
  if (!viewerEl.value || !renderer || !camera) {
    return;
  }
  const rect = viewerEl.value.getBoundingClientRect();
  const width = Math.max(1, Math.floor(rect.width));
  const height = Math.max(1, Math.floor(rect.height));
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
}

function animate() {
  if (!renderer || !scene || !camera) {
    return;
  }
  controls?.update();
  renderer.render(scene, camera);
  animationFrame = window.requestAnimationFrame(animate);
}

function clearModel() {
  if (!scene || !currentModel) {
    return;
  }
  scene.remove(currentModel);
  currentModel.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.geometry) {
      mesh.geometry.dispose();
    }
    const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(material)) {
      material.forEach((item) => item.dispose());
    } else {
      material?.dispose();
    }
  });
  currentModel = null;
}

async function loadPreviewModel() {
  if (!selectedSave.value || !summary.value?.artifacts?.hasPreview || !scene) {
    clearModel();
    viewerMessage.value = "还没有生成真实 3D 模型";
    viewerHint.value = "点击底部“生成/刷新模型”，生成完成后这里会加载 GLB 预览。";
    return;
  }

  viewerMessage.value = "正在加载 GLB 模型...";
  viewerHint.value = "首次加载可能稍慢，完成后可旋转和缩放查看。";
  clearModel();
  const loader = new GLTFLoader();
  const url = `/api/model/${selectedSave.value.id}/preview.glb?t=${Date.now()}`;
  loader.load(
    url,
    (gltf) => {
      currentModel = gltf.scene;
      currentModel.traverse((child) => {
        const mesh = child as THREE.Mesh;
        if (mesh.isMesh) {
          mesh.castShadow = true;
          mesh.receiveShadow = true;
          const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
          materials.forEach((material) => {
            if (material) {
              material.wireframe = wireframe.value;
            }
          });
        }
      });
      scene?.add(currentModel);
      fitModelToView();
      viewerMessage.value = "";
      viewerHint.value = "";
    },
    undefined,
    (error) => {
      viewerMessage.value = "GLB 加载失败";
      viewerHint.value = error instanceof Error ? error.message : "请重新生成模型。";
    },
  );
}

function fitModelToView() {
  if (!currentModel || !camera || !controls) {
    return;
  }
  const box = new THREE.Box3().setFromObject(currentModel);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  currentModel.position.sub(center);
  const maxSize = Math.max(size.x, size.y, size.z) || 1;
  const distance = maxSize * 2.1;
  camera.position.set(0, maxSize * 0.45, distance);
  controls.target.set(0, 0, 0);
  controls.update();
}

function resetCamera() {
  fitModelToView();
}

function toggleWireframe() {
  wireframe.value = !wireframe.value;
  currentModel?.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) {
      return;
    }
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    materials.forEach((material) => {
      if (material) {
        material.wireframe = wireframe.value;
      }
    });
  });
}

async function refreshTools() {
  const data = await $fetch<{ gameDir: string; tools: ToolStatus }>("/api/tools", {
    query: { gameDir: gameDir.value.trim() || undefined },
  });
  tools.value = data.tools;
}

async function loadSaves() {
  loadingSaves.value = true;
  status.value = "正在读取本地存档...";
  try {
    await refreshTools();
    const data = await $fetch<{ defaultSaveDir: string; saveDir: string; saves: SaveSummary[] }>("/api/saves", {
      query: { saveDir: saveDir.value.trim() || undefined },
    });
    saveDir.value = data.saveDir || data.defaultSaveDir;
    saves.value = data.saves || [];
    status.value = saves.value.length ? `已找到 ${saves.value.length} 个存档。` : "没有找到 sav.dat 存档。";
    if (saves.value.length) {
      await selectSave(saves.value[0]);
    } else {
      selectedSave.value = null;
      summary.value = null;
      appearance.value = null;
      loadout.value = null;
    }
  } catch (error: unknown) {
    status.value = error instanceof Error ? error.message : "读取存档失败。";
  } finally {
    loadingSaves.value = false;
  }
}

async function selectSave(save: SaveSummary) {
  selectedSave.value = save;
  summary.value = null;
  appearance.value = null;
  loadout.value = null;
  activeJob.value = null;
  loadingSelection.value = true;
  status.value = `正在分析 ${save.name}...`;
  try {
    const [summaryData, appearanceData, loadoutData] = await Promise.all([
      $fetch<SaveSummaryResponse>(`/api/save/${save.id}/summary`),
      $fetch<AppearancePreset>(`/api/save/${save.id}/appearance`),
      $fetch<LoadoutPreset>(`/api/save/${save.id}/loadout`),
    ]);
    summary.value = summaryData;
    appearance.value = appearanceData;
    loadout.value = loadoutData;
    status.value = `已选择 ${save.name}。`;
    await nextTick();
    initViewer();
    await loadPreviewModel();
  } catch (error: unknown) {
    status.value = error instanceof Error ? error.message : "分析存档失败。";
  } finally {
    loadingSelection.value = false;
  }
}

async function refreshSummary() {
  if (!selectedSave.value) {
    return;
  }
  summary.value = await $fetch<SaveSummaryResponse>(`/api/save/${selectedSave.value.id}/summary`);
}

async function startBuild(force = false) {
  if (!selectedSave.value || building.value) {
    return;
  }
  building.value = true;
  viewerMessage.value = "正在生成真实 3D 模型";
  viewerHint.value = "后端会读取本地游戏资源并写入项目缓存目录。";
  const data = await $fetch<{ jobId: string; job: BuildJob }>("/api/model/build", {
    method: "POST",
    body: {
      saveId: selectedSave.value.id,
      gameDir: gameDir.value,
      force,
      renderOptions: { ...renderOptions },
    },
  });
  activeJob.value = data.job;
  pollJob(data.jobId);
}

function pollJob(jobId: string) {
  if (pollTimer) {
    clearTimeout(pollTimer);
  }
  pollTimer = setTimeout(async () => {
    try {
      const job = await $fetch<BuildJob>(`/api/model/jobs/${jobId}`);
      activeJob.value = job;
      if (job.status === "queued" || job.status === "running") {
        pollJob(jobId);
        return;
      }
      building.value = false;
      await refreshSummary();
      await loadPreviewModel();
      if (job.status === "error") {
        viewerMessage.value = "模型生成未完成";
        viewerHint.value = job.error || "请查看底部生成日志。";
      }
    } catch (error: unknown) {
      building.value = false;
      viewerMessage.value = "任务轮询失败";
      viewerHint.value = error instanceof Error ? error.message : "请重新点击生成。";
    }
  }, 800);
}

async function openCacheDir() {
  if (!selectedSave.value) {
    return;
  }
  const data = await $fetch<{ cacheDir: string; opened: boolean }>(`/api/model/${selectedSave.value.id}/cache.open`, {
    method: "POST",
  });
  status.value = data.opened ? "已打开缓存目录。" : `缓存目录：${data.cacheDir}`;
}

onMounted(async () => {
  initViewer();
  await loadSaves();
});

onBeforeUnmount(() => {
  if (pollTimer) {
    clearTimeout(pollTimer);
  }
  if (animationFrame) {
    window.cancelAnimationFrame(animationFrame);
  }
  resizeObserver?.disconnect();
  controls?.dispose();
  clearModel();
  renderer?.dispose();
});
</script>

<style scoped>
:global(*) {
  box-sizing: border-box;
}

:global(body) {
  margin: 0;
  color: #f5f7fb;
  background: #07090f;
  font-family: "Microsoft YaHei", "PingFang SC", "Segoe UI", Arial, sans-serif;
}

.app-shell {
  min-height: 100vh;
  display: grid;
  grid-template-columns: 380px minmax(0, 1fr);
  background:
    linear-gradient(135deg, rgba(0, 216, 190, 0.1), transparent 34%),
    linear-gradient(315deg, rgba(255, 218, 77, 0.08), transparent 28%),
    #07090f;
}

.sidebar {
  min-height: 100vh;
  padding: 22px;
  border-right: 1px solid #2b3445;
  background: #0d1320;
}

.content {
  min-width: 0;
  padding: 24px;
  display: grid;
  grid-template-rows: auto minmax(430px, 1fr) auto;
  gap: 16px;
}

.title-block {
  margin-bottom: 20px;
}

.eyebrow {
  margin: 0 0 6px;
  color: #ffd84d;
  font-size: 12px;
  font-weight: 800;
  letter-spacing: 0;
  text-transform: uppercase;
}

h1,
h2,
h3,
p {
  margin-top: 0;
}

h1 {
  margin-bottom: 0;
  color: #ffffff;
  font-size: 30px;
  line-height: 1.18;
}

h2 {
  margin-bottom: 0;
  color: #ffffff;
  font-size: 24px;
  line-height: 1.25;
}

h3 {
  margin-bottom: 0;
  color: #ffffff;
  font-size: 18px;
  line-height: 1.3;
}

.field {
  margin-bottom: 14px;
}

label {
  display: block;
  color: #e7ecf6;
  font-size: 13px;
  font-weight: 700;
}

.field label,
.control-label {
  margin-bottom: 7px;
}

input,
select {
  width: 100%;
  min-height: 42px;
  border: 1px solid #536074;
  border-radius: 8px;
  padding: 9px 11px;
  color: #ffffff;
  background: #111a2a;
  outline: none;
}

input:focus,
select:focus {
  border-color: #ffd84d;
  box-shadow: 0 0 0 3px rgba(255, 216, 77, 0.18);
}

button,
a {
  font: inherit;
}

a {
  text-decoration: none;
}

.primary-button,
.secondary-button,
.ghost-button,
.mode-button {
  min-height: 42px;
  border-radius: 8px;
  font-weight: 800;
  cursor: pointer;
}

.primary-button {
  width: 100%;
  border: 0;
  color: #061018;
  background: #ffd84d;
}

.primary-button:disabled {
  color: #d7deeb;
  background: #495466;
  cursor: not-allowed;
}

.secondary-button,
.ghost-button,
.mode-button {
  display: inline-grid;
  place-items: center;
  border: 1px solid #536074;
  padding: 0 14px;
  color: #f5f7fb;
  background: #141d2d;
}

.secondary-button:hover,
.ghost-button:hover,
.ghost-button.active,
.mode-button.active {
  border-color: #66e3ff;
  color: #061018;
  background: #66e3ff;
}

.secondary-button.disabled {
  pointer-events: none;
  color: #9aa7bb;
  background: #263142;
}

.status {
  min-height: 24px;
  margin: 12px 0;
  color: #9fe8ff;
  font-size: 14px;
  font-weight: 700;
}

.save-list {
  display: grid;
  gap: 10px;
  max-height: calc(100vh - 282px);
  overflow: auto;
  padding-right: 4px;
}

.save-item {
  display: grid;
  grid-template-columns: 76px minmax(0, 1fr);
  gap: 5px 10px;
  width: 100%;
  border: 1px solid #2f3a4c;
  border-radius: 8px;
  padding: 8px;
  color: #f5f7fb;
  background: #141d2d;
  text-align: left;
  cursor: pointer;
}

.save-item.active {
  border-color: #ffd84d;
  background: #1c2738;
  box-shadow: 0 0 0 2px rgba(255, 216, 77, 0.18);
}

.thumb {
  grid-row: span 3;
  width: 76px;
  height: 48px;
  border-radius: 6px;
  object-fit: cover;
  background: #07090f;
}

.thumb.empty {
  display: grid;
  place-items: center;
  color: #d7deeb;
  border: 1px solid #344257;
  font-size: 12px;
}

.save-name {
  color: #ffffff;
  font-weight: 800;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.save-meta {
  color: #cbd5e8;
  font-size: 12px;
}

.summary-bar,
.viewer-panel,
.action-panel,
.empty-panel {
  border: 1px solid #2f3a4c;
  border-radius: 8px;
  background: #101827;
}

.summary-bar {
  display: grid;
  grid-template-columns: minmax(240px, 1fr) auto repeat(3, minmax(120px, 160px));
  gap: 14px;
  align-items: center;
  padding: 16px;
}

.summary-title {
  min-width: 0;
}

.summary-title h2 {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.summary-chip {
  border-radius: 999px;
  padding: 7px 12px;
  color: #061018;
  background: #cbd5e8;
  font-weight: 900;
  white-space: nowrap;
}

.summary-chip.done {
  background: #4ee6c5;
}

.summary-chip.running {
  background: #ffd84d;
}

.summary-chip.error {
  color: #ffffff;
  background: #b94b55;
}

.summary-item {
  min-height: 58px;
  border: 1px solid #2d384a;
  border-radius: 8px;
  padding: 9px 10px;
  background: #0d1320;
}

.summary-item span {
  display: block;
  margin-bottom: 5px;
  color: #aebbd0;
  font-size: 12px;
  font-weight: 700;
}

.summary-item strong {
  color: #ffffff;
  font-size: 17px;
}

.viewer-panel {
  min-height: 430px;
  display: grid;
  grid-template-rows: auto minmax(350px, 1fr);
  overflow: hidden;
}

.viewer-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  padding: 14px 16px;
  border-bottom: 1px solid #2f3a4c;
}

.viewer-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.viewer {
  position: relative;
  min-height: 350px;
  background:
    linear-gradient(180deg, rgba(102, 227, 255, 0.08), transparent 40%),
    #05070c;
}

.viewer :deep(canvas) {
  display: block;
  width: 100%;
  height: 100%;
}

.viewer-overlay {
  position: absolute;
  inset: 0;
  z-index: 1;
  display: grid;
  place-content: center;
  padding: 24px;
  text-align: center;
  pointer-events: none;
}

.viewer-overlay strong {
  color: #ffffff;
  font-size: 24px;
}

.viewer-overlay p {
  max-width: 520px;
  margin: 10px auto 0;
  color: #d7deeb;
  line-height: 1.6;
}

.action-panel {
  padding: 16px;
}

.control-strip {
  display: grid;
  grid-template-columns: minmax(260px, 1.2fr) minmax(280px, 1fr) minmax(260px, 0.9fr);
  gap: 14px;
  margin-bottom: 14px;
}

.control-label {
  display: block;
  color: #ffd84d;
  font-size: 12px;
  font-weight: 900;
}

.mode-grid,
.switch-grid,
.select-grid {
  display: grid;
  gap: 10px;
}

.mode-grid {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.mode-button {
  width: 100%;
}

.switch-grid {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.check-line {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 42px;
  border: 1px solid #2d384a;
  border-radius: 8px;
  padding: 0 10px;
  background: #0d1320;
}

.check-line input {
  width: 18px;
  min-height: 18px;
  accent-color: #ffd84d;
}

.check-line span {
  color: #ffffff;
}

.select-grid {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.action-row {
  display: grid;
  grid-template-columns: minmax(180px, 240px) repeat(4, minmax(120px, auto));
  gap: 10px;
  margin-bottom: 14px;
}

.build-button {
  width: auto;
}

.loadout-panel {
  display: grid;
  grid-template-columns: minmax(220px, 0.8fr) minmax(0, 1.2fr);
  gap: 12px;
  margin-bottom: 14px;
  border: 1px solid #2d384a;
  border-radius: 8px;
  padding: 12px;
  background: #0d1320;
}

.loadout-panel strong {
  color: #ffffff;
}

.loadout-panel p {
  margin: 7px 0 0;
  color: #cbd5e8;
  line-height: 1.5;
}

.slot-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-content: flex-start;
}

.slot-pill {
  border: 1px solid #3f4b5f;
  border-radius: 999px;
  padding: 6px 10px;
  color: #cbd5e8;
  background: #141d2d;
  font-size: 12px;
  font-weight: 800;
}

.slot-pill.detected {
  border-color: #4ee6c5;
  color: #061018;
  background: #4ee6c5;
}

.tool-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
  margin-bottom: 14px;
}

.tool-card {
  border: 1px solid #593a42;
  border-radius: 8px;
  padding: 10px;
  background: #211622;
}

.tool-card.ok {
  border-color: #2e6b61;
  background: #0f2827;
}

.tool-card span {
  display: block;
  margin-bottom: 5px;
  color: #ffd84d;
  font-size: 12px;
  font-weight: 900;
}

.tool-card strong {
  color: #ffffff;
  font-size: 13px;
  line-height: 1.45;
}

.warning-box,
.log-box {
  border: 1px solid #2d384a;
  border-radius: 8px;
  padding: 12px;
  background: #0d1320;
}

.warning-box {
  margin-bottom: 12px;
  border-color: #7a6730;
}

.warning-box strong,
.log-title strong {
  color: #ffffff;
}

.warning-box p,
.log-box p {
  margin: 7px 0 0;
  color: #d7deeb;
  line-height: 1.5;
}

.log-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  color: #9fe8ff;
}

.empty-panel {
  min-height: 420px;
  display: grid;
  place-content: center;
  padding: 24px;
  text-align: center;
}

.empty-panel p {
  color: #cbd5e8;
}

@media (max-width: 1240px) {
  .app-shell {
    grid-template-columns: 1fr;
  }

  .sidebar {
    min-height: auto;
    border-right: 0;
    border-bottom: 1px solid #2b3445;
  }

  .save-list {
    max-height: 360px;
  }

  .summary-bar,
  .control-strip,
  .action-row,
  .loadout-panel,
  .tool-grid {
    grid-template-columns: 1fr 1fr;
  }
}

@media (max-width: 760px) {
  .content,
  .sidebar {
    padding: 16px;
  }

  .summary-bar,
  .control-strip,
  .mode-grid,
  .switch-grid,
  .select-grid,
  .action-row,
  .loadout-panel,
  .tool-grid {
    grid-template-columns: 1fr;
  }

  .viewer-toolbar {
    align-items: flex-start;
    flex-direction: column;
  }
}
</style>
