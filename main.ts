import { App, Plugin, PluginSettingTab, Setting, TFile, setIcon } from 'obsidian';
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
// Applied two ways: the .heic-bg rule in styles.css (whose !important wins
// against themes that use !important on embeds), and a plain inline style
// as a fallback so it still works if styles.css is missing on a device.
function setBackground(el: HTMLElement, mode: BackgroundMode, custom: string) {
    const color = backgroundColorFor(mode, custom);
    el.classList.add('heic-bg');
    el.setCssProps({ '--heic-bg': color });
    el.setCssStyles({ background: color });
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

        // Open the lightbox on a tap. Detection uses pointer events instead
        // of click: on iOS, if anything in the editor calls preventDefault on
        // the touch, the synthesized click never fires -- pointerup always
        // does. The click listener only suppresses Obsidian's own preview.
        let downX = 0, downY = 0, downTime = 0;
        img.addEventListener('pointerdown', event => {
            downX = event.clientX;
            downY = event.clientY;
            downTime = Date.now();
        }, { capture: true });
        img.addEventListener('pointerup', event => {
            const moved = Math.hypot(event.clientX - downX, event.clientY - downY) > 10;
            const quick = Date.now() - downTime < 500;
            if (moved || !quick) return; // a scroll or long-press, not a tap
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation();
            new HeicLightbox(url, this.settings.invertColors).open();
        }, { capture: true });
        img.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation();
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
 *  Lightbox                                                                  *
 *                                                                            *
 *  A plain fullscreen overlay appended to the document body. It does NOT     *
 *  use Obsidian's Modal, so none of Obsidian's per-platform modal styling    *
 *  applies to it: its geometry is fully its own on desktop, tablet, and      *
 *  phone. All input is handled through Pointer Events (one code path for     *
 *  mouse, touch, and pen), and zoom always works through the on-screen       *
 *  buttons even if a gesture misbehaves on some device.                      *
 * ========================================================================== */

type LightboxBackground = 'default' | 'black' | 'white';

class HeicLightbox {
    private root: HTMLElement;
    private imgEl!: HTMLImageElement;

    // Transform state. Scale 1 = image fitted to screen.
    private scale = 1;
    private tx = 0;
    private ty = 0;
    private readonly MIN_SCALE = 0.2;
    private readonly MAX_SCALE = 8;

    // Momentary background for viewing transparent images: default (theme
    // background) -> black -> white -> default. Never persisted.
    private background: LightboxBackground = 'default';

    // Gesture state (Pointer Events).
    private pointers = new Map<number, { x: number; y: number }>();
    private pinchStartDistance = 0;
    private pinchStartScale = 1;
    private panStart: { x: number; y: number; tx: number; ty: number } | null = null;

    private onKeyDown = (event: KeyboardEvent) => {
        if (event.key === 'Escape') this.close();
    };

    constructor(imageUrl: string, invert: boolean) {
        // Every critical style is set from JS so the lightbox works even if
        // styles.css never made it onto the device (a repeated mobile failure
        // mode). The classes remain for optional cosmetic theming only.
        this.root = activeDocument.createElement('div');
        this.root.addClass('heic-lightbox');
        this.root.setCssStyles({
            position: 'fixed',
            top: '0',
            right: '0',
            bottom: '0',
            left: '0',
            zIndex: '9999',
            overflow: 'hidden',
            cursor: 'grab',
            touchAction: 'none' // all touch input goes to the pointer handlers
        });
        this.applyBackground();

        this.imgEl = this.root.createEl('img', { cls: 'heic-lightbox-image' });
        this.imgEl.src = imageUrl;
        this.imgEl.draggable = false;
        this.imgEl.classList.toggle('heic-invert', invert);
        // width/height 100% + object-fit: contain guarantees the whole image
        // fits the screen at scale 1 on any resolution.
        this.imgEl.setCssStyles({
            width: '100%',
            height: '100%',
            objectFit: 'contain',
            transformOrigin: 'center center',
            userSelect: 'none',
            cursor: 'inherit'
        });

        this.buildControls();
        this.bindGestures();
    }

    open() {
        activeDocument.body.appendChild(this.root);
        activeDocument.addEventListener('keydown', this.onKeyDown);
    }

    close() {
        activeDocument.removeEventListener('keydown', this.onKeyDown);
        this.root.remove();
    }

    /* ---- Background ---------------------------------------------------- */

    private applyBackground() {
        const color =
            this.background === 'black' ? '#000000' :
            this.background === 'white' ? '#ffffff' :
            'var(--background-primary)';
        this.root.setCssStyles({ background: color });
    }

    /* ---- Controls -------------------------------------------------------- */

    private buildControls() {
        const bar = this.root.createEl('div', { cls: 'heic-lightbox-controls' });
        bar.setCssStyles({
            position: 'absolute',
            top: 'calc(env(safe-area-inset-top, 0px) + 12px)', // below any notch/status bar
            right: '12px',
            display: 'flex',
            gap: '8px'
        });
        // Taps on the control bar must never start an image gesture.
        bar.addEventListener('pointerdown', event => event.stopPropagation());

        this.button(bar, 'paintbrush', 'Cycle background (theme / black / white)', () => {
            this.background =
                this.background === 'default' ? 'black' :
                this.background === 'black' ? 'white' : 'default';
            this.applyBackground();
        });
        this.button(bar, 'zoom-out', 'Zoom out', () => this.setScale(this.scale / 1.5));
        this.button(bar, 'zoom-in', 'Zoom in', () => this.setScale(this.scale * 1.5));
        this.button(bar, 'x', 'Close', () => this.close());
    }

    private button(bar: HTMLElement, icon: string, label: string, onClick: () => void) {
        const btn = bar.createEl('button', { cls: 'heic-lightbox-button', attr: { 'aria-label': label } });
        btn.setCssStyles({
            width: '44px', // comfortable touch target
            height: '44px',
            borderRadius: '50%',
            border: 'none',
            padding: '0',
            backgroundColor: 'var(--background-modifier-hover)',
            color: 'var(--text-normal)',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center'
        });
        setIcon(btn, icon);
        btn.addEventListener('click', onClick);
    }

    /* ---- Zoom & pan --------------------------------------------------------- */

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

    private bindGestures() {
        const surface = this.root;

        surface.addEventListener('pointerdown', event => {
            surface.setPointerCapture(event.pointerId);
            this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

            if (this.pointers.size === 1 && this.scale > 1) {
                this.panStart = { x: event.clientX, y: event.clientY, tx: this.tx, ty: this.ty };
                surface.setCssStyles({ cursor: 'grabbing' });
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
                this.panStart = null;
                surface.setCssStyles({ cursor: 'grab' });
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