<script setup lang="ts">
import { ref, shallowRef, computed, onMounted, onBeforeUnmount, watch, nextTick } from 'vue';
import * as THREE from 'three';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { ElMessage } from 'element-plus';
import { Viewer } from '../../src';
import {
  type SceneConfig,
  applySceneCameraViewById,
  applySceneConfig,
  captureSceneConfigFromViewer,
  sceneConfigToJson,
  parseSceneConfigJson,
  syncCameraToSceneView,
  syncDefaultCameraToConfig,
} from '../sceneConfig';
import {
  MOCK_DEVICES_BY_ROOM,
  MOCK_GROUPS_BY_ROOM,
  MOCK_ROOM_SCENES,
  getRoomContext,
  type RoomSceneContext,
} from './mockRooms';
import type { DemoDevice, DemoDeviceGroup } from './mockEquipment';

/** 可拖拽到画布的 Tip 贴图（public/icons 下 png） */
const TIP_SPRITE_ASSETS = [
  '/icons/pos.png',
  '/icons/temp.png',
  '/icons/wet.png',
  '/icons/camera.png',
  '/icons/alarm.png',
  '/icons/callin.png',
  '/icons/people.png',
];

/** 工作台内模型场景补光（在 Viewer 默认光基础上略增强 + 双侧补光） */
const STUDIO_LIGHTING = {
  hemiIntensity: 1.38,
  dirIntensity: 2.35,
  shadows: 'auto' as const,
  extraDirections: [
    { position: [-16, 24, 12] as [number, number, number], intensity: 1.05 },
    { position: [24, 16, -20] as [number, number, number], intensity: 0.7 },
  ],
};

interface SceneModelRow {
  rowId: string;
  kind: 'mesh' | 'tip' | 'object';
  modelId: string;
  label: string;
  duplicateName: boolean;
  ref: THREE.Object3D;
}

type BindingValue =
  | { kind: 'device'; deviceId: string }
  | { kind: 'group'; groupCode: string };

type BindingsMap = Record<string, BindingValue>;

function isInteractMarked(o: THREE.Object3D): boolean {
  return (o.userData as { interact?: boolean })?.interact === true;
}

function resolveRowIdFromHit(obj: THREE.Object3D | null): string | null {
  let cur: THREE.Object3D | null = obj;
  while (cur) {
    if (!isInteractMarked(cur)) {
      cur = cur.parent;
      continue;
    }
    const ud = cur.userData as { tipId?: string };
    if (cur instanceof THREE.Sprite && ud.tipId) return `tip:${ud.tipId}`;
    if (cur instanceof THREE.Mesh) return `mesh:${cur.uuid}`;
    return `object:${cur.uuid}`;
  }
  return null;
}

function bindingsStorageKey(roomId: string) {
  return `threeStage-studio-bindings-${roomId}`;
}

function loadBindings(roomId: string): BindingsMap {
  try {
    const raw = localStorage.getItem(bindingsStorageKey(roomId));
    if (!raw) return {};
    const o = JSON.parse(raw) as unknown;
    if (!o || typeof o !== 'object') return {};
    return o as BindingsMap;
  } catch {
    return {};
  }
}

function saveBindingsToStorage(roomId: string, m: BindingsMap) {
  localStorage.setItem(bindingsStorageKey(roomId), JSON.stringify(m));
}

const canvasRef = ref<HTMLCanvasElement | null>(null);
const viewerRef = shallowRef<Viewer | null>(null);
const sceneConfig = ref<SceneConfig | null>(null);
const roomContext = ref<RoomSceneContext | null>(null);
const roomPickerOpen = ref(true);
const pickedRoomId = ref(MOCK_ROOM_SCENES[0]!.roomId);

const loading = ref(false);
const sceneRows = ref<SceneModelRow[]>([]);
const bindings = ref<BindingsMap>({});
const sidebarCollapsed = ref(false);
const activeTab = ref<'models' | 'devices' | 'advanced'>('models');
const searchModels = ref('');
const searchDevices = ref('');
const mappingVisible = ref(false);
const selectedRowId = ref<string | null>(null);
const selectedTipId = ref<string | null>(null);
const importJsonText = ref('');
const floatCollapsed = ref(false);
/** 当前选中的预设视角 id（用于高亮芯片） */
const activeViewId = ref<string>('');
const bookmarkEditViewId = ref<string>('');
const newViewIdInput = ref('view-custom');
const newViewNameInput = ref('自定义视角');

const editOpen = ref(false);
const editRow = ref<SceneModelRow | null>(null);
const formDeviceId = ref('');
const formGroupCode = ref('');

let transformControl: TransformControls | null = null;
let pendingTipTexture: string | null = null;
let tipDragEndHandler: ((e: PointerEvent) => void) | null = null;

const roomDevices = computed((): DemoDevice[] => {
  const id = roomContext.value?.roomId;
  if (!id) return [];
  return MOCK_DEVICES_BY_ROOM[id] ?? [];
});

const roomGroups = computed((): DemoDeviceGroup[] => {
  const id = roomContext.value?.roomId;
  if (!id) return [];
  return MOCK_GROUPS_BY_ROOM[id] ?? [];
});

const deviceOptions = computed(() =>
  roomDevices.value.map((d) => ({ label: `${d.id} · ${d.name}`, value: d.id })),
);
const groupOptions = computed(() =>
  roomGroups.value.map((g) => ({ label: `${g.code} · ${g.name}`, value: g.code })),
);

function findDevice(id: string): DemoDevice | undefined {
  return roomDevices.value.find((d) => d.id === id);
}

function findGroup(code: string): DemoDeviceGroup | undefined {
  return roomGroups.value.find((g) => g.code === code);
}

