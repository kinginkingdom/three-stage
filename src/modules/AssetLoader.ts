import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import type { AssetSpec, LoadOptions, LoaderProgress, PipelineFile, ViewerEvents } from '../types';
import type { StrictEventBus } from '../core/EventBus';
import { applyTransform, createRequestId } from '../core/utils';

export interface AssetLoaderConfig {
  enableDraco: boolean;
  dracoDecoderPath: string;
}

export class AssetLoader {
  private readonly gltfLoader: GLTFLoader;
  private readonly dracoLoader: DRACOLoader | null;
  private disposed = false;

  constructor(
    private readonly bus: StrictEventBus<ViewerEvents>,
    private readonly config: AssetLoaderConfig,
  ) {
    this.gltfLoader = new GLTFLoader();
    if (config.enableDraco) {
      const d = new DRACOLoader();
      d.setDecoderPath(config.dracoDecoderPath);
      this.gltfLoader.setDRACOLoader(d);
      this.dracoLoader = d;
    } else {
      this.dracoLoader = null;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.dracoLoader?.dispose();
  }

  async load(url: string, options: LoadOptions = {}): Promise<{ requestId: string; root: THREE.Group }> {
    return this.loadMany([{ url }], options);
  }

  async loadMany(
    assets: ReadonlyArray<AssetSpec>,
    options: LoadOptions = {},
  ): Promise<{ requestId: string; root: THREE.Group }> {
    this.assertNotDisposed();
    const requestId = createRequestId();
    this.bus.emit('load-start', { requestId });

    // 统一用 Group 作为“每次加载的根”，保持模型内部层级不被破坏
    const root = new THREE.Group();
    root.name = 'LoadedRoot';

    let completed = 0;
    const total = assets.length;

    const emitProgress = (p: Omit<LoaderProgress, 'requestId'>) => {
      const payload: LoaderProgress = { requestId, ...p };
      this.bus.emit('load-progress', payload);
      options.onProgress?.(payload);
    };

    for (const spec of assets) {
      emitProgress({ url: spec.url, loaded: completed, total, ratio: total === 0 ? 1 : completed / total, phase: 'fetch' });
      const group = await this.loadOneToGroup(spec, emitProgress);
      root.add(group);
      completed += 1;
      emitProgress({ url: spec.url, loaded: completed, total, ratio: total === 0 ? 1 : completed / total, phase: 'finalize' });
    }

    this.bus.emit('load-complete', { requestId, root });
    return { requestId, root };
  }

  async loadPipeline(
    pipeline: PipelineFile | string,
    options: LoadOptions = {},
  ): Promise<{ requestId: string; root: THREE.Group }> {
    this.assertNotDisposed();
    // Pipeline：用 JSON 描述资源列表 + 初始变换，由 Loader 动态拼装场景
    const data: PipelineFile =
      typeof pipeline === 'string' ? (JSON.parse(pipeline) as PipelineFile) : pipeline;
    return this.loadMany(data.assets, options);
  }

  private loadOneToGroup(
    spec: AssetSpec,
    emitProgress: (p: Omit<LoaderProgress, 'requestId'>) => void,
  ): Promise<THREE.Group> {
    return new Promise((resolve, reject) => {
      emitProgress({ url: spec.url, loaded: 0, total: 1, ratio: 0, phase: 'fetch' });
      this.gltfLoader.load(
        spec.url,
        (gltf: GLTF) => {
          emitProgress({ url: spec.url, loaded: 1, total: 1, ratio: 1, phase: 'parse' });
          const g = new THREE.Group();
          g.name = spec.name ?? this.inferName(spec.url);
          g.add(gltf.scene);
          // 只在外层 Group 应用 transform，避免动到 glTF 内部节点
          if (spec.transform) applyTransform(g, spec.transform);
          resolve(g);
        },
        (ev: ProgressEvent<EventTarget>) => {
          const loaded = typeof ev.loaded === 'number' ? ev.loaded : 0;
          const total = typeof ev.total === 'number' && ev.total > 0 ? ev.total : loaded;
          emitProgress({ url: spec.url, loaded, total, ratio: total === 0 ? 0 : loaded / total, phase: 'fetch' });
        },
        (err: unknown) => reject(err),
      );
    });
  }

  private inferName(url: string): string {
    const last = url.split('/').pop();
    return last ? last.replace(/\.(glb|gltf)$/i, '') : 'asset';
  }

  private assertNotDisposed(): void {
    if (this.disposed) throw new Error('AssetLoader is disposed');
  }
}

