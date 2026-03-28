# three-stage

> 基于 Three.js 的工业级场景封装：可配置加载管线 / 性能优化 / 交互 / 摄像机导航 / 高亮与区域可视化。

## 特性概览

- **统一加载**：多 GLB/GLTF、DRACO 解压、Pipeline JSON 场景拼装（保持层级，用 `THREE.Group` 作为加载根）。
- **性能优化**：
  - 一键 **InstancedMesh 实例化**（支持 per-instance 高亮用 `instanceColor`）。
  - **静态合批**：`mergeGeometries` 按材质分组合并，降低 draw call。
  - **BVH 加速拾取**：集成 `three-mesh-bvh`，对大场景 raycast 提速。
- **交互系统**：
  - 鼠标/指针事件：`click / dblclick / mousemove / contextmenu / drag-*`。
  - **点击防误触**：短按+小位移才触发 click，拖拽旋转时不误点模型。
  - 只对 `userData.interact === true` 的对象（或带此标记的父节点）做交互。
- **摄像机 & 导航**：
  - 轨道控制（OrbitControls）。
  - 基于包围盒的 **平滑对焦 focus**（GSAP 动画）。
  - GSAP 驱动的 **巡检/漫游路径**（Catmull-Rom 曲线）。
- **高亮 & 可视化**：
  - 非破坏性高亮：优先改 emissive，必要时对共享材质做克隆，避免“串亮”。
  - `userData.highlightRoot = true` 支持“整柜/整设备”整体高亮。
  - 呼吸灯高亮（可配置强度、周期）。
  - 影响区域（球/盒）可视化（半透明体 + Edges 边线）。
- **按 userData 显隐**：`setVisibilityByUserData({ type: 'pipe' }, false)` 批量控制对象显隐。
- **Tip Sprite & 巡检**：
  - `addTipsForMeshes` 为 mesh 上方批量添加 Sprite，支持 `resolveInteractionTarget` 使点击 tip 等同于点击关联 mesh。
  - 巡检：以设备列表循环聚焦（上一站/下一站/恢复）。
- **状态 & 事件总线**：`StrictEventBus` 驱动，解耦 Loader / Interactor / Navigator / EffectManager。

## 安装

```bash
npm install three @murmur_han/three-stage
```

> 注意：`three`、`gsap`、`three-mesh-bvh` 均作为 **peer 依赖** 使用，不会被打包进库本身。

## Quick Start

```ts
import { Viewer } from '@murmur_han/three-stage';

const canvas = document.querySelector<HTMLCanvasElement>('#c');
if (!canvas) throw new Error('Canvas not found');

const viewer = new Viewer({
  canvas,
  enableDraco: true,
  dracoDecoderPath: '/draco/',
  enableOrbitControls: true,
  enableDrag: true,
  enableBVH: true,
  clearColor: 0xffffff,
  lighting: {
    shadows: 'auto',
    shadowCatcher: true,
  },
});

viewer.on('object-click', (hit) => {
  viewer.setHighlightFromInteraction(hit, { breathing: true, color: 0x4fc3f7 });
  if (hit.intersectedObject) {
    viewer.focus(hit.intersectedObject, { durationMs: 500, padding: 1.4 }).catch(() => void 0);
  }
});

(async () => {
  const root = await viewer.load('/models/scene.glb', { attachToRoot: true });

  // 性能优化：实例化 + 合批
  viewer.optimizeInstancing({ minCount: 2, enableInstanceColor: true });
  viewer.optimizeMerge({ groupByMaterial: true, disposeSources: false });

  // 初始对焦到整场景
  await viewer.focus(root, { durationMs: 700, padding: 1.6 });
})().catch(console.error);
```

### 本仓库 dev 示例：大图背景 + Sprite（`fab.png`）

本地启动 dev 后访问 **`?fabBg=1`**（例如 `http://localhost:5173/?fabBg=1`，端口以实际为准）。将园区鸟瞰图放在 **`public/models/fab.png`**，示例会：

- 用该图贴满与当前相机视锥匹配的竖直平面（不加载 GLB）；
- 在图上用 **Tip Sprite** 打若干示例点（FAB / PMD / SGS 等），支持点击与 DOM 标签跟随；
- **仅允许滚轮缩放**（关闭轨道旋转与平移）。实现见 `examples/main.ts` 中的 `runFabBackgroundDemo`。

