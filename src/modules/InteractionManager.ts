import * as THREE from 'three';
import type { InteractionData, RaycastOptions, ViewerEvents } from '../types';
import type { StrictEventBus } from '../core/EventBus';

export interface InteractionManagerConfig {
  canvas: HTMLCanvasElement;
  camera: THREE.Camera;
  root: THREE.Object3D;
  raycast: RaycastOptions | undefined;
  enableDrag: boolean;
}

type PointerLikeEvent = PointerEvent | MouseEvent;

export class InteractionManager {
  private disposed = false;
  private readonly raycaster = new THREE.Raycaster();
  private readonly ndc = new THREE.Vector2();
  private readonly lastHover: { uuid: string | null; instanceId: number | undefined } = { uuid: null, instanceId: undefined };
  private dragging: { pointerId: number; hit: InteractionData } | null = null;
  // 点击判定相关：短按 + 小位移 才认为是 click
  private pointerDownPos: { x: number; y: number } | null = null;
  private pointerDownTime = 0;
  private pointerDownId: number | null = null;
  private suppressClick = false;
  private readonly clickMoveTolerancePx = 5;
  private readonly clickDurationMs = 250;

  constructor(
    private readonly bus: StrictEventBus<ViewerEvents>,
    private readonly cfg: InteractionManagerConfig,
  ) {
    if (cfg.raycast?.params) this.raycaster.params = cfg.raycast.params;
    this.bind();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unbind();
  }

  setRaycastOptions(opts: RaycastOptions): void {
    this.assertNotDisposed();
    if (opts.params) this.raycaster.params = opts.params;
    (this.cfg as InteractionManagerConfig).raycast = opts;
  }

  private bind(): void {
    const el = this.cfg.canvas;
    el.addEventListener('pointermove', this.onPointerMove, { passive: true });
    el.addEventListener('pointerdown', this.onPointerDown, { passive: false });
    el.addEventListener('pointerup', this.onPointerUp, { passive: true });
    el.addEventListener('pointerleave', this.onPointerLeave, { passive: true });
    el.addEventListener('dblclick', this.onDblClick, { passive: true });
    el.addEventListener('contextmenu', this.onContextMenu, { passive: false });
  }

  private unbind(): void {
    const el = this.cfg.canvas;
    el.removeEventListener('pointermove', this.onPointerMove);
    el.removeEventListener('pointerdown', this.onPointerDown);
    el.removeEventListener('pointerup', this.onPointerUp);
    el.removeEventListener('pointerleave', this.onPointerLeave);
    el.removeEventListener('dblclick', this.onDblClick);
    el.removeEventListener('contextmenu', this.onContextMenu);
  }

  private onPointerMove = (ev: PointerEvent) => {
    if (this.disposed) return;
    // 只要移动超过阈值，就标记为“本次不再触发 click”
    if (this.pointerDownPos && this.pointerDownId === ev.pointerId) {
      const dx = ev.clientX - this.pointerDownPos.x;
      const dy = ev.clientY - this.pointerDownPos.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > this.clickMoveTolerancePx) {
        this.suppressClick = true;
      }
    }

    const hit = this.raycast(ev, 'mousemove');
    if (this.cfg.enableDrag && this.dragging && this.dragging.pointerId === ev.pointerId) {
      this.bus.emit('drag-move', { ...hit, type: 'drag' });
      return;
    }

