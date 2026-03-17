import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { gsap } from 'gsap';
import type { FocusOptions, RoamOptions, RoamPathPoint } from '../types';

export interface CameraControllerConfig {
  canvas: HTMLCanvasElement;
  camera: THREE.PerspectiveCamera;
  enableOrbitControls: boolean;
  enableRoaming: boolean;
}

export class CameraController {
  readonly controls: OrbitControls | null;
  private disposed = false;
  private roamingTween: gsap.core.Tween | null = null;
  private focusTween: gsap.core.Tween | null = null;

  constructor(private readonly cfg: CameraControllerConfig) {
    if (cfg.enableOrbitControls) {
      const c = new OrbitControls(cfg.camera, cfg.canvas);
      c.enableDamping = true;
      c.dampingFactor = 0.08;
      this.controls = c;
    } else {
      this.controls = null;
    }
  }

  update(dtSeconds: number): void {
    if (this.disposed) return;
    // 预留 dt 入参：后续可扩展为基于 dt 的控制器（当前 OrbitControls 不用）
    void dtSeconds;
    this.controls?.update();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.roamingTween?.kill();
    this.focusTween?.kill();
    this.controls?.dispose();
    this.roamingTween = null;
    this.focusTween = null;
  }

  focusOnObject(target: THREE.Object3D, opts: FocusOptions = {}): Promise<void> {
    this.assertNotDisposed();
    const durationMs = opts.durationMs ?? 650;
    const padding = opts.padding ?? 1.2;
    const minRadius = opts.minRadius ?? 2;

    const box = new THREE.Box3().setFromObject(target);
    const sphere = new THREE.Sphere();
    box.getBoundingSphere(sphere);
    if (sphere.radius < minRadius) sphere.radius = minRadius;

    const cam = this.cfg.camera;
    const fromPos = cam.position.clone();
    const toTarget = sphere.center.clone();

    const fov = (cam.fov * Math.PI) / 180;
    const distance = (sphere.radius * padding) / Math.tan(fov / 2);
    const dir = cam.getWorldDirection(new THREE.Vector3()).multiplyScalar(-1).normalize();
    const toPos = toTarget.clone().add(dir.multiplyScalar(distance));

    const fromLookAt = this.getLookAt();
    const toLookAt = toTarget.clone();

    const setOrbitTarget = opts.setOrbitTarget ?? true;

    this.focusTween?.kill();
    const p = { t: 0 };
    return new Promise((resolve) => {
      this.focusTween = gsap.to(p, {
        t: 1,
        duration: durationMs / 1000,
        ease: 'power2.inOut',
        onUpdate: () => {
          const t = p.t;
          cam.position.lerpVectors(fromPos, toPos, t);
          const lookAt = fromLookAt.clone().lerp(toLookAt, t);
          cam.lookAt(lookAt);
          if (setOrbitTarget && this.controls) {
            this.controls.target.copy(lookAt);
            this.controls.update();
          }
        },
        onComplete: () => resolve(),
        // focus 动画允许被下一次 focus/stop 直接中断
        onInterrupt: () => resolve(),
      });
    });
  }

  startRoaming(points: ReadonlyArray<RoamPathPoint>, opts: RoamOptions): void {
    this.assertNotDisposed();
    if (!this.cfg.enableRoaming) throw new Error('Roaming is disabled by config');
    if (points.length < 2) throw new Error('Roaming requires at least 2 points');

    const durationMs = opts.durationMs;
    const loop = opts.loop ?? false;

    const positions = points.map((p) => new THREE.Vector3(p.position[0], p.position[1], p.position[2]));
    const curve = new THREE.CatmullRomCurve3(positions, loop, 'centripetal', 0.5);

    this.stopRoaming();
    const p = { t: 0 };
    this.roamingTween = gsap.to(p, {
      t: 1,
      duration: durationMs / 1000,
      ease: 'none',
      repeat: loop ? -1 : 0,
      onUpdate: () => {
        if (this.disposed) return;
        const t = p.t % 1;
        const pos = curve.getPointAt(t);
        this.cfg.camera.position.copy(pos);
        // 默认“向前看”：取切线方向作为视线（可在未来扩展为按点位 lookAt）
        const forward = curve.getTangentAt(Math.min(1, t + 0.001)).normalize();
        const lookAt = pos.clone().add(forward);
        this.cfg.camera.lookAt(lookAt);
        if (this.controls) {
          this.controls.target.copy(lookAt);
          this.controls.update();
        }
      },
      onComplete: () => {
        this.roamingTween = null;
      },
    });
  }

  stopRoaming(): void {
    this.roamingTween?.kill();
    this.roamingTween = null;
  }

  private getLookAt(): THREE.Vector3 {
    if (this.controls) return this.controls.target.clone();
    const cam = this.cfg.camera;
    const dir = cam.getWorldDirection(new THREE.Vector3());
    return cam.position.clone().add(dir.multiplyScalar(10));
  }

  private assertNotDisposed(): void {
    if (this.disposed) throw new Error('CameraController is disposed');
  }
}

