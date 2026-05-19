import { Plugin, TFile, Modal, App, PluginSettingTab, Setting } from 'obsidian';
import heic2any from 'heic2any';

interface HeicViewerSettings {
    invertColors: boolean;
    blendMode: string; 
}

const DEFAULT_SETTINGS: HeicViewerSettings = {
    invertColors: false,
    blendMode: 'none'
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
        `;
        document.head.appendChild(this.styleEl);

        this.registerInterval(window.setInterval(() => {
            this.scanDocumentForHEIC();
        }, 300));
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
        this.updateVisibleImages(); 
    }

    updateVisibleImages() {
        const allImages = document.querySelectorAll('.heic-injected');
        allImages.forEach(img => {
            const embed = img.closest('.internal-embed');
            const cmBlock = img.closest('.cm-embed-block'); // Find the Live Preview wrapper

            // Invert
            if (this.settings.invertColors) img.classList.add('heic-invert');
            else img.classList.remove('heic-invert');

            // Reset Blends
            img.classList.remove('heic-blend-multiply', 'heic-blend-screen');
            if (embed) embed.classList.remove('heic-blend-container');
            if (cmBlock) cmBlock.classList.remove('heic-blend-container');

            // Apply Blends & Strip Backgrounds
            if (this.settings.blendMode === 'multiply' || this.settings.blendMode === 'screen') {
                img.classList.add(`heic-blend-${this.settings.blendMode}`);
                if (embed) embed.classList.add('heic-blend-container');
                if (cmBlock) cmBlock.classList.add('heic-blend-container');
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
            const blob = new Blob([arrayBuffer]);
            
            const conversionResult = await heic2any({ blob, toType: "image/png" });
            const resultBlob = Array.isArray(conversionResult) ? conversionResult[0] : conversionResult;
            const url = URL.createObjectURL(resultBlob);

            this.addToCache(file.path, url); // Add to our Smart Queue

            placeholder.remove();
            this.injectImage(embed, url, src);

        } catch (error: any) {
            placeholder.setText(`Failed to convert ${src}.`);
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
        
        if (this.settings.blendMode === 'multiply' || this.settings.blendMode === 'screen') {
            img.classList.add(`heic-blend-${this.settings.blendMode}`);
            embed.classList.add('heic-blend-container');
            
            // 🚀 STRIP LIVE PREVIEW WRAPPER BACKGROUND
            const cmBlock = embed.closest('.cm-embed-block');
            if (cmBlock) cmBlock.classList.add('heic-blend-container');
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
    }
}

class HeicImageModal extends Modal {
    imageUrl: string;
    settings: HeicViewerSettings;

    constructor(app: App, imageUrl: string, settings: HeicViewerSettings) {
        super(app);
        this.imageUrl = imageUrl;
        this.settings = settings; 
    }

    onOpen() {
        const { contentEl } = this;
        
        contentEl.empty();
        contentEl.style.padding = '0';
        contentEl.style.display = 'flex';
        contentEl.style.justifyContent = 'center';
        contentEl.style.alignItems = 'center';
        contentEl.style.overflow = 'hidden';

        if (this.settings.blendMode !== 'none') {
            contentEl.classList.add('heic-blend-container');
        }

        const img = contentEl.createEl('img');
        img.src = this.imageUrl;
        img.addClass('heic-injected'); 
        img.style.maxWidth = '100%';
        img.style.maxHeight = '85vh'; 
        img.style.objectFit = 'contain';
        img.style.borderRadius = 'var(--radius-m)';

        if (this.settings.invertColors) img.classList.add('heic-invert');
        
        if (this.settings.blendMode === 'multiply') {
            img.classList.add('heic-blend-multiply');
        } else if (this.settings.blendMode === 'screen') {
            img.classList.add('heic-blend-screen');
        }
    }

    onClose() {
        this.contentEl.empty();
    }
}