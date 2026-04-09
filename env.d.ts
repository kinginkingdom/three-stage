/// <reference types="vite/client" />
/// <reference types="element-plus/global" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  /**
   * 第二泛型为 script setup 暴露给模板的绑定类型。
   * 使用 `object` 会导致模板里大量 “Cannot find name …”。
   */
  const component: DefineComponent<{}, any, any>;
  export default component;
}
