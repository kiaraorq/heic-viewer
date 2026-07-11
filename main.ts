import { App, Modal, Plugin, PluginSettingTab, Setting, TFile, setIcon } from 'obsidian';
import { HeifDecoder, HeifImage } from 'libheif-js';

/* ========================================================================== *
 *  Settings                                                                  *
 * ========================================================================== */

type BackgroundMode = 'transparent' | 'black' | 'white' | 'custom';

interface HeicViewerSettings {
    invertColors: boolean;
    backgroundMode: BackgroundMode;
    customBackgroundColor: string;
}

const DEFAULT_SETTINGS: HeicViewerSettings = {
    invertColors: false,
    backgroundMode: 'transparent',
    customBackgroundColor: '#161616'
};

function backgroundColorFor(mode: BackgroundMode, custom: string): string {
    switch (mode) {
        case 'black': return '#000000';
        case 'white': return '#ffffff';
        case 'custom': return custom || '#161616';
        default: return 'transparent';
    }
}

// Gives an element a deliberate background behind image transparency.
// The color feeds the .heic-bg rule in styles.css via a CSS variable.
function setBackground(el: HTMLElement, mode: BackgroundMode, custom: string) {
    el.classList.add('heic-bg');
    el.setCssProps({ '--heic-bg': backgroundColorFor(mode, custom) });
}

/* ========================================================================== *
 *  HEIC decoding                                                             *
 * ========================================================================== */

// Decodes HEIC/HEIF bytes into a PNG blob, preserving the alpha channel.
async function decodeHeicToPngBlob(buffer: ArrayBuffer): Promise<Blob> {
    const images = new HeifDecoder().decode(buffer);
    if (!images || images.length === 0) throw new Error('no image found in file');

    const image: HeifImage = images[0];
    const width = image.get_width();
    const height = image.get_height();

    const imageData: ImageData = await new Promise((resolve, reject) => {
        image.display(new ImageData(width, height), (result: ImageData | null) => {
            if (!result) return reject(new Error('decode failed'));
            resolve(result);
        });
    });

    const canvas = activeDocument.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no canvas context');
    ctx.putImageData(imageData, 0, 0);

    return new Promise((resolve, reject) => {
        canvas.toBlob(blob => {
            if (!blob) return reject(new Error('PNG encoding failed'));
            resolve(blob);
        }, 'image/png');
    });
}

/* ========================================================================== *
 *  Plugin: finds HEIC embeds and swaps in converted images                   *
 * ========================================================================== */

export default class HeicViewerPlugin extends Plugin {
    settings!: HeicViewerSettings;

    // Converted images (vault path -> blob URL), least-recently-used eviction.
    private cache = new Map<string, string>();
    private cacheOrder: string[] = [];
    private readonly CACHE_LIMIT = 30;

    async onload() {
        await this.loadSettings();
        this.addSettingTab(new HeicSettingTab(this.app, this));
        this.registerInterval(window.setInterval(() => this.scan(), 300));
    }

    onunload() {
        this.cache.forEach(url => URL.revokeObjectURL(url));
        this.cache.clear();
        this.cacheOrder = [];
    }

    async loadSettings() {
        const data = (await this.loadData()) as Partial<HeicViewerSettings> | null;
        this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
    }

    async saveSettings() {
        await this.saveData(this.settings);
        this.refreshRenderedImages();
    }

    /* ---- Embed scanning ---------------------------------------------------- */

    private scan() {
        activeDocument.querySelectorAll('.internal-embed').forEach(el => {
            if (!el.instanceOf(HTMLElement)) return;
            const src = el.getAttribute('src');
            if (!src) return;

            const lower = src.toLowerCase();
            if (!lower.endsWith('.heic') && !lower.endsWith('.heif')) return;

            void this.ensureRendered(el, src);

            // Obsidian (mobile especially) re-adds its "unsupported file" link
            // inside the embed at arbitrary times; keep everything that isn't
            // ours hidden on every pass.
            el.childNodes.forEach(child => {
                if (!child.instanceOf(HTMLElement)) return;
                if (child.hasClass('heic-own')) return;
                if (child.getCssPropertyValue('display') === 'none') return;
                child.setCssStyles({ display: 'none' });
            });
        });
    }

