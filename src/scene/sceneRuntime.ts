import * as THREE from 'three';
import type { Viewer } from '../Viewer';
import type {
  SceneCameraConfig,
  SceneCameraViewConfig,
  SceneConfig,
  SceneSource,
  SceneTipConfig,
} from './sceneConfigTypes';

const SCENE_BG_USERDATA_KEY = 'sceneConfigBg';

/** 移除由 applySceneConfig 写入的背景、Tips、已加载模型（保留 TipManager 与灯光等） */
export function clearSceneConfigLayers(viewer: Viewer): void {
  for (const c of [...viewer.scene.children]) {
    if ((c.userData as Record<string, unknown>)[SCENE_BG_USERDATA_KEY]) viewer.scene.remove(c);
  }
  for (const id of [...viewer.tips.getAllTips().keys()]) {
    viewer.tips.removeTip(id);
  }
  for (const c of [...viewer.root.children]) {
    if (c.name !== 'TipManager') viewer.root.remove(c);
  }
}

export async function applySceneConfig(viewer: Viewer, config: SceneConfig): Promise<void> {
  clearSceneConfigLayers(viewer);
  await applySceneSource(viewer, config.scene.source);
  await applySceneTips(viewer, config.tips ?? []);
  applySceneCameras(viewer, config.cameras);
}

/**
 * 通用场景几何优化（实例化 / 合批），便于在通过 SceneConfig 加载完场景后复用。
 * 具体排除规则（如管道、地面等）建议由调用方在 Viewer 层自行处理。
 */
export function optimizeSceneForPerformance(
  viewer: Viewer,
  options?: {
    /** 触发实例化的最小重复次数，对应 optimizeInstancing.minCount，默认 2 */
    minInstanceCount?: number;
    /** 是否启用实例颜色，对应 optimizeInstancing.enableInstanceColor，默认 true */
    enableInstanceColor?: boolean;
    /** 是否按材质合批，对应 optimizeMerge.groupByMaterial，默认 true */
    groupByMaterial?: boolean;
    /** 合批后是否释放源 mesh，对应 optimizeMerge.disposeSources，默认 false */
    disposeSources?: boolean;
  },
): void {
  const {
    minInstanceCount = 2,
    enableInstanceColor = true,
    groupByMaterial = true,
    disposeSources = false,
  } = options ?? {};

  // 这些方法在 Viewer 示例里已有；加 typeof 判断以防将来裁剪 API
  if (typeof (viewer as any).optimizeInstancing === 'function') {
    (viewer as any).optimizeInstancing({
      minCount: minInstanceCount,
      enableInstanceColor,
    });
  }

  if (typeof (viewer as any).optimizeMerge === 'function') {
    (viewer as any).optimizeMerge({
      groupByMaterial,
      disposeSources,
    });
  }
}

export async function applySceneSource(viewer: Viewer, source: SceneSource): Promise<void> {
  if (source.kind === 'background') {
    const bg = source.background;
    const tex = await new THREE.TextureLoader().loadAsync(bg.imageUrl);
    tex.colorSpace = THREE.SRGBColorSpace;

    const mat = new THREE.SpriteMaterial({
      map: tex,
      depthWrite: false,
      depthTest: false,
      transparent: true,
    });
    const sprite = new THREE.Sprite(mat);
    sprite.name = 'sceneConfigBackgroundSprite';
    (sprite.userData as Record<string, unknown>)[SCENE_BG_USERDATA_KEY] = true;
    sprite.position.fromArray(bg.position);
    sprite.scale.fromArray(bg.scale);
    sprite.renderOrder = bg.renderOrder ?? -1000;
    sprite.visible = bg.visible ?? true;
    viewer.scene.add(sprite);
    return;
  }

  for (const m of source.models) {
    const root = await viewer.load(m.url, { attachToRoot: true });
    if (m.id) root.name = `sceneConfigModel:${m.id}`;
    root.position.fromArray(m.position ?? [0, 0, 0]);
    const rot = m.rotation ?? [0, 0, 0];
    root.rotation.set(rot[0], rot[1], rot[2]);
    root.scale.fromArray(m.scale ?? [1, 1, 1]);
    root.visible = m.visible ?? true;
    Object.assign(root.userData, m.userData);
  }
}

