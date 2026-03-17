import * as THREE from 'three';
import { Viewer } from '../src';

// Replace with your Draco GLB/GLTF URL (must be reachable by the dev server).
// If you serve draco decoders from /public/draco, keep dracoDecoderPath as '/draco/'.
const MODEL_URL = '/models/P2_FAB_F1_update_draco.glb';

const canvas = document.querySelector<HTMLCanvasElement>('#c');
if (!canvas) throw new Error('Canvas not found');

const viewer = new Viewer({
  canvas,
  enableDraco: true,
  dracoDecoderPath: '/draco/',
  enableOrbitControls: true,
  enableDrag: true,
  enableBVH: true,
  clearColor: 0xffffff,
  lighting: {
    shadows: 'auto',
    shadowCatcher: true,
    shadowCameraSize: 120,  // 大场景时调大，避免阴影出现方形裁切
    extraDirections: [
      { position: [0, 15, 0], intensity: 0.8 },           // 顶光
      { position: [8, 8, 8], intensity: 0.6 },           // 平行光1：左前上
      { position: [-8, 6, -6], intensity: 0.5 },        // 平行光2：右后上
    ],
  },
  optimizer: { frustumCulling: true, keepOriginals: false },
});

viewer.on('load-progress', (p) => {
  // high-signal progress hook
  if (p.url) console.debug(`[load] ${p.phase} ${p.url} ${(p.ratio * 100).toFixed(1)}%`);
});

viewer.on('object-click', (hit) => {
  console.log(hit, 'hit');
  viewer.setHighlightFromInteraction(hit, { color: 0x00e5ff, emissiveIntensity: 1.2 });
  const target = viewer.resolveInteractionTarget(hit);
  if (target) {
    viewer.focus(target, { durationMs: 500, padding: 1.4 }).catch(() => void 0);
  }
});

// Tip 旁 DOM 弹框：常驻显示 curName 等，每个 tip 一个
const tipPopupsContainer = document.getElementById('tip-popups');

async function run() {
  const root = await viewer.load(MODEL_URL, { attachToRoot: true });

  // userData.type === 'pipe' 的管道初始化隐藏
  viewer.setVisibilityByUserData({ type: 'pipe' }, false);

  // Manual performance controls（排除 pipe、ground，保留层级以便交互）
  const hasGroundInAncestry = (o: THREE.Object3D) =>
    String((o.userData as { name?: string }).name ?? '').includes('ground');
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
      size: 0.05,
      sizeAttenuation: false,
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
    viewer.setHighlightObject(inspectTargets[idx]!);
    viewer.focus(inspectTargets[idx]!, { durationMs: 600, padding: 1.4 }).catch(() => void 0);
  };
  document.getElementById('inspect-prev')?.addEventListener('click', () => {
    if (inspectTargets.length === 0) return;
    inspectIndex = (inspectIndex - 1 + inspectTargets.length) % inspectTargets.length;
    focusInspectTarget(inspectIndex);
  });
  document.getElementById('inspect-next')?.addEventListener('click', () => {
    if (inspectTargets.length === 0) return;
    inspectIndex = (inspectIndex + 1) % inspectTargets.length;
    focusInspectTarget(inspectIndex);
  });
  document.getElementById('inspect-restore')?.addEventListener('click', () => {
    inspectIndex = -1;
    updateInspectInfo();
    viewer.setHighlightObject(null);
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

  // 常驻 DOM 弹框：每个 tip 一个，显示 curName 等
  const popups: { el: HTMLElement; sprite: THREE.Sprite }[] = [];
  tipIds.forEach((id) => {
    const sprite = viewer.tips.getTip(id);
    if (!sprite) return;
    const el = document.createElement('div');
    el.className = 'tip-popup';
    el.dataset.tipId = id;
    const ud = sprite.userData as Record<string, unknown>;
    el.innerHTML = `
      <!-- <div class="label">curName</div> -->
      <div class="value">${String(ud.curName ?? '-')}</div>
      <!-- <div class="label">name</div> -->
      <!-- <div class="value">${String(ud.name ?? '-')}</div> -->
    `;
    if (tipPopupsContainer) tipPopupsContainer.appendChild(el);
    popups.push({ el, sprite });
  });

  // 每帧更新所有 tip 弹框位置（用 transform 保留亚像素精度，减少拖拽时抖动）
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

  // Optional: focus whole loaded root at start
  await viewer.focus(root, { durationMs: 700, padding: 1.6 });
}

run().catch((e) => console.error(e));

