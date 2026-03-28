/**
 * 场景配置协议（与业务无关）：展示态 apply、编辑态 capture 共用。
 * `binding` 为透传业务字段，库不解析其含义。
 */

export type SceneConfigVec3 = [number, number, number];

export type SceneSource =
  | { kind: 'background'; background: SceneBackgroundConfig }
  | { kind: 'model'; models: SceneModelConfig[] };

export interface SceneBackgroundConfig {
  imageUrl: string;
  position: SceneConfigVec3;
  scale: SceneConfigVec3;
  renderOrder?: number;
  visible?: boolean;
}

export interface SceneModelConfig {
  id?: string;
  url: string;
  position?: SceneConfigVec3;
  rotation?: SceneConfigVec3;
  scale?: SceneConfigVec3;
  visible?: boolean;
  userData?: Record<string, unknown>;
}

export interface SceneTipConfig {
  id: string;
  textureUrl: string;
  position: SceneConfigVec3;
  size?: number;
  sizeAttenuation?: boolean;
  interact?: boolean;
  visible?: boolean;
  binding?: Record<string, unknown>;
}

export interface SceneCameraViewConfig {
  id: string;
  name?: string;
  position: SceneConfigVec3;
  target: SceneConfigVec3;
  fov?: number;
}

export interface SceneCameraConfig {
  defaultViewId?: string;
  views: SceneCameraViewConfig[];
}

export interface SceneConfig {
  version: string;
  scene: { source: SceneSource };
  tips?: SceneTipConfig[];
  cameras: SceneCameraConfig;
}

/** 简短别名，便于业务代码与旧示例对齐 */
export type Vec3 = SceneConfigVec3;
export type BackgroundConfig = SceneBackgroundConfig;
export type ModelConfig = SceneModelConfig;
export type TipConfig = SceneTipConfig;
export type CameraViewConfig = SceneCameraViewConfig;
export type CameraConfig = SceneCameraConfig;
