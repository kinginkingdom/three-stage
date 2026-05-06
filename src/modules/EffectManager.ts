import * as THREE from 'three';
import type { HighlightLayer, HighlightStyle, InfluenceZoneShape, InfluenceZoneStyle } from '../types';

export interface HighlightTarget {
  object: THREE.Object3D;
  /** Only meaningful when `object` is an InstancedMesh. */
  instanceId: number | undefined;
}

type MaterialSnapshot = {
  originalMaterial?: THREE.Material;
  clonedMaterial?: THREE.Material;
  emissive?: THREE.Color;
  emissiveIntensity?: number;
  color?: THREE.Color;
};

type LayerRuntime = {
  highlighted: HighlightTarget | null;
  breathingOpts: { min: number; max: number; speed: number } | null;
  breathingTime: number;
  highlightColor: THREE.Color;
};

const LAYERS: HighlightLayer[] = ['interaction', 'state'];

export class EffectManager {
  private disposed = false;

  private readonly layerRuntime: Record<HighlightLayer, LayerRuntime> = {
    interaction: {
      highlighted: null,
      breathingOpts: null,
      breathingTime: 0,
      highlightColor: new THREE.Color(),
    },
    state: {
      highlighted: null,
      breathingOpts: null,
      breathingTime: 0,
      highlightColor: new THREE.Color(),
    },
  };

  private materialSnapshots = new Map<string, MaterialSnapshot>();
  private instancedSnapshots = new Map<string, Float32Array>();

