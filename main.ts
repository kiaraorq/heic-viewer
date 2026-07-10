import { Plugin, TFile, Modal, App, PluginSettingTab, Setting } from 'obsidian';
// libheif-js doesn't ship types matching this default-namespace usage, so treat as any.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const libheif: any = require('libheif-js');

type BackgroundMode = 'transparent' | 'black' | 'white' | 'custom';

interface HeicViewerSettings {
    invertColors: boolean;
    blendMode: string;
    backgroundMode: BackgroundMode;
    customBackgroundColor: string;
}

const DEFAULT_SETTINGS: HeicViewerSettings = {
    invertColors: false,
    blendMode: 'none',
    backgroundMode: 'transparent',
    customBackgroundColor: '#161616'
}

// Returns the actual color to paint behind transparent regions, or null to
// mean "leave it truly transparent". Shared by the plugin class (for the
// inline embed) and the modal (which only has a settings object, not the
// plugin instance) so the two can never drift out of sync.
function resolveBackgroundColor(settings: HeicViewerSettings): string | null {
    switch (settings.backgroundMode) {
        case 'black': return '#000000';
        case 'white': return '#ffffff';
        case 'custom': return settings.customBackgroundColor || '#000000';
        case 'transparent':
        default:
            return null;
    }
}

// Strips the element's border/shadow (always) and either leaves its
// background transparent or paints it with the resolved color, using
// setProperty(..., 'important') so it reliably beats the theme's own
// !important background rules on the same element.
function applyBackgroundTreatment(el: HTMLElement, settings: HeicViewerSettings) {
    el.classList.add('heic-blend-container');
    el.style.removeProperty('background-color');
    el.style.removeProperty('background');

    const color = resolveBackgroundColor(settings);
    if (color) {
        el.style.setProperty('background-color', color, 'important');
        el.style.setProperty('background', color, 'important');
    }
}

export default class HeicViewerPlugin extends Plugin {
    settings: HeicViewerSettings;
    private styleEl: HTMLStyleElement;

    // 🧠 SMART QUEUE (LRU CACHE): Safely holds up to 30 images in RAM 
    // without ever accidentally deleting the one you are looking at!
    private blobCache = new Map<string, string>();
    private cacheQueue: string[] = []; 
    private MAX_CACHE_SIZE = 30; 

    async onload() {
        await this.loadSettings();
        this.addSettingTab(new HeicViewerSettingTab(this.app, this));

        this.styleEl = document.createElement('style');
        this.styleEl.id = 'heic-viewer-styles';
        this.styleEl.textContent = `
            .heic-invert { filter: invert(1) hue-rotate(180deg); }
            .heic-blend-multiply { mix-blend-mode: multiply; } 
            .heic-blend-screen { mix-blend-mode: screen; }     

            /* Nuke backgrounds on the embed AND the Live Preview wrapper! */
            .heic-blend-container { 
                background-color: transparent !important; 
                background: transparent !important;
                border: none !important; 
                box-shadow: none !important; 
            }

            /* Make the fullscreen viewer actually take over the whole screen,
               instead of Obsidian's default centered, size-limited dialog box. */
            .heic-fullscreen-modal {
                width: 100vw !important;
                height: 100vh !important;
                max-width: 100vw !important;
                max-height: 100vh !important;
                top: 0 !important;
                left: 0 !important;
                margin: 0 !important;
                border-radius: 0 !important;
                padding: 0 !important;
            }
            .heic-fullscreen-content {
                width: 100%;
                height: 100%;
                touch-action: none; /* we handle pinch/pan ourselves */
            }
        `;
        document.head.appendChild(this.styleEl);

        this.registerInterval(window.setInterval(() => {
            this.scanDocumentForHEIC();
        }, 300));
    }

    async loadSettings() {
        const loadedData: any = await this.loadData();
        this.settings = Object.assign({}, DEFAULT_SETTINGS, loadedData);

        // Migrate users coming from the old on/off "Dark Background" toggle:
        // on -> approximate with 'black', off -> 'transparent' (the new default).
        if (loadedData && typeof loadedData.darkBackground === 'boolean' && !loadedData.backgroundMode) {
            this.settings.backgroundMode = loadedData.darkBackground ? 'black' : 'transparent';
            await this.saveData(this.settings);
        }
    }

