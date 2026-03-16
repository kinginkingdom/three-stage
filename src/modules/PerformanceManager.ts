import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from 'three-mesh-bvh';
import type { BVHOptions, InstancingOptions, MergeOptions, OptimizerOptions } from '../types';

type BVHBufferGeometry = THREE.BufferGeometry & {
  computeBoundsTree?: typeof computeBoundsTree;
  disposeBoundsTree?: typeof disposeBoundsTree;
};

export interface InstancingResult {
  created: THREE.InstancedMesh[];
  removed: THREE.Mesh[];
}

export interface MergeResult {
  created: THREE.Mesh[];
  removed: THREE.Mesh[];
}

export class PerformanceManager {
  private disposed = false;
  private bvhEnabled = false;
  private bvhGeometries = new Set<THREE.BufferGeometry>();

  constructor(private readonly options: OptimizerOptions = {}) {}

  dispose(): void {
    this.disposed = true;
    this.disableBVH();
  }

  setFrustumCulling(root: THREE.Object3D, enabled: boolean): void {
    root.traverse((o) => {
      if ((o as THREE.Mesh).isMesh || (o as THREE.InstancedMesh).isInstancedMesh) {
        o.frustumCulled = enabled;
      }
    });
  }

  /**
   * 开启 BVH 加速拾取（适合“大场景高频 raycast”）。
   * 注意：做了 merge/simplify 这类“改几何拓扑”的操作后，建议重建一次 BVH。
   */
  enableBVH(root: THREE.Object3D, opts: BVHOptions = {}): { patchedMeshes: number; builtGeometries: number } {
    this.assertNotDisposed();
    this.bvhEnabled = true;

    const filter =
      opts.filter ??
      ((m: THREE.Mesh) => {
        return !(m instanceof THREE.SkinnedMesh) && !!m.geometry && (m.geometry as THREE.BufferGeometry).isBufferGeometry;
      });

    let patchedMeshes = 0;
    let builtGeometries = 0;

    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      if (!filter(mesh)) return;

      // 关键：用 BVH 版本 raycast 替换 Mesh.raycast（不改 Three 核心）。
      mesh.raycast = acceleratedRaycast;
      patchedMeshes += 1;

      const geom = mesh.geometry as BVHBufferGeometry;
      // 关键：给 geometry 注入 compute/disposeBoundsTree，并只构建一次。
      geom.computeBoundsTree = computeBoundsTree;
      geom.disposeBoundsTree = disposeBoundsTree;

      if (!this.bvhGeometries.has(geom)) {
        // 构建 BVH（有成本，建议只对需要交互/拾取的网格启用）
        geom.computeBoundsTree?.();
        this.bvhGeometries.add(geom);
        builtGeometries += 1;
      }
    });

    return { patchedMeshes, builtGeometries };
  }

  disableBVH(): void {
    if (!this.bvhEnabled) return;
    this.bvhEnabled = false;
    // 释放 BVH，避免内存常驻
    for (const g of this.bvhGeometries) {
      (g as BVHBufferGeometry).disposeBoundsTree?.();
    }
    this.bvhGeometries.clear();
  }

  /**
   * 重复网格 → InstancedMesh（手动可控的降 drawcall 手段）
   * 默认按 geometry.uuid + material.uuid 分桶
   */
  createInstancing(root: THREE.Object3D, opts: InstancingOptions = {}): InstancingResult {
    this.assertNotDisposed();
    const minCount = opts.minCount ?? 2;
    const filter =
      opts.filter ??
      ((m: THREE.Mesh) => {
        if (m instanceof THREE.SkinnedMesh) return false;
        // 排除带 interact 的 mesh，实例化后无法单独点击（userData 丢失）
        if (this.hasInteractInAncestry(m)) return false;
        return true;
      });
    const getKey =
      opts.getKey ??
      ((m: THREE.Mesh) => {
        const mat = m.material;
        const matKey = Array.isArray(mat) ? mat.map((x) => x.uuid).join('|') : mat.uuid;
        return `${m.geometry.uuid}::${matKey}`;
      });

    const candidates: THREE.Mesh[] = [];
    root.traverse((o) => {
      if ((o as THREE.Mesh).isMesh && !(o as THREE.InstancedMesh).isInstancedMesh) {
        const m = o as THREE.Mesh;
        if (!filter(m)) return;
        if (!m.geometry || !m.material) return;
        candidates.push(m);
      }
    });

    const buckets = new Map<string, THREE.Mesh[]>();
    for (const m of candidates) {
      const key = getKey(m);
      const list = buckets.get(key) ?? [];
      list.push(m);
      buckets.set(key, list);
    }

    const created: THREE.InstancedMesh[] = [];
    const removed: THREE.Mesh[] = [];

    for (const [, list] of buckets) {
      if (list.length < minCount) continue;
      const proto = list[0];
      if (!proto) continue;
      if (Array.isArray(proto.material)) continue; // skip multi-material meshes (non-trivial)

      const inst = new THREE.InstancedMesh(proto.geometry, proto.material, list.length);
      inst.name = `${proto.name || 'instanced'}_${list.length}`;
      inst.castShadow = proto.castShadow;
      inst.receiveShadow = proto.receiveShadow;
      inst.frustumCulled = this.options.frustumCulling ?? true;

      const dummy = new THREE.Object3D();
      for (let i = 0; i < list.length; i += 1) {
        const m = list[i]!;
        m.updateWorldMatrix(true, false);
        dummy.matrix.copy(m.matrixWorld);
        inst.setMatrixAt(i, dummy.matrix);
      }
      inst.instanceMatrix.needsUpdate = true;

      if (opts.enableInstanceColor) {
        // 用 instanceColor 做“单实例高亮”的基础（需要交互返回 instanceId）
        const colors = new Float32Array(list.length * 3);
        for (let i = 0; i < list.length; i += 1) {
          colors[i * 3 + 0] = 1;
          colors[i * 3 + 1] = 1;
          colors[i * 3 + 2] = 1;
        }
        inst.instanceColor = new THREE.InstancedBufferAttribute(colors, 3);
      }

      // 这里把每个源 Mesh 的 worldMatrix 烘焙到 instanceMatrix，
      // 所以 InstancedMesh 本体直接挂到 root 下即可（无需保留原层级 parent/transform）。
      root.add(inst);
      created.push(inst);

      // BVH 已启用时，InstancedMesh 的拾取同样受益
      if (this.bvhEnabled) {
        inst.raycast = acceleratedRaycast;
      }

      if (!this.options.keepOriginals) {
        for (const m of list) {
          if (m.parent) m.parent.remove(m);
          removed.push(m);
        }
      }
    }

    return { created, removed };
  }

  /**
   * 静态网格合批（减少 drawcall）
   * 默认按材质分组合并，保证渲染正确性
   * 默认排除 userData.interact=true 的 mesh（及其子节点），避免合并后无法单独交互
   */
  mergeStatic(root: THREE.Object3D, opts: MergeOptions = {}): MergeResult {
    this.assertNotDisposed();
    const filter =
      opts.filter ??
      ((m: THREE.Mesh) => {
        if (m instanceof THREE.SkinnedMesh) return false;
        if ((m as unknown as THREE.InstancedMesh).isInstancedMesh) return false;
        // 排除带 interact 标记的 mesh，合并后无法单独点击/高亮
        if (this.hasInteractInAncestry(m)) return false;
        return true;
      });
    const groupByMaterial = opts.groupByMaterial ?? true;

    const meshes: THREE.Mesh[] = [];
    root.traverse((o) => {
      if ((o as THREE.Mesh).isMesh && !(o as THREE.InstancedMesh).isInstancedMesh) {
        const m = o as THREE.Mesh;
        if (!filter(m)) return;
        if (Array.isArray(m.material)) return;
        meshes.push(m);
      }
    });

    const buckets = new Map<string, THREE.Mesh[]>();
    for (const m of meshes) {
      const key = groupByMaterial ? (m.material as THREE.Material).uuid : 'all';
      const list = buckets.get(key) ?? [];
      list.push(m);
      buckets.set(key, list);
    }

    const created: THREE.Mesh[] = [];
    const removed: THREE.Mesh[] = [];

    for (const [, list] of buckets) {
      if (list.length < 2) continue;
      const geoms: THREE.BufferGeometry[] = [];
      const mat = list[0]!.material as THREE.Material;

      for (const m of list) {
        m.updateWorldMatrix(true, false);
        const g = m.geometry.clone();
        g.applyMatrix4(m.matrixWorld);
        geoms.push(g);
      }

      const merged = mergeGeometries(geoms, false);
      if (!merged) continue;

      const mergedMesh = new THREE.Mesh(merged, mat);
      mergedMesh.name = `merged_${list.length}`;
      mergedMesh.frustumCulled = this.options.frustumCulling ?? true;
      root.add(mergedMesh);
      created.push(mergedMesh);

      if (this.bvhEnabled) {
        // 合并后是“新几何”，需要单独构建一次 BVH
        mergedMesh.raycast = acceleratedRaycast;
        this.enableBVH(mergedMesh, { filter: () => true });
      }

      if (!this.options.keepOriginals) {
        for (const m of list) {
          if (m.parent) m.parent.remove(m);
          removed.push(m);
          if (opts.disposeSources) m.geometry.dispose();
        }
      }

      for (const g of geoms) g.dispose();
    }

    return { created, removed };
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
    if (this.disposed) throw new Error('PerformanceManager is disposed');
  }
}

