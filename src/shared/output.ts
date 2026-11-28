/**
 * 工具输出不设长度上限。
 *
 * pi-durable 默认会把工具回执截到 50 KiB / 2000 行；TinyCraft 的契约是完整返回，
 * 超长内容由调用方显式分页或报错，不允许框架静默丢掉中间部分。
 */
export const UNLIMITED_OUTPUT = {
  maxBytes: Infinity,
  maxLines: Infinity,
  retain: 'head',
} as const;
