import * as THREE from 'three';
import type {
  AssetSpec,
  LoadOptions,
  PipelineFile,
  ViewerConfig,
  ViewerEvents,
  ViewerState,
  OptimizerOptions,
  InstancingOptions,
  MergeOptions,
  FocusOptions,
  RoamOptions,
  ViewPreset,
  SetViewOptions,
  RoamPathPoint,
  HighlightStyle,
  FoundMesh,
  FoundObject3D,
  InfluenceZoneShape,
  InfluenceZoneStyle,
  InteractionData,
  Unsubscribe,
  UserDataFilter,
  AddTipsForMeshesOptions,
  AddTipsForMeshesResult,
} from './types';
import { StrictEventBus } from './core/EventBus';
import { computeDpr, worldToScreen } from './core/utils';
import { AssetLoader } from './modules/AssetLoader';
import { TipManager } from './modules/TipManager';
import { PerformanceManager } from './modules/PerformanceManager';
import { InteractionManager } from './modules/InteractionManager';
import { CameraController } from './modules/CameraController';
import { EffectManager } from './modules/EffectManager';

export class Viewer {
  /** `root` 专门承载加载资产：便于统一 dispose/优化/拾取范围控制，避免污染用户自建节点 */
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;
  /** Root group for loaded models. */
  readonly root: THREE.Group;

  /** 内部事件总线：模块解耦（交互/加载/状态） */
  readonly events: StrictEventBus<ViewerEvents>;
  readonly loader: AssetLoader;
  readonly optimizer: PerformanceManager;
  readonly interactor: InteractionManager;
  readonly navigator: CameraController;
  readonly visualizer: EffectManager;
  readonly tips: TipManager;

  private state: ViewerState = 'init';
  private disposed = false;
  private raf = 0;
  private lastT = 0;
  private resizeObserver: ResizeObserver | null = null;
  private shadowsEnabled = false;
  private fpsEma = 60;
  private fpsLowSince = 0;
  private fpsHighSince = 0;
  private shadowCatcher: THREE.Mesh | null = null;
  private occlusionSnapshots = new Map<
    string,
    { original: THREE.Material; cloned: THREE.Material; opacity?: number; transparent?: boolean }
  >();

  constructor(private readonly config: ViewerConfig) {
    this.events = new StrictEventBus<ViewerEvents>();

    this.scene = new THREE.Scene();
    this.root = new THREE.Group();
    this.root.name = 'ViewerRoot';
    this.scene.add(this.root);

    const rect = config.canvas.getBoundingClientRect();
    this.camera = new THREE.PerspectiveCamera(50, rect.width / Math.max(1, rect.height), 0.1, 2000);
    const initCam = config.initialCamera;
    this.camera.position.set(
      initCam?.position?.[0] ?? 3,
      initCam?.position?.[1] ?? 2,
      initCam?.position?.[2] ?? 5,
    );
    const target = initCam?.target ?? [0, 0, 0];
    this.camera.lookAt(target[0], target[1], target[2]);

    this.renderer = new THREE.WebGLRenderer({
      canvas: config.canvas,
      context: config.context,
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
    });
    // 默认白底（也可通过 clearColor 覆盖）
    const clear = config.clearColor ?? 0xffffff;
    this.renderer.setClearColor(clear, 1);
    this.scene.background = new THREE.Color(clear);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    const dpr = computeDpr(config.dpr, window.devicePixelRatio);
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(Math.max(1, rect.width), Math.max(1, rect.height), false);

    this.loader = new AssetLoader(this.events, {
      enableDraco: config.enableDraco ?? false,
      dracoDecoderPath: config.dracoDecoderPath ?? '/draco/',
    });

    this.optimizer = new PerformanceManager(config.optimizer ?? ({ frustumCulling: true } satisfies OptimizerOptions));

    this.navigator = new CameraController({
      canvas: config.canvas,
      camera: this.camera,
      enableOrbitControls: config.enableOrbitControls ?? true,
      enableRoaming: config.enableRoaming ?? false,
      ...(config.orbitControls != null ? { orbitControls: config.orbitControls } : {}),
    });
    if (this.navigator.controls && initCam?.target) {
      this.navigator.controls.target.set(target[0], target[1], target[2]);
    }

    this.visualizer = new EffectManager();

    this.tips = new TipManager(this.config.tips);
    this.root.add(this.tips.getGroup());

    this.interactor = new InteractionManager(this.events, {
      canvas: config.canvas,
      camera: this.camera,
      root: this.root,
      raycast: config.raycast,
      enableDrag: config.enableDrag ?? false,
    });

    this.initDefaultLighting();
    this.attachResize();
    this.setState('idle');
    this.startLoop();
  }

