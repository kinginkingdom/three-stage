import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { gsap } from 'gsap';
import type {
  FocusOptions,
  OrbitControlsOptions,
  RoamOptions,
  RoamPathPoint,
  ViewPreset,
  SetViewOptions,
} from '../types';

export interface CameraControllerConfig {
  canvas: HTMLCanvasElement;
  camera: THREE.PerspectiveCamera;
  enableOrbitControls: boolean;
  enableRoaming: boolean;
  orbitControls?: OrbitControlsOptions;
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
      if (cfg.orbitControls) {
        CameraController.applyOrbitControlOptions(c, cfg.orbitControls);
      }
      this.controls = c;
    } else {
      this.controls = null;
    }
  }

  private static applyOrbitControlOptions(c: OrbitControls, o: OrbitControlsOptions): void {
    if (o.enableRotate !== undefined) c.enableRotate = o.enableRotate;
    if (o.enableZoom !== undefined) c.enableZoom = o.enableZoom;
    if (o.enablePan !== undefined) c.enablePan = o.enablePan;
    if (o.enableDamping !== undefined) c.enableDamping = o.enableDamping;
    if (o.dampingFactor !== undefined) c.dampingFactor = o.dampingFactor;
    if (o.minDistance !== undefined) c.minDistance = o.minDistance;
    if (o.maxDistance !== undefined) c.maxDistance = o.maxDistance;
    if (o.minPolarAngle !== undefined) c.minPolarAngle = o.minPolarAngle;
    if (o.maxPolarAngle !== undefined) c.maxPolarAngle = o.maxPolarAngle;
    if (o.minAzimuthAngle !== undefined) c.minAzimuthAngle = o.minAzimuthAngle;
    if (o.maxAzimuthAngle !== undefined) c.maxAzimuthAngle = o.maxAzimuthAngle;
    if (o.rotateSpeed !== undefined) c.rotateSpeed = o.rotateSpeed;
    if (o.zoomSpeed !== undefined) c.zoomSpeed = o.zoomSpeed;
    if (o.panSpeed !== undefined) c.panSpeed = o.panSpeed;
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
    const lookAts = points.map((p) =>
      p.lookAt ? new THREE.Vector3(p.lookAt[0], p.lookAt[1], p.lookAt[2]) : null,
    );
    const hasExplicitLookAt = lookAts.some((v) => v !== null);
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
        let lookAt: THREE.Vector3;
        if (hasExplicitLookAt) {
          // 使用 RoamPathPoint.lookAt：在相邻控制点之间做线性插值
          const segT = t * (points.length - 1);
          let i = Math.floor(segT);
          let localT = segT - i;
          if (i >= points.length - 1) {
            i = points.length - 2;
            localT = 1;
          }

          const getLookAtForIndex = (idx: number): THREE.Vector3 => {
            const explicit = lookAts[idx];
            if (explicit) return explicit.clone();
            // 没有显式 lookAt 时，退化为“沿路径前进方向看”
            const pt = positions[idx]!;
            const tt = idx / (points.length - 1);
            const forwardAtIdx = curve.getTangentAt(tt).normalize();
            return pt.clone().add(forwardAtIdx);
          };

          const a = getLookAtForIndex(i);
          const b = getLookAtForIndex(i + 1);
          lookAt = a.lerp(b, localT);
        } else {
          // 默认“向前看”：取切线方向作为视线
          const forward = curve.getTangentAt(Math.min(1, t + 0.001)).normalize();
          lookAt = pos.clone().add(forward);
        }

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

  /** 预设视角方向（单位向量），相机位置 = target + dir * distance */
  private static readonly VIEW_DIRS: Record<ViewPreset, [number, number, number]> = {
    front: [0, 0, 1],
    back: [0, 0, -1],
    top: [0, 1, 0],
    bottom: [0, -1, 0],
    left: [-1, 0, 0],
    right: [1, 0, 0],
    topLeft: [-0.577, 0.577, 0.577],
    topRight: [0.577, 0.577, 0.577],
    bottomLeft: [-0.577, -0.577, 0.577],
    bottomRight: [0.577, -0.577, 0.577],
  };

  setView(preset: ViewPreset, opts: SetViewOptions = {}): Promise<void> {
    this.assertNotDisposed();
    const cam = this.cfg.camera;
    const targetVec = new THREE.Vector3(
      opts.target?.[0] ?? this.controls?.target.x ?? 0,
      opts.target?.[1] ?? this.controls?.target.y ?? 0,
      opts.target?.[2] ?? this.controls?.target.z ?? 0,
    );
    const dir = CameraController.VIEW_DIRS[preset];
    const dirVec = new THREE.Vector3(dir[0], dir[1], dir[2]).normalize();
    const distance = opts.distance ?? cam.position.distanceTo(targetVec);
    const toPos = targetVec.clone().add(dirVec.multiplyScalar(distance));
    const animate = opts.animate !== false;
    const durationMs = opts.durationMs ?? 400;

    if (!animate) {
      cam.position.copy(toPos);
      cam.lookAt(targetVec);
      if (this.controls) {
        this.controls.target.copy(targetVec);
        this.controls.update();
      }
      return Promise.resolve();
    }

    this.focusTween?.kill();
    const fromPos = cam.position.clone();
    const fromLookAt = this.getLookAt();
    const p = { t: 0 };
    return new Promise((resolve) => {
      this.focusTween = gsap.to(p, {
        t: 1,
        duration: durationMs / 1000,
        ease: 'power2.inOut',
        onUpdate: () => {
          const t = p.t;
          cam.position.lerpVectors(fromPos, toPos, t);
          const lookAt = fromLookAt.clone().lerp(targetVec, t);
          cam.lookAt(lookAt);
          if (this.controls) {
            this.controls.target.copy(lookAt);
            this.controls.update();
          }
        },
        onComplete: () => resolve(),
        onInterrupt: () => resolve(),
      });
    });
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