### 配置驱动与场景编辑器（dev）

- **只读展示**：`config.html` + `examples/configScene.ts`，`?kind=background` / `?kind=model` 切换示例。
- **编辑能力**：`editor.html` + Vue3 + Element Plus（`examples/editor/`）
  - 点击 Tip Sprite 选中，**TransformControls** 三轴平移；
  - 侧栏编辑 `binding`（name / deviceId / type），同步到 Sprite `userData`；
  - **导出 JSON**：`exportSceneConfig`（与 `applySceneConfig` 对称，含 Tip 坐标与默认相机视角）；亦可使用 `captureSceneConfigFromViewer`。
  - **导入 JSON**：粘贴后「导入并应用」。
- **场景配置工作台（关系映射 + 编辑合一）**：`mapping.html` + `examples/mapping/`
  - **前置**：弹窗模拟「楼层房间 ↔ 场景文件 / 初始 JSON」绑定；也可 `?roomId=room-substation-1f` 直达。
  - 进入后按房间加载**设备 / 设备组**列表；场景来自 `SceneConfig`（含已有 Tip）；**仅列出自身 `userData.interact === true`** 的 Mesh、Group（节点）、Tip；**模型 ID 为 `userData.name`**。
  - **Tip**：画布上方 **图标条拖到画布** 放置；选中后 **TransformControls** + **固定悬浮窗** 编辑（与旧场景编辑器一致）；侧栏「高级」可粘贴 JSON。
  - **关联映射**：总表 + 设备/设备组**两个下拉二选一**；绑定按房间存 `localStorage`（Demo）。
  - **预设视角**：`SceneConfig.cameras.views` 支持多书签；画布上方可快速切换，侧栏「高级」可更新某条书签、改默认视角或从当前机位新增书签。库内新增 `applySceneCameraView` / `applySceneCameraViewById` / `syncCameraToSceneView`。
  - **光照**：工作台 Viewer 使用略增强的默认半球光 + 主光 + 两盏补光，减轻模型场景偏暗。
  - **保存**：控制台打印 `sceneConfig` 快照与 `deviceBindings` 完整 payload（预留对接上传）。
  - 独立 **`/editor.html`** 仍保留作轻量编辑入口。
- **场景配置 API**（类型如 `SceneConfig` / `TipConfig`，函数如 `applySceneConfig`、`clearSceneConfigLayers`、`captureSceneConfigFromViewer`、`parseSceneConfigJson`）从包根 **`@murmur_han/three-stage`** 导出；本仓库示例里通过 **`examples/sceneConfig.ts`** 再导出，并附带演示预设 **`examples/scenePresets.ts`**（`bgDemoConfig` / `modelDemoConfig`）。

依赖：`npm install` 后 `npm run dev`，浏览器打开 **`/editor.html`**、**`/config.html`** 或 **`/mapping.html`**。

## ViewerConfig 配置

```ts
export interface ViewerConfig {
  canvas: HTMLCanvasElement;
  context?: WebGLRenderingContext | WebGL2RenderingContext;
  dpr?: number | { min: number; max: number };
  clearColor?: number; // 默认 0xffffff

  enableDraco?: boolean;
  dracoDecoderPath?: string; // 默认 '/draco/'

  enableOrbitControls?: boolean; // 默认 true
  enableRoaming?: boolean;       // 默认 false
  enableDrag?: boolean;          // 默认 false

  enableBVH?: boolean;           // 默认 false
  bvh?: BVHOptions;

  lighting?: LightingOptions;
  raycast?: RaycastOptions;
  optimizer?: OptimizerOptions;
}
```

### 射线与 Hover（RaycastOptions）

```ts
export interface RaycastOptions {
  whitelist?: ReadonlyArray<THREE.Object3D>;
  blacklist?: ReadonlyArray<THREE.Object3D>;
  layers?: number[];
  params?: THREE.RaycasterParameters;
  maxHits?: number;
  hoverDelayMs?: number; // 新增：hover 停留延迟（毫秒）
}
```