const selectedTip = computed(() => {
  if (!selectedTipId.value || !sceneConfig.value?.tips) return null;
  return sceneConfig.value.tips.find((t) => t.id === selectedTipId.value) ?? null;
});

const showFloatPanel = computed(
  () => roomContext.value && selectedRowId.value && !floatCollapsed.value,
);

const headerBreadcrumb = computed(() => {
  const r = roomContext.value;
  if (!r) return '请选择楼层房间与场景';
  return `${r.buildingPath} / ${r.floorRoomLabel}`;
});

const cameraViews = computed(() => sceneConfig.value?.cameras.views ?? []);

const filteredModels = computed(() => {
  const q = searchModels.value.trim().toLowerCase();
  if (!q) return sceneRows.value;
  return sceneRows.value.filter(
    (row) =>
      row.modelId.toLowerCase().includes(q) ||
      row.label.toLowerCase().includes(q) ||
      row.kind.toLowerCase().includes(q),
  );
});

const filteredDevices = computed(() => {
  const q = searchDevices.value.trim().toLowerCase();
  const match = (d: DemoDevice) =>
    !q || d.id.toLowerCase().includes(q) || d.name.toLowerCase().includes(q) || d.type.toLowerCase().includes(q);
  return roomDevices.value.filter(match);
});

const filteredGroups = computed(() => {
  const q = searchDevices.value.trim().toLowerCase();
  const match = (g: DemoDeviceGroup) =>
    !q ||
    g.code.toLowerCase().includes(q) ||
    g.name.toLowerCase().includes(q) ||
    g.typeLabel.toLowerCase().includes(q);
  return roomGroups.value.filter(match);
});

const mappingTableRows = computed(() =>
  sceneRows.value.map((r) => {
    const b = bindings.value[r.rowId];
    let bindKind: 'none' | 'device' | 'group' = 'none';
    let bindCode = '';
    let equipName = '—';
    let equipType = '—';
    if (b?.kind === 'device') {
      bindKind = 'device';
      bindCode = b.deviceId;
      const d = findDevice(b.deviceId);
      if (d) {
        equipName = d.name;
        equipType = d.type;
      } else {
        equipName = '（设备已不存在）';
        equipType = '—';
      }
    } else if (b?.kind === 'group') {
      bindKind = 'group';
      bindCode = b.groupCode;
      const g = findGroup(b.groupCode);
      if (g) {
        equipName = g.name;
        equipType = g.typeLabel;
      } else {
        equipName = '（设备组已不存在）';
        equipType = '—';
      }
    }
    return { ...r, bindKind, bindCode, equipName, equipType };
  }),
);

watch(
  bindings,
  (m) => {
    const rid = roomContext.value?.roomId;
    if (rid) saveBindingsToStorage(rid, m);
  },
  { deep: true },
);

const bindingName = computed({
  get: () => String(selectedTip.value?.binding?.name ?? ''),
  set: (v: string) => updateTipBindingField('name', v),
});
const bindingDeviceIdField = computed({
  get: () => String(selectedTip.value?.binding?.deviceId ?? ''),
  set: (v: string) => updateTipBindingField('deviceId', v),
});
const bindingTypeField = computed({
  get: () => String(selectedTip.value?.binding?.type ?? ''),
  set: (v: string) => updateTipBindingField('type', v),
});

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

function updateTipBindingField(key: string, val: string) {
  const t = selectedTip.value;
  const v = viewerRef.value;
  if (!t || !v) return;
  if (!t.binding) t.binding = {};
  t.binding[key] = val;
  v.tips.updateTip(t.id, undefined, { userData: { ...t.binding } });
  refreshModelList();
}

const meshModelIdEdit = computed({
  get: () => {
    const row = sceneRows.value.find((r) => r.rowId === selectedRowId.value);
    if (!row || row.kind === 'tip') return '';
    return row.modelId;
  },
  set: (v: string) => {
    const row = sceneRows.value.find((r) => r.rowId === selectedRowId.value);
    if (!row || row.kind === 'tip') return;
    const ud = row.ref.userData as Record<string, unknown>;
    ud.name = v;
    refreshModelList();
  },
});

