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
  enableRoaming?: boolean;
  enableDrag?: boolean;
  /** Enable BVH acceleration for raycasting (three-mesh-bvh). */
  enableBVH?: boolean;
  bvh?: BVHOptions;

  raycast?: RaycastOptions;
  optimizer?: OptimizerOptions;
  /** Tip 图标管理配置（Sprite 贴图注册表等） */
  tips?: { textureRegistry?: TipTextureRegistry; defaultSize?: number };
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
}

export interface MergeOptions {
  /** Merge only these meshes (if provided). */
  filter?: (mesh: THREE.Mesh) => boolean;
  /** Merge by material to preserve batching correctness. Defaults to true. */
  groupByMaterial?: boolean;
  /** If true, disposes geometries of merged sources. */
  disposeSources?: boolean;
}

export interface FocusOptions {
  durationMs?: number;
  /** Extra padding factor around the bounding sphere radius. Defaults to 1.2. */
  padding?: number;
  /** If true, also moves OrbitControls target. */
  setOrbitTarget?: boolean;
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
  /** Sprite 尺寸（世界单位，默认 0.5） */
  size?: number;
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