- `hoverDelayMs` 默认 `250`；例如设置 `300` 后，鼠标短暂划过不会触发 `object-hover`，停留超过阈值才触发。
- 值为 `0` 或负数时，恢复“即时 hover”。

### 光照 LightingOptions

```ts
export interface LightingOptions {
  hemiIntensity?: number;   // 默认 1.0
  dirIntensity?: number;    // 默认 1.6
  shadows?: boolean | 'auto'; // 默认 'auto'
  shadowMapSize?: 512 | 1024 | 2048; // 默认 1024
  shadowCatcher?: boolean;  // 默认 true（接收阴影的透明地面）
  shadowCatcherOpacity?: number; // 默认 0.18
  extraDirections?: {
    position: [number, number, number];
    intensity?: number;
    color?: number;
  }[];
}
```

- `shadows: 'auto'`：根据硬件信息（`deviceMemory` / `hardwareConcurrency`）和 **实时帧率 EMA** 动态开关阴影：
  - 平均 FPS < 35 持续 2 秒：自动关闭阴影。
  - 平均 FPS > 55 持续 3 秒：自动重新开启阴影。
- `extraDirections`：可以轻松加多盏补光，例如：

```ts
lighting: {
  extraDirections: [
    { position: [-8, 6, 4], intensity: 0.8 },
    { position: [0, 10, -6], intensity: 0.6, color: 0xfff0e0 },
  ],
}
```

### 交互只作用于 `userData.interact === true`

`InteractionManager` 在做 raycast 时，会从命中的物体向上找父节点，只有当 **某一层的 `userData.interact === true`** 时才认为这次命中有效。

```ts
node.userData.interact = true; // 节点及其子孙都可交互
```

这样可以保证场景里只有你标记过的设备/对象参与点击/拾取。

### BVHOptions（可选）

```ts
export interface BVHOptions {
  autoBuild?: boolean; // 默认 true（attachToRoot 且 enableBVH 时，每次 load 后自动 build）
  filter?: (mesh: THREE.Mesh) => boolean;
}
```

内部通过 `PerformanceManager.enableBVH(root, opts)` 对 Mesh 和 BufferGeometry 打补丁：

- `mesh.raycast = acceleratedRaycast`
- `geometry.computeBoundsTree / disposeBoundsTree` + 构建 BVH

适合 **大静态场景 + 高频拾取** 的场景；对非常小的 demo 可以关闭以节省内存。

## 性能优化 API

- `viewer.optimizeInstancing(opts?: InstancingOptions)`
  - 对重复网格自动分桶，生成 `THREE.InstancedMesh`，并可选创建 `instanceColor` 以支持“单实例高亮”。
  - `excludeUserData: { type: 'pipe' }` 排除指定 userData 的对象；`excludeFilter: (o) => ...` 排除满足条件的 mesh。
- `viewer.optimizeMerge(opts?: MergeOptions)`
  - 对静态网格按材质分组合并（`mergeGeometries`），仅合并属性签名一致的几何体。
  - 同样支持 `excludeUserData`、`excludeFilter`。
- `viewer.setFrustumCulling(enabled: boolean)`
  - 一键开关整个 `root` 子树的 frustumCulling 标志。
- `viewer.enableBVHNow()`
  - 可手动在合批/精简后重新构建 BVH。

### 查找 Mesh：`viewer.findMeshes`

按 userData 或自定义条件查找 mesh，返回包围盒和中心点，方便做批量操作：

```ts
const results = viewer.findMeshes(
  (o) => String(o.userData?.name ?? '').includes('ground'),
  { interactableOnly: true },
);

results.forEach(({ object, box, center }) => {
  console.log(object.name, center, box);
});
```

返回类型：

```ts
interface FoundMesh {
  object: THREE.Mesh;
  box: THREE.Box3;
  center: THREE.Vector3;
}
```

## 交互与事件

`Viewer` 内部使用强类型事件总线：