function collectSceneModels(viewer: Viewer): SceneModelRow[] {
  const rows: SceneModelRow[] = [];
  const seen = new Set<string>();

  viewer.root.traverse((o) => {
    if (!isInteractMarked(o)) return;
    const ud = o.userData as { tipId?: string; name?: unknown };
    const modelId = typeof ud.name === 'string' ? ud.name : '';

    if (o instanceof THREE.Sprite && ud.tipId) {
      const rowId = `tip:${ud.tipId}`;
      if (seen.has(rowId)) return;
      seen.add(rowId);
      rows.push({
        rowId,
        kind: 'tip',
        modelId,
        label: modelId || `（未设置 name，tipId=${ud.tipId}）`,
        duplicateName: false,
        ref: o,
      });
      return;
    }

    if (o instanceof THREE.Mesh) {
      const rowId = `mesh:${o.uuid}`;
      if (seen.has(rowId)) return;
      seen.add(rowId);
      rows.push({
        rowId,
        kind: 'mesh',
        modelId,
        label: modelId || '（未设置 userData.name）',
        duplicateName: false,
        ref: o,
      });
      return;
    }

    const rowId = `object:${o.uuid}`;
    if (seen.has(rowId)) return;
    seen.add(rowId);
    rows.push({
      rowId,
      kind: 'object',
      modelId,
      label: modelId || `（未设置 userData.name · ${o.type}）`,
      duplicateName: false,
      ref: o,
    });
  });

  const counts = new Map<string, number>();
  for (const r of rows) {
    const id = r.modelId.trim();
    if (!id) continue;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  for (const r of rows) {
    const id = r.modelId.trim();
    r.duplicateName = id !== '' && (counts.get(id) ?? 0) > 1;
  }

  return rows;
}

function refreshModelList() {
  const v = viewerRef.value;
  if (!v) return;
  sceneRows.value = collectSceneModels(v);
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
  ctl.setSize(1.25);
  ctl.addEventListener('dragging-changed', (e) => {
    const on = (e as unknown as { value?: boolean }).value === true;
    if (v.navigator.controls) v.navigator.controls.enabled = !on;
  });
  ctl.addEventListener('objectChange', () => {
    const id = (sprite.userData as { tipId?: string }).tipId;
    if (!id || !sceneConfig.value?.tips) return;
    const tip = sceneConfig.value.tips.find((t) => t.id === id);
    if (tip) tip.position = [sprite.position.x, sprite.position.y, sprite.position.z];
  });
  v.scene.add(ctl.getHelper());
  ctl.attach(sprite);
  transformControl = ctl;
}

function syncActiveViewAfterApply() {
  const cfg = sceneConfig.value;
  if (!cfg?.cameras?.views.length) {
    activeViewId.value = '';
    return;
  }
  const def = cfg.cameras.defaultViewId ?? cfg.cameras.views[0]!.id;
  activeViewId.value = def;
  if (!bookmarkEditViewId.value || !cfg.cameras.views.some((x) => x.id === bookmarkEditViewId.value)) {
    bookmarkEditViewId.value = def;
  }
}

async function applyScene() {
  const v = viewerRef.value;
  const cfg = sceneConfig.value;
  if (!v || !cfg) return;
  loading.value = true;
  try {
    await applySceneConfig(v, cfg);
    refreshModelList();
    syncActiveViewAfterApply();
  } finally {
    loading.value = false;
  }
}

function switchToCameraView(viewId: string) {
  const v = viewerRef.value;
  const cfg = sceneConfig.value;
  if (!v || !cfg) return;
  if (!applySceneCameraViewById(v, cfg.cameras, viewId)) {
    ElMessage.warning('未找到该视角');
    return;
  }
  activeViewId.value = viewId;
  ElMessage.success('已切换视角');
}

function updateBookmarkFromCurrent() {
  const v = viewerRef.value;
  const cfg = sceneConfig.value;
  const vid = bookmarkEditViewId.value;
  if (!v || !cfg || !vid) return;
  if (!syncCameraToSceneView(v, cfg.cameras, vid)) {
    ElMessage.warning('未找到该视角条目');
    return;
  }
  ElMessage.success(`已用当前相机更新「${vid}」`);
}

function setDefaultCameraView(viewId: string) {
  const cfg = sceneConfig.value;
  if (!cfg) return;
  cfg.cameras.defaultViewId = viewId;
  activeViewId.value = viewId;
  ElMessage.success('已设为默认启动视角');
}

function addCameraViewFromCurrent() {
  const v = viewerRef.value;
  const cfg = sceneConfig.value;
  if (!v || !cfg) return;
  const id = newViewIdInput.value.trim().replace(/\s+/g, '-');
  if (!id) {
    ElMessage.warning('请填写视角 id（英文/短横线）');
    return;
  }
  if (cfg.cameras.views.some((x) => x.id === id)) {
    ElMessage.warning('该 id 已存在');
    return;
  }
  const name = newViewNameInput.value.trim() || id;
  const ctl = v.navigator.controls;
  cfg.cameras.views.push({
    id,
    name,
    position: [v.camera.position.x, v.camera.position.y, v.camera.position.z],
    target: ctl ? [ctl.target.x, ctl.target.y, ctl.target.z] : [0, 0, 0],
    fov: v.camera.fov,
  });
  activeViewId.value = id;
  bookmarkEditViewId.value = id;
  ElMessage.success('已从当前机位新增视角');
}

function ensureViewer() {
  const canvas = canvasRef.value;
  if (!canvas || viewerRef.value) return;
  const v = new Viewer({
    canvas,
    enableDraco: true,
    dracoDecoderPath: '/draco/',
    enableOrbitControls: true,
    enableDrag: false,
    enableBVH: true,
    enableRoaming: false,
    clearColor: 0xeef2f6,
    lighting: STUDIO_LIGHTING,
  });
  viewerRef.value = v;
  unsubClick = v.on('object-click', (hit) => {
    if (!hit.intersectedObject) {
      selectedRowId.value = null;
      selectedTipId.value = null;
      detachGizmo();
      return;
    }
    const obj = hit.intersectedObject;
    const ud = obj.userData as { tipId?: string };
    if (obj instanceof THREE.Sprite && ud.tipId) {
      selectedRowId.value = `tip:${ud.tipId}`;
      selectedTipId.value = ud.tipId;
      attachGizmo(obj);
      floatCollapsed.value = false;
      return;
    }
    selectedTipId.value = null;
    detachGizmo();
    selectedRowId.value = resolveRowIdFromHit(obj);
    floatCollapsed.value = false;
  });
}

function confirmRoom() {
  const ctx = getRoomContext(pickedRoomId.value);
  if (!ctx) {
    ElMessage.error('无效房间');
    return;
  }
  roomContext.value = ctx;
  sceneConfig.value = structuredClone(ctx.initialSceneConfig) as SceneConfig;
  bindings.value = loadBindings(ctx.roomId);
  roomPickerOpen.value = false;
  selectedRowId.value = null;
  selectedTipId.value = null;
  detachGizmo();
  nextTick(() => {
    ensureViewer();
    void applyScene();
  });
}

function tryInitFromUrl() {
  const id = new URLSearchParams(location.search).get('roomId');
  if (!id) return;
  const ctx = getRoomContext(id);
  if (!ctx) return;
  roomContext.value = ctx;
  sceneConfig.value = structuredClone(ctx.initialSceneConfig) as SceneConfig;
  bindings.value = loadBindings(ctx.roomId);
  roomPickerOpen.value = false;
}

function focusRow(row: SceneModelRow) {
  const v = viewerRef.value;
  if (!v) return;
  selectedRowId.value = row.rowId;
  if (row.kind === 'tip' && row.ref instanceof THREE.Sprite) {
    const tipId = (row.ref.userData as { tipId?: string }).tipId;
    if (tipId) {
      selectedTipId.value = tipId;
      attachGizmo(row.ref);
    }
  } else {
    selectedTipId.value = null;
    detachGizmo();
  }
  void v.focus(row.ref, { duration: 0.45 });
}

function openEdit(row: SceneModelRow) {
  editRow.value = row;
  const b = bindings.value[row.rowId];
  if (b?.kind === 'device') {
    formDeviceId.value = b.deviceId;
    formGroupCode.value = '';
  } else if (b?.kind === 'group') {
    formDeviceId.value = '';
    formGroupCode.value = b.groupCode;
  } else {
    formDeviceId.value = '';
    formGroupCode.value = '';
  }
  editOpen.value = true;
}

function onDeviceSelect(devId: string | null | undefined) {
  if (devId) formGroupCode.value = '';
}

function onGroupSelect(code: string | null | undefined) {
  if (code) formDeviceId.value = '';
}

function saveEdit() {
  const row = editRow.value;
  if (!row) return;
  const dev = formDeviceId.value;
  const grp = formGroupCode.value;
  const next = { ...bindings.value };
  if (dev && grp) {
    ElMessage.warning('请只绑定设备或设备组之一');
    return;
  }
  if (dev) next[row.rowId] = { kind: 'device', deviceId: dev };
  else if (grp) next[row.rowId] = { kind: 'group', groupCode: grp };
  else delete next[row.rowId];
  bindings.value = next;
  editOpen.value = false;
  ElMessage.success('已保存绑定');
}

function unbindRow(rowId: string) {
  const next = { ...bindings.value };
  delete next[rowId];
  bindings.value = next;
  ElMessage.success('已解绑');
}

function openMappingForSelected() {
  if (!selectedRowId.value) {
    ElMessage.info('请先在场景或列表中选中一个模型');
    return;
  }
  mappingVisible.value = true;
}

function removeSelectedTip() {
  const id = selectedTipId.value;
  const v = viewerRef.value;
  const cfg = sceneConfig.value;
  if (!id || !v || !cfg?.tips) return;
  cfg.tips = cfg.tips.filter((t) => t.id !== id);
  v.tips.removeTip(id);
  selectedTipId.value = null;
  selectedRowId.value = null;
  detachGizmo();
  refreshModelList();
  ElMessage.success('已删除 Tip');
}

function captureCameraToConfig() {
  const v = viewerRef.value;
  const cfg = sceneConfig.value;
  if (!v || !cfg) return;
  syncDefaultCameraToConfig(v, cfg.cameras);
  ElMessage.success('已将当前相机写入默认视角');
}

function importFromText() {
  try {
    const parsed = parseSceneConfigJson(importJsonText.value);
    sceneConfig.value = parsed;
    void applyScene();
    detachGizmo();
    selectedTipId.value = null;
    selectedRowId.value = null;
    ElMessage.success('已导入并应用');
  } catch {
    ElMessage.error('JSON 解析失败');
  }
}

function placeTipFromPointer(clientX: number, clientY: number, textureUrl: string) {
  const canvas = canvasRef.value;
  const v = viewerRef.value;
  const cfg = sceneConfig.value;
  if (!canvas || !v || !cfg) return;

  const rect = canvas.getBoundingClientRect();
  const x = ((clientX - rect.left) / rect.width) * 2 - 1;
  const y = -((clientY - rect.top) / rect.height) * 2 + 1;
  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(new THREE.Vector2(x, y), v.camera);
  const hits = raycaster.intersectObjects(v.scene.children, true);
  const hit = hits[0];
  const pos: [number, number, number] = hit
    ? [hit.point.x, hit.point.y, hit.point.z]
    : [0, 2, 0];

  const id = `tip-${Date.now()}`;
  const short = id.slice(-6);
  const name = `TIP_${short}`;
  if (!cfg.tips) cfg.tips = [];
  cfg.tips.push({
    id,
    textureUrl,
    position: pos,
    size: 0.55,
    sizeAttenuation: true,
    interact: true,
    visible: true,
    binding: { name },
  });
  v.tips.addTipSync(id, pos, {
    textureUrl,
    size: 0.55,
    userData: { name },
  });
  refreshModelList();
  selectedTipId.value = id;
  selectedRowId.value = `tip:${id}`;
  const sp = v.tips.getTip(id);
  if (sp) attachGizmo(sp);
  ElMessage.success('已添加 Tip，可拖动 Gizmo 微调');
}

function startTipDragFromPalette(url: string, ev: PointerEvent) {
  ev.preventDefault();
  pendingTipTexture = url;
  tipDragEndHandler = (e: PointerEvent) => {
    if (tipDragEndHandler) {
      window.removeEventListener('pointerup', tipDragEndHandler);
      tipDragEndHandler = null;
    }
    const tex = pendingTipTexture;
    pendingTipTexture = null;
    if (!tex) return;
    const canvas = canvasRef.value;
    if (!canvas) return;
    const r = canvas.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) {
      ElMessage.info('请在画布区域内释放以放置 Tip');
      return;
    }
    placeTipFromPointer(e.clientX, e.clientY, tex);
  };
  window.addEventListener('pointerup', tipDragEndHandler);
  ElMessage.info('拖到画布上松开鼠标以放置');
}

