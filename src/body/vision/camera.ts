import { Viewer } from 'prismarine-viewer/viewer/lib/viewer.js';
import { WorldView } from 'prismarine-viewer/viewer/lib/worldView.js';
import { getBufferFromStream } from 'prismarine-viewer/viewer/lib/simpleUtils.js';

import THREE from 'three';
import { createCanvas } from 'node-canvas-webgl/lib/index.js';
import fs from 'fs/promises';
import { Buffer } from 'node:buffer';
import { Vec3 } from 'vec3';
import { EventEmitter } from 'events';

import worker_threads from 'worker_threads';

import { chromaStatsOf, colorFromStats, type FrameColor, type FrameView } from './frame_record.ts';
import { ensureViewerEntityTextures } from './assets.ts';
import { patchViewerEntityModels } from './entity_models.ts';

// prismarine-viewer 的 viewer 内部用的是**全局** THREE / Worker
// （见 node_modules/prismarine-viewer/viewer/lib/entity/Entity.js 的 `/* global THREE */`）。
// 它自己的 headless 入口（lib/headless.js）会设置这两个全局，而我们只用了
// viewer/lib 的子路径，所以要自己装。
//
// 以前这里是靠 browser_viewer.ts 里那句 `import prismarine-viewer`（根模块会
// eager-require headless，从而设置全局）顺带装上的——**别把别人的副作用当依赖**：
// 删掉那个文件，截图链就静默断掉（屏幕全黑/报 THREE is not defined）。
(global as unknown as Record<string, unknown>).THREE = THREE;
(global as unknown as Record<string, unknown>).Worker = worker_threads.Worker;

// 朝向的类型在 `frame_record.ts`（纯逻辑，测试里不会把 `window` 带进来）。

export class Camera extends EventEmitter {
    bot: any; // mineflayer 无类型，bot 统一 any
    fp: string;
    viewDistance: number;
    width: number;
    height: number;
    canvas: any;
    renderer: any;
    viewer: any;
    worldView: any;

    constructor (bot: any, fp: string) {
        super();
        this.bot = bot;
        this.fp = fp;
        this.viewDistance = 12;
        this.width = 800;
        this.height = 512;
        this.canvas = createCanvas(this.width, this.height);
        this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas });
        this.viewer = new Viewer(this.renderer);
        this._init()
            .then(() => {
                this.emit('ready');
            })
            .catch((error: unknown) => {
                // 相机初始化失败不能变成未处理 rejection：截图链退化为纯文本。
                console.warn('[vision] camera init failed:', error instanceof Error ? error.message : String(error));
                this.emit('failed');
            });
    }

    async _init (): Promise<void> {
        // 实体贴图必须先就位：缺一张图就可能让 loadImage 抛未处理 rejection 杀掉进程。
        const assets = ensureViewerEntityTextures();
        if (!assets.ok) throw new Error(assets.error ?? '实体贴图不可用');
        if (assets.copied) console.log('[vision] 已从仓库复制实体贴图到 viewer:', assets.target);
        const botPos = this.bot.entity.position;
        const center = new Vec3(botPos.x, botPos.y+this.bot.entity.height, botPos.z);
        this.viewer.setVersion(this.bot.version);
        // Load world
        const worldView = new WorldView(this.bot.world, this.viewDistance, center);
        this.viewer.listen(worldView);
        worldView.listenToBot(this.bot);
        await worldView.init(center);
        this.worldView = worldView;
    }

    /**
     * 拍一张。
     *
     * **返回文件名 + 这一帧自己的朝向**：朝向在**渲染这一帧的那一行**读、
     * 和 `setFirstPersonCamera` 用的是**同一次读数**，所以回执里说"这张图朝哪"
     * 永远是**这一帧**的事实，不是"几秒后身体又转到哪了"（真机事故：
     * 快照说"朝天空（pitch −88°）"、图里却是水平隧道 ⇒ bot 正确地不信图、丢掉好画面）。
     */
    async capture(): Promise<{ file: string; view: FrameView; color: FrameColor | null }> {
        const center = new Vec3(this.bot.entity.position.x, this.bot.entity.position.y+this.bot.entity.height, this.bot.entity.position.z);
        this.viewer.camera.position.set(center.x, center.y, center.z);
        await this.worldView.updatePosition(center);
        // **这一帧的朝向**：就在喂给相机之前读一次，和下面 setFirstPersonCamera 同一个来源。
        const yaw = Number(this.bot.entity.yaw);
        const pitch = Number(this.bot.entity.pitch);
        this.viewer.setFirstPersonCamera(this.bot.entity.position, yaw, pitch);
        this.viewer.update();
        this.renderer.render(this.viewer.scene, this.viewer.camera);

        // **这一帧到底有没有颜色**（真机 overnight_b：画面清晰可读却全灰，同会话时有时无）。
        // 量的是渲染出来的像素，不是 JPEG 字节：`readPixels` 拿的是渲染结果的 RGB，
        // 正好覆盖"WebGL 上下文丢色/没开色彩缓冲 / 贴图退化成灰度"这两类。
        // 量不到就记 null（回执**什么都不说**，不许猜"应该是彩色"）。
        let color: FrameColor | null = null;
        try {
            const gl = this.renderer.getContext() as unknown as {
                readPixels: (x: number, y: number, w: number, h: number, format: number, type: number, pixels: Uint8Array) => void;
                RGBA: number;
                UNSIGNED_BYTE: number;
            };
            const w = Number(this.canvas.width);
            const h = Number(this.canvas.height);
            const pixels = new Uint8Array(w * h * 4);
            gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
            // **尾部/覆盖率统计**，不是平均：灰墙为主的画面平均彩度低，
            // 但只要有一块矿（彩色像素占比够）就不能判"丢颜色"（真机 overnight_b）。
            color = colorFromStats(chromaStatsOf(pixels, w, h, 7));
        } catch {
            color = null;
        }

        const imageStream = this.canvas.createJPEGStream({
            bufsize: 4096,
            quality: 100,
            progressive: false
        });

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `screenshot_${timestamp}`;

        const buf: Buffer = await getBufferFromStream(imageStream);
        await this._ensureScreenshotDirectory();
        await fs.writeFile(`${this.fp}/${filename}.jpg`, buf);
        console.log('saved', filename);
        if (color?.grayscale === true) {
            console.warn('screenshot is grayscale', { file: filename, ...color });
        }
        return {
            file: filename,
            // 读不到就记 null（回执会**什么都不说**，而不是拿当前朝向冒充这一帧）
            view: { yaw: Number.isFinite(yaw) ? yaw : null, pitch: Number.isFinite(pitch) ? pitch : null },
            color,
        };
    }

    async _ensureScreenshotDirectory(): Promise<void> {
        let stats: { isDirectory(): boolean } | undefined;
        try {
            stats = await fs.stat(this.fp);
        } catch (e: unknown) {
            void e;
            if (!stats?.isDirectory()) {
                await fs.mkdir(this.fp);
            }
        }
    }
}
