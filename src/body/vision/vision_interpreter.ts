/**
 * 视觉：现拍一张图，返回 base64 JPEG；同时记下**这一帧自己的**朝向与颜色统计，
 * 供 Live State 快照引用。
 *
 * 这一层只做"拍 + 记"，不做任何世界判断；版本不支持时直接拒绝初始化（不出错图）。
 */
import fs from 'node:fs';
import { getVersion, supportedVersions } from 'prismarine-viewer/viewer/lib/version.js';
import { Camera } from './camera.ts';
import { frameRecordOf, type FrameColor, type FrameView } from './frame_record.ts';

export interface VisionOptions {
  bot: any;
  /** 截图目录（通常是 `bots/<name>/screenshots/`）。 */
  dir: string;
  /** 等相机就绪的上限（毫秒），默认 10 秒。 */
  readyTimeoutMs?: number;
}

export class VisionInterpreter {
  readonly bot: any;
  readonly dir: string;
  readonly camera: Camera;
  private readonly readyTimeoutMs: number;

  /** 最近一次拍摄（文件名 + 拍摄时间），供快照引用。 */
  lastScreenshot: { file: string; takenAt: number } | null = null;
  /** 这一帧自己的朝向；null = 这一帧没记录。 */
  lastFrameView: FrameView | null = null;
  /** 这一帧有没有颜色；null = 没测到。 */
  lastFrameColor: FrameColor | null = null;

  constructor(options: VisionOptions) {
    // **版本必须原生支持，不做任何兼容手术。**
    // prismarine-viewer 的方块表/贴图/模型只按它自己支持的版本出；世界版本对不上时，
    // 画面会静默画错（把 A 画成 B，或者「?」）。宁可不出图、只用文本快照，
    // 也不给模型一张错的图——错图比没图更贵。在这里就失败：连渲染器都不初始化。
    const worldVersion = String(options.bot?.version ?? '');
    if (getVersion(worldVersion) !== worldVersion) {
      const highest = supportedVersions[supportedVersions.length - 1];
      throw new Error(
        `渲染器不支持世界版本 ${worldVersion}（prismarine-viewer 最高 ${highest}）：` +
          '视觉关闭，只用文本；把服务器固定到受支持的版本即可。',
      );
    }
    this.bot = options.bot;
    this.dir = options.dir.endsWith('/') ? options.dir : `${options.dir}/`;
    this.readyTimeoutMs = options.readyTimeoutMs ?? 10_000;
    this.camera = new Camera(options.bot, this.dir);
  }

  /** 现拍一张返回 base64；相机没就绪/拍失败返回 null，调用方直接跳过图片。 */
  async captureBase64(): Promise<string | null> {
    try {
      // 相机 init 是异步的（worldView 就绪才放行）。
      const deadline = Date.now() + this.readyTimeoutMs;
      while ((this.camera as { worldView?: unknown }).worldView == null && Date.now() < deadline) {
        await new Promise<void>((resolve) => setTimeout(resolve, 200));
      }
      if ((this.camera as { worldView?: unknown }).worldView == null) return null;

      const shot = await this.camera.capture();
      const record = frameRecordOf(shot, Date.now());
      if (record == null) {
        this.lastScreenshot = null;
        this.lastFrameView = null;
        return null;
      }
      this.lastScreenshot = { file: record.file, takenAt: record.takenAt };
      this.lastFrameView = record.view;
      this.lastFrameColor = record.color ?? null;
      return fs.readFileSync(`${this.dir}${record.file}.jpg`).toString('base64');
    } catch (error: unknown) {
      // 截图失败不能炸轮次：本轮只给文本。
      const message = error instanceof Error ? error.message : String(error);
      console.warn('screenshot capture failed:', message);
      return null;
    }
  }
}
