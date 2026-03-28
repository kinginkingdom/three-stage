/**
 * Demo：前置「楼层房间 ↔ 场景资源」绑定结果。
 * 正式环境由列表页写入上下文，此处用选择弹窗 + URL ?roomId= 模拟。
 */
import type { SceneConfig } from '../sceneConfig';
import { bgDemoConfig, modelDemoConfig } from '../scenePresets';
import type { DemoDevice, DemoDeviceGroup } from './mockEquipment';

export interface RoomSceneContext {
  roomId: string;
  /** 如 1F · 变电所 */
  floorRoomLabel: string;
  /** 面包屑前缀 */
  buildingPath: string;
  /** 打开本页时加载的场景配置（含已有 Tip） */
  initialSceneConfig: SceneConfig;
}

function cloneModelWithSeedTip(): SceneConfig {
  const c = structuredClone(modelDemoConfig) as SceneConfig;
  c.tips = [
    {
      id: 'seed-tip-1',
      textureUrl: '/icons/temp.png',
      position: [12, 6, 2],
      size: 0.55,
      sizeAttenuation: true,
      interact: true,
      visible: true,
      binding: { name: 'TIP_进线柜监测', type: 'sensor' },
    },
  ];
  return c;
}

export const MOCK_ROOM_SCENES: RoomSceneContext[] = [
  {
    roomId: 'room-substation-1f',
    floorRoomLabel: '1F · 变电所',
    buildingPath: '创新中心 / CUB',
    initialSceneConfig: cloneModelWithSeedTip(),
  },
  {
    roomId: 'room-park-bg',
    floorRoomLabel: '园区 · 鸟瞰配图',
    buildingPath: '创新中心 / 室外',
    initialSceneConfig: structuredClone(bgDemoConfig) as SceneConfig,
  },
];

/** 按房间拉取设备（Demo） */
export const MOCK_DEVICES_BY_ROOM: Record<string, DemoDevice[]> = {
  'room-substation-1f': [
    { id: 'LV_40D3A1', name: '变配电柜 A1', type: '低压柜' },
    { id: 'LV_40D3A2', name: '变配电柜 A2', type: '低压柜' },
    { id: 'LV_40D3A3', name: '变配电柜 A3', type: '低压柜' },
    { id: 'F2_CUS_B1_HHW_CP01', name: '温湿度传感器 01', type: '传感器' },
    { id: 'ALM_FAB_001', name: '声光报警器', type: '报警设备' },
  ],
  'room-park-bg': [
    { id: 'PARK_CAM_01', name: '园区摄像头 01', type: '摄像头' },
    { id: 'PARK_ACCESS_01', name: '门禁控制器', type: '门禁' },
  ],
};

export const MOCK_GROUPS_BY_ROOM: Record<string, DemoDeviceGroup[]> = {
  'room-substation-1f': [
    { code: 'GRP_LV_ROW1', name: '低压柜第一排设备组', typeLabel: '设备组' },
    { code: 'GRP_SENSOR_ZONE_A', name: 'A 区传感器组', typeLabel: '设备组' },
  ],
  'room-park-bg': [{ code: 'GRP_PARK_NORTH', name: '北区设备组', typeLabel: '设备组' }],
};

export function getRoomContext(roomId: string): RoomSceneContext | undefined {
  return MOCK_ROOM_SCENES.find((r) => r.roomId === roomId);
}
