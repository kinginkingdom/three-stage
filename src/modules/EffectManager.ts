import * as THREE from 'three';
import type { HighlightStyle, InfluenceZoneShape, InfluenceZoneStyle } from '../types';

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

export class EffectManager {
  private disposed = false;

  private highlighted: HighlightTarget | null = null;
  private materialSnapshots = new Map<string, MaterialSnapshot>();
  private instancedSnapshots = new Map<string, Float32Array>(); // key: uuid
  private highlightColor = new THREE.Color();
  private breathingOpts: { min: number; max: number; speed: number } | null = null;
  private breathingTime = 0;

  private zones = new Map<string, THREE.Object3D>();

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearHighlight();
    for (const [, o] of this.zones) {
      this.disposeObject(o);
    }
    this.zones.clear();
  }

  setHighlight(target: HighlightTarget | null, style: HighlightStyle = {}): void {
    this.assertNotDisposed();
    if (!target) {
      this.clearHighlight();
      this.breathingOpts = null;
      return;
    }
    if (this.highlighted) this.clearHighlight();

    const color = new THREE.Color(style.color ?? 0x4fc3f7);
    const breathing = style.breathing ?? true;
    const emissiveIntensity = style.emissiveIntensity ?? (breathing ? style.breathingMax ?? 0.35 : 0.3);

    if (breathing) {
      this.breathingOpts = {
        min: style.breathingMin ?? 0.1,
        max: style.breathingMax ?? 0.24,
        speed: style.breathingSpeed ?? 0.5,
      };
      this.breathingTime = 0;
      this.highlightColor.copy(color);
    } else {
      this.breathingOpts = null;
    }

    // Instanced per-instance highlight via instanceColor.
    const inst = target.object as unknown as THREE.InstancedMesh;
    if (inst && inst.isInstancedMesh && typeof target.instanceId === 'number') {
      if (!inst.instanceColor) {
        this.highlightWholeObject(target.object, color, emissiveIntensity);
      } else {
        const uuid = inst.uuid;
        const attr = inst.instanceColor;
        const prev = new Float32Array(attr.array as ArrayLike<number>);
        this.instancedSnapshots.set(uuid, prev);
        attr.setXYZ(target.instanceId, color.r, color.g, color.b);
        attr.needsUpdate = true;
      }
      this.highlighted = target;
      return;
    }

    this.highlightWholeObject(target.object, color, emissiveIntensity);
    this.highlighted = target;
  }

  /** 每帧调用，用于呼吸灯动画 */
  update(dtSeconds: number): void {
    if (!this.breathingOpts || !this.highlighted) return;
    this.breathingTime += dtSeconds;
    const { min, max, speed } = this.breathingOpts;
    const t = 0.5 + 0.5 * Math.sin(this.breathingTime * Math.PI * 2 * speed);
    const intensity = min + (max - min) * t;
    this.applyEmissiveToHighlighted(this.highlightColor, intensity);
  }

  private applyEmissiveToHighlighted(color: THREE.Color, intensity: number): void {
    if (!this.highlighted) return;
    const obj = this.highlighted.object;
    const inst = obj as unknown as THREE.InstancedMesh;
    if (inst?.isInstancedMesh && typeof this.highlighted.instanceId === 'number' && inst.instanceColor) {
      inst.instanceColor.setXYZ(this.highlighted.instanceId, color.r, color.g, color.b);
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

  clearHighlight(): void {
    if (!this.highlighted) return;
    const obj = this.highlighted.object;
    const inst = obj as unknown as THREE.InstancedMesh;
    if (inst && inst.isInstancedMesh) {
      const snap = this.instancedSnapshots.get(inst.uuid);
      if (snap && inst.instanceColor) {
        inst.instanceColor.array.set(snap);
        inst.instanceColor.needsUpdate = true;
      }
      this.instancedSnapshots.delete(inst.uuid);
    } else {
      obj.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        if (Array.isArray(mesh.material)) return;
        const snap = this.materialSnapshots.get(mesh.uuid);
        if (!snap) return;
        if (snap.originalMaterial) {
          if (snap.clonedMaterial) snap.clonedMaterial.dispose();
          mesh.material = snap.originalMaterial;
        }
        const mat = mesh.material as THREE.MeshStandardMaterial;
        if (snap.emissive) mat.emissive.copy(snap.emissive);
        if (typeof snap.emissiveIntensity === 'number') mat.emissiveIntensity = snap.emissiveIntensity;
        if (snap.color && (mat as unknown as { color?: THREE.Color }).color) mat.color.copy(snap.color);
        this.materialSnapshots.delete(mesh.uuid);
      });
    }
    this.highlighted = null;
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

  private highlightWholeObject(obj: THREE.Object3D, color: THREE.Color, emissiveIntensity: number): void {
    obj.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      if (Array.isArray(mesh.material)) return;

      if (!this.materialSnapshots.has(mesh.uuid)) {
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
        this.materialSnapshots.set(mesh.uuid, snap);
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

