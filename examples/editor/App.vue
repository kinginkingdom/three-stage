<script setup lang="ts">
import { ref, shallowRef, onMounted, onBeforeUnmount, computed } from 'vue';
import * as THREE from 'three';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { ElMessage } from 'element-plus';
import { Viewer } from '../../src';
import {
  type SceneConfig,
  applySceneConfig,
  exportSceneConfig,
  sceneConfigToJson,
  parseSceneConfigJson,
  bgDemoConfig,
  modelDemoConfig,
  syncDefaultCameraToConfig,
} from '../sceneConfig';

const canvasRef = ref<HTMLCanvasElement | null>(null);
const viewerRef = shallowRef<Viewer | null>(null);
const sceneConfig = ref<SceneConfig>(structuredClone(bgDemoConfig) as SceneConfig);
const kind = ref<'background' | 'model'>('background');
const selectedTipId = ref<string | null>(null);
const importJsonText = ref('');
const loading = ref(false);

let transformControl: TransformControls | null = null;

const selectedTip = computed(() => {
  if (!selectedTipId.value) return null;
  return sceneConfig.value.tips?.find((t) => t.id === selectedTipId.value) ?? null;
});

const bindingName = computed({
  get: () => String(selectedTip.value?.binding?.name ?? ''),
  set: (v) => updateBindingField('name', v),
});
const bindingDeviceId = computed({
  get: () => String(selectedTip.value?.binding?.deviceId ?? ''),
  set: (v) => updateBindingField('deviceId', v),
});
const bindingType = computed({
  get: () => String(selectedTip.value?.binding?.type ?? ''),
  set: (v) => updateBindingField('type', v),
});

/** Tip 世界尺度（与配置里 `size` 一致，导出 JSON 会带上） */
const tipSize = computed({
  get: () => selectedTip.value?.size ?? 0.55,
  set: (v: number | null) => {
    const t = selectedTip.value;
    const viewer = viewerRef.value;
    if (!t || !viewer || v == null || !Number.isFinite(v) || v <= 0) return;
    t.size = v;
    viewer.tips.updateTip(t.id, undefined, { size: v });
  },
});

/** true：近大远小（透视下随距离缩放）；false：屏幕尺寸相对稳定 */
const tipSizeAttenuation = computed({
  get: () => selectedTip.value?.sizeAttenuation ?? true,
  set: (v: boolean) => {
    const t = selectedTip.value;
    const viewer = viewerRef.value;
    if (!t || !viewer) return;
    t.sizeAttenuation = v;
    viewer.tips.updateTip(t.id, undefined, { sizeAttenuation: v });
  },
});

function updateBindingField(key: string, val: string) {
  const t = selectedTip.value;
  const v = viewerRef.value;
  if (!t || !v) return;
  if (!t.binding) t.binding = {};
  t.binding[key] = val;
  v.tips.updateTip(t.id, undefined, { userData: { ...t.binding } });
}

async function applyConfig() {
  const v = viewerRef.value;
  if (!v) return;
  loading.value = true;
  try {
    await applySceneConfig(v, sceneConfig.value);
    detachGizmo();
    selectedTipId.value = null;
  } finally {
    loading.value = false;
  }
}

function switchKind() {
  sceneConfig.value = structuredClone(kind.value === 'background' ? bgDemoConfig : modelDemoConfig) as SceneConfig;
  void applyConfig();
}

function detachGizmo() {
  if (transformControl && viewerRef.value) {
    transformControl.detach();
    viewerRef.value.scene.remove(transformControl.getHelper());
    transformControl.dispose();
    transformControl = null;
  }
}

function attachGizmo(sprite: THREE.Sprite) {
  const v = viewerRef.value;
  if (!v) return;
  detachGizmo();
  const ctl = new TransformControls(v.camera, v.renderer.domElement);
  ctl.setMode('translate');
  ctl.setSize(1.35);
  ctl.addEventListener('dragging-changed', (e) => {
    const on = (e as unknown as { value?: boolean }).value === true;
    if (v.navigator.controls) v.navigator.controls.enabled = !on;
  });
  ctl.addEventListener('objectChange', () => {
    const id = (sprite.userData as { tipId?: string }).tipId;
    if (!id) return;
    const tip = sceneConfig.value.tips?.find((t) => t.id === id);
    if (tip) tip.position = [sprite.position.x, sprite.position.y, sprite.position.z];
  });
  // r180+：TransformControls 不是 Object3D，必须把 getHelper() 加进场景
  v.scene.add(ctl.getHelper());
  ctl.attach(sprite);
  transformControl = ctl;
}

function selectTipFromHit(hit: { intersectedObject: THREE.Object3D | null } | null) {
  if (!hit?.intersectedObject) {
    selectedTipId.value = null;
    detachGizmo();
    return;
  }
  const ud = hit.intersectedObject.userData as { tipId?: string };
  if (!ud.tipId || !(hit.intersectedObject instanceof THREE.Sprite)) {
    selectedTipId.value = null;
    detachGizmo();
    return;
  }
  selectedTipId.value = ud.tipId;
  attachGizmo(hit.intersectedObject);
}

