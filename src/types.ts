import type * as THREE from 'three';

export type ViewerState = 'init' | 'loading' | 'idle' | 'interacting' | 'roaming' | 'disposed';

export interface Disposable {
  dispose(): void;
}

export interface EventMap {
  [event: string]: unknown;
}

export type Unsubscribe = () => void;

export interface EventBus<TEvents extends EventMap> {
  on<K extends keyof TEvents>(event: K, handler: (payload: TEvents[K]) => void): Unsubscribe;
  once<K extends keyof TEvents>(event: K, handler: (payload: TEvents[K]) => void): Unsubscribe;
  off<K extends keyof TEvents>(event: K, handler: (payload: TEvents[K]) => void): void;
  emit<K extends keyof TEvents>(event: K, payload: TEvents[K]): void;
  clear(): void;
}

export interface ViewerEvents extends EventMap {
  'state-change': { prev: ViewerState; next: ViewerState };
  'frame': { dt: number; t: number };
  'load-start': { requestId: string };
  'load-progress': LoaderProgress;
  'load-complete': { requestId: string; root: THREE.Group };
  'load-error': { requestId: string; error: unknown };

  'object-click': InteractionData;
  'object-dblclick': InteractionData;
  'object-contextmenu': InteractionData;
  'object-hover': InteractionData | null;
  'drag-start': InteractionData;
  'drag-move': InteractionData;
  'drag-end': InteractionData;
}

/**
 * 细粒度配置 Three.js `OrbitControls`（仅当 `enableOrbitControls === true` 时生效）。
 * 未写明的项保持 three.js 默认；本库创建控制器后会先打开阻尼，可被此处覆盖。
 *
 * 常见对应关系：旋转 ≈ `enableRotate`（左键拖绕目标转），缩放 ≈ `enableZoom`（滚轮等），平移 ≈ `enablePan`（右键 / 中键等，依 `mouseButtons`）。
 */
export interface OrbitControlsOptions {
  enableRotate?: boolean;
  enableZoom?: boolean;
  enablePan?: boolean;
  enableDamping?: boolean;
  dampingFactor?: number;
  minDistance?: number;
  maxDistance?: number;
  minPolarAngle?: number;
  maxPolarAngle?: number;
  minAzimuthAngle?: number;
  maxAzimuthAngle?: number;
  rotateSpeed?: number;
  zoomSpeed?: number;
  panSpeed?: number;
}

export interface ViewerConfig {
  canvas: HTMLCanvasElement;
  /**
   * If provided, renderer will be created with this context.
   * Useful for OffscreenCanvas/WebGL context sharing.
   */
  context?: WebGLRenderingContext | WebGL2RenderingContext;
  dpr?: number | { min: number; max: number };
  /** 背景色（默认白底） */
  clearColor?: number;
  lighting?: LightingOptions;

  enableDraco?: boolean;
  dracoDecoderPath?: string;

  enableOrbitControls?: boolean;
  /** 轨道控制器细项；`enableOrbitControls === false` 时忽略 */
  orbitControls?: OrbitControlsOptions;
  enableRoaming?: boolean;
  enableDrag?: boolean;
  /** Enable BVH acceleration for raycasting (three-mesh-bvh). */
  enableBVH?: boolean;
  bvh?: BVHOptions;

  raycast?: RaycastOptions;
  optimizer?: OptimizerOptions;
  /** Tip 图标管理配置（Sprite 贴图注册表等） */
  tips?: { textureRegistry?: TipTextureRegistry; defaultSize?: number };
  /** 初始相机视角，未设置时默认 position [3,2,5] target [0,0,0] */
  initialCamera?: {
    position?: [number, number, number];
    target?: [number, number, number];
  };
}

export interface LightingOptions {
  /** 环境/天空光强度（默认 1.0） */
  hemiIntensity?: number;
  /** 主方向光强度（默认 1.6） */
  dirIntensity?: number;
  /** 是否开启阴影：true/false/auto（默认 auto） */
  shadows?: boolean | 'auto';
  /** 阴影贴图尺寸（默认 1024） */
  shadowMapSize?: 512 | 1024 | 2048;
  /** 阴影相机视锥范围（世界单位），场景大时需调大，默认 ±80 即 160x160 */
  shadowCameraSize?: number;
  /** 阴影相机 far，默认 300 */
  shadowCameraFar?: number;
  /** 阴影 normalBias，缓解条纹状 shadow acne，默认 0.02 */
  shadowNormalBias?: number;
  /** 是否添加阴影接收地面（默认 true） */
  shadowCatcher?: boolean;
  /** 阴影接收地面透明度（默认 0.18） */
  shadowCatcherOpacity?: number;
  /**
   * 额外方向光配置（可同时加多盏补光），按顺序添加到场景中。
   */
  extraDirections?: {
    position: [number, number, number];
    intensity?: number;
    color?: number;
  }[];
}