    async saveSettings() {
        await this.saveData(this.settings);
        this.updateVisibleImages(); 
    }

    updateVisibleImages() {
        const allImages = document.querySelectorAll('.heic-injected');
        allImages.forEach(img => {
            const embed = img.closest('.internal-embed') as HTMLElement | null;
            const cmBlock = img.closest('.cm-embed-block') as HTMLElement | null; // Live Preview wrapper

            // Invert
            if (this.settings.invertColors) img.classList.add('heic-invert');
            else img.classList.remove('heic-invert');

            // Reset Blend filters (these only affect the <img> itself)
            img.classList.remove('heic-blend-multiply', 'heic-blend-screen');

            // ALWAYS apply a deliberate background treatment — transparent, black,
            // white, or a custom color — so any real transparency in the converted
            // PNG is handled on purpose rather than showing whatever color the
            // theme happens to use.
            if (embed) applyBackgroundTreatment(embed, this.settings);
            if (cmBlock) applyBackgroundTreatment(cmBlock, this.settings);

            // Apply Blends (color-remapping filters), separate from background stripping
            if (this.settings.blendMode === 'multiply' || this.settings.blendMode === 'screen') {
                img.classList.add(`heic-blend-${this.settings.blendMode}`);
            }
        });
    }

    scanDocumentForHEIC() {
        const allEmbeds = document.querySelectorAll('.internal-embed');
        for (let i = 0; i < allEmbeds.length; i++) {
            const embed = allEmbeds[i] as HTMLElement;
            const src = embed.getAttribute('src');
            
            if (src && (src.toLowerCase().endsWith('.heic') || src.toLowerCase().endsWith('.heif'))) {
                this.processEmbed(embed, src); 
            }
        }
    }

    async processEmbed(embed: HTMLElement, src: string) {
        if (embed.getAttribute('data-heic-processed') === 'true') return;
        embed.setAttribute('data-heic-processed', 'true');

        const activeFile = this.app.workspace.getActiveFile();
        const sourcePath = activeFile ? activeFile.path : "";

        const file = this.app.metadataCache.getFirstLinkpathDest(src, sourcePath);
        if (!(file instanceof TFile)) return;

        embed.childNodes.forEach(child => {
            if (child instanceof HTMLElement) child.style.display = 'none';
        });

        // FAST LOAD: Check our Smart Queue
        if (this.blobCache.has(file.path)) {
            const url = this.blobCache.get(file.path);
            this.addToCache(file.path, url!); // Bumps it to the "most recently used" spot
            this.injectImage(embed, url!, src);
            return;
        }

        this.setupLazyLoad(embed, file, src);
    }

