/**
 * 直播链路专用调试日志
 * 生产构建启用了 babel transform-remove-console，会把字面量 console.* 调用全部移除。
 * 这里通过引用捕获 console.warn 函数绕过该转换，保证 Release APK 也能在
 * `adb logcat -s ReactNativeJS` 中看到 [ORION-DEBUG] 日志。
 */

type LogFn = (...args: any[]) => void;

const noop: LogFn = () => {};

let warn: LogFn = noop;
try {
  // eslint-disable-next-line no-console
  if (typeof console !== "undefined" && typeof console.warn === "function") {
    warn = console.warn.bind(console);
  }
} catch {
  warn = noop;
}

export const liveDebug = (message: string, ...args: any[]): void => {
  try {
    warn(`[ORION-DEBUG] ${message}`, ...args);
  } catch {
    // 忽略日志输出异常，绝不影响业务流程
  }
};
