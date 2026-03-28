/** Demo 设备主数据（真实设备） */
export interface DemoDevice {
  id: string;
  name: string;
  type: string;
}

/** Demo 设备组 */
export interface DemoDeviceGroup {
  code: string;
  name: string;
  typeLabel: string;
}

export const MOCK_DEVICES: DemoDevice[] = [
  { id: 'LV_40D3A1', name: '变配电柜 A1', type: '低压柜' },
  { id: 'LV_40D3A2', name: '变配电柜 A2', type: '低压柜' },
  { id: 'LV_40D3A3', name: '变配电柜 A3', type: '低压柜' },
  { id: 'F2_CUS_B1_HHW_CP01', name: '温湿度传感器 01', type: '传感器' },
  { id: 'ALM_FAB_001', name: '声光报警器', type: '报警设备' },
];

export const MOCK_DEVICE_GROUPS: DemoDeviceGroup[] = [
  { code: 'GRP_LV_ROW1', name: '低压柜第一排设备组', typeLabel: '设备组' },
  { code: 'GRP_SENSOR_ZONE_A', name: 'A 区传感器组', typeLabel: '设备组' },
];

export function findDevice(id: string): DemoDevice | undefined {
  return MOCK_DEVICES.find((d) => d.id === id);
}

export function findGroup(code: string): DemoDeviceGroup | undefined {
  return MOCK_DEVICE_GROUPS.find((g) => g.code === code);
}