    setupLazyLoad(embed: HTMLElement, file: TFile, src: string) {
        const placeholder = embed.createEl('div', { 
            text: 'Scroll to load HEIC...',
            cls: 'heic-injected', 
            attr: { style: 'padding: 2em; text-align: center; border: 1px dashed var(--background-modifier-border); border-radius: var(--radius-m); color: var(--text-muted); cursor: pointer;' }
        });

        const observer = new IntersectionObserver((entries, observerInstance) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    observerInstance.unobserve(entry.target);
                    placeholder.setText('Converting HEIC...');
                    this.convertHeic(embed, file, src, placeholder);
                }
            });
        }, { rootMargin: "50px" });

        observer.observe(placeholder);
    }

    async convertHeic(embed: HTMLElement, file: TFile, src: string, placeholder: HTMLElement) {
        try {
            const arrayBuffer = await this.app.vault.readBinary(file);

            const decoder = new libheif.HeifDecoder();
            const images = decoder.decode(arrayBuffer);
            if (!images || !images.length) {
                throw new Error('ERR_LIBHEIF no images found in file');
            }
            const image = images[0];
            const width = image.get_width();
            const height = image.get_height();

            // Start from a zero-initialized buffer (fully transparent black), not
            // preset-opaque. display() fully overwrites every pixel -- including
            // alpha -- with the real decoded values, so this doesn't matter for
            // correctness, but starting transparent avoids ever showing a stray
            // opaque pixel if a future libheif build behaves differently.
            const imageData: ImageData = await new Promise((resolve, reject) => {
                image.display(new ImageData(width, height), (result: ImageData | null) => {
                    if (!result) return reject(new Error('ERR_LIBHEIF display() failed'));
                    resolve(result);
                });
            });

            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d');
            if (!ctx) throw new Error('ERR_CANVAS could not get 2d context');
            ctx.putImageData(imageData, 0, 0);

            const resultBlob: Blob = await new Promise((resolve, reject) => {
                canvas.toBlob((blob) => {
                    if (!blob) return reject(new Error('ERR_CANVAS toBlob failed'));
                    resolve(blob);
                }, 'image/png');
            });

            const url = URL.createObjectURL(resultBlob);

            this.addToCache(file.path, url); // Add to our Smart Queue

            placeholder.remove();
            this.injectImage(embed, url, src);

        } catch (error: any) {
            const detail = error && error.message ? error.message : String(error);
            placeholder.setText(`Failed to convert ${src}: ${detail}`);
            placeholder.style.color = 'red';
            placeholder.style.border = '1px solid red';
        }
    }

    // 🧠 HELPER: Manages the 30-image limit so we never run out of RAM
    addToCache(filePath: string, url: string) {
        this.blobCache.set(filePath, url);
        
        // Remove the file from the queue if it's already there so we don't have duplicates
        this.cacheQueue = this.cacheQueue.filter(p => p !== filePath);
        this.cacheQueue.push(filePath);
        
        // If we have more than 30 images, delete the oldest one permanently
        if (this.cacheQueue.length > this.MAX_CACHE_SIZE) {
            const oldest = this.cacheQueue.shift();
            if (oldest) {
                const oldUrl = this.blobCache.get(oldest);
                if (oldUrl) URL.revokeObjectURL(oldUrl);
                this.blobCache.delete(oldest);
            }
        }
    }

    injectImage(embed: HTMLElement, url: string, src: string) {
        const img = document.createElement('img');
        img.src = url;
        img.alt = src;
        img.addClass('heic-injected');
        img.style.maxWidth = '100%';
        img.style.borderRadius = 'var(--radius-m)';
        img.style.cursor = 'zoom-in'; 
        
        // Apply initial settings
        if (this.settings.invertColors) img.classList.add('heic-invert');

        // ALWAYS apply a deliberate background treatment (transparent, black,
        // white, or custom) — otherwise a genuinely transparent PNG (from a HEIC
        // with an alpha channel) just shows whatever color the theme puts behind
        // the embed.
        applyBackgroundTreatment(embed, this.settings);
        const cmBlock = embed.closest('.cm-embed-block') as HTMLElement | null;
        if (cmBlock) applyBackgroundTreatment(cmBlock, this.settings);

        if (this.settings.blendMode === 'multiply' || this.settings.blendMode === 'screen') {
            img.classList.add(`heic-blend-${this.settings.blendMode}`);
        }
        
        img.addEventListener('click', (event) => {
            event.stopPropagation(); 
            event.preventDefault();
            new HeicImageModal(this.app, url, this.settings).open(); 
        });

        embed.appendChild(img);
    }

    onunload() {
        this.blobCache.forEach(url => URL.revokeObjectURL(url));
        this.blobCache.clear();
        this.cacheQueue = [];
        if (this.styleEl) this.styleEl.remove(); 
    }
}

class HeicViewerSettingTab extends PluginSettingTab {
    plugin: HeicViewerPlugin;