function saveAll() {
  const v = viewerRef.value;
  const cfg = sceneConfig.value;
  const room = roomContext.value;
  if (!v || !cfg || !room) {
    ElMessage.warning('请先完成房间与场景加载');
    return;
  }
  const sceneSnapshot = captureSceneConfigFromViewer(v, cfg);
  const payload = {
    roomId: room.roomId,
    floorRoomLabel: room.floorRoomLabel,
    buildingPath: room.buildingPath,
    sceneConfig: sceneSnapshot,
    deviceBindings: bindings.value,
  };
  console.log('[保存] 场景配置 JSON\n', sceneConfigToJson(sceneSnapshot));
  console.log('[保存] 设备关联\n', JSON.stringify(bindings.value, null, 2));
  console.log('[保存] 完整 payload（接口可直传）\n', JSON.stringify(payload, null, 2));
  ElMessage.success('已在控制台打印，后续可对接上传接口');
}

function closeFloatPanel() {
  floatCollapsed.value = true;
}

function expandFloatPanel() {
  floatCollapsed.value = false;
}

let unsubClick: (() => void) | null = null;

onMounted(() => {
  tryInitFromUrl();
  nextTick(() => {
    if (roomContext.value) {
      ensureViewer();
      void applyScene();
    }
  });
});

