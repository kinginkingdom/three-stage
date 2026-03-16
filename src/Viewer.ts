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
  RoamPathPoint,
  HighlightStyle,
  InfluenceZoneShape,
  InfluenceZoneStyle,
  InteractionData,
  Unsubscribe,
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

  constructor(private readonly config: ViewerConfig) {
    this.events = new StrictEventBus<ViewerEvents>();

    this.scene = new THREE.Scene();
    this.root = new THREE.Group();
    this.root.name = 'ViewerRoot';
    this.scene.add(this.root);

    const rect = config.canvas.getBoundingClientRect();
    this.camera = new THREE.PerspectiveCamera(50, rect.width / Math.max(1, rect.height), 0.1, 2000);
    this.camera.position.set(3, 2, 5);

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
    });

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
      if (options.attachToRoot ?? true) this.root.add(root);
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
      if (options.attachToRoot ?? true) this.root.add(root);
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
      if (options.attachToRoot ?? true) this.root.add(root);
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
  }

  optimizeMerge(opts: MergeOptions = {}): void {
    this.assertNotDisposed();
    this.optimizer.mergeStatic(this.root, opts);
  }

  setFrustumCulling(enabled: boolean): void {
    this.assertNotDisposed();
    this.optimizer.setFrustumCulling(this.root, enabled);
  }

  async focus(target: THREE.Object3D, opts: FocusOptions = {}): Promise<void> {
    this.assertNotDisposed();
    await this.navigator.focusOnObject(target, opts);
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

  setHighlightFromInteraction(hit: InteractionData | null, style: HighlightStyle = {}): void {
    this.assertNotDisposed();
    if (!hit?.intersectedObject) {
      this.visualizer.setHighlight(null);
      return;
    }
    // 高亮范围：优先用点击对象本身（若 interact=true），否则找最近的 interact 祖先
    let obj: THREE.Object3D = hit.intersectedObject;
    if ((obj.userData as { interact?: boolean })?.interact === true) {
      // 点击对象本身即 interact 层，无需再往上找
    } else {
      let cur: THREE.Object3D | null = obj.parent;
      while (cur) {
        if ((cur.userData as { interact?: boolean })?.interact === true) {
          obj = cur;
          break;
        }
        cur = cur.parent;
      }
      // 兼容：若未找到 interact，再尝试 highlightRoot
      if (obj === hit.intersectedObject) {
        cur = hit.intersectedObject;
        while (cur) {
          if ((cur.userData as { highlightRoot?: boolean })?.highlightRoot) {
            obj = cur;
            break;
          }
          cur = cur.parent;
        }
      }
    }
    this.visualizer.setHighlight({ object: obj, instanceId: hit.instanceId }, style);
  }

  setHighlightObject(obj: THREE.Object3D | null, style: HighlightStyle = {}): void {
    this.assertNotDisposed();
    if (!obj) this.visualizer.setHighlight(null);
    else this.visualizer.setHighlight({ object: obj, instanceId: undefined }, style);
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
    dir.position.set(5, 8, 6);
    dir.castShadow = true;
    dir.shadow.bias = -0.00005;
    const mapSize = lighting.shadowMapSize ?? 1024;
    dir.shadow.mapSize.set(mapSize, mapSize);
    dir.shadow.camera.near = 0.5;
    dir.shadow.camera.far = 80;
    dir.shadow.camera.left = -20;
    dir.shadow.camera.right = 20;
    dir.shadow.camera.top = 20;
    dir.shadow.camera.bottom = -20;
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
    // 默认：接收阴影即可；是否投射阴影一般由资产/业务决定（避免全场 cast 导致成本暴涨）
    this.root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.receiveShadow = enabled;
      if (!enabled) mesh.castShadow = false;
    });
    if (this.shadowCatcher) this.shadowCatcher.visible = enabled;
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

  private assertNotDisposed(): void {
    if (this.disposed) throw new Error('Viewer is disposed');
  }
}

