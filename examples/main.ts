import * as THREE from 'three';
import { Viewer } from '../src';
import type { RoamPathPoint } from '../src';

// Replace with your Draco GLB/GLTF URL (must be reachable by the dev server).
// If you serve draco decoders from /public/draco, keep dracoDecoderPath as '/draco/'.
const MODEL_URL = '/models/P2_FAB_F1_update_draco.glb';

/** 大图背景 + Sprite 打点：访问 `?fabBg=1`，使用 `public/models/fab.png` */
const FAB_BG_DEMO = new URLSearchParams(location.search).get('fabBg') === '1';
const FAB_BG_URL = '/models/fab.png';

type TipSeed = { id: string; curName: string; position: [number, number, number] };
type TipBatchConfig = {
  textureUrl: string;
  size: number;
  sizeAttenuation?: boolean;
  tips: TipSeed[];
};
type FabBackgroundConfig = {
  imageUrl: string;
  center: [number, number, number];
  /** 背景 Sprite 世界尺度（x/y），不根据贴图比例计算 */
  scale: number;
  renderOrder: number;
  lockControls: boolean;
  minDistance: number;
  maxDistance: number;
};

const FAB_BG_CONFIG: FabBackgroundConfig = {
  imageUrl: FAB_BG_URL,
  center: [0, 0, 0],
  scale: 50,
  renderOrder: -1000,
  lockControls: true,
  minDistance: 6,
  maxDistance: 40,
};

const FAB_TIPS_CONFIG: TipBatchConfig = {
  textureUrl: '/icons/pos.png',
  size: 0.55,
  sizeAttenuation: true,
  tips: [
    { id: 'fab-bg-fab', curName: 'FAB', position: [-8.8, 2.2, 0.03] },
    { id: 'fab-bg-pmd', curName: 'PMD', position: [-1.7, 3.3, 0.03] },
    { id: 'fab-bg-sgs', curName: 'SGS', position: [3.8, 0.6, 0.03] },
    { id: 'fab-bg-hpm', curName: 'HPM', position: [-4.8, -1.6, 0.03] },
    { id: 'fab-bg-cub', curName: 'CUB', position: [7.0, -2.2, 0.03] },
  ],
};

const canvas = document.querySelector<HTMLCanvasElement>('#c');
if (!canvas) throw new Error('Canvas not found');

const viewer = new Viewer({
  canvas,
  enableDraco: !FAB_BG_DEMO,
  dracoDecoderPath: '/draco/',
  enableOrbitControls: true,
  enableDrag: !FAB_BG_DEMO,
  enableBVH: !FAB_BG_DEMO,
  enableRoaming: !FAB_BG_DEMO,
  raycast: {
    hoverDelayMs: 300, // 停留 300ms 后才触发 object-hover
  },
  clearColor: 0xffffff,
  lighting: FAB_BG_DEMO
    ? { shadows: false }
    : {
        shadows: 'auto',
        shadowCatcher: true,
        shadowCameraSize: 120, // 大场景时调大，避免阴影出现方形裁切
        extraDirections: [
          { position: [0, 15, 0], intensity: 0.8 }, // 顶光
          { position: [8, 8, 8], intensity: 0.6 }, // 平行光1：左前上
          { position: [-8, 6, -6], intensity: 0.5 }, // 平行光2：右后上
        ],
      },
  optimizer: { frustumCulling: true, keepOriginals: false },
  initialCamera: FAB_BG_DEMO
    ? { position: [0, 0, 18], target: [10, 0, 0] }
    : {
        position: [15.6, 110.3, 91.4],
        target: [9.6, -1.79, 2.25],
      },
});

viewer.on('load-progress', (p) => {
  // high-signal progress hook
  if (p.url) console.debug(`[load] ${p.phase} ${p.url} ${(p.ratio * 100).toFixed(1)}%`);
});

viewer.on('object-click', (hit) => {
  if (FAB_BG_DEMO) {
    const ud = hit.intersectedObject?.userData as { curName?: string } | undefined;
    console.log('[fabBg] click', ud?.curName ?? hit.intersectedObject?.name ?? hit);
    return;
  }
  console.log(hit, 'hit');
  viewer.setHighlightFromInteraction(hit, { color: 0x00e5ff, emissiveIntensity: 1.2 });
  const target = viewer.resolveInteractionTarget(hit);
  if (target) {
    viewer.applyOcclusionDimming(target, { opacity: 0.18 });
    viewer.focus(target, { durationMs: 500, padding: 1.4 }).catch(() => void 0);
  }
});

// Hover 示例：快速划过不触发，停留超过 hoverDelayMs 才触发
viewer.on('object-hover', (hit) => {
  if (!hit) {
    console.log('[hover] leave');
    return;
  }
  const target = viewer.resolveInteractionDataTarget(hit);
  const ud = target?.userData as { curName?: string; name?: string } | undefined;
  console.log('[hover] target:', ud?.curName ?? ud?.name ?? target?.name ?? target?.uuid ?? 'unknown');
});

// Tip 旁 DOM 弹框：常驻显示 curName 等，每个 tip 一个
const tipPopupsContainer = document.getElementById('tip-popups');