export async function applySceneTips(viewer: Viewer, tips: SceneTipConfig[]): Promise<void> {
  if (!tips.length) return;
  const byTexture = new Map<string, SceneTipConfig[]>();
  for (const tip of tips) {
    if (!byTexture.has(tip.textureUrl)) byTexture.set(tip.textureUrl, []);
    byTexture.get(tip.textureUrl)!.push(tip);
  }

  for (const [textureUrl, group] of byTexture) {
    viewer.tips.registerTexture('pos', textureUrl);
    for (const t of group) {
      const sprite = viewer.tips.addTipSync(t.id, t.position, {
        textureUrl,
        size: t.size ?? 0.55,
        sizeAttenuation: t.sizeAttenuation ?? true,
        interact: t.interact ?? true,
        userData: { ...(t.binding ?? {}) },
      });
      sprite.visible = t.visible ?? true;
    }
  }
}

export function applySceneCameras(viewer: Viewer, cameras: SceneCameraConfig): void {
  if (!cameras.views.length) return;
  const defaultId = cameras.defaultViewId ?? cameras.views[0]!.id;
  const view = cameras.views.find((v) => v.id === defaultId) ?? cameras.views[0]!;
  applySceneCameraView(viewer, view);
}

/** 切换到某一预设视角（不修改 defaultViewId） */
export function applySceneCameraView(viewer: Viewer, view: SceneCameraViewConfig): void {
  viewer.camera.position.fromArray(view.position);
  viewer.camera.lookAt(...view.target);
  if (view.fov != null) {
    viewer.camera.fov = view.fov;
    viewer.camera.updateProjectionMatrix();
  }
  if (viewer.navigator.controls) {
    viewer.navigator.controls.target.set(...view.target);
    viewer.navigator.controls.update();
  }
}

/** 按 id 查找并切换视角；找不到返回 false */
export function applySceneCameraViewById(viewer: Viewer, cameras: SceneCameraConfig, viewId: string): boolean {
  const view = cameras.views.find((v) => v.id === viewId);
  if (!view) return false;
  applySceneCameraView(viewer, view);
  return true;
}

/** 将当前相机与 Orbit 目标写入指定视角条目（非仅默认） */
export function syncCameraToSceneView(viewer: Viewer, cameras: SceneCameraConfig, viewId: string): boolean {
  const v = cameras.views.find((x) => x.id === viewId);
  if (!v) return false;
  const ctl = viewer.navigator.controls;
  v.position = [viewer.camera.position.x, viewer.camera.position.y, viewer.camera.position.z];
  if (ctl) v.target = [ctl.target.x, ctl.target.y, ctl.target.z];
  v.fov = viewer.camera.fov;
  return true;
}

/** 从 Viewer 同步 Tip 世界坐标到配置（与 applySceneTips 对称） */
export function syncTipPositionsFromViewer(viewer: Viewer, tips: SceneTipConfig[]): void {
  for (const t of tips) {
    const s = viewer.tips.getTip(t.id);
    if (s) t.position = [s.position.x, s.position.y, s.position.z];
  }
}

/** 将当前相机与 Orbit target 写入默认视角条目（与 applySceneCameras 对称） */
export function syncDefaultCameraToSceneConfig(viewer: Viewer, cameras: SceneCameraConfig): void {
  if (!cameras.views.length) return;
  const defaultId = cameras.defaultViewId ?? cameras.views[0]!.id;
  const v = cameras.views.find((x) => x.id === defaultId) ?? cameras.views[0]!;
  const ctl = viewer.navigator.controls;
  v.position = [viewer.camera.position.x, viewer.camera.position.y, viewer.camera.position.z];
  if (ctl) v.target = [ctl.target.x, ctl.target.y, ctl.target.z];
  v.fov = viewer.camera.fov;
}

/** 别名，与历史示例命名一致 */
export const syncDefaultCameraToConfig = syncDefaultCameraToSceneConfig;

/** 深拷贝 base 后写入 Tip 位置与默认相机，得到可 JSON 序列化的配置 */
export function captureSceneConfigFromViewer(viewer: Viewer, base: SceneConfig): SceneConfig {
  const out = JSON.parse(JSON.stringify(base)) as SceneConfig;
  syncTipPositionsFromViewer(viewer, out.tips ?? []);
  syncDefaultCameraToSceneConfig(viewer, out.cameras);
  return out;
}

/** 与 captureSceneConfigFromViewer 相同（历史命名） */
export const exportSceneConfig = captureSceneConfigFromViewer;

export function sceneConfigToJson(config: SceneConfig, pretty = true): string {
  return pretty ? JSON.stringify(config, null, 2) : JSON.stringify(config);
}

export function parseSceneConfigJson(text: string): SceneConfig {
  return JSON.parse(text) as SceneConfig;
}
