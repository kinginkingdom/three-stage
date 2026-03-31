import type { SceneConfig } from '../src';

export const bgDemoConfig: SceneConfig = {
  version: '1.0.0',
  scene: {
    source: {
      kind: 'background',
      background: {
        imageUrl: '/models/fab.png',
        position: [0, 0, 0],
        scale: [50, 50, 1],
        renderOrder: -1000,
        visible: true,
      },
    },
  },
  tips: [
    {
      id: 'tip-fab',
      textureUrl: '/icons/pos.png',
      position: [-8.8, 2.2, 0.03],
      size: 0.55,
      sizeAttenuation: true,
      interact: true,
      visible: true,
      binding: { name: 'FAB', deviceId: 'fab-001', type: 'area' },
    },
    {
      id: 'tip-pmd',
      textureUrl: '/icons/pos.png',
      position: [-1.7, 3.3, 0.03],
      size: 0.55,
      binding: { name: 'PMD', deviceId: 'pmd-001', type: 'device' },
    },
  ],
  cameras: {
    defaultViewId: 'view-main',
    views: [
      { id: 'view-main', name: '主视角', position: [0, 0, 18], target: [10, 0, 0], fov: 50 },
      { id: 'view-left', name: '左侧', position: [-14, 6, 8], target: [0, 0, 0], fov: 48 },
      { id: 'view-top', name: '俯视', position: [0, 28, 0.1], target: [0, 0, 0], fov: 50 },
    ],
  },
};

export const modelDemoConfig: SceneConfig = {
  version: '1.0.0',
  scene: {
    source: {
      kind: 'model',
      models: [
        {
          id: 'main',
          url: '/models/P2_FAB_F1_update_draco.glb',
          position: [0, 0, 0],
          rotation: [0, 0, 0],
          scale: [1, 1, 1],
          visible: true,
        },
      ],
    },
  },
  tips: [],
  cameras: {
    defaultViewId: 'view-main',
    views: [
      {
        id: 'view-main',
        name: '默认视角',
        position: [15.6, 110.3, 91.4],
        target: [9.6, -1.79, 2.25],
        fov: 50,
      },
      {
        id: 'view-patrol',
        name: '巡视',
        position: [28, 72, 48],
        target: [8, 4, 4],
        fov: 48,
      },
      {
        id: 'view-low',
        name: '低机位',
        position: [22, 18, 36],
        target: [10, 2, 6],
        fov: 52,
      },
    ],
  },
};
