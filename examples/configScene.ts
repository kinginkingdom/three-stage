import { Viewer } from '../src';
import {
  applySceneConfig,
  bgDemoConfig,
  modelDemoConfig,
} from './sceneConfig';

const canvas = document.querySelector<HTMLCanvasElement>('#c');
if (!canvas) throw new Error('Canvas not found');

const viewer = new Viewer({
  canvas,
  enableDraco: true,
  dracoDecoderPath: '/draco/',
  enableOrbitControls: true,
  enableDrag: false,
  enableBVH: true,
  enableRoaming: false,
  clearColor: 0xffffff,
});

async function run() {
  const kind = new URLSearchParams(location.search).get('kind') ?? 'background';
  const cfg = kind === 'model' ? modelDemoConfig : bgDemoConfig;
  await applySceneConfig(viewer, cfg);
}

run().catch((e) => console.error(e));