    const curKey = hit.uuid ? `${hit.uuid}:${hit.instanceId ?? -1}` : null;
    const prevKey = this.lastHover.uuid ? `${this.lastHover.uuid}:${this.lastHover.instanceId ?? -1}` : null;
    if (curKey !== prevKey) {
      this.lastHover.uuid = hit.uuid;
      this.lastHover.instanceId = hit.instanceId;
      this.bus.emit('object-hover', hit.intersection ? hit : null);
    }
  };

  private onPointerDown = (ev: PointerEvent) => {
    if (this.disposed) return;

    // 记录潜在 click 起点
    if (ev.button === 0) {
      this.pointerDownPos = { x: ev.clientX, y: ev.clientY };
      this.pointerDownTime = performance.now();
      this.pointerDownId = ev.pointerId;
      this.suppressClick = false;
    }

    // 左键 + 开启拖拽时，才进入 drag 流程
    if (this.cfg.enableDrag && ev.button === 0) {
      const hit = this.raycast(ev, 'drag');
      if (!hit.intersection) return;
      this.dragging = { pointerId: ev.pointerId, hit };
      this.cfg.canvas.setPointerCapture(ev.pointerId);
      this.bus.emit('drag-start', hit);
      ev.preventDefault();
    }
  };

  private onPointerUp = (ev: PointerEvent) => {
    if (this.disposed) return;

    // 先结束拖拽
    if (this.cfg.enableDrag && this.dragging && this.dragging.pointerId === ev.pointerId) {
      const hitDrag = this.raycast(ev, 'drag');
      this.bus.emit('drag-end', hitDrag);
      this.dragging = null;
    }

    // 再判定是否触发 click（短按 + 小位移）
    if (ev.button === 0 && this.pointerDownPos && this.pointerDownId === ev.pointerId) {
      const elapsed = performance.now() - this.pointerDownTime;
      if (!this.suppressClick && elapsed <= this.clickDurationMs) {
        const hit = this.raycast(ev, 'click');
        this.bus.emit('object-click', hit);
      }
    }

    if (this.pointerDownId === ev.pointerId) {
      this.pointerDownPos = null;
      this.pointerDownId = null;
      this.suppressClick = false;
    }
  };

  private onPointerLeave = (_ev: PointerEvent) => {
    if (this.disposed) return;
    if (this.lastHover.uuid !== null) {
      this.lastHover.uuid = null;
      this.lastHover.instanceId = undefined;
      this.bus.emit('object-hover', null);
    }
    // 离开画布也重置一次 click 状态
    this.pointerDownPos = null;
    this.pointerDownId = null;
    this.suppressClick = false;
  };

  private onDblClick = (ev: MouseEvent) => {
    if (this.disposed) return;
    // 如果本次交互已经被判定为“大位移拖拽”，则不触发双击
    if (this.suppressClick) return;
    const hit = this.raycast(ev, 'dblclick');
    this.bus.emit('object-dblclick', hit);
  };

  private onContextMenu = (ev: MouseEvent) => {
    if (this.disposed) return;
    const hit = this.raycast(ev, 'contextmenu');
    this.bus.emit('object-contextmenu', hit);
    ev.preventDefault();
  };

  private raycast(ev: PointerLikeEvent, type: InteractionData['type']): InteractionData {
    const rect = this.cfg.canvas.getBoundingClientRect();
    const x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
    const y = -(((ev.clientY - rect.top) / rect.height) * 2 - 1);
    this.ndc.set(x, y);

    // 性能手段：优先 whitelist（小集合），其次 root 全量；再用 blacklist 二次过滤
    const { whitelist, blacklist, layers, maxHits } = this.cfg.raycast ?? {};

    this.raycaster.setFromCamera(this.ndc, this.cfg.camera);
    if (layers && layers.length > 0) {
      for (const l of layers) this.raycaster.layers.enable(l);
    }

    let intersects: THREE.Intersection<THREE.Object3D>[] = [];
    if (whitelist && whitelist.length > 0) {
      for (const o of whitelist) {
        const hits = this.raycaster.intersectObject(o, true);
        intersects = intersects.concat(hits);
        // 只取前 N 个命中，避免深层场景产生大量交点导致卡顿
        if (typeof maxHits === 'number' && intersects.length >= maxHits) break;
      }
    } else {
      intersects = this.raycaster.intersectObject(this.cfg.root, true);
    }

    const hit = this.pickFirstInteractHit(intersects, blacklist) ?? null;
    const obj = hit?.object ?? null;

    return {
      type,
      pointerId: (ev as PointerEvent).pointerId ?? -1,
      buttons: (ev as MouseEvent).buttons ?? 0,
      clientX: ev.clientX,
      clientY: ev.clientY,
      ndc: { x, y },
      intersection: hit,
      intersectedObject: obj,
      uuid: obj?.uuid ?? null,
      userData: obj?.userData ?? null,
      normal: hit?.face?.normal ? hit.face.normal.clone() : null,
      uv: hit?.uv ? hit.uv.clone() : null,
      distance: typeof hit?.distance === 'number' ? hit.distance : null,
      instanceId: hit?.instanceId,
    };
  }

  private pickFirstInteractHit(
    intersects: ReadonlyArray<THREE.Intersection<THREE.Object3D>>,
    blacklist: ReadonlyArray<THREE.Object3D> | undefined,
  ): THREE.Intersection<THREE.Object3D> | undefined {
    const blocked = blacklist && blacklist.length > 0 ? new Set(blacklist.map((o) => o.uuid)) : null;
    for (let i = 0; i < intersects.length; i += 1) {
      const hit = intersects[i]!;
      if (blocked && blocked.has(hit.object.uuid)) continue;
      if (this.isInteractable(hit.object)) return hit;
    }
    return undefined;
  }

  private isInteractable(obj: THREE.Object3D): boolean {
    // 约定：只允许 userData.interact === true 的对象参与交互
    // 支持在父节点打标（点到子 mesh 也算可交互）
    let cur: THREE.Object3D | null = obj;
    while (cur) {
      const ud = cur.userData as { interact?: boolean } | undefined;
      if (ud?.interact === true) return true;
      cur = cur.parent;
    }
    return false;
  }

  private assertNotDisposed(): void {
    if (this.disposed) throw new Error('InteractionManager is disposed');
  }
}