function attachTipDomPopups(tipIds: string[]) {
  const popups: { el: HTMLElement; sprite: THREE.Sprite }[] = [];
  tipIds.forEach((id) => {
    const sprite = viewer.tips.getTip(id);
    if (!sprite) return;
    const el = document.createElement('div');
    el.className = 'tip-popup';
    el.dataset.tipId = id;
    const ud = sprite.userData as Record<string, unknown>;
    el.innerHTML = `<div class="value">${String(ud.curName ?? '-')}</div>`;
    if (tipPopupsContainer) tipPopupsContainer.appendChild(el);
    popups.push({ el, sprite });
  });

  viewer.on('frame', () => {
    const rect = viewer.renderer.domElement.getBoundingClientRect();
    popups.forEach(({ el, sprite }) => {
      if (!sprite.visible) {
        el.style.display = 'none';
        return;
      }
      const { x, y, visible } = viewer.worldToScreen(sprite);
      if (!visible) {
        el.style.display = 'none';
        return;
      }
      el.style.display = 'block';
      el.style.left = `${rect.left}px`;
      el.style.top = `${rect.top}px`;
      el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -100%)`;
    });
  });
}

function addTipsFromConfig(config: TipBatchConfig): string[] {
  viewer.tips.registerTexture('pos', config.textureUrl);
  const tipIds: string[] = [];
  for (const tip of config.tips) {
    viewer.tips.addTipSync(tip.id, tip.position, {
      textureUrl: config.textureUrl,
      size: config.size,
      sizeAttenuation: config.sizeAttenuation ?? true,
      userData: { curName: tip.curName },
    });
    tipIds.push(tip.id);
  }
  return tipIds;
}

function runAfterFirstPaint(task: () => void, delayMs = 150): void {
  // 比 requestIdleCallback 更可控：确保首帧出来后再执行，并且一定会触发
  window.requestAnimationFrame(() => {
    window.setTimeout(task, delayMs);
  });
}

async function setupFabBackground(config: FabBackgroundConfig): Promise<void> {
  const tex = await new THREE.TextureLoader().loadAsync(config.imageUrl);
  tex.colorSpace = THREE.SRGBColorSpace;

  const [cx, cy, cz] = config.center;
  const s = config.scale;

  const bgMat = new THREE.SpriteMaterial({
    map: tex,
    depthWrite: false,
    depthTest: false,
    transparent: true,
  });
  const bgSprite = new THREE.Sprite(bgMat);
  bgSprite.name = 'fabBackgroundSprite';
  bgSprite.renderOrder = config.renderOrder;
  bgSprite.position.set(cx, cy, cz);
  bgSprite.scale.set(s, s, 1);
  viewer.scene.add(bgSprite);

  const ctl = viewer.navigator.controls;
  if (ctl && config.lockControls) {
    ctl.enableRotate = false;
    ctl.enablePan = false;
    ctl.minDistance = config.minDistance;
    ctl.maxDistance = config.maxDistance;
    ctl.update();
  }
}

/**
 * 静态园区鸟瞰 PNG 贴平面 + 若干 Sprite；仅缩放（轨道旋转/平移关闭）。
 * 打点坐标为相对图幅的比例，可按实际图微调 `u`/`v`。
 */
async function runFabBackgroundDemo() {
  document.body.classList.add('fab-bg-demo');

  const hdr = document.querySelector('header small');
  if (hdr) {
    hdr.innerHTML =
      'Fab 背景图模式 <code>?fabBg=1</code> · 加载一个大 Sprite 作为背景 · 点击 Sprite 看控制台';
  }
  await setupFabBackground(FAB_BG_CONFIG);
  const tipIds = addTipsFromConfig(FAB_TIPS_CONFIG);
  attachTipDomPopups(tipIds);
}

async function run() {
  // console.time('first-visible');
  const root = await viewer.load(MODEL_URL, { attachToRoot: true });

  // userData.type === 'pipe' 的管道初始化隐藏
  viewer.setVisibilityByUserData({ type: 'pipe' }, false);
  // console.timeEnd('first-visible');

  // Manual performance controls（排除 pipe、ground，保留层级以便交互）
  const hasGroundInAncestry = (o: THREE.Object3D) =>
    String((o.userData as { name?: string }).name ?? '').includes('ground');
  // runAfterFirstPaint(() => {
    // console.time('post-optimize');
    viewer.optimizeInstancing({
      minCount: 2,
      enableInstanceColor: true,
      excludeUserData: { type: 'pipe' },
      excludeFilter: hasGroundInAncestry,
    });
    viewer.optimizeMerge({
      groupByMaterial: true,
      disposeSources: false,
      excludeUserData: { type: 'pipe' },
      excludeFilter: hasGroundInAncestry,
    });
    // console.timeEnd('post-optimize');
  // }, 200);

  // 管道显隐切换按钮
  let pipesVisible = false;
  const btn = document.querySelector<HTMLButtonElement>('#toggle-pipe');
  if (btn) {
    const updateLabel = () => {
      btn.textContent = pipesVisible ? '管道 隐藏' : '管道 显示';
    };
    updateLabel();
    btn.addEventListener('click', () => {
      pipesVisible = !pipesVisible;
      viewer.setVisibilityByUserData({ type: 'pipe' }, pipesVisible);
      updateLabel();
    });
  }

  // 调试：打印整个场景树
  // viewer.debugPrintScene();
  // 调试：打印所有 interact=true 的可交互对象，以及“点不到”的 mesh
  // viewer.debugPrintInteractables();

  // Influence zone example (dynamic overlay)
  viewer.upsertInfluenceZone(
    'zone-A',
    { kind: 'sphere', center: [0, 1, 0], radius: 1.2 },
    { color: 0x66ff66, opacity: 0.12 },
  );

  // userData.name 包含 'ground' 的 mesh 上方添加 tip，使用 pos.png（含自身或祖先）
  viewer.tips.registerTexture('pos', '/icons/pos.png');
  const { tipIds, targetMap } = viewer.addTipsForMeshes(
    hasGroundInAncestry, // 复用上面的 filter
    {
      textureUrl: '/icons/pos.png',
      size: 1,
      sizeAttenuation: true,
      interact: true,
      offset: 2.5,
    },
  );
  console.debug(`[tips] added ${tipIds.length} tips for ground meshes`);

  // 巡检：以 ground 为站点，上一站/下一站/恢复
  const inspectTargets = tipIds.map((id) => targetMap.get(id)).filter(Boolean) as THREE.Object3D[];
  let inspectIndex = -1;
  const updateInspectInfo = () => {
    const el = document.getElementById('inspect-info');
    if (el) {
      el.textContent = inspectTargets.length
        ? inspectIndex >= 0
          ? `${inspectIndex + 1}/${inspectTargets.length}`
          : `-/${inspectTargets.length}`
        : '0/0';
    }
  };
  const focusInspectTarget = (idx: number) => {
    if (idx < 0 || idx >= inspectTargets.length) return;
    inspectIndex = idx;
    updateInspectInfo();
    // 巡检 focus：弱高亮（交互层），与报警等状态层强高亮可同时存在
    viewer.setInteractionHighlightObject(inspectTargets[idx]!, {
      color: 0x4fc3f7,
      emissiveIntensity: 1.0,
      breathing: true,
      breathingMax: 0.22,
    });
    viewer.focus(inspectTargets[idx]!, { durationMs: 600, padding: 1.4 }).catch(() => void 0);
  };
  document.getElementById('inspect-prev')?.addEventListener('click', () => {
    if (inspectTargets.length === 0) return;
    inspectIndex = (inspectIndex - 1 + inspectTargets.length) % inspectTargets.length;
    focusInspectTarget(inspectIndex);
  });
  document.getElementById('inspect-next')?.addEventListener('click', () => {
    if (inspectTargets.length === 0) return;
    // setInterval(() => {
      inspectIndex = (inspectIndex + 1) % inspectTargets.length;
      focusInspectTarget(inspectIndex);
    // }, 5000);
  });
  document.getElementById('inspect-restore')?.addEventListener('click', () => {
    inspectIndex = -1;
    updateInspectInfo();
    viewer.clearInteractionHighlight();
    viewer.clearOcclusionDimming();
    viewer.focus(root, { durationMs: 600, padding: 1.6 }).catch(() => void 0);
  });
  updateInspectInfo();

  // 预设视角切换
  const viewPresets = ['front', 'top', 'topLeft', 'topRight'] as const;
  viewPresets.forEach((preset) => {
    document.getElementById(`view-${preset}`)?.addEventListener('click', () => {
      viewer.setView(preset, { animate: true, durationMs: 400 });
    });
  });

  attachTipDomPopups(tipIds);

  // 路径漫游示例：围绕场景做一圈
  const roamPoints: RoamPathPoint[] = [
    { position: [0, 36, 44], lookAt: [0, 0, 0] },
    { position: [36, 36, 0], lookAt: [0, 0, 0] },
    { position: [0, 86, -40], lookAt: [0, 0, 0] },
    { position: [-36, 20, 0], lookAt: [0, 0, 0] },
  ];
  document.getElementById('roam-start')?.addEventListener('click', () => {
    viewer.startRoaming(roamPoints, { durationMs: 30000, loop: true });
  });
  document.getElementById('roam-stop')?.addEventListener('click', () => {
    viewer.stopRoaming();
  });

  // Optional: focus whole loaded root at start
  // await viewer.focus(root, { durationMs: 700, padding: 1.6 });
  const center = new THREE.Vector3(); // 模型中心
new THREE.Box3().setFromObject(root).getCenter(center);

const target = viewer.navigator.controls?.target.clone() ?? new THREE.Vector3(0, 0, 0);
const delta = center.clone().sub(target);

// 保持角度，只做平移
viewer.camera.position.add(delta);
viewer.navigator.controls?.target.add(delta);
viewer.navigator.controls?.update();
}

async function main() {
  if (FAB_BG_DEMO) await runFabBackgroundDemo();
  else await run();
}

main().catch((e) => console.error(e));

