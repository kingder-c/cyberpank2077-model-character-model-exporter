<template>
  <main class="app-shell">
    <aside class="sidebar">
      <header class="title-block">
        <p class="eyebrow">Cyberpunk 2077</p>
        <h1>V 鐪熷疄 3D 棰勮</h1>
      </header>

      <div class="field">
        <label for="gameDir">娓告垙鐩綍</label>
        <input id="gameDir" v-model="gameDir" type="text" @change="refreshTools" />
      </div>

      <div class="field">
        <label for="saveDir">瀛樻。鐩綍</label>
        <input id="saveDir" v-model="saveDir" type="text" />
      </div>

      <button class="primary-button" :disabled="loadingSaves" @click="loadSaves">
        {{ loadingSaves ? "姝ｅ湪鎵弿瀛樻。..." : "閲嶆柊鎵弿瀛樻。" }}
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
          <div v-else class="thumb empty">鏃犲浘</div>
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
          <span>身材类型</span>
          <strong>{{ summary?.bodyVariant?.toUpperCase() || "-" }}</strong>
        </div>
        <div class="summary-item">
          <span>身高性别</span>
          <strong>{{ genderLabel(summary?.bodyGender || selectedSave.meta.bodyGender) }}</strong>
        </div>
        <div class="summary-item">
          <span>游戏版本</span>
          <strong>{{ summary?.buildPatch || selectedSave.meta.buildPatch || "-" }}</strong>
        </div>
      </section>

        <section class="main-workspace" v-if="selectedSave">
          <section class="work-zone">
            <section class="viewer-panel">
              <div class="viewer-toolbar">
                <div>
                <p class="eyebrow">3D 预览</p>
                <h3>{{ viewerTitle }}</h3>
              </div>
              <div class="viewer-actions">
                <button class="ghost-button" @click="resetCamera">重置相机</button>
                <button class="ghost-button" :class="{ active: wireframe }" @click="toggleWireframe">
                  {{ wireframe ? "线框显示" : "光照显示" }}
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
          </section>

          <aside class="log-dock" v-if="selectedSave">
          <div class="log-box">
            <div class="log-title">
              <strong>生成日志</strong>
              <span>{{ jobProgress }}%</span>
            </div>
            <div class="log-progress-track">
              <div class="log-progress-fill" :style="{ width: `${jobProgress}%` }"></div>
            </div>
              <div ref="logScrollRef" class="log-scroll">
                <p v-if="!activeJob?.logs.length">
                  等待生成任务，点击底部“生成/刷新模型”后会在此显示详细导出日志，并可打开缓存目录查看结果。
                </p>
                <p v-for="(line, index) in activeJob?.logs || []" :key="`${index}-${line}`">{{ line }}</p>
              </div>
            </div>
          </aside>
        </section>

        <section v-if="selectedSave" class="operation-dock">
          <section class="action-panel">
            <div class="action-quick">
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
              <button class="secondary-button" type="button" @click="operationExpanded = !operationExpanded">
                {{ operationExpanded ? "收起高级参数" : "展开高级参数" }}
              </button>
            </div>

            <div v-show="operationExpanded" class="operation-body">
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
                    <span>同时导出 3MF</span>
                  </label>
                </div>

                <div class="select-grid">
                  <label>
                    <span class="control-label">姿态</span>
                    <select v-model="renderOptions.poseId">
                      <option value="neutral">中性</option>
                      <option value="combat-ready">战斗准备</option>
                      <option value="katana-idle">拔刀待机</option>
                      <option value="photo-mode">拍照姿势</option>
                    </select>
                  </label>
                  <label>
                    <span class="control-label">表情</span>
                    <select v-model="renderOptions.expressionId">
                      <option value="neutral">默认表情</option>
                      <option value="confident">自信</option>
                      <option value="serious">严肃</option>
                      <option value="smirk">轻笑</option>
                    </select>
                  </label>
                </div>
              </div>

              <div class="parallel-control">
                <div class="control-label">并发解包数（1-16）</div>
                <div class="parallel-fields">
                  <input v-model.number="buildParallelism" type="range" min="1" max="16" step="1" />
                  <input v-model.number="buildParallelism" type="number" min="1" max="16" step="1" />
                  <strong>{{ buildParallelism }} 线程</strong>
                </div>
                <div class="parallel-note">更高并发可加速 WolvenKit 导出；如果系统内存紧张，可降低到 1~2。</div>
              </div>

              <div class="loadout-panel">
                <div>
                  <strong>存档着装识别</strong>
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
                  <span>游戏目录</span>
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
                <strong>解析警告</strong>
                <p v-for="warning in allWarnings" :key="warning">{{ warning }}</p>
              </div>
            </div>
          </section>
        </section>

      <section v-else class="empty-panel">
        <h2>请选择一个存档</h2>
        <p>请先启动后端并读取存档后，选择一个保存文件，生成并预览 V 的 3D 形象。</p>
      </section>
    </section>
  </main>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
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
  parallelism: number;
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
const status = ref("准备就绪");
const viewerEl = ref<HTMLDivElement | null>(null);
const viewerMessage = ref("请先选择一个存档并点击生成");
const viewerHint = ref("点击下方按钮生成模型，完成后会自动加载 GLB 预览。 ");
const wireframe = ref(false);
const operationExpanded = ref(false);
const logScrollRef = ref<HTMLElement | null>(null);
const buildParallelism = ref(3);