onBeforeUnmount(() => {
  if (tipDragEndHandler) window.removeEventListener('pointerup', tipDragEndHandler);
  unsubClick?.();
  detachGizmo();
  viewerRef.value?.dispose();
  viewerRef.value = null;
});
</script>

<template>
  <el-container class="page">
    <!-- 前置：楼层房间 + 场景资源（正式环境由列表页完成） -->
    <el-dialog
      v-model="roomPickerOpen"
      title="选择场景上下文"
      width="520px"
      :close-on-click-modal="false"
      :show-close="false"
      class="room-dialog"
    >
      <p class="dialog-lead">
        模拟「前置列表」已完成的绑定：每个楼层房间对应一份场景文件（模型 / 配图）及初始 JSON。进入工作台后将加载该房间的设备列表。
      </p>
      <el-form label-position="top">
        <el-form-item label="楼层 / 房间">
          <el-select v-model="pickedRoomId" style="width: 100%">
            <el-option
              v-for="r in MOCK_ROOM_SCENES"
              :key="r.roomId"
              :label="`${r.buildingPath} — ${r.floorRoomLabel}`"
              :value="r.roomId"
            />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button type="primary" @click="confirmRoom">进入配置工作台</el-button>
      </template>
    </el-dialog>

    <el-header class="header" height="56px">
      <div class="brand">
        <span class="brand-mark" aria-hidden="true" />
        <div class="brand-text">
          <div class="brand-title">场景配置工作台</div>
          <div class="breadcrumb">{{ headerBreadcrumb }}</div>
        </div>
      </div>
      <div class="header-actions">
        <el-button v-if="roomContext" @click="roomPickerOpen = true">切换房间</el-button>
        <el-button @click="openMappingForSelected">关联映射</el-button>
        <el-button type="primary" @click="mappingVisible = true">绑定总表</el-button>
        <el-button type="success" :disabled="!roomContext" @click="saveAll">保存（打印）</el-button>
        <el-button tag="a" href="/config.html?kind=model" target="_blank" plain>预览</el-button>
      </div>
    </el-header>

    <el-container v-if="roomContext" class="body">
      <el-main class="main">
        <div class="canvas-shell">
          <div class="tip-palette">
            <span class="palette-label">Tip 图标</span>
            <span class="palette-hint">拖到画布松开放置</span>
            <div class="palette-items">
              <button
                v-for="url in TIP_SPRITE_ASSETS"
                :key="url"
                type="button"
                class="palette-chip"
                :title="url"
                @pointerdown="startTipDragFromPalette(url, $event)"
              >
                <img :src="url" alt="" class="palette-img" draggable="false" />
              </button>
            </div>
          </div>
          <div v-if="cameraViews.length" class="view-bar">
            <span class="palette-label">预设视角</span>
            <span class="palette-hint">多书签切换；默认视角见侧栏「高级」</span>
            <div class="view-chips">
              <el-button
                v-for="vw in cameraViews"
                :key="vw.id"
                size="small"
                :type="activeViewId === vw.id ? 'primary' : 'default'"
                class="view-chip"
                @click="switchToCameraView(vw.id)"
              >
                {{ vw.name || vw.id }}
                <el-tag
                  v-if="sceneConfig?.cameras.defaultViewId === vw.id"
                  size="small"
                  effect="plain"
                  class="default-tag"
                >
                  默认
                </el-tag>
              </el-button>
            </div>
          </div>
          <div class="canvas-inner">
            <canvas ref="canvasRef" class="canvas" />
          </div>
        </div>
        <p class="canvas-hint">
          可交互对象需 <code>userData.interact === true</code>；模型 ID 为 <code>userData.name</code>。选中 Tip 后出现三轴平移与右侧悬浮窗。
        </p>

        <!-- 固定悬浮编辑窗 -->
        <transition name="float">
          <div v-if="showFloatPanel" class="float-panel">
            <div class="float-head">
              <span class="float-title">选中项</span>
              <div class="float-head-actions">
                <el-button text size="small" @click="closeFloatPanel">收起</el-button>
              </div>
            </div>

            <template v-if="selectedTip">
              <div class="float-section-label">Tip 标注</div>
              <el-form label-position="top" size="small" class="float-form">
                <el-form-item label="Tip ID">
                  <el-input :model-value="selectedTip.id" disabled />
                </el-form-item>
                <el-form-item label="模型 ID（binding.name → userData.name）">
                  <el-input v-model="bindingName" placeholder="用于设备关联映射" />
                </el-form-item>
                <el-form-item label="图标大小 size">
                  <el-input-number v-model="tipSize" :min="0.05" :max="30" :step="0.05" :precision="2" controls-position="right" style="width: 100%" />
                </el-form-item>
                <el-form-item label="近大远小">
                  <el-switch v-model="tipSizeAttenuation" active-text="开" inactive-text="关" />
                </el-form-item>
                <el-form-item label="binding.deviceId">
                  <el-input v-model="bindingDeviceIdField" />
                </el-form-item>
                <el-form-item label="binding.type">
                  <el-input v-model="bindingTypeField" />
                </el-form-item>
                <el-button type="danger" plain size="small" @click="removeSelectedTip">删除此 Tip</el-button>
              </el-form>
            </template>

            <template v-else-if="selectedRowId">
              <div class="float-section-label">场景模型（Mesh / 节点）</div>
              <el-form label-position="top" size="small" class="float-form">
                <el-form-item label="模型 ID（userData.name）">
                  <el-input v-model="meshModelIdEdit" placeholder="与关联映射一致" />
                </el-form-item>
                <el-button type="primary" plain size="small" @click="mappingVisible = true">去绑定设备</el-button>
              </el-form>
            </template>
          </div>
        </transition>

        <button
          v-if="roomContext && floatCollapsed && selectedRowId"
          type="button"
          class="float-reopen"
          @click="expandFloatPanel"
        >
          编辑
        </button>
      </el-main>

      <el-aside :width="sidebarCollapsed ? '0px' : '340px'" class="aside-wrap">
        <button type="button" class="aside-toggle" :title="sidebarCollapsed ? '展开' : '收起'" @click="sidebarCollapsed = !sidebarCollapsed">
          {{ sidebarCollapsed ? '‹' : '›' }}
        </button>
        <div v-show="!sidebarCollapsed" class="aside-inner">
          <el-tabs v-model="activeTab" class="tabs">
            <el-tab-pane label="场景模型" name="models">
              <el-input v-model="searchModels" placeholder="搜索模型 ID" clearable class="search" />
              <el-scrollbar class="list-scroll">
                <div
                  v-for="row in filteredModels"
                  :key="row.rowId"
                  class="model-item"
                  :class="{ active: selectedRowId === row.rowId }"
                  @click="focusRow(row)"
                >
                  <div class="model-id">
                    {{ row.modelId || '（未设置 name）' }}
                    <el-tag v-if="row.kind === 'tip'" size="small" type="warning" class="tag">Tip</el-tag>
                    <el-tag v-else-if="row.kind === 'mesh'" size="small" type="info" class="tag">Mesh</el-tag>
                    <el-tag v-else size="small" type="success" class="tag">节点</el-tag>
                    <el-tag v-if="row.duplicateName" size="small" type="danger" class="tag">重名</el-tag>
                  </div>
                  <div class="model-sub muted">{{ row.label }}</div>
                </div>
                <p v-if="!filteredModels.length" class="empty muted">无匹配项</p>
              </el-scrollbar>
            </el-tab-pane>

            <el-tab-pane label="设备列表" name="devices">
              <el-input v-model="searchDevices" placeholder="搜索设备 / 设备组" clearable class="search" />
              <div class="section-title">设备</div>
              <el-table :data="filteredDevices" size="small" stripe max-height="240">
                <el-table-column prop="id" label="设备编号" width="118">
                  <template #default="{ row: d }">
                    <el-text type="primary">{{ d.id }}</el-text>
                  </template>
                </el-table-column>
                <el-table-column prop="name" label="设备名称" />
                <el-table-column prop="type" label="类型" width="80" />
              </el-table>
              <div class="section-title">设备组</div>
              <el-table :data="filteredGroups" size="small" stripe max-height="160">
                <el-table-column prop="code" label="组编号" width="118">
                  <template #default="{ row: g }">
                    <el-text type="primary">{{ g.code }}</el-text>
                  </template>
                </el-table-column>
                <el-table-column prop="name" label="名称" />
                <el-table-column label="" width="72">
                  <template #default>
                    <el-tag size="small" type="success">组</el-tag>
                  </template>
                </el-table-column>
              </el-table>
            </el-tab-pane>

            <el-tab-pane label="高级" name="advanced">
              <div class="adv-block">
                <div class="adv-title">场景</div>
                <el-button size="small" :loading="loading" @click="applyScene">重新应用场景配置</el-button>
              </div>
              <div class="adv-block">
                <div class="adv-title">相机书签（cameras.views）</div>
                <p class="adv-desc muted">
                  配置里可有多条视角；「默认」为打开场景时应用的条目（defaultViewId）。
                </p>
                <el-button size="small" @click="captureCameraToConfig">当前机位 → 写入默认视角</el-button>
                <div class="adv-row">
                  <el-select v-model="bookmarkEditViewId" placeholder="选择书签" size="small" style="width: 100%">
                    <el-option v-for="vw in cameraViews" :key="vw.id" :label="vw.name || vw.id" :value="vw.id" />
                  </el-select>
                </div>
                <el-button size="small" @click="updateBookmarkFromCurrent">当前机位 → 更新所选书签</el-button>
                <el-button
                  size="small"
                  :disabled="!bookmarkEditViewId"
                  @click="setDefaultCameraView(bookmarkEditViewId)"
                >
                  将所选书签设为默认
                </el-button>
                <el-divider />
                <div class="adv-title">从当前机位新建书签</div>
                <el-input v-model="newViewIdInput" size="small" placeholder="id，如 view-east" class="adv-row" />
                <el-input v-model="newViewNameInput" size="small" placeholder="显示名称" class="adv-row" />
                <el-button size="small" type="primary" plain @click="addCameraViewFromCurrent">添加视角</el-button>
              </div>
              <el-divider />
              <div class="adv-block">
                <div class="adv-title">导入 SceneConfig JSON</div>
                <el-input v-model="importJsonText" type="textarea" :rows="8" placeholder="{ ... }" />
                <el-button size="small" style="margin-top: 8px" @click="importFromText">导入并应用</el-button>
              </div>
            </el-tab-pane>
          </el-tabs>
        </div>
      </el-aside>
    </el-container>

    <div v-else class="placeholder">
      <p>请选择楼层房间以加载工作台</p>
    </div>

    <el-dialog v-model="mappingVisible" title="设备关联映射" width="min(960px, 96vw)" destroy-on-close>
      <el-table :data="mappingTableRows" stripe max-height="440" size="small">
        <el-table-column prop="modelId" label="模型 ID" min-width="140">
          <template #default="{ row: r }">
            {{ r.modelId || '—' }}
            <el-tag v-if="r.duplicateName" size="small" type="danger" class="tag">重名</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="来源" width="72">
          <template #default="{ row: r }">
            <el-tag :type="r.kind === 'tip' ? 'warning' : r.kind === 'mesh' ? 'info' : 'success'" size="small">
              {{ r.kind === 'tip' ? 'Tip' : r.kind === 'mesh' ? 'Mesh' : '节点' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="绑定" width="88">
          <template #default="{ row: r }">
            <el-tag v-if="r.bindKind === 'none'" type="info" size="small">未绑定</el-tag>
            <el-tag v-else-if="r.bindKind === 'device'" type="primary" size="small">设备</el-tag>
            <el-tag v-else type="success" size="small">设备组</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="bindCode" label="设备 ID / 组编号" min-width="140" />
        <el-table-column prop="equipName" label="设备名称" min-width="120" />
        <el-table-column prop="equipType" label="设备类型" width="100" />
        <el-table-column label="操作" width="140" fixed="right">
          <template #default="{ row: r }">
            <el-button type="primary" link @click="openEdit(r)">编辑</el-button>
            <el-button type="danger" link :disabled="r.bindKind === 'none'" @click="unbindRow(r.rowId)">解绑</el-button>
          </template>
        </el-table-column>
      </el-table>
      <template #footer>
        <span class="muted footer-hint">绑定按房间写入 localStorage（Demo）。</span>
        <el-button @click="mappingVisible = false">关闭</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="editOpen" title="编辑绑定关系" width="480px" destroy-on-close>
      <template v-if="editRow">
        <p class="muted">
          模型 ID：<strong>{{ editRow.modelId || '（未设置）' }}</strong>（{{
            editRow.kind === 'tip' ? 'Tip' : editRow.kind === 'mesh' ? 'Mesh' : '交互节点'
          }}）
        </p>
        <p class="hint muted">设备与设备组二选一。</p>
        <el-form label-position="top">
          <el-form-item label="绑定设备">
            <el-select v-model="formDeviceId" filterable clearable placeholder="选择设备" style="width: 100%" @change="onDeviceSelect">
              <el-option v-for="o in deviceOptions" :key="o.value" :label="o.label" :value="o.value" />
            </el-select>
          </el-form-item>
          <el-form-item label="绑定设备组">
            <el-select v-model="formGroupCode" filterable clearable placeholder="选择设备组" style="width: 100%" @change="onGroupSelect">
              <el-option v-for="o in groupOptions" :key="o.value" :label="o.label" :value="o.value" />
            </el-select>
          </el-form-item>
        </el-form>
      </template>
      <template #footer>
        <el-button @click="editOpen = false">取消</el-button>
        <el-button type="primary" @click="saveEdit">确定</el-button>
      </template>
    </el-dialog>
  </el-container>
</template>

<style scoped>
.page {
  height: 100vh;
  flex-direction: column;
  background: linear-gradient(165deg, #eef2f7 0%, #e2e8f0 100%);
  --studio-primary: #2563eb;
  --studio-card: rgba(255, 255, 255, 0.92);
}

.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 20px;
  background: var(--studio-card);
  backdrop-filter: blur(12px);
  border-bottom: 1px solid rgba(15, 23, 42, 0.08);
  box-shadow: 0 1px 0 rgba(255, 255, 255, 0.8) inset;
}

.brand {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}

.brand-mark {
  width: 10px;
  height: 36px;
  border-radius: 4px;
  background: linear-gradient(180deg, var(--studio-primary), #7c3aed);
  flex-shrink: 0;
}

.brand-title {
  font-weight: 700;
  font-size: 15px;
  color: #0f172a;
  letter-spacing: -0.02em;
}

.breadcrumb {
  font-size: 12px;
  color: #64748b;
  margin-top: 2px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: min(520px, 45vw);
}

.header-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  justify-content: flex-end;
}

.body {
  flex: 1;
  min-height: 0;
}

.main {
  padding: 16px;
  position: relative;
  min-width: 0;
}

.canvas-shell {
  height: 100%;
  min-height: 400px;
  display: flex;
  flex-direction: column;
  background: #fff;
  border-radius: 12px;
  border: 1px solid rgba(15, 23, 42, 0.06);
  box-shadow: 0 4px 24px rgba(15, 23, 42, 0.06);
  overflow: hidden;
}

.tip-palette {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  padding: 10px 14px;
  background: linear-gradient(90deg, #f8fafc, #fff);
  border-bottom: 1px solid #e2e8f0;
}

.palette-label {
  font-size: 13px;
  font-weight: 600;
  color: #334155;
}

.palette-hint {
  font-size: 12px;
  color: #94a3b8;
}

.palette-items {
  display: flex;
  gap: 8px;
}

.palette-chip {
  width: 44px;
  height: 44px;
  padding: 4px;
  border-radius: 10px;
  border: 2px dashed #cbd5e1;
  background: #fff;
  cursor: grab;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: border-color 0.15s, box-shadow 0.15s;
}

.palette-chip:hover {
  border-color: var(--studio-primary);
  box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.15);
}

.palette-img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  pointer-events: none;
}

.view-bar {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  flex-wrap: wrap;
  padding: 8px 14px 10px;
  background: #fff;
  border-bottom: 1px solid #e2e8f0;
}

.view-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
  flex: 1;
  min-width: 0;
}