  private zones = new Map<string, THREE.Object3D>();

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearHighlightLayer('all');
    for (const [, o] of this.zones) {
      this.disposeObject(o);
    }
    this.zones.clear();
  }

  setHighlight(
    target: HighlightTarget | null,
    style: HighlightStyle = {},
    layer: HighlightLayer = 'interaction',
  ): void {
    this.assertNotDisposed();
    if (!target) {
      this.clearHighlightLayer(layer);
      return;
    }

    if (layer === 'interaction' && this.shouldSkipInteractionFor(target)) {
      this.clearHighlightLayer('interaction');
      return;
    }

    if (this.layerRuntime[layer].highlighted) this.clearHighlightLayer(layer);

    const color = new THREE.Color(style.color ?? 0x4fc3f7);
    const breathing = style.breathing ?? true;
    const emissiveIntensity = style.emissiveIntensity ?? (breathing ? style.breathingMax ?? 0.35 : 0.3);

    const runtime = this.layerRuntime[layer];

    if (breathing) {
      runtime.breathingOpts = {
        min: style.breathingMin ?? 0.1,
        max: style.breathingMax ?? 0.24,
        speed: style.breathingSpeed ?? 0.5,
      };
      runtime.breathingTime = 0;
      runtime.highlightColor.copy(color);
    } else {
      runtime.breathingOpts = null;
    }

    const inst = target.object as unknown as THREE.InstancedMesh;
    if (inst && inst.isInstancedMesh && typeof target.instanceId === 'number') {
      if (!inst.instanceColor) {
        this.highlightWholeObject(target.object, color, emissiveIntensity, layer);
      } else {
        const uuid = inst.uuid;
        const attr = inst.instanceColor;
        const prev = new Float32Array(attr.array as ArrayLike<number>);
        this.instancedSnapshots.set(snapshotKey(layer, uuid), prev);
        attr.setXYZ(target.instanceId, color.r, color.g, color.b);
        attr.needsUpdate = true;
      }
      runtime.highlighted = target;
      return;
    }

    this.highlightWholeObject(target.object, color, emissiveIntensity, layer);
    runtime.highlighted = target;
  }

  /** 清除一层高亮，或 `'all'` 清除全部。 */
  clearHighlightLayer(layer: HighlightLayer | 'all'): void {
    if (layer === 'all') {
      for (const id of LAYERS) this.clearOneLayer(id);
      return;
    }
    this.clearOneLayer(layer);
  }

  /** 每帧调用，用于呼吸灯动画 */
  update(dtSeconds: number): void {
    for (const layer of LAYERS) {
      const runtime = this.layerRuntime[layer];
      if (!runtime.breathingOpts || !runtime.highlighted) continue;
      runtime.breathingTime += dtSeconds;
      const { min, max, speed } = runtime.breathingOpts;
      const t = 0.5 + 0.5 * Math.sin(runtime.breathingTime * Math.PI * 2 * speed);
      const intensity = min + (max - min) * t;
      this.applyEmissiveToHighlighted(runtime.highlighted, runtime.highlightColor, intensity);
    }
  }

  private applyEmissiveToHighlighted(
    target: HighlightTarget,
    color: THREE.Color,
    intensity: number,
  ): void {
    const obj = target.object;
    const inst = obj as unknown as THREE.InstancedMesh;
    if (inst?.isInstancedMesh && typeof target.instanceId === 'number' && inst.instanceColor) {
      inst.instanceColor.setXYZ(target.instanceId, color.r, color.g, color.b);
      inst.instanceColor.needsUpdate = true;
      return;
    }
    obj.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || Array.isArray(mesh.material)) return;
      const mat = mesh.material as THREE.MeshStandardMaterial;
      if ((mat as unknown as { emissive?: THREE.Color }).emissive) {
        mat.emissive.copy(color);
        mat.emissiveIntensity = intensity;
        mat.needsUpdate = true;
      }
    });
  }

  private clearOneLayer(layer: HighlightLayer): void {
    const runtime = this.layerRuntime[layer];
    if (!runtime.highlighted) return;
    const obj = runtime.highlighted.object;
    const inst = obj as unknown as THREE.InstancedMesh;
    if (inst && inst.isInstancedMesh) {
      const snap = this.instancedSnapshots.get(snapshotKey(layer, inst.uuid));
      if (snap && inst.instanceColor) {
        inst.instanceColor.array.set(snap);
        inst.instanceColor.needsUpdate = true;
      }
      this.instancedSnapshots.delete(snapshotKey(layer, inst.uuid));
    } else {
      obj.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        if (Array.isArray(mesh.material)) return;
        const snap = this.materialSnapshots.get(snapshotKey(layer, mesh.uuid));
        if (!snap) return;
        if (snap.originalMaterial) {
          if (snap.clonedMaterial) snap.clonedMaterial.dispose();
          mesh.material = snap.originalMaterial;
        }
        const mat = mesh.material as THREE.MeshStandardMaterial;
        if (snap.emissive) mat.emissive.copy(snap.emissive);
        if (typeof snap.emissiveIntensity === 'number') mat.emissiveIntensity = snap.emissiveIntensity;
        if (snap.color && (mat as unknown as { color?: THREE.Color }).color) mat.color.copy(snap.color);
        this.materialSnapshots.delete(snapshotKey(layer, mesh.uuid));
      });
    }
    runtime.highlighted = null;
    runtime.breathingOpts = null;
  }

  private shouldSkipInteractionFor(target: HighlightTarget): boolean {
    const state = this.layerRuntime.state.highlighted;
    if (!state) return false;

    if (this.highlightTargetsOverlap(target.object, state.object)) return true;

    const st = state.object as unknown as THREE.InstancedMesh;
    if (st?.isInstancedMesh && st === target.object) return true;

    return false;
  }

  /** 状态高亮对象与交互目标在场景树上是否视为同一套高亮（避免 hover 盖住报警母节点等）。 */
  private highlightTargetsOverlap(a: THREE.Object3D, b: THREE.Object3D): boolean {
    if (a === b) return true;
    return this.isDescendantOf(a, b) || this.isDescendantOf(b, a);
  }

  private isDescendantOf(child: THREE.Object3D, ancestor: THREE.Object3D): boolean {
    let cur: THREE.Object3D | null = child;
    while (cur) {
      if (cur === ancestor) return true;
      cur = cur.parent;
    }
    return false;
  }

  upsertInfluenceZone(id: string, shape: InfluenceZoneShape, style: InfluenceZoneStyle = {}): THREE.Object3D {
    this.assertNotDisposed();
    const existing = this.zones.get(id);
    if (existing) {
      this.disposeObject(existing);
      this.zones.delete(id);
    }

    const color = style.color ?? 0x33aaff;
    const opacity = style.opacity ?? 0.18;

    const group = new THREE.Group();
    group.name = `influenceZone:${id}`;

    if (shape.kind === 'sphere') {
      const geo = new THREE.SphereGeometry(shape.radius, 24, 16);
      const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(shape.center[0], shape.center[1], shape.center[2]);
      group.add(mesh);

      const wire = new THREE.LineSegments(
        new THREE.EdgesGeometry(geo, 18),
        new THREE.LineBasicMaterial({ color, transparent: true, opacity: Math.min(1, opacity + 0.25) }),
      );
      wire.position.copy(mesh.position);
      group.add(wire);
    } else {
      const geo = new THREE.BoxGeometry(shape.size[0], shape.size[1], shape.size[2]);
      const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(shape.center[0], shape.center[1], shape.center[2]);
      group.add(mesh);

      const wire = new THREE.LineSegments(
        new THREE.EdgesGeometry(geo, 30),
        new THREE.LineBasicMaterial({ color, transparent: true, opacity: Math.min(1, opacity + 0.25) }),
      );
      wire.position.copy(mesh.position);
      group.add(wire);
    }

    this.zones.set(id, group);
    return group;
  }

  removeInfluenceZone(id: string): void {
    const z = this.zones.get(id);
    if (!z) return;
    this.disposeObject(z);
    this.zones.delete(id);
  }

  getInfluenceZone(id: string): THREE.Object3D | undefined {
    return this.zones.get(id);
  }

  private highlightWholeObject(
    obj: THREE.Object3D,
    color: THREE.Color,
    emissiveIntensity: number,
    layer: HighlightLayer,
  ): void {
    obj.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      if (Array.isArray(mesh.material)) return;

      const key = snapshotKey(layer, mesh.uuid);
      if (!this.materialSnapshots.has(key)) {
        const snap: MaterialSnapshot = {};
        const original = mesh.material as THREE.Material;
        const cloned = original.clone();
        mesh.material = cloned;
        snap.originalMaterial = original;
        snap.clonedMaterial = cloned;

        const matNow = mesh.material as THREE.MeshStandardMaterial;
        if ((matNow as unknown as { emissive?: THREE.Color }).emissive) snap.emissive = matNow.emissive.clone();
        if (typeof (matNow as unknown as { emissiveIntensity?: number }).emissiveIntensity === 'number') {
          snap.emissiveIntensity = matNow.emissiveIntensity;
        }
        if ((matNow as unknown as { color?: THREE.Color }).color) snap.color = matNow.color.clone();
        this.materialSnapshots.set(key, snap);
      }

      const mat = mesh.material as THREE.MeshStandardMaterial;
      if ((mat as unknown as { emissive?: THREE.Color }).emissive) {
        mat.emissive.copy(color);
        mat.emissiveIntensity = emissiveIntensity;
      } else if ((mat as unknown as { color?: THREE.Color }).color) {
        mat.color.copy(color);
      }
      mat.needsUpdate = true;
    });
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

  private assertNotDisposed(): void {
    if (this.disposed) throw new Error('EffectManager is disposed');
  }
}

function snapshotKey(layer: HighlightLayer, uuid: string): string {
  return `${layer}:${uuid}`;
}