```ts
viewer.on('object-click', (hit) => {
  // hit: InteractionData，包含 intersection / uuid / userData / normal / uv / distance / instanceId
});

viewer.on('state-change', ({ prev, next }) => {
  // init -> loading -> idle / interacting / roaming / disposed
});

viewer.on('load-progress', (p) => {
  // { requestId, url, loaded, total, ratio, phase }
});

viewer.on('frame', ({ dt, t }) => {
  // 每帧回调，用于 DOM 弹框位置更新等
});
```

防误触逻辑：

- 只有 **短按（< 250 ms）+ 小位移（< 5 px）** 才视为 `click`。
- 拖拽（旋转/平移）过程中不会触发 `object-click`。

拖拽事件：

- `drag-start` / `drag-move` / `drag-end`（payload 同 `InteractionData`）。

## 摄像机与导航

```ts
// 对单个对象做平滑对焦
await viewer.focus(targetObject, {
  durationMs: 650,
  padding: 1.4,
  minRadius: 2,  // Sprite 等小物体避免镜头过近
  setOrbitTarget: true,
});

// 巡检路径（相机沿曲线移动）
viewer.startRoaming(
  [
    { position: [0, 2, 8] },
    { position: [8, 4, 0] },
    { position: [0, 3, -8] },
  ],
  { durationMs: 20000, loop: true },
);
```

内部使用 GSAP 做摄像机动画（可中断、可复用）。

### 设备巡检（聚焦循环）

以设备列表循环聚焦：上一站 → 下一站 → 恢复（整场景）。示例：

```ts
const { tipIds, targetMap } = viewer.addTipsForMeshes(filter, opts);
const targets = tipIds.map((id) => targetMap.get(id)).filter(Boolean);

// 上一站 / 下一站：viewer.focus(targets[index])
// 恢复：viewer.focus(root)
```

## 按 userData 显隐

```ts
// 隐藏 userData.type === 'pipe' 的对象
viewer.setVisibilityByUserData({ type: 'pipe' }, false);

// 自定义谓词
viewer.setVisibilityByUserData((o) => String(o.userData?.name ?? '').includes('ground'), true);
```

## 高亮与影响区域

### 点击高亮

```ts
viewer.on('object-click', (hit) => {
  viewer.setHighlightFromInteraction(hit, { breathing: true, color: 0x4fc3f7 });
});
```

**HighlightStyle 配置**（默认呼吸灯，柔和高亮）：

```ts
interface HighlightStyle {
  color?: number;           // 高亮颜色，默认 0x4fc3f7
  breathing?: boolean;      // 呼吸灯效果，默认 true
  breathingMin?: number;   // 呼吸最低强度，默认 0.12
  breathingMax?: number;   // 呼吸最高强度，默认 0.35
  breathingSpeed?: number; // 呼吸周期（秒），默认 2
  emissiveIntensity?: number; // 非呼吸灯时的固定强度
}
```

- 若命中 InstancedMesh 且有 `instanceColor`，则只高亮一个实例。
- 若命中普通 Mesh：
  - 在当前高亮目标下，如果多个 Mesh 共享同一个材质，会先对这些 Mesh **克隆材质** 再改颜色，避免“串亮到别的柜子”。

### 整柜/整设备高亮

给设备根节点打一个标记：

```ts
deviceRoot.userData.highlightRoot = true;
```

之后点击任意子 Mesh，`setHighlightFromInteraction` 会自动上卷到最近的 `highlightRoot` 节点做整体高亮。

### 影响区域（Area of Influence）

```ts
viewer.upsertInfluenceZone(
  'zone-1',
  { kind: 'sphere', center: [0, 1.2, 0], radius: 2.0 },
  { color: 0x33aaff, opacity: 0.15 },
);
```

会绘制一个带半透明体和边线的区域，可用于表示设备影响范围/告警区域等。

## Tip 图标与 worldToScreen

### addTipsForMeshes（批量添加）

为匹配 userData 的 mesh 在其上方批量添加 Sprite，点击 tip 时通过 `resolveInteractionTarget` 解析为关联 mesh，交互行为与直接点击 mesh 一致：