export interface BVHOptions {
  /**
   * If true, build BVH automatically after each load call when attachToRoot is true.
   * Defaults to true when enableBVH is true.
   */
  autoBuild?: boolean;
  /**
   * Only build BVH for meshes passing this filter.
   * Defaults to: Mesh with BufferGeometry and NOT SkinnedMesh.
   */
  filter?: (mesh: THREE.Mesh) => boolean;
}

export interface RaycastOptions {
  /** Limit candidates for raycasting (performance). */
  whitelist?: ReadonlyArray<THREE.Object3D>;
  /** Exclude objects from raycasting. */
  blacklist?: ReadonlyArray<THREE.Object3D>;
  /** Objects with these layers will be considered. */
  layers?: number[];
  /** Raycaster params forwarded to THREE.Raycaster. */
  params?: THREE.RaycasterParameters;
  /**
   * Max intersections returned by raycast.
   * When set, we stop once we have enough hits.
   */
  maxHits?: number;
  /**
   * Hover event delay in milliseconds.
   * - 0 or negative: emit hover immediately on pointer move.
   * - positive: pointer must stay on same target for this duration.
   */
  hoverDelayMs?: number;
}

export interface InteractionData {
  type: 'click' | 'dblclick' | 'contextmenu' | 'mousemove' | 'drag';
  pointerId: number;
  buttons: number;
  clientX: number;
  clientY: number;
  ndc: { x: number; y: number };
  /**
   * Raw intersection.
   * Note: `instanceId` is set by Three.js for instanced meshes.
   */
  intersection: THREE.Intersection<THREE.Object3D> | null;
  intersectedObject: THREE.Object3D | null;
  uuid: string | null;
  userData: unknown;
  normal: THREE.Vector3 | null;
  uv: THREE.Vector2 | null;
  distance: number | null;
  instanceId: number | undefined;
}

export interface LoaderProgress {
  requestId: string;
  url?: string;
  loaded: number;
  total: number;
  ratio: number; // 0..1
  phase: 'fetch' | 'parse' | 'finalize';
}

export interface AssetSpec {
  url: string;
  /** Optional name for lookup. */
  name?: string;
  /**
   * Apply transform at root group level.
   * This keeps internal hierarchy intact.
   */
  transform?: TransformLike;
}

export interface PipelineFile {
  assets: AssetSpec[];
}

export interface TransformLike {
  position?: [number, number, number];
  rotationEuler?: [number, number, number]; // radians
  scale?: [number, number, number];
}

export interface LoadOptions {
  /** Whether to add loaded content to viewer root automatically. */
  attachToRoot?: boolean;
  /** Per-request progress callback in addition to event bus emission. */
  onProgress?: (p: LoaderProgress) => void;
}

export interface OptimizerOptions {
  /** Whether to keep original meshes after generating instancing/merge results. */
  keepOriginals?: boolean;
  /** Defaults to true. */
  frustumCulling?: boolean;
}

export interface InstancingOptions {
  /**
   * Minimum count of identical meshes before instancing.
   * Defaults to 2.
   */
  minCount?: number;
  /** If true, create `instanceColor` attribute for per-instance highlighting. */
  enableInstanceColor?: boolean;
  /**
   * Custom grouping key. If omitted, we group by geometry.uuid + material.uuid.
   */
  getKey?: (mesh: THREE.Mesh) => string;
  /** Filter which meshes can be instanced. */
  filter?: (mesh: THREE.Mesh) => boolean;
  /** 排除自身或祖先 userData 匹配的对象，如 { type: 'pipe' } 不参与实例化 */
  excludeUserData?: Record<string, unknown>;
  /** 排除满足条件的 mesh（如 name 包含 ground），与 excludeUserData 二选一 */
  excludeFilter?: (obj: THREE.Object3D) => boolean;
}

export interface MergeOptions {
  /** Merge only these meshes (if provided). */
  filter?: (mesh: THREE.Mesh) => boolean;
  /** 排除自身或祖先 userData 匹配的对象，如 { type: 'pipe' } 不参与合并 */
  excludeUserData?: Record<string, unknown>;
  /** 排除满足条件的 mesh（如 name 包含 ground），与 excludeUserData 二选一 */
  excludeFilter?: (obj: THREE.Object3D) => boolean;
  /** Merge by material to preserve batching correctness. Defaults to true. */
  groupByMaterial?: boolean;
  /** If true, disposes geometries of merged sources. */
  disposeSources?: boolean;
}

