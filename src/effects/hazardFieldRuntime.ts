import * as THREE from 'three';
import type { Viewer } from '../Viewer';
import type { HazardFieldSpec } from './hazardFieldTypes';
import {
  mergeGasVisual,
  mergeHeatVisual,
  mergeLiquidVisual,
} from './hazardFieldTypes';

/** 气体：Fresnel 边缘亮 + 时间脉动 +  additive */
const GAS_VERT = /* glsl */ `
varying vec3 vWorldPosition;
varying vec3 vWorldNormal;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPosition = wp.xyz;
  vWorldNormal = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const GAS_FRAG = /* glsl */ `
uniform vec3 uCoreColor;
uniform vec3 uRimColor;
uniform float uAlphaMul;
uniform float uTime;
uniform float uPhase;
varying vec3 vWorldPosition;
varying vec3 vWorldNormal;
void main() {
  vec3 viewDir = normalize(cameraPosition - vWorldPosition);
  float ndv = abs(dot(viewDir, vWorldNormal));
  float fresnel = pow(1.0 - ndv, 2.35);
  float pulse = 0.5 + 0.5 * sin(uTime * (2.1 + uPhase * 0.15) + length(vWorldPosition) * 0.12);
  float a = uAlphaMul * (0.18 + 0.82 * fresnel) * (0.75 + 0.25 * pulse);
  vec3 col = mix(uCoreColor, uRimColor, fresnel);
  col += uRimColor * fresnel * fresnel * 0.85;
  gl_FragColor = vec4(col, a);
}
`;

const LIQUID_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const LIQUID_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform vec3 uAccent;
uniform float uOpacityPeak;
uniform float uEdgeSoft;
uniform float uTime;
varying vec2 vUv;
void main() {
  vec2 d = (vUv - 0.5) * 2.0;
  float r = length(d);
  if (r > 1.001) discard;
  float core = 1.0 - smoothstep(1.0 - uEdgeSoft, 1.0, r);
  float rip = sin(r * 22.0 - uTime * 4.2) * 0.5 + 0.5;
  float rip2 = sin(r * 13.0 - uTime * 2.1 + 1.7) * 0.5 + 0.5;
  float waves = rip * 0.22 + rip2 * 0.14;
  float inner = (1.0 - r) * (1.0 - r);
  vec3 glow = mix(uColor, uAccent, inner * 1.2) * (1.0 + waves + inner * 2.5);
  float a = uOpacityPeak * core * (0.65 + 0.35 * rip + inner * 0.8);
  gl_FragColor = vec4(glow, a);
}
`;