```ts
const { tipIds, targetMap } = viewer.addTipsForMeshes(
  (o) => String(o.userData?.name ?? '').includes('ground'),
  { textureUrl: '/icons/pos.png', size: 48, sizeAttenuation: false, offset: 0.3 },
);

// 点击 tip 时解析为 ground mesh
viewer.on('object-click', (hit) => {
  const target = viewer.resolveInteractionTarget(hit);
  if (target) viewer.focus(target);
});

// 若需要拿“业务对象”（优先 interact=true，回退 highlightRoot）
viewer.on('object-hover', (hit) => {
  const dataTarget = viewer.resolveInteractionDataTarget(hit);
  if (!dataTarget) return;
  // dataTarget.userData ...
});
```

需用 `excludeFilter` 排除 ground 参与 merge，否则 mesh 被合并后无法解析。

### TipManager（Sprite 图标）

在设备 3D 位置创建可点击的 Sprite 图标：

```ts
viewer.tips.registerTexture('camera', '/icons/camera.png');

viewer.tips.addTipSync('cam-1', [1, 2, 3], {
  type: 'camera',
  size: 0.4,
  sizeAttenuation: false,  // 固定像素大小
  interact: true,
  userData: { deviceId: 'cam-1', name: '入口摄像头' },
});

// 异步添加（等贴图加载完再显示）
await viewer.tips.addTip('sensor-1', [2, 1.5, 0], {
  textureUrl: '/icons/temp.png',
  userData: { deviceId: 'sensor-1' },
});

// 更新位置
viewer.tips.updateTip('cam-1', [1.5, 2.2, 3]);

// 移除
viewer.tips.removeTip('cam-1');
```

Tip 默认 `userData.interact = true`，会参与 raycast，点击时触发 `object-click`。

### worldToScreen（DOM 弹框定位）

将 3D 对象投影到画布像素坐标，用于 DOM 弹框定位：

```ts
viewer.on('object-click', (hit) => {
  if (!hit.intersectedObject) return;
  const { x, y, visible } = viewer.worldToScreen(hit.intersectedObject);
  if (!visible) return; // 在视野外则隐藏弹框
  popupEl.style.left = `${x}px`;
  popupEl.style.top = `${y}px`;
  popupEl.style.display = 'block';
  // 根据 hit.userData.deviceId 请求接口加载设备数据
});
```

相机移动时需每帧或 on resize 重新调用 `worldToScreen` 更新弹框位置。

---

## 版本记录

### 0.3.0

- **场景相机**：新增 `applySceneCameraView`、`applySceneCameraViewById`、`syncCameraToSceneView`；`applySceneCameras` 内部复用单视角应用逻辑。
- **示例预设**：`scenePresets` 中模型 / 背景场景补充多组 `cameras.views` 书签。
- **Dev 工作台**：`mapping.html` 场景配置工作台（房间上下文、Tip 拖拽、悬浮编辑、设备关联、保存打印 payload）、`public/icons` 多枚 Tip 贴图；工作台 Viewer 增强补光。

### 0.2.0

- 主入口导出**场景配置协议与运行时**：`SceneConfig`、`TipConfig`（及 `Scene*` 类型）、`applySceneConfig`、`clearSceneConfigLayers`、`captureSceneConfigFromViewer` / `exportSceneConfig`、`parseSceneConfigJson`、`syncDefaultCameraToSceneConfig` 等（实现位于 `src/scene`）。
- 仓库内示例：`config.html` / `editor.html`，演示预设 `examples/scenePresets.ts`。
- `package.json` 已配置 `prepublishOnly`，`npm publish` 前会自动执行 `npm run build`。

### 0.1.x

- 此前版本见 npm 与 git 历史。

---

## 发布到 npm 的建议

- 在 `package.json` 中设置：
  - `name`：你要发布的包名（例如 `@your-scope/three-stage`）。
  - `version`：如 `0.3.0`。
  - `description` / `keywords` / `repository` / `author` 等元信息。
- 确保构建脚本：

```jsonc
{
  "scripts": {
    "build": "npm run build:types && vite build",
    "build:types": "tsc -p tsconfig.build.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "prepublishOnly": "npm run build"
  },
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  }
}
```

发布流程示例：

```bash
npm publish --access public
```

（`prepublishOnly` 会在发布前自动构建；若需本地检查，可先执行 `npm run build`。）

> 如需改为私有包或组织作用域，请按你公司/团队的 npm 规范调整 `name` 和 `access`。
