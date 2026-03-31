/**
 * 危险/环境监测类场效应的**纯视觉配置**（与后端推送、网络分层无关）。
 * 由业务将状态映射为下列 spec，再交给 HazardFieldLayer 渲染。
 */

export type HazardFieldKind = 'gas' | 'liquid' | 'heat';

/** 气体扩散：多层半透明球壳，中心密、边缘淡 */
export interface GasPlumeVisualConfig {
  /** 最外球半径（世界单位） */
  radius: number;
  /** 颜色（乘到每层不透明度上） */
  color: number;
  /** 最内层峰值不透明度量级（各层递减） */
  opacityPeak: number;
  /** 球壳层数，≥1 */
  shellCount: number;
  /** 渲染排序，越大越靠后绘制 */
  renderOrder: number;
}

/** 漏液/积液：水平圆盘，径向衰减 */
export interface LiquidPoolVisualConfig {
  radius: number;
  color: number;
  opacityPeak: number;
  /** 边缘软化，越大边缘越柔和 */
  edgeSoftness: number;
  renderOrder: number;
}

/** 区域温度热力：水平平面上的高斯热点（可叠加多 spec） */
export interface HeatFieldVisualConfig {
  /** 平面在 XZ 上的半宽（平面尺寸为 2*planeHalfSize） */
  planeHalfSize: number;
  /** 高斯特征半径（约到边缘 e^-1 量级，可调） */
  sigma: number;
  hotColor: number;
  coldColor: number;
  opacity: number;
  renderOrder: number;
}

export const DEFAULT_GAS_VISUAL: GasPlumeVisualConfig = {
  radius: 4.5,
  color: 0x44ffcc,
  opacityPeak: 0.52,
  shellCount: 7,
  renderOrder: 120,
};

export const DEFAULT_LIQUID_VISUAL: LiquidPoolVisualConfig = {
  radius: 3.8,
  color: 0xffaa33,
  opacityPeak: 0.62,
  edgeSoftness: 0.42,
  renderOrder: 110,
};

export const DEFAULT_HEAT_VISUAL: HeatFieldVisualConfig = {
  planeHalfSize: 22,
  sigma: 7.5,
  hotColor: 0xff6622,
  coldColor: 0x1133aa,
  opacity: 0.55,
  renderOrder: 100,
};

export type HazardFieldSpec =
  | {
      id: string;
      kind: 'gas';
      position: [number, number, number];
      visual?: Partial<GasPlumeVisualConfig>;
    }
  | {
      id: string;
      kind: 'liquid';
      position: [number, number, number];
      visual?: Partial<LiquidPoolVisualConfig>;
    }
  | {
      id: string;
      kind: 'heat';
      position: [number, number, number];
      visual?: Partial<HeatFieldVisualConfig>;
    };

export function mergeGasVisual(p?: Partial<GasPlumeVisualConfig>): GasPlumeVisualConfig {
  return { ...DEFAULT_GAS_VISUAL, ...p };
}

export function mergeLiquidVisual(p?: Partial<LiquidPoolVisualConfig>): LiquidPoolVisualConfig {
  return { ...DEFAULT_LIQUID_VISUAL, ...p };
}

export function mergeHeatVisual(p?: Partial<HeatFieldVisualConfig>): HeatFieldVisualConfig {
  return { ...DEFAULT_HEAT_VISUAL, ...p };
}