const jobProgress = computed(() => Math.max(0, Math.min(100, activeJob.value?.progress ?? 0)));

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
  { value: "save-outfit", label: "还原存档穿戴" },
  { value: "clothing-only", label: "仅服装无武器" },
  { value: "weapons-only", label: "仅武器" },
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
    return activeJob.value.title || "任务进行中";
  }
  if (activeJob.value?.status === "error") {
    return "生成失败";
  }
  if (summary.value?.artifacts?.hasPreview) {
    return summary.value.artifacts.has3mf ? "已有可预览模型 / 支持 3MF" : "已有可预览模型";
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
    return "正在读取着装识别信息...";
  }
  const clothingCount = loadout.value.clothingSlots.filter((slot) => slot.detected).length;
  const weaponCount = loadout.value.weaponSlots.filter((slot) => slot.detected).length;
  const candidateCount = loadout.value.resourceCandidates.length;
  return `识别到 ${clothingCount} 套服装、${weaponCount} 件武器、${candidateCount} 条候选资源`;
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

watch(
  buildParallelism,
  (value) => {
    const normalized = Math.max(1, Math.min(16, Number.parseInt(`${value}`, 10) || 1));
    if (normalized !== buildParallelism.value) {
      buildParallelism.value = normalized;
    }
  },
  { immediate: true },
);