  on<K extends keyof ViewerEvents>(event: K, handler: (payload: ViewerEvents[K]) => void): Unsubscribe {
    return this.events.on(event, handler);
  }

  getState(): ViewerState {
    return this.state;
  }

  enableBVHNow(): { patchedMeshes: number; builtGeometries: number } {
    this.assertNotDisposed();
    // BVH 是“用时间/内存换 raycast 性能”，适合高频拾取的大静态场景
    return this.optimizer.enableBVH(this.root, this.config.bvh ?? {});
  }

  /**
   * 调试用：打印所有 userData.interact === true 的对象及其可交互子 mesh
   * 用于排查“点不到”的原因（地板等未打标则不会出现在此列表）
   */
  debugPrintInteractables(): void {
    this.assertNotDisposed();
    const interactRoots: THREE.Object3D[] = [];
    const interactableMeshes: { obj: THREE.Object3D; path: string }[] = [];
    const nonInteractableMeshes: { obj: THREE.Object3D; path: string }[] = [];

    const getPath = (o: THREE.Object3D): string => {
      const parts: string[] = [];
      let cur: THREE.Object3D | null = o;
      while (cur && cur !== this.root) {
        parts.unshift(cur.name || cur.type || cur.uuid.slice(0, 8));
        cur = cur.parent;
      }
      return parts.join(' / ');
    };

    const hasInteractInAncestry = (o: THREE.Object3D): boolean => {
      let cur: THREE.Object3D | null = o;
      while (cur) {
        if ((cur.userData as { interact?: boolean })?.interact === true) return true;
        cur = cur.parent;
      }
      return false;
    };

    this.root.traverse((o) => {
      const ud = o.userData as { interact?: boolean } | undefined;
      if (ud?.interact === true) interactRoots.push(o);

      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) {
        const path = getPath(o);
        if (hasInteractInAncestry(o)) {
          interactableMeshes.push({ obj: o, path });
        } else {
          nonInteractableMeshes.push({ obj: o, path });
        }
      }
    });