.view-chip {
  margin: 0 !important;
}

.default-tag {
  margin-left: 6px;
  vertical-align: middle;
}

.adv-block {
  margin-bottom: 12px;
}

.adv-title {
  font-size: 12px;
  font-weight: 700;
  color: #334155;
  margin-bottom: 6px;
}

.adv-desc {
  font-size: 12px;
  line-height: 1.45;
  margin: 0 0 8px;
}

.adv-row {
  margin: 8px 0;
}

.canvas-inner {
  flex: 1;
  min-height: 0;
  position: relative;
}

.canvas {
  display: block;
  width: 100%;
  height: 100%;
}

.canvas-hint {
  margin: 10px 4px 0;
  font-size: 12px;
  color: #64748b;
  line-height: 1.5;
}

.canvas-hint code {
  font-size: 11px;
  background: rgba(255, 255, 255, 0.7);
  padding: 1px 5px;
  border-radius: 4px;
}

.float-panel {
  position: fixed;
  top: 72px;
  right: 24px;
  width: 300px;
  max-height: calc(100vh - 100px);
  overflow: auto;
  z-index: 50;
  background: var(--studio-card);
  backdrop-filter: blur(16px);
  border-radius: 14px;
  border: 1px solid rgba(15, 23, 42, 0.08);
  box-shadow: 0 12px 40px rgba(15, 23, 42, 0.12), 0 0 0 1px rgba(255, 255, 255, 0.5) inset;
  padding: 0 0 14px;
}