watch(
  () => `${activeJob.value?.id ?? ""}:${activeJob.value?.logs.length ?? 0}`,
  async () => {
    await nextTick();
    const el = logScrollRef.value;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  },
);

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
  const body = save.meta.bodyGender ? `性别：${genderLabel(save.meta.bodyGender)}` : "性别：未识别";
  const level = save.meta.level ? `等级：${save.meta.level}` : "等级：未识别";
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
    viewerMessage.value = "请先选择一个存档并点击生成";
    viewerHint.value = "点击下方按钮生成模型，完成后会自动加载 GLB 预览。";
    return;
  }

  viewerMessage.value = "正在加载 GLB 模型...";
  viewerHint.value = "请耐心等待，加载完成后可继续旋转查看。";
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
        viewerHint.value = error instanceof Error ? error.message : "GLB 加载失败";
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
    status.value = saves.value.length ? `读取到 ${saves.value.length} 个存档` : "未找到可用的 sav.dat 存档。";
    if (saves.value.length) {
      await selectSave(saves.value[0]);
    } else {
      selectedSave.value = null;
      summary.value = null;
      appearance.value = null;
      loadout.value = null;
    }
  } catch (error: unknown) {
    status.value = error instanceof Error ? error.message : "读取存档失败";
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
    status.value = `解析中 ${save.name}...`;
  try {
    const [summaryData, appearanceData, loadoutData] = await Promise.all([
      $fetch<SaveSummaryResponse>(`/api/save/${save.id}/summary`),
      $fetch<AppearancePreset>(`/api/save/${save.id}/appearance`),
      $fetch<LoadoutPreset>(`/api/save/${save.id}/loadout`),
    ]);
    summary.value = summaryData;
    appearance.value = appearanceData;
    loadout.value = loadoutData;
    status.value = `已选择 ${save.name}`;
    await nextTick();
    initViewer();
    await loadPreviewModel();
  } catch (error: unknown) {
    status.value = error instanceof Error ? error.message : "解析存档失败";
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
  viewerMessage.value = "正在生成 V 的 3D 模型";
  viewerHint.value = "请耐心等待，模型任务会先导出资源再进入 Blender 合成。";
  const data = await $fetch<{ jobId: string; job: BuildJob }>("/api/model/build", {
    method: "POST",
    body: {
      saveId: selectedSave.value.id,
      gameDir: gameDir.value,
      force,
      renderOptions: { ...renderOptions },
      parallelism: buildParallelism.value,
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
        viewerHint.value = job.error || "请查看日志了解详细错误";
      }
    } catch (error: unknown) {
      building.value = false;
      viewerMessage.value = "任务轮询失败";
      viewerHint.value = error instanceof Error ? error.message : "请重试或查看后端日志";
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
  status.value = data.opened ? "已打开缓存目录" : `打开缓存目录失败：${data.cacheDir}`;
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
  display: flex;
  flex-direction: column;
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
.main-workspace,
.empty-panel {
  border: 1px solid #2f3a4c;
  border-radius: 8px;
  background: #101827;
}

.main-workspace {
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(320px, min(380px, 38vw));
  align-items: start;
  gap: 16px;
}

.operation-dock {
  position: sticky;
  bottom: 16px;
  z-index: 10;
}

.work-zone {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 0;
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

.log-dock {
  min-width: 0;
  min-height: 430px;
  max-height: calc(100vh - 180px);
  position: sticky;
  top: 16px;
  display: flex;
  flex-direction: column;
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
  border: 1px solid #2f3a4c;
  border-radius: 8px;
  background: #101827;
  display: flex;
  flex-direction: column;
  gap: 12px;
  box-shadow: 0 12px 24px rgba(0, 0, 0, 0.26);
}

.action-quick {
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  gap: 8px;
}

.action-quick .primary-button {
  width: 100%;
}

.log-box {
  border: 1px solid #2d384a;
  border-radius: 8px;
  padding: 12px;
  background: #0d1320;
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
  max-height: inherit;
}

.log-scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
  margin-top: 8px;
  padding-right: 6px;
}

.log-progress-track {
  width: 100%;
  height: 10px;
  margin-top: 8px;
  border-radius: 999px;
  background: #1b2532;
  overflow: hidden;
  border: 1px solid #2f3a4c;
}

.log-progress-fill {
  height: 100%;
  border-radius: inherit;
  background: linear-gradient(90deg, #ffd84d, #66e3ff);
  transition: width 200ms ease;
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

.operation-body {
  display: grid;
  gap: 14px;
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
  white-space: pre-wrap;
}

.parallel-control {
  border: 1px solid #2d384a;
  border-radius: 8px;
  padding: 10px;
  background: #0d1320;
}

.parallel-fields {
  margin-top: 8px;
  display: grid;
  grid-template-columns: 1fr 110px auto;
  align-items: center;
  gap: 8px;
}

.parallel-fields input[type="range"] {
  width: 100%;
}

.parallel-fields input[type="number"] {
  min-width: 0;
  width: 110px;
}

.parallel-note {
  margin-top: 6px;
  color: #9aa7bb;
  font-size: 12px;
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

  .main-workspace,
  .summary-bar,
  .control-strip,
  .loadout-panel,
  .tool-grid {
    grid-template-columns: 1fr;
  }

  .action-quick {
    grid-template-columns: 1fr 1fr;
  }

  .parallel-fields {
    grid-template-columns: 1fr;
  }

  .operation-dock {
    position: static;
  }
}

@media (max-width: 760px) {
  .content,
  .sidebar {
    padding: 16px;
  }

  .main-workspace {
    grid-template-columns: 1fr;
  }

  .summary-bar,
  .control-strip,
  .mode-grid,
  .switch-grid,
  .select-grid,
  .loadout-panel,
  .tool-grid,
  .action-quick {
    grid-template-columns: 1fr;
  }

  .work-zone {
    gap: 10px;
  }

  .viewer-panel {
    min-height: 360px;
  }

  .viewer-toolbar {
    align-items: flex-start;
    flex-direction: column;
  }
}
</style>