function downloadJson() {
  const v = viewerRef.value;
  if (!v) return;
  const exported = exportSceneConfig(v, sceneConfig.value);
  const blob = new Blob([sceneConfigToJson(exported)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'scene-config.json';
  a.click();
  URL.revokeObjectURL(a.href);
  ElMessage.success('已导出 scene-config.json');
}

function importFromText() {
  try {
    const parsed = parseSceneConfigJson(importJsonText.value);
    sceneConfig.value = parsed;
    void applyConfig();
    ElMessage.success('已导入并应用');
  } catch {
    ElMessage.error('JSON 解析失败');
  }
}

function captureCameraToConfig() {
  const v = viewerRef.value;
  if (!v) return;
  syncDefaultCameraToConfig(v, sceneConfig.value.cameras);
  ElMessage.success('已将当前相机写入默认视角');
}

let unsubClick: (() => void) | null = null;

onMounted(() => {
  const canvas = canvasRef.value;
  if (!canvas) return;
  const v = new Viewer({
    canvas,
    enableDraco: true,
    dracoDecoderPath: '/draco/',
    enableOrbitControls: true,
    enableDrag: false,
    enableBVH: true,
    enableRoaming: false,
    clearColor: 0x1a1f2e,
  });
  viewerRef.value = v;
  unsubClick = v.on('object-click', (hit) => {
    selectTipFromHit(hit);
  });
  void applyConfig();
});

onBeforeUnmount(() => {
  unsubClick?.();
  detachGizmo();
  viewerRef.value?.dispose();
  viewerRef.value = null;
});
</script>

<template>
  <div class="editor-layout">
    <aside class="sidebar">
      <h2 class="title">场景编辑器</h2>
      <p class="hint">点击 Tip 选中：三轴 Gizmo 平移；侧栏可改绑定、图标大小（size）与近大远小（sizeAttenuation）。</p>

      <el-form label-position="top" size="small">
        <el-form-item label="示例场景">
          <el-radio-group v-model="kind" @change="switchKind">
            <el-radio-button value="background">背景图</el-radio-button>
            <el-radio-button value="model">GLB 模型</el-radio-button>
          </el-radio-group>
        </el-form-item>

        <el-form-item label="重新应用当前配置">
          <el-button type="primary" :loading="loading" @click="applyConfig">应用配置</el-button>
        </el-form-item>

        <el-form-item label="相机">
          <el-button @click="captureCameraToConfig">当前视角写入默认 view</el-button>
        </el-form-item>

        <el-divider />

        <template v-if="selectedTip">
          <el-form-item label="Tip ID">
            <el-input :model-value="selectedTip.id" disabled />
          </el-form-item>
          <el-form-item label="图标缩放 size（世界单位）">
            <el-input-number
              v-model="tipSize"
              :min="0.05"
              :max="30"
              :step="0.05"
              :precision="2"
              controls-position="right"
              style="width: 100%"
            />
          </el-form-item>
          <el-form-item label="近大远小 sizeAttenuation">
            <el-switch v-model="tipSizeAttenuation" active-text="开启" inactive-text="关闭" />
          </el-form-item>
          <el-form-item label="名称 binding.name">
            <el-input v-model="bindingName" />
          </el-form-item>
          <el-form-item label="设备 ID binding.deviceId">
            <el-input v-model="bindingDeviceId" />
          </el-form-item>
          <el-form-item label="类型 binding.type">
            <el-input v-model="bindingType" />
          </el-form-item>
        </template>
        <p v-else class="muted">未选中 Tip（点击场景中的标注图标）</p>

        <el-divider />

        <el-form-item label="导入 JSON（粘贴后点击导入）">
          <el-input v-model="importJsonText" type="textarea" :rows="6" placeholder="{ ... }" />
          <el-button style="margin-top: 8px" @click="importFromText">导入并应用</el-button>
        </el-form-item>

        <el-form-item>
          <el-button type="success" @click="downloadJson">导出配置 JSON</el-button>
        </el-form-item>
      </el-form>
    </aside>

    <main class="canvas-wrap">
      <canvas ref="canvasRef" class="canvas" />
    </main>
  </div>
</template>

<style scoped>
.editor-layout {
  display: flex;
  height: 100vh;
  background: #0b1020;
  color: #e6e8ef;
}
.sidebar {
  width: 320px;
  flex-shrink: 0;
  padding: 16px;
  border-right: 1px solid rgba(255, 255, 255, 0.08);
  overflow: auto;
}
.title {
  margin: 0 0 8px;
  font-size: 18px;
}
.hint {
  margin: 0 0 16px;
  font-size: 12px;
  opacity: 0.75;
  line-height: 1.4;
}
.muted {
  font-size: 13px;
  opacity: 0.6;
}
.canvas-wrap {
  flex: 1;
  min-width: 0;
  position: relative;
}
.canvas {
  display: block;
  width: 100%;
  height: 100%;
}
</style>