.float-enter-active,
.float-leave-active {
  transition: opacity 0.2s ease, transform 0.2s ease;
}

.float-enter-from,
.float-leave-to {
  opacity: 0;
  transform: translateX(12px);
}

.float-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 14px;
  border-bottom: 1px solid rgba(15, 23, 42, 0.06);
  background: linear-gradient(90deg, rgba(37, 99, 235, 0.06), transparent);
}

.float-title {
  font-weight: 700;
  font-size: 14px;
  color: #0f172a;
}

.float-section-label {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: #64748b;
  padding: 12px 14px 0;
}

.float-form {
  padding: 0 14px;
}

.float-reopen {
  position: fixed;
  top: 50%;
  right: 0;
  transform: translateY(-50%);
  z-index: 49;
  padding: 10px 8px 10px 10px;
  border-radius: 8px 0 0 8px;
  border: 1px solid rgba(15, 23, 42, 0.1);
  border-right: none;
  background: var(--studio-card);
  font-size: 12px;
  font-weight: 600;
  color: var(--studio-primary);
  cursor: pointer;
  box-shadow: -4px 0 16px rgba(15, 23, 42, 0.08);
}

.aside-wrap {
  position: relative;
  background: #fff;
  border-left: 1px solid #e2e8f0;
  transition: width 0.2s ease;
  overflow: visible;
}