const HEAT_VERT = /* glsl */ `
varying vec3 vWorldPosition;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPosition = wp.xyz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const HEAT_FRAG = /* glsl */ `
uniform vec3 uHot;
uniform vec3 uCold;
uniform vec3 uCenter;
uniform float uSigma2;
uniform float uOpacity;
uniform float uTime;
varying vec3 vWorldPosition;
void main() {
  float dx = vWorldPosition.x - uCenter.x;
  float dz = vWorldPosition.z - uCenter.z;
  float d2 = dx * dx + dz * dz;
  float hx = vWorldPosition.x * 0.38 + uTime * 0.55;
  float hz = vWorldPosition.z * 0.31 - uTime * 0.42;
  float n = sin(hx) * sin(hz * 1.73 + 1.1) * 0.14;
  float g = exp(-d2 / max(uSigma2, 1e-4)) * (1.0 + n);
  float flicker = 0.9 + 0.1 * sin(uTime * 4.8 + d2 * 0.025);
  vec3 col = mix(uCold, uHot, g * flicker);
  col += uHot * g * g * 0.55;
  float a = g * uOpacity * flicker * (1.0 + 0.2 * n);
  gl_FragColor = vec4(col, a);
}
`;

type TimeUniform = { value: number };

function disposeObject(root: THREE.Object3D): void {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry?.dispose();
    const mat = mesh.material;
    if (Array.isArray(mat)) {
      for (const m of mat) m.dispose();
    } else {
      mat?.dispose();
    }
  });
}

function buildGas(
  spec: Extract<HazardFieldSpec, { kind: 'gas' }>,
  uTime: TimeUniform,
): THREE.Group {
  const g = mergeGasVisual(spec.visual);
  const shellCount = Math.max(1, Math.min(32, Math.floor(g.shellCount)));
  const root = new THREE.Group();
  root.name = `hazard:gas:${spec.id}`;
  root.position.set(spec.position[0], spec.position[1], spec.position[2]);

  const core = new THREE.Color(g.color);
  core.multiplyScalar(0.35);
  const rim = new THREE.Color(g.color);
  rim.lerp(new THREE.Color(0xffffff), 0.55);

  for (let i = 0; i < shellCount; i++) {
    const t = (i + 1) / shellCount;
    const ri = g.radius * t;
    const falloff = 1.0 - t * 0.82;
    const alphaMul = Math.min(1.2, g.opacityPeak * falloff * (0.5 + 0.5 * (1 - i / Math.max(1, shellCount - 1))));
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uCoreColor: { value: new THREE.Vector3(core.r, core.g, core.b) },
        uRimColor: { value: new THREE.Vector3(rim.r, rim.g, rim.b) },
        uAlphaMul: { value: alphaMul },
        uTime,
        uPhase: { value: (i / shellCount) * 6.28318 },
      },
      vertexShader: GAS_VERT,
      fragmentShader: GAS_FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(ri, 40, 40), mat);
    mesh.renderOrder = g.renderOrder + i;
    root.add(mesh);
  }
  return root;
}

function buildLiquid(spec: Extract<HazardFieldSpec, { kind: 'liquid' }>, uTime: TimeUniform): THREE.Group {
  const v = mergeLiquidVisual(spec.visual);
  const root = new THREE.Group();
  root.name = `hazard:liquid:${spec.id}`;
  root.position.set(spec.position[0], spec.position[1], spec.position[2]);
  root.rotation.x = -Math.PI / 2;

  const col = new THREE.Color(v.color);
  const accent = new THREE.Color(v.color);
  accent.lerp(new THREE.Color(0xffffff), 0.45);

  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Vector3(col.r, col.g, col.b) },
      uAccent: { value: new THREE.Vector3(accent.r, accent.g, accent.b) },
      uOpacityPeak: { value: v.opacityPeak },
      uEdgeSoft: { value: v.edgeSoftness },
      uTime,
    },
    vertexShader: LIQUID_VERT,
    fragmentShader: LIQUID_FRAG,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });

  const mesh = new THREE.Mesh(new THREE.CircleGeometry(v.radius, 96), mat);
  mesh.renderOrder = v.renderOrder;
  root.add(mesh);
  return root;
}

function buildHeat(spec: Extract<HazardFieldSpec, { kind: 'heat' }>, uTime: TimeUniform): THREE.Group {
  const h = mergeHeatVisual(spec.visual);
  const root = new THREE.Group();
  root.name = `hazard:heat:${spec.id}`;
  root.position.set(spec.position[0], spec.position[1], spec.position[2]);
  root.rotation.x = -Math.PI / 2;

  const hot = new THREE.Color(h.hotColor);
  const cold = new THREE.Color(h.coldColor);
  const sigma2 = h.sigma * h.sigma * 2.0;

  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uHot: { value: new THREE.Vector3(hot.r, hot.g, hot.b) },
      uCold: { value: new THREE.Vector3(cold.r, cold.g, cold.b) },
      uCenter: { value: new THREE.Vector3(spec.position[0], spec.position[1], spec.position[2]) },
      uSigma2: { value: sigma2 },
      uOpacity: { value: h.opacity },
      uTime,
    },
    vertexShader: HEAT_VERT,
    fragmentShader: HEAT_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });

  const w = h.planeHalfSize * 2;
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, w, 1, 1), mat);
  mesh.renderOrder = h.renderOrder;
  root.add(mesh);
  return root;
}

function build(spec: HazardFieldSpec, uTime: TimeUniform): THREE.Group {
  if (spec.kind === 'gas') return buildGas(spec, uTime);
  if (spec.kind === 'liquid') return buildLiquid(spec, uTime);
  return buildHeat(spec, uTime);
}

export interface HazardFieldLayerOptions {
  /** 默认挂到场景根，与 Viewer 灯光同级，不参与 root 内资产拾取 */
  parent?: THREE.Object3D;
  /** 整层可见性 */
  visible?: boolean;
  /**
   * 是否驱动着色器时间（Fresnel 脉动、漏液涟漪、热力闪烁）。
   * 为 false 时动画停在一帧，略省 CPU。
   */
  animated?: boolean;
}

/**
 * 在场景中挂载/更新「气体 / 漏液圆盘 / 平面热力」等场效应网格（仅视觉）。
 * 业务将后端状态映射为 {@link HazardFieldSpec} 后调用 {@link HazardFieldLayer.setSpecs}。
 */
export class HazardFieldLayer {
  readonly group: THREE.Group;
  private readonly objects = new Map<string, THREE.Group>();
  private readonly clock = new THREE.Clock();
  /** 各特效材质共享同一时间 uniform */
  private readonly sharedTime: TimeUniform = { value: 0 };
  private rafId: number | null = null;
  private disposed = false;
  private readonly animated: boolean;

  constructor(options: HazardFieldLayerOptions = {}) {
    this.group = new THREE.Group();
    this.group.name = 'HazardFieldLayer';
    this.group.visible = options.visible ?? true;
    this.animated = options.animated ?? true;
    const parent = options.parent;
    if (parent) parent.add(this.group);
  }

  /** 挂到 {@link Viewer.scene} 上（推荐） */
  static attachToViewer(viewer: Viewer, opts?: HazardFieldLayerOptions): HazardFieldLayer {
    const layer = new HazardFieldLayer({ ...opts, parent: viewer.scene });
    return layer;
  }

  private tick = (): void => {
    if (this.disposed) return;
    this.sharedTime.value = this.clock.getElapsedTime();
    if (this.animated && this.objects.size > 0) {
      this.rafId = requestAnimationFrame(this.tick);
    } else {
      this.rafId = null;
    }
  };

  private refreshAnimationLoop(): void {
    if (!this.animated || this.disposed) return;
    if (this.objects.size === 0) {
      if (this.rafId != null) {
        cancelAnimationFrame(this.rafId);
        this.rafId = null;
      }
      return;
    }
    if (this.rafId == null) {
      this.rafId = requestAnimationFrame(this.tick);
    }
  }

  private stripAndDispose(id: string): void {
    const g = this.objects.get(id);
    if (!g) return;
    this.group.remove(g);
    disposeObject(g);
    this.objects.delete(id);
  }

  /** 全量同步：列表外的 id 会被移除，同 id 会重建为最新 spec */
  setSpecs(specs: readonly HazardFieldSpec[]): void {
    this.assertNotDisposed();
    const next = new Set(specs.map((s) => s.id));
    for (const id of [...this.objects.keys()]) {
      if (!next.has(id)) this.stripAndDispose(id);
    }
    for (const spec of specs) {
      this.stripAndDispose(spec.id);
      const g = build(spec, this.sharedTime);
      this.group.add(g);
      this.objects.set(spec.id, g);
    }
    this.refreshAnimationLoop();
  }

  upsert(spec: HazardFieldSpec): void {
    this.assertNotDisposed();
    this.stripAndDispose(spec.id);
    const g = build(spec, this.sharedTime);
    this.group.add(g);
    this.objects.set(spec.id, g);
    this.refreshAnimationLoop();
  }

  remove(id: string): void {
    this.assertNotDisposed();
    this.stripAndDispose(id);
    this.refreshAnimationLoop();
  }

  clear(): void {
    this.assertNotDisposed();
    for (const id of [...this.objects.keys()]) this.stripAndDispose(id);
    this.refreshAnimationLoop();
  }

  getObject(id: string): THREE.Group | undefined {
    return this.objects.get(id);
  }

  dispose(): void {
    if (this.disposed) return;
    if (this.rafId != null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    for (const id of [...this.objects.keys()]) this.stripAndDispose(id);
    this.disposed = true;
    this.group.removeFromParent();
  }

  private assertNotDisposed(): void {
    if (this.disposed) throw new Error('HazardFieldLayer is disposed');
  }
}