    constructor(app: App, plugin: HeicViewerPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const {containerEl} = this;
        containerEl.empty();

        containerEl.createEl('h2', {text: 'HEIC Viewer Settings'});

        new Setting(containerEl)
            .setName('Invert Images Color')
            .setDesc('Inverts the colors of all HEIC images. Great for reading scanned documents.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.invertColors)
                .onChange(async (value) => {
                    this.plugin.settings.invertColors = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Blend/Remove Backgrounds')
            .setDesc('Choose how to blend your images. Use "Drop White" for scanned documents, and "Drop Black" to fix iPhone cutouts that imported with black backgrounds.')
            .addDropdown(dropdown => dropdown
                .addOption('none', 'No Blending')
                .addOption('multiply', 'Drop White Backgrounds')
                .addOption('screen', 'Drop Black Backgrounds')
                .setValue(this.plugin.settings.blendMode)
                .onChange(async (value) => {
                    this.plugin.settings.blendMode = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Background Behind Transparency')
            .setDesc('Some HEIC images have a genuinely transparent background. Choose how to treat that: leave it fully transparent (default), fill it with black or white, or pick any custom color.')
            .addDropdown(dropdown => dropdown
                .addOption('transparent', 'Transparent (default)')
                .addOption('black', 'Black')
                .addOption('white', 'White')
                .addOption('custom', 'Custom color')
                .setValue(this.plugin.settings.backgroundMode)
                .onChange(async (value) => {
                    this.plugin.settings.backgroundMode = value as BackgroundMode;
                    await this.plugin.saveSettings();
                    this.display(); // re-render so the color picker appears/disappears as needed
                }));

        if (this.plugin.settings.backgroundMode === 'custom') {
            new Setting(containerEl)
                .setName('Custom Background Color')
                .setDesc('Pick any color to fill transparent regions with.')
                .addColorPicker(picker => picker
                    .setValue(this.plugin.settings.customBackgroundColor)
                    .onChange(async (value) => {
                        this.plugin.settings.customBackgroundColor = value;
                        await this.plugin.saveSettings();
                    }));
        }
    }
}

class HeicImageModal extends Modal {
    imageUrl: string;
    settings: HeicViewerSettings;
    private imgEl: HTMLImageElement;

    // Zoom/pan state
    private scale = 1;
    private offsetX = 0;
    private offsetY = 0;
    private isDragging = false;
    private dragStartX = 0;
    private dragStartY = 0;
    private lastTouchDistance = 0;
    private singleTouchStart = { x: 0, y: 0, offsetX: 0, offsetY: 0 };

    private readonly MIN_SCALE = 1;
    private readonly MAX_SCALE = 6;

    constructor(app: App, imageUrl: string, settings: HeicViewerSettings) {
        super(app);
        this.imageUrl = imageUrl;
        this.settings = settings; 
    }

    onOpen() {
        const { contentEl, modalEl } = this;

        // Take over the whole screen instead of Obsidian's default centered dialog.
        modalEl.addClass('heic-fullscreen-modal');

        contentEl.empty();
        contentEl.addClass('heic-fullscreen-content');
        contentEl.style.padding = '0';
        contentEl.style.display = 'flex';
        contentEl.style.justifyContent = 'center';
        contentEl.style.alignItems = 'center';
        contentEl.style.overflow = 'hidden';
        contentEl.style.cursor = 'grab';

        // ALWAYS apply a deliberate background treatment, same choice as the inline embed.
        applyBackgroundTreatment(contentEl, this.settings);

        const img = contentEl.createEl('img');
        this.imgEl = img;
        img.src = this.imageUrl;
        img.addClass('heic-injected'); 
        img.style.maxWidth = '100%';
        img.style.maxHeight = '100%';
        img.style.objectFit = 'contain';
        img.style.borderRadius = 'var(--radius-m)';
        img.style.transformOrigin = 'center center';
        img.style.userSelect = 'none';
        img.draggable = false;

        if (this.settings.invertColors) img.classList.add('heic-invert');
        
        if (this.settings.blendMode === 'multiply') {
            img.classList.add('heic-blend-multiply');
        } else if (this.settings.blendMode === 'screen') {
            img.classList.add('heic-blend-screen');
        }

        this.setupZoomAndPan(contentEl);
    }

    private applyTransform() {
        this.imgEl.style.transform = `translate(${this.offsetX}px, ${this.offsetY}px) scale(${this.scale})`;
    }

    private clampScale(scale: number): number {
        return Math.min(this.MAX_SCALE, Math.max(this.MIN_SCALE, scale));
    }

    private resetZoom() {
        this.scale = this.MIN_SCALE;
        this.offsetX = 0;
        this.offsetY = 0;
        this.applyTransform();
    }

    private setupZoomAndPan(container: HTMLElement) {
        // --- Mouse wheel zoom (desktop / trackpad) ---
        container.addEventListener('wheel', (event: WheelEvent) => {
            event.preventDefault();
            const delta = -event.deltaY * 0.0015;
            const newScale = this.clampScale(this.scale + this.scale * delta);
            if (newScale === this.scale) return;
            this.scale = newScale;
            if (this.scale === this.MIN_SCALE) {
                this.offsetX = 0;
                this.offsetY = 0;
            }
            this.applyTransform();
        }, { passive: false });

        // --- Double-click to toggle zoom (desktop) ---
        container.addEventListener('dblclick', (event: MouseEvent) => {
            event.preventDefault();
            if (this.scale > this.MIN_SCALE) {
                this.resetZoom();
            } else {
                this.scale = this.clampScale(3);
                this.applyTransform();
            }
        });

        // --- Mouse drag to pan (desktop), only meaningful once zoomed in ---
        container.addEventListener('mousedown', (event: MouseEvent) => {
            if (this.scale <= this.MIN_SCALE) return;
            this.isDragging = true;
            this.dragStartX = event.clientX - this.offsetX;
            this.dragStartY = event.clientY - this.offsetY;
            container.style.cursor = 'grabbing';
        });
        window.addEventListener('mousemove', this.onMouseMove);
        window.addEventListener('mouseup', this.onMouseUp);

        // --- Touch: two-finger pinch to zoom, one-finger drag to pan (mobile) ---
        container.addEventListener('touchstart', (event: TouchEvent) => {
            if (event.touches.length === 2) {
                this.lastTouchDistance = this.getTouchDistance(event.touches);
            } else if (event.touches.length === 1 && this.scale > this.MIN_SCALE) {
                const touch = event.touches[0];
                this.singleTouchStart = { x: touch.clientX, y: touch.clientY, offsetX: this.offsetX, offsetY: this.offsetY };
            }
        }, { passive: true });

        container.addEventListener('touchmove', (event: TouchEvent) => {
            if (event.touches.length === 2) {
                event.preventDefault();
                const distance = this.getTouchDistance(event.touches);
                if (this.lastTouchDistance > 0) {
                    const ratio = distance / this.lastTouchDistance;
                    this.scale = this.clampScale(this.scale * ratio);
                    this.applyTransform();
                }
                this.lastTouchDistance = distance;
            } else if (event.touches.length === 1 && this.scale > this.MIN_SCALE) {
                event.preventDefault();
                const touch = event.touches[0];
                this.offsetX = this.singleTouchStart.offsetX + (touch.clientX - this.singleTouchStart.x);
                this.offsetY = this.singleTouchStart.offsetY + (touch.clientY - this.singleTouchStart.y);
                this.applyTransform();
            }
        }, { passive: false });

        container.addEventListener('touchend', () => {
            this.lastTouchDistance = 0;
            if (this.scale === this.MIN_SCALE) {
                this.offsetX = 0;
                this.offsetY = 0;
                this.applyTransform();
            }
        });
    }

    private onMouseMove = (event: MouseEvent) => {
        if (!this.isDragging) return;
        this.offsetX = event.clientX - this.dragStartX;
        this.offsetY = event.clientY - this.dragStartY;
        this.applyTransform();
    };

    private onMouseUp = () => {
        if (!this.isDragging) return;
        this.isDragging = false;
        this.contentEl.style.cursor = 'grab';
    };

    private getTouchDistance(touches: TouchList): number {
        const dx = touches[0].clientX - touches[1].clientX;
        const dy = touches[0].clientY - touches[1].clientY;
        return Math.sqrt(dx * dx + dy * dy);
    }

    onClose() {
        window.removeEventListener('mousemove', this.onMouseMove);
        window.removeEventListener('mouseup', this.onMouseUp);
        this.contentEl.empty();
    }
}