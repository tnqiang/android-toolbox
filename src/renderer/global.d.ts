import type { ApiType } from '../preload/index';

declare global {
  interface Window {
    api: ApiType;
  }
}

// Vite 的静态资源 import（png / jpg / svg 等）默认有类型，
// 但为了稳妥起见显式声明一下
declare module '*.png' {
  const src: string;
  export default src;
}
declare module '*.jpg' {
  const src: string;
  export default src;
}
declare module '*.svg' {
  const src: string;
  export default src;
}

export {};