    private async ensureRendered(embed: HTMLElement, src: string) {
        if (embed.getAttribute('data-heic') === 'done') return;
        embed.setAttribute('data-heic', 'done');

        const activeFile = this.app.workspace.getActiveFile();
        const file = this.app.metadataCache.getFirstLinkpathDest(src, activeFile ? activeFile.path : '');
        if (!(file instanceof TFile)) return;

        const cached = this.cache.get(file.path);
        if (cached) {
            this.remember(file.path, cached);
            this.showImage(embed, cached, src);
            return;
        }

        // Convert lazily, once the embed is scrolled near the viewport.
        const placeholder = embed.createEl('div', {
            text: 'Scroll to load HEIC…',
            cls: 'heic-own heic-placeholder'
        });
        const observer = new IntersectionObserver((entries, obs) => {
            entries.forEach(entry => {
                if (!entry.isIntersecting) return;
                obs.unobserve(entry.target);
                placeholder.setText('Converting HEIC…');
                void this.convert(embed, file, src, placeholder);
            });
        }, { rootMargin: '50px' });
        observer.observe(placeholder);
    }

    private async convert(embed: HTMLElement, file: TFile, src: string, placeholder: HTMLElement) {
        try {
            const buffer = await this.app.vault.readBinary(file);
            const url = URL.createObjectURL(await decodeHeicToPngBlob(buffer));
            this.remember(file.path, url);
            placeholder.remove();
            this.showImage(embed, url, src);
        } catch (error: unknown) {
            placeholder.setText(`Failed to convert ${src}: ${error instanceof Error ? error.message : String(error)}`);
            placeholder.addClass('heic-error');
        }
    }

    private remember(path: string, url: string) {
        this.cache.set(path, url);
        this.cacheOrder = this.cacheOrder.filter(p => p !== path);
        this.cacheOrder.push(path);
        if (this.cacheOrder.length > this.CACHE_LIMIT) {
            const oldest = this.cacheOrder.shift();
            if (oldest) {
                const url = this.cache.get(oldest);
                if (url) URL.revokeObjectURL(url);
                this.cache.delete(oldest);
            }
        }
    }

    /* ---- Rendering ----------------------------------------------------------- */

    private showImage(embed: HTMLElement, url: string, src: string) {
        const img = embed.createEl('img', { cls: 'heic-own heic-image', attr: { alt: src } });
        img.src = url;
        img.classList.toggle('heic-invert', this.settings.invertColors);
        setBackground(embed, this.settings.backgroundMode, this.settings.customBackgroundColor);

        // Open our viewer; capture-phase + stopImmediatePropagation keeps
        // Obsidian's built-in image preview from hijacking the tap.
        img.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation();
            new HeicViewerModal(this.app, url, this.settings).open();
        }, { capture: true });

        // A failed blob load falls back to showing alt text (the filename);
        // show a clear message instead.
        img.addEventListener('error', () => {
            const msg = embed.createEl('div', {
                text: `Couldn't display ${src}.`,
                cls: 'heic-own heic-placeholder heic-error'
            });
            img.replaceWith(msg);
        });
    }

    private refreshRenderedImages() {
        activeDocument.querySelectorAll('img.heic-image').forEach(img => {
            img.classList.toggle('heic-invert', this.settings.invertColors);
            const embed = img.closest('.internal-embed');
            if (embed && embed.instanceOf(HTMLElement)) {
                setBackground(embed, this.settings.backgroundMode, this.settings.customBackgroundColor);
            }
        });
    }
}

/* ========================================================================== *
 *  Settings tab                                                              *
 * ========================================================================== */

