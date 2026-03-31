import { HazardFieldLayer, Viewer, type HazardFieldSpec } from '../src';
import { applySceneConfig } from './sceneConfig';
import { modelDemoConfig } from './scenePresets';

const canvas = document.querySelector<HTMLCanvasElement>('#c');
if (!canvas) throw new Error('#c canvas not found');

const STUDIO_LIGHTING = {
  hemiIntensity: 1.38,
  dirIntensity: 2.35,
  shadows: 'auto' as const,
  extraDirections: [
    { position: [-16, 24, 12] as [number, number, number], intensity: 1.05 },
    { position: [24, 16, -20] as [number, number, number], intensity: 0.7 },
  ],
};

const viewer = new Viewer({
  canvas,
  enableDraco: true,
  dracoDecoderPath: '/draco/',
  enableOrbitControls: true,
  enableDrag: false,
  enableBVH: true,
  enableRoaming: false,
  clearColor: 0x1a1f2e,
  lighting: STUDIO_LIGHTING,
});

const hazardLayer = HazardFieldLayer.attachToViewer(viewer);

/** 与示例机房模型大致同量级坐标（地面附近 + 空中） */
function buildSpecs(): HazardFieldSpec[] {
  const list: HazardFieldSpec[] = [];
  if ((document.querySelector('#ck-gas') as HTMLInputElement)?.checked) {
    list.push({
      id: 'demo-gas',
      kind: 'gas',
      position: [14, 5, 4],
      visual: { radius: 5, color: 0x66ffaa, opacityPeak: 0.42, shellCount: 6 },
    });
  }
  if ((document.querySelector('#ck-liquid') as HTMLInputElement)?.checked) {
    list.push({
      id: 'demo-liquid',
      kind: 'liquid',
      position: [10, 1.45, 6],
      visual: { radius: 4.5, color: 0xd4882c, opacityPeak: 0.5, edgeSoftness: 0.4 },
    });
  }
  if ((document.querySelector('#ck-heat') as HTMLInputElement)?.checked) {
    list.push({
      id: 'demo-heat',
      kind: 'heat',
      position: [6, 1.43, 2],
      visual: {
        planeHalfSize: 18,
        sigma: 7,
        hotColor: 0xff5533,
        coldColor: 0x2244aa,
        opacity: 0.45,
      },
    });
  }
  return list;
}

function applyHazards() {
  hazardLayer.setSpecs(buildSpecs());
}

async function main() {
  const cfg = structuredClone(modelDemoConfig);
  await applySceneConfig(viewer, cfg);
  applyHazards();

  document.querySelector('#btn-refresh')?.addEventListener('click', () => applyHazards());
  document.querySelector('#btn-clear')?.addEventListener('click', () => {
    hazardLayer.clear();
  });

  for (const id of ['ck-gas', 'ck-liquid', 'ck-heat']) {
    document.querySelector(`#${id}`)?.addEventListener('change', () => applyHazards());
  }
}

main().catch((e) => console.error(e));
