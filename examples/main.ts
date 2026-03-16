import { Viewer } from '../src';

// Replace with your Draco GLB/GLTF URL (must be reachable by the dev server).
// If you serve draco decoders from /public/draco, keep dracoDecoderPath as '/draco/'.
const MODEL_URL = '/models/xxx.glb';

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
  },
  optimizer: { frustumCulling: true, keepOriginals: false },
});

viewer.on('load-progress', (p) => {
  // high-signal progress hook
  if (p.url) console.debug(`[load] ${p.phase} ${p.url} ${(p.ratio * 100).toFixed(1)}%`);
});

viewer.on('object-click', (hit) => {
  console.log(hit,'hit');
  viewer.setHighlightFromInteraction(hit, { color: 0x00e5ff, emissiveIntensity: 1.2 });
  if (hit.intersectedObject) viewer.focus(hit.intersectedObject, { durationMs: 500, padding: 1.4 }).catch(() => void 0);
});

async function run() {
  const root = await viewer.load(MODEL_URL, { attachToRoot: true });

  // Manual performance controls
  viewer.optimizeInstancing({ minCount: 2, enableInstanceColor: true });
  viewer.optimizeMerge({ groupByMaterial: true, disposeSources: false });

  // Influence zone example (dynamic overlay)
  viewer.upsertInfluenceZone(
    'zone-A',
    { kind: 'sphere', center: [0, 1, 0], radius: 1.2 },
    { color: 0x66ff66, opacity: 0.12 },
  );

  // Optional: focus whole loaded root at start
  await viewer.focus(root, { durationMs: 700, padding: 1.6 });
}

run().catch((e) => console.error(e));