/** 预设视角：前/后/上/下/左/右，以及左上/右上/左下/右下（斜 45°） */
export type ViewPreset =
  | 'front'
  | 'back'
  | 'top'
  | 'bottom'
  | 'left'
  | 'right'
  | 'topLeft'
  | 'topRight'
  | 'bottomLeft'
  | 'bottomRight';

export interface SetViewOptions {
  /** 观察目标点，默认使用当前 OrbitControls target */
  target?: [number, number, number];
  /** 相机到目标的距离，默认保持当前距离 */
  distance?: number;
  /** 是否动画过渡，默认 true */
  animate?: boolean;
  /** 动画时长（毫秒），默认 400 */
  durationMs?: number;
}

export interface FocusOptions {
  durationMs?: number;
  /** Extra padding factor around the bounding sphere radius. Defaults to 1.2. */
  padding?: number;
  /** 最小包围球半径（世界单位），用于 Sprite 等小物体避免镜头过近，默认 2 */
  minRadius?: number;
  /** If true, also moves OrbitControls target. */
  setOrbitTarget?: boolean;
  /**
   * 与 Orbit 右键平移同类：在 framing 完成后，沿相机视平面（right / up）平移「相机 + 观察点」，
   * 模型在画布上相对移动。单位为世界坐标长度，与当前相机尺度一致。
   */
  viewPlanePan?: { right?: number; up?: number };
}

export interface RoamPathPoint {
  position: [number, number, number];
  lookAt?: [number, number, number];
  /** 0..1 normalized time along the path. */
  t?: number;
}

export interface RoamOptions {
  durationMs: number;
  loop?: boolean;
}

export interface FoundMesh {
  object: THREE.Mesh;
  box: THREE.Box3;
  center: THREE.Vector3;
}

/** {@link Viewer.findMeshes} 的广义版本：`object` 可为 Group / Mesh 等任意 Object3D */
export interface FoundObject3D {
  object: THREE.Object3D;
  box: THREE.Box3;
  center: THREE.Vector3;
}

export type InfluenceZoneShape =
  | { kind: 'sphere'; center: [number, number, number]; radius: number }
  | { kind: 'box'; center: [number, number, number]; size: [number, number, number] };

export interface InfluenceZoneStyle {
  color?: number;
  opacity?: number;
  dashed?: boolean;
}

export interface HighlightStyle {
  color?: number;
  emissiveIntensity?: number;
  /** 呼吸灯效果：强度在 min~max 间缓慢变化，默认开启 */
  breathing?: boolean;
  /** 呼吸周期（秒），默认 2 */
  breathingSpeed?: number;
  /** 呼吸最低强度，默认 0.12 */
  breathingMin?: number;
  /** 呼吸最高强度，默认 0.35 */
  breathingMax?: number;
}

/** 预置 tip 类型，可扩展 */
export type TipType = 'camera' | 'sensor' | 'person' | 'temperature' | 'humidity' | 'custom';

export interface TipOptions {
  /** 类型，用于从纹理注册表取默认贴图 */
  type?: TipType;
  /** 自定义贴图 URL（优先于 type） */
  textureUrl?: string;
  /** 自定义贴图实例（最高优先级） */
  texture?: THREE.Texture;
  /** Sprite 尺寸：sizeAttenuation 为 true 时是世界单位，false 时是像素，默认 0.5 */
  size?: number;
  /** 是否随距离衰减尺寸（false 则固定像素大小，更易见且 hit 区域稳定），默认 true */
  sizeAttenuation?: boolean;
  /** 是否参与 raycast 点击/hover，默认 true */
  interact?: boolean;
  /** 自定义 userData，便于点击时识别设备 */
  userData?: Record<string, unknown>;
}

export interface TipTextureRegistry {
  [type: string]: string | THREE.Texture;
}

export interface WorldToScreenResult {
  x: number;
  y: number;
  visible: boolean;
}

/**
 * 按 userData 筛选对象的条件：
 * - 对象形式 { type: 'pipe' }：匹配 userData 中所有键值对完全一致
 * - 函数形式：(obj) => boolean：自定义谓词
 */
export type UserDataFilter =
  | Record<string, unknown>
  | ((obj: THREE.Object3D) => boolean);

export interface AddTipsForMeshesOptions extends Omit<TipOptions, 'texture' | 'userData'> {
  /** 贴图 URL，必填 */
  textureUrl: string;
  /** 对象上方偏移（世界单位），默认 0.5 */
  offset?: number;
  /** 仅对 userData.interact 为 true 的 mesh 添加（或其祖先有 interact） */
  interactableOnly?: boolean;
}

export interface AddTipsForMeshesResult {
  tipIds: string[];
  /** tipId -> 关联的 Object3D（用于 DOM 弹框 worldToScreen 定位） */
  targetMap: Map<string, THREE.Object3D>;
}