class HeicSettingTab extends PluginSettingTab {
    constructor(app: App, private plugin: HeicViewerPlugin) {
        super(app, plugin);
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        new Setting(containerEl)
            .setName('Invert image colors')
            .setDesc('Inverts all HEIC images. Useful for reading scanned documents in dark themes.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.invertColors)
                .onChange(async value => {
                    this.plugin.settings.invertColors = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Background behind transparency')
            .setDesc('How to fill transparent regions of HEIC images.')
            .addDropdown(dropdown => dropdown
                .addOption('transparent', 'Transparent (default)')
                .addOption('black', 'Black')
                .addOption('white', 'White')
                .addOption('custom', 'Custom color')
                .setValue(this.plugin.settings.backgroundMode)
                .onChange(async value => {
                    this.plugin.settings.backgroundMode = value as BackgroundMode;
                    await this.plugin.saveSettings();
                    this.display();
                }));

        if (this.plugin.settings.backgroundMode === 'custom') {
            new Setting(containerEl)
                .setName('Custom background color')
                .addColorPicker(picker => picker
                    .setValue(this.plugin.settings.customBackgroundColor)
                    .onChange(async value => {
                        this.plugin.settings.customBackgroundColor = value;
                        await this.plugin.saveSettings();
                    }));
        }
    }
}

/* ========================================================================== *
 *  Fullscreen viewer                                                         *
 *                                                                            *
 *  Input handling uses Pointer Events exclusively: one code path for mouse,  *
 *  touch, and pen on every platform, instead of parallel mouse and touch     *
 *  systems that can disagree. Zoom always works via the on-screen buttons    *
 *  even if a gesture misbehaves on some device.                              *
 * ========================================================================== */

class HeicViewerModal extends Modal {
    private imgEl!: HTMLImageElement;
    private tempBackground: BackgroundMode | null = null;
    private static readonly BG_CYCLE: (BackgroundMode | null)[] = [null, 'black', 'white'];

    // Transform state. Scale 1 = image fitted to screen.
    private scale = 1;
    private tx = 0;
    private ty = 0;
    private readonly MIN_SCALE = 0.2;
    private readonly MAX_SCALE = 8;

    // Active pointers (by pointerId) and gesture state.
    private pointers = new Map<number, { x: number; y: number }>();
    private pinchStartDistance = 0;
    private pinchStartScale = 1;
    private panStart: { x: number; y: number; tx: number; ty: number } | null = null;
    private lastTapTime = 0;
    private downPos = { x: 0, y: 0 };

    constructor(app: App, private imageUrl: string, private settings: HeicViewerSettings) {
        super(app);
    }

    /* ---- Setup ------------------------------------------------------------- */

    onOpen() {
        const { contentEl, modalEl, containerEl } = this;

        containerEl.addClass('heic-viewer-container');
        modalEl.addClass('heic-viewer-modal');
        contentEl.empty();
        contentEl.addClass('heic-viewer-content');
        this.applyBackground();

        this.imgEl = contentEl.createEl('img', { cls: 'heic-viewer-image' });
        this.imgEl.src = this.imageUrl;
        this.imgEl.draggable = false;
        this.imgEl.classList.toggle('heic-invert', this.settings.invertColors);

        this.buildControls(contentEl);
        this.bindGestures(contentEl);
    }

    onClose() {
        // All listeners live on contentEl and its children; emptying it is
        // the entire cleanup (no window/document listeners are used).
        this.contentEl.empty();
    }

    /* ---- Background ---------------------------------------------------------- */

    private applyBackground() {
        const mode = this.tempBackground ?? this.settings.backgroundMode;
        setBackground(this.contentEl, mode, this.settings.customBackgroundColor);
        setBackground(this.modalEl, mode, this.settings.customBackgroundColor);
    }

    /* ---- Controls -------------------------------------------------------------- */

    private buildControls(container: HTMLElement) {
        const bar = container.createEl('div', { cls: 'heic-viewer-controls' });
        // Taps on the control bar must never start an image gesture.
        bar.addEventListener('pointerdown', event => event.stopPropagation());

        const bgBtn = this.addControl(bar, 'palette', 'Cycle temporary background');
        bgBtn.addEventListener('click', () => {
            const cycle = HeicViewerModal.BG_CYCLE;
            this.tempBackground = cycle[(cycle.indexOf(this.tempBackground) + 1) % cycle.length];
            this.applyBackground();
        });

        this.addControl(bar, 'zoom-out', 'Zoom out')
            .addEventListener('click', () => this.setScale(this.scale / 1.5));
        this.addControl(bar, 'zoom-in', 'Zoom in')
            .addEventListener('click', () => this.setScale(this.scale * 1.5));

        const closeBtn = this.addControl(bar, 'x', 'Close viewer');
        closeBtn.addEventListener('click', () => this.close());
    }

    private addControl(bar: HTMLElement, icon: string, label: string): HTMLButtonElement {
        const btn = bar.createEl('button', { cls: 'heic-viewer-button', attr: { 'aria-label': label } });
        setIcon(btn, icon);
        return btn;
    }

    /* ---- Zoom & pan --------------------------------------------------------------- */

    private setScale(value: number) {
        this.scale = Math.min(this.MAX_SCALE, Math.max(this.MIN_SCALE, value));
        // At or below fit size the whole image is visible; keep it centered.
        if (this.scale <= 1) {
            this.tx = 0;
            this.ty = 0;
        }
        this.applyTransform();
    }

    private applyTransform() {
        this.imgEl.setCssStyles({
            transform: `translate(${this.tx}px, ${this.ty}px) scale(${this.scale})`
        });
    }

    private pointerDistance(): number {
        const [a, b] = [...this.pointers.values()];
        return Math.hypot(a.x - b.x, a.y - b.y);
    }

    private bindGestures(surface: HTMLElement) {
        surface.addEventListener('pointerdown', event => {
            surface.setPointerCapture(event.pointerId);
            this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

            if (this.pointers.size === 1) {
                this.downPos = { x: event.clientX, y: event.clientY };
                if (this.scale > 1) {
                    this.panStart = { x: event.clientX, y: event.clientY, tx: this.tx, ty: this.ty };
                    surface.addClass('heic-dragging');
                }
            } else if (this.pointers.size === 2) {
                this.panStart = null;
                this.pinchStartDistance = this.pointerDistance();
                this.pinchStartScale = this.scale;
            }
        });

        surface.addEventListener('pointermove', event => {
            const p = this.pointers.get(event.pointerId);
            if (!p) return;
            p.x = event.clientX;
            p.y = event.clientY;

            if (this.pointers.size === 2 && this.pinchStartDistance > 0) {
                this.setScale(this.pinchStartScale * (this.pointerDistance() / this.pinchStartDistance));
            } else if (this.pointers.size === 1 && this.panStart) {
                this.tx = this.panStart.tx + (event.clientX - this.panStart.x);
                this.ty = this.panStart.ty + (event.clientY - this.panStart.y);
                this.applyTransform();
            }
        });

        const endPointer = (event: PointerEvent) => {
            if (!this.pointers.delete(event.pointerId)) return;
            if (this.pointers.size < 2) this.pinchStartDistance = 0;
            if (this.pointers.size === 0) {
                surface.removeClass('heic-dragging');

                // Double-tap (or double-click) toggles between fit and 3x.
                // Works identically for touch and mouse via pointer events.
                const moved = Math.hypot(event.clientX - this.downPos.x, event.clientY - this.downPos.y) > 10;
                const now = Date.now();
                if (!moved && now - this.lastTapTime < 300) {
                    this.setScale(this.scale === 1 ? 3 : 1);
                    this.lastTapTime = 0;
                } else if (!moved) {
                    this.lastTapTime = now;
                }
                this.panStart = null;
            }
        };
        surface.addEventListener('pointerup', endPointer);
        surface.addEventListener('pointercancel', endPointer);

        // Mouse wheel / trackpad zoom (desktop).
        surface.addEventListener('wheel', event => {
            event.preventDefault();
            this.setScale(this.scale * (1 - event.deltaY * 0.0015));
        }, { passive: false });
    }
}