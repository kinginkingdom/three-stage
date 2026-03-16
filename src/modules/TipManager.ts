import * as THREE from 'three';
import type { TipOptions, TipTextureRegistry, TipType } from '../types';

const DEFAULT_SIZE = 0.5;

export interface TipManagerConfig {
  /** 类型 → 贴图 URL 或 Texture 的映射，用于 addTip 时按 type 取贴图 */
  textureRegistry?: TipTextureRegistry;
  /** 默认 Sprite 尺寸（世界单位） */
  defaultSize?: number;
}

export class TipManager {
  private readonly group = new THREE.Group();
  private readonly tips = new Map<string, THREE.Sprite>();
  private readonly textureCache = new Map<string, THREE.Texture>();
  private readonly textureLoader = new THREE.TextureLoader();
  private disposed = false;

  constructor(private readonly config: TipManagerConfig = {}) {
    this.group.name = 'TipManager';
  }

  /** 供 Viewer 挂到 root 下，tips 参与 raycast */
  getGroup(): THREE.Group {
    return this.group;
  }

  /**
   * 在指定 3D 位置创建 Sprite tip
   * @param id 唯一标识，用于 remove/update
   * @param position 世界坐标 [x, y, z]
   * @param opts 类型、贴图、尺寸等
   */
  async addTip(
    id: string,
    position: [number, number, number],
    opts: TipOptions = {},
  ): Promise<THREE.Sprite> {
    this.assertNotDisposed();
    this.removeTip(id);

    const texture = await this.resolveTexture(opts);
    const size = opts.size ?? this.config.defaultSize ?? DEFAULT_SIZE;

    const material = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthTest: true,
      depthWrite: false,
    });
    const sprite = new THREE.Sprite(material);
    sprite.position.set(position[0], position[1], position[2]);
    sprite.scale.set(size, size, 1);
    sprite.name = `tip:${id}`;
    sprite.userData = { tipId: id, ...opts.userData };
    sprite.userData.interact = true;

    this.group.add(sprite);
    this.tips.set(id, sprite);
    return sprite;
  }

  /** 同步添加（若贴图已缓存）。贴图未加载完时先占位，加载后更新 */
  addTipSync(id: string, position: [number, number, number], opts: TipOptions = {}): THREE.Sprite {
    this.assertNotDisposed();
    this.removeTip(id);

    const size = opts.size ?? this.config.defaultSize ?? DEFAULT_SIZE;
    const placeholder = this.createPlaceholderTexture();
    const material = new THREE.SpriteMaterial({
      map: placeholder,
      transparent: true,
      depthTest: true,
      depthWrite: false,
    });
    const sprite = new THREE.Sprite(material);
    sprite.position.set(position[0], position[1], position[2]);
    sprite.scale.set(size, size, 1);
    sprite.name = `tip:${id}`;
    sprite.userData = { tipId: id, ...opts.userData };
    (sprite.userData as Record<string, unknown>).interact = true;

    this.group.add(sprite);
    this.tips.set(id, sprite);

    this.resolveTexture(opts).then((tex) => {
      if (this.disposed || !this.tips.has(id)) return;
      const s = this.tips.get(id);
      if (s) {
        const mat = s.material as THREE.SpriteMaterial;
        const old = mat.map;
        mat.map = tex;
        mat.needsUpdate = true;
        if (old && old !== tex) old.dispose();
      }
    });

    return sprite;
  }

  removeTip(id: string): void {
    const sprite = this.tips.get(id);
    if (!sprite) return;
    this.group.remove(sprite);
    (sprite.material as THREE.SpriteMaterial).map?.dispose();
    sprite.material.dispose();
    this.tips.delete(id);
  }

  updateTip(id: string, position?: [number, number, number], opts?: Partial<TipOptions>): void {
    const sprite = this.tips.get(id);
    if (!sprite) return;
    if (position) sprite.position.set(position[0], position[1], position[2]);
    if (opts?.size) sprite.scale.setScalar(opts.size);
    if (opts?.userData) Object.assign(sprite.userData, opts.userData);
  }

  getTip(id: string): THREE.Sprite | undefined {
    return this.tips.get(id);
  }

  getAllTips(): ReadonlyMap<string, THREE.Sprite> {
    return this.tips;
  }

  /** 注册类型贴图，供 addTip({ type: 'camera' }) 等使用 */
  registerTexture(type: TipType | string, urlOrTexture: string | THREE.Texture): void {
    if (typeof urlOrTexture === 'string') {
      this.textureCache.delete(type);
      (this.config.textureRegistry ??= {})[type] = urlOrTexture;
    } else {
      (this.config.textureRegistry ??= {})[type] = urlOrTexture;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const [, sprite] of this.tips) {
      this.group.remove(sprite);
      (sprite.material as THREE.SpriteMaterial).map?.dispose();
      sprite.material.dispose();
    }
    this.tips.clear();
    for (const tex of this.textureCache.values()) tex.dispose();
    this.textureCache.clear();
  }

  private async resolveTexture(opts: TipOptions): Promise<THREE.Texture> {
    if (opts.texture) return opts.texture;
    if (opts.textureUrl) return this.loadTexture(opts.textureUrl);

    const type = opts.type ?? 'custom';
    const reg = this.config.textureRegistry ?? {};
    const entry = reg[type];
    if (typeof entry === 'string') return this.loadTexture(entry);
    if (entry instanceof THREE.Texture) return entry;

    return this.createPlaceholderTexture();
  }

  private loadTexture(url: string): Promise<THREE.Texture> {
    const cached = this.textureCache.get(url);
    if (cached) return Promise.resolve(cached);

    return new Promise((resolve, reject) => {
      this.textureLoader.load(
        url,
        (tex) => {
          tex.colorSpace = THREE.SRGBColorSpace;
          this.textureCache.set(url, tex);
          resolve(tex);
        },
        undefined,
        reject,
      );
    });
  }

  private createPlaceholderTexture(): THREE.Texture {
    const canvas = document.createElement('canvas');
    canvas.width = 32;
    canvas.height = 32;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.fillStyle = '#888';
      ctx.fillRect(0, 0, 32, 32);
      ctx.strokeStyle = '#fff';
      ctx.strokeRect(4, 4, 24, 24);
    }
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  private assertNotDisposed(): void {
    if (this.disposed) throw new Error('TipManager is disposed');
  }
}