.aside-toggle {
  position: absolute;
  left: 0;
  top: 50%;
  transform: translate(-100%, -50%);
  z-index: 2;
  width: 22px;
  height: 48px;
  border: 1px solid #e2e8f0;
  border-right: none;
  border-radius: 8px 0 0 8px;
  background: #fff;
  cursor: pointer;
  font-size: 14px;
  color: #64748b;
}

.aside-inner {
  height: 100%;
  display: flex;
  flex-direction: column;
  padding: 0 12px 12px;
  box-sizing: border-box;
}

.tabs {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.tabs :deep(.el-tabs__content) {
  flex: 1;
  min-height: 0;
}

.search {
  margin-bottom: 10px;
}

.list-scroll {
  height: calc(100vh - 220px);
  min-height: 200px;
}

.model-item {
  padding: 10px 8px;
  border-radius: 10px;
  cursor: pointer;
  border: 1px solid transparent;
  margin-bottom: 4px;
  transition: background 0.15s;
}

.model-item:hover {
  background: #f1f5f9;
}

.model-item.active {
  background: #eff6ff;
  border-color: #bfdbfe;
}

.model-id {
  font-weight: 600;
  font-size: 13px;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

.model-sub {
  font-size: 12px;
  margin-top: 4px;
}

.tag {
  margin-left: 0;
}

.section-title {
  font-size: 13px;
  font-weight: 600;
  margin: 12px 0 8px;
  color: #334155;
}

.empty {
  padding: 24px;
  text-align: center;
}

.muted {
  color: #64748b;
  font-size: 13px;
}

.hint {
  margin: 0 0 12px;
}

.footer-hint {
  float: left;
  max-width: 55%;
  line-height: 32px;
}

.placeholder {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #64748b;
}

.dialog-lead {
  font-size: 13px;
  color: #64748b;
  line-height: 1.55;
  margin: 0 0 16px;
}
</style>