    console.group('[three-stage] debugPrintInteractables');
    console.log('打标 interact=true 的根节点:', interactRoots.length);
    interactRoots.forEach((r, i) => {
      console.log(`  [${i}]`, r.name || r.type, r.uuid, getPath(r));
    });
    console.log('可交互的 Mesh（点击会命中）:', interactableMeshes.length);
    interactableMeshes.forEach((m, i) => {
      console.log(`  [${i}]`, m.obj.name || m.obj.type, m.path);
    });
    console.log('不可交互的 Mesh（点不到）:', nonInteractableMeshes.length);
    nonInteractableMeshes.forEach((m, i) => {
      console.log(`  [${i}]`, m.obj.name || m.obj.type, m.path);
    });
    console.groupEnd();
  }

  /**
   * 调试用：打印整个场景树（root 下所有节点）
   * @param maxDepth 最大层级深度，默认 10
   */
  debugPrintScene(maxDepth = 10): void {
    this.assertNotDisposed();
    const lines: string[] = [];

    const visit = (o: THREE.Object3D, depth: number) => {
      if (depth > maxDepth) return;
      const indent = '  '.repeat(depth);
      const name = (o as { name?: string }).name || '(unnamed)';
      const type = (o as { type?: string }).type || o.constructor.name;
      const interact = (o.userData as { interact?: boolean })?.interact;
      const extra = interact !== undefined ? ` [interact=${interact}]` : '';
      const meshInfo = (o as THREE.Mesh).isMesh ? ' [Mesh]' : '';
      lines.push(`${indent}${name} (${type})${meshInfo}${extra}`);
      o.children.forEach((c) => visit(c, depth + 1));
    };

    lines.push('ViewerRoot');
    this.root.children.forEach((c) => visit(c, 1));

    console.group('[three-stage] debugPrintScene');
    lines.forEach((l) => console.log(l));
    console.groupEnd();
  }

  async load(url: string, options: LoadOptions = {}): Promise<THREE.Group> {
    this.assertNotDisposed();
    this.setState('loading');
    try {
      const { root } = await this.loader.load(url, options);
      if (options.attachToRoot ?? true) {
        this.root.add(root);
        this.applyShadowToRoot();
      }
      if (this.config.enableBVH) {
        const auto = this.config.bvh?.autoBuild ?? true;
        // 只有挂到 this.root（拾取范围内）才自动建 BVH
        if (auto && (options.attachToRoot ?? true)) this.enableBVHNow();
      }
      this.setState('idle');
      return root;
    } catch (error) {
      const requestId = 'unknown';
      this.events.emit('load-error', { requestId, error });
      this.setState('idle');
      throw error;
    }
  }

  async loadMany(assets: ReadonlyArray<AssetSpec>, options: LoadOptions = {}): Promise<THREE.Group> {
    this.assertNotDisposed();
    this.setState('loading');
    try {
      const { root } = await this.loader.loadMany(assets, options);
      if (options.attachToRoot ?? true) {
        this.root.add(root);
        this.applyShadowToRoot();
      }
      if (this.config.enableBVH) {
        const auto = this.config.bvh?.autoBuild ?? true;
        if (auto && (options.attachToRoot ?? true)) this.enableBVHNow();
      }
      this.setState('idle');
      return root;
    } catch (error) {
      const requestId = 'unknown';
      this.events.emit('load-error', { requestId, error });
      this.setState('idle');
      throw error;
    }
  }

  async loadPipeline(pipeline: PipelineFile | string, options: LoadOptions = {}): Promise<THREE.Group> {
    this.assertNotDisposed();
    this.setState('loading');
    try {
      const { root } = await this.loader.loadPipeline(pipeline, options);
      if (options.attachToRoot ?? true) {
        this.root.add(root);
        this.applyShadowToRoot();
      }
      if (this.config.enableBVH) {
        const auto = this.config.bvh?.autoBuild ?? true;
        if (auto && (options.attachToRoot ?? true)) this.enableBVHNow();
      }
      this.setState('idle');
      return root;
    } catch (error) {
      const requestId = 'unknown';
      this.events.emit('load-error', { requestId, error });
      this.setState('idle');
      throw error;
    }
  }

  optimizeInstancing(opts: InstancingOptions = {}): void {
    this.assertNotDisposed();
    this.optimizer.createInstancing(this.root, opts);
    this.applyShadowToRoot();
  }

  optimizeMerge(opts: MergeOptions = {}): void {
    this.assertNotDisposed();
    this.optimizer.mergeStatic(this.root, opts);
    this.applyShadowToRoot();
  }

  setFrustumCulling(enabled: boolean): void {
    this.assertNotDisposed();
    this.optimizer.setFrustumCulling(this.root, enabled);
  }

  /**
   * TODO: 仅对真正挡住相机→目标视线的 mesh 做“X 光”式半透明处理。
   * 当前为实验实现：后续需要进一步调优（多材质、性能、与 BVH 更紧密配合）并补充 README 文档。
   * 仅在调用时做一次射线，适合点击聚焦时使用。
   */
  applyOcclusionDimming(target: THREE.Object3D, opts: { opacity?: number } = {}): void {
    this.assertNotDisposed();
    const dimOpacity = opts.opacity ?? 0.15;
    this.clearOcclusionDimming();

    const camPos = this.camera.position.clone();
    const targetPos = new THREE.Vector3();
    target.getWorldPosition(targetPos);
    const dir = targetPos.clone().sub(camPos).normalize();
    const distToTarget = camPos.distanceTo(targetPos);

    const raycaster = new THREE.Raycaster(camPos, dir);
    // 避免 Sprite raycast 报错，需要提供 camera
    (raycaster as any).camera = this.camera;
    const intersects = raycaster.intersectObject(this.root, true);

    const occluderMeshes = new Set<THREE.Mesh>();
    const eps = 1e-3;

    const targetSubtree = new Set<string>();
    target.traverse((o) => targetSubtree.add(o.uuid));

    for (const hit of intersects) {
      if (hit.distance >= distToTarget - eps) break;
      let obj: THREE.Object3D | null = hit.object;
      // 跳过 Sprite 等非 Mesh 对象
      if ((obj as any).isSprite) continue;
      while (obj && !(obj as THREE.Mesh).isMesh) {
        obj = obj.parent;
      }
      const mesh = obj as THREE.Mesh | null;
      if (!mesh || !mesh.isMesh) continue;
      if (targetSubtree.has(mesh.uuid)) continue;
      if (this.hasInteractInAncestry(mesh)) continue;
      if (Array.isArray(mesh.material)) continue;
      occluderMeshes.add(mesh);
    }

    for (const mesh of occluderMeshes) {
      const mat = mesh.material as THREE.Material & { opacity?: number; transparent?: boolean };
      if (this.occlusionSnapshots.has(mesh.uuid)) continue;
      const cloned = mat.clone();
      this.occlusionSnapshots.set(mesh.uuid, {
        original: mat,
        cloned,
        opacity: (cloned as any).opacity,
        transparent: (cloned as any).transparent,
      });
      mesh.material = cloned;

      const dimMat = cloned as THREE.Material & { opacity?: number; transparent?: boolean };
      dimMat.transparent = true;
      const base = dimMat.opacity ?? 1;
      dimMat.opacity = Math.min(base, dimOpacity);
      if ((dimMat as any).needsUpdate !== undefined) {
        (dimMat as any).needsUpdate = true;
      }
    }
  }

  /** 恢复通过 applyOcclusionDimming 设置的 X 光半透明效果。 */
  clearOcclusionDimming(): void {
    if (this.occlusionSnapshots.size === 0) return;
    for (const [uuid, snap] of this.occlusionSnapshots) {
      const obj = this.root.getObjectByProperty('uuid', uuid) as THREE.Mesh | null;
      if (!obj || !obj.isMesh) continue;
      if (obj.material === snap.cloned) {
        obj.material = snap.original;
      }
      (snap.cloned as any).dispose?.();
    }
    this.occlusionSnapshots.clear();
  }

  /**
   * 查找满足条件的 mesh 列表，可用于批量加 tip / 巡检 / 统计等。
   * （实现上等同于 {@link findObjects} + 仅 Mesh 分支；共享同一套遍历与筛选逻辑。）
   * @param filter userData 过滤条件对象或自定义函数
   * @param opts.interactableOnly 若为 true，仅返回祖先链上带 interact=true 的 mesh
   */
  findMeshes(
    filter: UserDataFilter | ((obj: THREE.Object3D) => boolean),
    opts: { interactableOnly?: boolean } = {},
  ): FoundMesh[] {
    this.assertNotDisposed();
    const rows = this.findMatchingDescendants(filter, {
      interactableOnly: opts.interactableOnly ?? false,
      onlyMesh: true,
      skipViewerRoot: false,
    });
    return rows.map((row) => ({ ...row, object: row.object as THREE.Mesh }));
  }

  /**
   * 与 {@link findMeshes} 相同筛选语义，但遍历 **所有** Object3D（如 Group、空节点等），不限于 Mesh。
   * 自定义 `filter` 里可写 `obj.isGroup`、`obj.type === 'Group'` 等缩小范围。
   * @param opts.skipViewerRoot 默认 true，不返回挂资源的根 Group（`ViewerRoot`）
   */
  findObjects(
    filter: UserDataFilter | ((obj: THREE.Object3D) => boolean),
    opts: { interactableOnly?: boolean; skipViewerRoot?: boolean } = {},
  ): FoundObject3D[] {
    this.assertNotDisposed();
    return this.findMatchingDescendants(filter, {
      interactableOnly: opts.interactableOnly ?? false,
      onlyMesh: false,
      skipViewerRoot: opts.skipViewerRoot ?? true,
    });
  }

  async focus(target: THREE.Object3D, opts: FocusOptions = {}): Promise<void> {
    this.assertNotDisposed();
    await this.navigator.focusOnObject(target, opts);
  }

  /**
   * 切换到预设视角（前/后/上/下/左/右/左上/右上/左下/右下）
   */
  setView(preset: ViewPreset, opts: SetViewOptions = {}): Promise<void> {
    this.assertNotDisposed();
    return this.navigator.setView(preset, opts);
  }

  startRoaming(points: ReadonlyArray<RoamPathPoint>, opts: RoamOptions): void {
    this.assertNotDisposed();
    this.setState('roaming');
    this.navigator.startRoaming(points, opts);
  }

  stopRoaming(): void {
    this.navigator.stopRoaming();
    if (!this.disposed) this.setState('idle');
  }

  /**
   * 点击 tip sprite 时解析为关联的 ground mesh，使交互行为与直接点击 ground 一致。
   */
  resolveInteractionTarget(hit: InteractionData | null): THREE.Object3D | null {
    const target = hit?.intersectedObject;
    if (!target) return null;
    const ud = target.userData as { tipId?: string; targetUuid?: string };
    if (!ud.tipId || !ud.targetUuid) return target;
    let found: THREE.Object3D | null = null;
    this.root.traverse((o) => {
      if (o.uuid === ud.targetUuid) found = o;
    });
    return found ?? target;
  }

  /**
   * 从对象自身向上查找可作为业务目标的节点：
   * 1) 优先最近的 `userData.interact === true`
   * 2) 若未命中且允许回退，则找最近的 `userData.highlightRoot === true`
   * 3) 都未命中时返回自身
   */
  findInteractionDataObject(
    obj: THREE.Object3D,
    opts: { fallbackToHighlightRoot?: boolean } = {},
  ): THREE.Object3D {
    const fallbackToHighlightRoot = opts.fallbackToHighlightRoot ?? true;

    let cur: THREE.Object3D | null = obj;
    while (cur) {
      if ((cur.userData as { interact?: boolean })?.interact === true) return cur;
      cur = cur.parent;
    }

    if (fallbackToHighlightRoot) {
      cur = obj;
      while (cur) {
        if ((cur.userData as { highlightRoot?: boolean })?.highlightRoot) return cur;
        cur = cur.parent;
      }
    }
    return obj;
  }

  /**
   * 面向交互 hit 的业务目标解析：
   * - 先解析 tip -> 关联对象
   * - 再向上收敛到 `interact=true`（可回退 highlightRoot）
   */
  resolveInteractionDataTarget(
    hit: InteractionData | null,
    opts: { fallbackToHighlightRoot?: boolean } = {},
  ): THREE.Object3D | null {
    const resolved = this.resolveInteractionTarget(hit);
    if (!resolved) return null;
    return this.findInteractionDataObject(resolved, opts);
  }

  /**
   * 交互驱动的高亮（如 hover、指针 hit）：`hit === null` 时只清除**交互层**，不会动状态层。
   * 若要从代码里对已知 `Object3D` 做与 hover 同层的「弱高亮」，请用 {@link setInteractionHighlightObject}。
   */
  setHighlightFromInteraction(hit: InteractionData | null, style: HighlightStyle = {}): void {
    this.assertNotDisposed();
    const obj = this.resolveInteractionDataTarget(hit, { fallbackToHighlightRoot: true });
    if (!obj) {
      this.visualizer.setHighlight(null, {}, 'interaction');
      return;
    }
    this.visualizer.setHighlight({ object: obj, instanceId: hit?.instanceId }, style, 'interaction');
  }

  /**
   * **弱高亮（交互层）**：由代码指定对象，与 `setHighlightFromInteraction` 同属一层，可与状态层强高亮并存；
   * 典型用途：巡检 focus、键盘焦点、`Object3D` 引用驱动的临时提示（不等同于业务报警）。
   * 会先做与交互射线一致的 `highlightRoot` / `interact` 上卷解析。
   */
  setInteractionHighlightObject(obj: THREE.Object3D | null, style: HighlightStyle = {}): void {
    this.assertNotDisposed();
    if (!obj) {
      this.visualizer.setHighlight(null, {}, 'interaction');
      return;
    }
    const target = this.findInteractionDataObject(obj, { fallbackToHighlightRoot: true });
    this.visualizer.setHighlight({ object: target, instanceId: undefined }, style, 'interaction');
  }

  /**
   * **强高亮（状态层）**：业务状态如报警闪烁、侧栏选中设备等，应明显区分于交互弱高亮。
   * 传入 `null` 仅清除状态层，不影响交互层（hover / 巡检 focus 等）。
   */
  setHighlightObject(obj: THREE.Object3D | null, style: HighlightStyle = {}): void {
    this.assertNotDisposed();
    if (!obj) this.visualizer.setHighlight(null, {}, 'state');
    else this.visualizer.setHighlight({ object: obj, instanceId: undefined }, style, 'state');
  }

  /** 只清除 hover 等交互高亮。 */
  clearInteractionHighlight(): void {
    this.assertNotDisposed();
    this.visualizer.clearHighlightLayer('interaction');
  }

  /** 只清除 `setHighlightObject` 设置的状态高亮。 */
  clearStateHighlight(): void {
    this.assertNotDisposed();
    this.visualizer.clearHighlightLayer('state');
  }

  /** 清除全部两层高亮。 */
  clearAllHighlights(): void {
    this.assertNotDisposed();
    this.visualizer.clearHighlightLayer('all');
  }

  upsertInfluenceZone(id: string, shape: InfluenceZoneShape, style: InfluenceZoneStyle = {}): THREE.Object3D {
    this.assertNotDisposed();
    const zone = this.visualizer.upsertInfluenceZone(id, shape, style);
    this.scene.add(zone);
    return zone;
  }

  removeInfluenceZone(id: string): void {
    const zone = this.visualizer.getInfluenceZone(id);
    if (zone) this.scene.remove(zone);
    this.visualizer.removeInfluenceZone(id);
  }

  /**
   * 将 3D 对象/位置投影到画布像素坐标，供 DOM 弹框定位。
   * @param target 目标 Object3D 或 Vector3
   * @returns { x, y, visible } 画布内像素坐标
   */
  worldToScreen(target: THREE.Object3D | THREE.Vector3): { x: number; y: number; visible: boolean } {
    this.assertNotDisposed();
    return worldToScreen(this.camera, this.config.canvas, target);
  }

  /**
   * 为匹配 userData 的可交互 mesh 在其上方添加 tip sprite。
   * @param filter 筛选条件，如 (o) => String((o.userData as any).name || '').includes('ground')
   * @param opts 贴图、尺寸、是否可点击等
   */
  addTipsForMeshes(
    filter: UserDataFilter | ((obj: THREE.Object3D) => boolean),
    opts: AddTipsForMeshesOptions,
  ): AddTipsForMeshesResult {
    this.assertNotDisposed();
    const found = this.findMeshes(filter, { interactableOnly: opts.interactableOnly ?? false });
    const tipIds: string[] = [];
    const targetMap = new Map<string, THREE.Object3D>();
    const offset = opts.offset ?? 0.5;
    let idx = 0;

    for (const item of found) {
      const mesh = item.object;
      const box = item.box;
      const center = item.center;
      const pos: [number, number, number] = [center.x, box.max.y + offset, center.z];

      const id = `tip-mesh-${idx++}`;
      const mergedUserData: Record<string, unknown> = { targetUuid: mesh.uuid };
      let cur: THREE.Object3D | null = mesh;
      while (cur) {
        Object.assign(mergedUserData, cur.userData);
        cur = cur.parent;
      }
      const tipOpts: Parameters<typeof this.tips.addTipSync>[2] = {
        textureUrl: opts.textureUrl,
        size: opts.size ?? (opts.sizeAttenuation === false ? 48 : 0.4),
        interact: opts.interact ?? true,
        userData: mergedUserData,
      };
      if (opts.sizeAttenuation !== undefined) tipOpts.sizeAttenuation = opts.sizeAttenuation;
      this.tips.addTipSync(id, pos, tipOpts);
      tipIds.push(id);
      targetMap.set(id, mesh);
    }

    return { tipIds, targetMap };
  }

  /**
   * 按 userData 条件批量设置对象显隐。
   * @param filter 筛选条件：{ type: 'pipe' } 或 (obj) => userData.type === 'pipe'
   * @param visible 是否显示
   * @returns 被设置的对象数量
   */
  setVisibilityByUserData(filter: UserDataFilter, visible: boolean): number {
    this.assertNotDisposed();
    const match = typeof filter === 'function'
      ? filter
      : (obj: THREE.Object3D) => {
          const ud = obj.userData as Record<string, unknown>;
          for (const k of Object.keys(filter)) {
            if (ud[k] !== (filter as Record<string, unknown>)[k]) return false;
          }
          return Object.keys(filter).length > 0;
        };
    let count = 0;
    this.root.traverse((o) => {
      if (match(o)) {
        o.visible = visible;
        count += 1;
      }
    });
    return count;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.setState('disposed');

    cancelAnimationFrame(this.raf);
    this.resizeObserver?.disconnect();

    this.interactor.dispose();
    this.navigator.dispose();
    this.visualizer.dispose();
    this.tips.dispose();
    this.optimizer.dispose();
    this.loader.dispose();
    this.events.clear();

    // 释放 Viewer 负责创建/持有的 GPU 资源
    this.disposeObject(this.root);
    this.renderer.dispose();
  }

  private startLoop(): void {
    this.lastT = performance.now();
    const tick = (t: number) => {
      if (this.disposed) return;
      const dt = Math.max(0, (t - this.lastT) / 1000);
      this.lastT = t;

      this.events.emit('frame', { dt, t });

      // 简单自适应：低帧持续则关阴影，高帧持续则开阴影（仅在 shadows=auto 时生效）
      this.updateShadowAuto(t, dt);

      this.navigator.update(dt);
      this.visualizer.update(dt);
      this.renderer.render(this.scene, this.camera);
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  private attachResize(): void {
    const canvas = this.config.canvas;
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
    this.resize();
  }

  resize(): void {
    const rect = this.config.canvas.getBoundingClientRect();
    const w = Math.max(1, rect.width);
    const h = Math.max(1, rect.height);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();

    const dpr = computeDpr(this.config.dpr, window.devicePixelRatio);
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, false);
  }

  private initDefaultLighting(): void {
    const lighting = this.config.lighting ?? {};
    const hemiIntensity = lighting.hemiIntensity ?? 1.0;
    const dirIntensity = lighting.dirIntensity ?? 1.6;

    const hemi = new THREE.HemisphereLight(0xffffff, 0xffffff, hemiIntensity);
    this.scene.add(hemi);
    const dir = new THREE.DirectionalLight(0xffffff, dirIntensity);
    dir.position.set(18, 18, 6);
    dir.castShadow = true;
    dir.shadow.bias = -0.00005;
    dir.shadow.normalBias = lighting.shadowNormalBias ?? 0.02;
    const mapSize = lighting.shadowMapSize ?? 1024;
    dir.shadow.mapSize.set(mapSize, mapSize);
    const shadowSize = lighting.shadowCameraSize ?? 80;
    const shadowFar = lighting.shadowCameraFar ?? 300;
    dir.shadow.camera.near = 0.5;
    dir.shadow.camera.far = shadowFar;
    dir.shadow.camera.left = -shadowSize;
    dir.shadow.camera.right = shadowSize;
    dir.shadow.camera.top = shadowSize;
    dir.shadow.camera.bottom = -shadowSize;
    this.scene.add(dir);

    // 额外方向光（可从右/后/顶等多方向补光）
    const extras = lighting.extraDirections ?? [];
    for (const extra of extras) {
      const extraDir = new THREE.DirectionalLight(extra.color ?? 0xffffff, extra.intensity ?? dirIntensity * 0.6);
      extraDir.position.set(extra.position[0], extra.position[1], extra.position[2]);
      this.scene.add(extraDir);
    }

    const shadowsCfg = lighting.shadows ?? 'auto';
    const defaultEnable = shadowsCfg === true || (shadowsCfg === 'auto' && this.shouldEnableShadowsByHardware());
    this.setShadowsEnabled(defaultEnable);

    const needCatcher = lighting.shadowCatcher ?? true;
    if (needCatcher) {
      const opacity = lighting.shadowCatcherOpacity ?? 0.18;
      const catcherGeo = new THREE.PlaneGeometry(200, 200);
      const catcherMat = new THREE.ShadowMaterial({ opacity });
      const catcher = new THREE.Mesh(catcherGeo, catcherMat);
      catcher.name = 'ShadowCatcher';
      catcher.rotation.x = -Math.PI / 2;
      catcher.position.y = 0;
      catcher.receiveShadow = true;
      catcher.visible = this.shadowsEnabled;
      this.shadowCatcher = catcher;
      this.scene.add(catcher);
    }
  }

  private setShadowsEnabled(enabled: boolean): void {
    this.shadowsEnabled = enabled;
    this.renderer.shadowMap.enabled = enabled;
    if (enabled) this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.applyShadowToRoot();
    if (this.shadowCatcher) this.shadowCatcher.visible = enabled;
  }

  /** 对 root 下所有 mesh 应用阴影设置，load/optimize 后需调用以覆盖新加入的 mesh */
  private applyShadowToRoot(): void {
    this.root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.receiveShadow = this.shadowsEnabled;
      mesh.castShadow = this.shadowsEnabled; // 模型投射阴影到地面
    });
  }

  private shouldEnableShadowsByHardware(): boolean {
    const nav = navigator as unknown as { deviceMemory?: number; hardwareConcurrency?: number };
    const mem = nav.deviceMemory ?? 4;
    const cores = nav.hardwareConcurrency ?? 4;
    return mem >= 4 && cores >= 4;
  }

  private updateShadowAuto(nowMs: number, dtSeconds: number): void {
    const mode = this.config.lighting?.shadows ?? 'auto';
    if (mode !== 'auto') return;

    const fps = dtSeconds > 0 ? 1 / dtSeconds : 60;
    const alpha = 0.08; // EMA 平滑
    this.fpsEma = this.fpsEma * (1 - alpha) + fps * alpha;

    const low = this.fpsEma < 35;
    const high = this.fpsEma > 55;

    if (low) {
      if (this.fpsLowSince === 0) this.fpsLowSince = nowMs;
      this.fpsHighSince = 0;
      if (this.shadowsEnabled && nowMs - this.fpsLowSince > 2000) this.setShadowsEnabled(false);
    } else if (high) {
      if (this.fpsHighSince === 0) this.fpsHighSince = nowMs;
      this.fpsLowSince = 0;
      if (!this.shadowsEnabled && nowMs - this.fpsHighSince > 3000) this.setShadowsEnabled(true);
    } else {
      this.fpsLowSince = 0;
      this.fpsHighSince = 0;
    }
  }

  private disposeObject(obj: THREE.Object3D): void {
    obj.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.geometry?.dispose();
        if (Array.isArray(mesh.material)) {
          for (const m of mesh.material) m.dispose();
        } else {
          mesh.material?.dispose();
        }
      }
    });
  }

  private setState(next: ViewerState): void {
    const prev = this.state;
    this.state = next;
    if (prev !== next) this.events.emit('state-change', { prev, next });
  }

  private normalizeFindFilter(
    filter: UserDataFilter | ((obj: THREE.Object3D) => boolean),
  ): (obj: THREE.Object3D) => boolean {
    if (typeof filter === 'function') return filter;
    return (obj: THREE.Object3D) => {
      const ud = obj.userData as Record<string, unknown>;
      const f = filter as Record<string, unknown>;
      for (const k of Object.keys(f)) {
        if (ud[k] !== f[k]) return false;
      }
      return Object.keys(f).length > 0;
    };
  }

  /** findMeshes / findObjects 共用：一次 traverse，`onlyMesh` 与 skipViewerRoot 做分支 */
  private findMatchingDescendants(
    filter: UserDataFilter | ((obj: THREE.Object3D) => boolean),
    opts: { interactableOnly: boolean; onlyMesh: boolean; skipViewerRoot: boolean },
  ): FoundObject3D[] {
    const match = this.normalizeFindFilter(filter);
    const { interactableOnly, onlyMesh, skipViewerRoot } = opts;
    const results: FoundObject3D[] = [];

    this.root.traverse((o) => {
      if (skipViewerRoot && o === this.root) return;
      if (onlyMesh && !(o as THREE.Mesh).isMesh) return;
      if (interactableOnly && !this.hasInteractInAncestry(o)) return;
      if (!match(o)) return;

      const box = new THREE.Box3().setFromObject(o);
      const center = new THREE.Vector3();
      box.getCenter(center);
      results.push({ object: o, box, center });
    });

    return results;
  }

  private hasInteractInAncestry(o: THREE.Object3D): boolean {
    let cur: THREE.Object3D | null = o;
    while (cur) {
      if ((cur.userData as { interact?: boolean })?.interact === true) return true;
      cur = cur.parent;
    }
    return false;
  }

  private assertNotDisposed(): void {
    if (this.disposed) throw new Error('Viewer is disposed');
  }
}

