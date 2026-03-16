import * as THREE from 'three';
import type { TransformLike, WorldToScreenResult } from '../types';

/**
 * 将 3D 对象/位置投影到画布像素坐标，供 DOM 弹框定位。
 * @param camera 透视相机
 * @param canvas 画布元素（用于取尺寸和边界）
 * @param target 目标对象或世界坐标
 * @returns { x, y, visible } 画布内像素坐标，visible 表示在视野内且未被遮挡
 */
export function worldToScreen(
  camera: THREE.PerspectiveCamera,
  canvas: HTMLCanvasElement,
  target: THREE.Object3D | THREE.Vector3,
): WorldToScreenResult {
  const vec = new THREE.Vector3();
  if (target instanceof THREE.Vector3) {
    vec.copy(target);
  } else {
    target.getWorldPosition(vec);
  }
  vec.project(camera);

  const rect = canvas.getBoundingClientRect();
  const w = rect.width;
  const h = rect.height;
  const x = ((vec.x + 1) / 2) * w;
  const y = ((1 - vec.y) / 2) * h;

  const visible = vec.z >= 0 && vec.z <= 1 && vec.x >= -1 && vec.x <= 1 && vec.y >= -1 && vec.y <= 1;
  return { x, y, visible };
}

export function applyTransform(obj: THREE.Object3D, t: TransformLike): void {
  if (t.position) obj.position.set(t.position[0], t.position[1], t.position[2]);
  if (t.rotationEuler) obj.rotation.set(t.rotationEuler[0], t.rotationEuler[1], t.rotationEuler[2]);
  if (t.scale) obj.scale.set(t.scale[0], t.scale[1], t.scale[2]);
}

export function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

export function computeDpr(
  dpr: number | { min: number; max: number } | undefined,
  devicePixelRatio: number,
): number {
  if (typeof dpr === 'number') return dpr;
  const raw = devicePixelRatio || 1;
  if (!dpr) return raw;
  return clamp(raw, dpr.min, dpr.max);
}

export function createRequestId(): string {
  // short, stable, non-crypto id; good enough for in-memory tracking
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

