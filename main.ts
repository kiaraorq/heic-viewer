import { Plugin, TFile, Modal, App } from 'obsidian';
import heic2any from 'heic2any';

export default class HeicViewerPlugin extends Plugin {
    private blobCache = new Map<string, string>();

    async onload() {
        // A single, universal scanner that catches HEIC images everywhere in Obsidian!
        // (Live Preview, Reading View, Canvas, Hover Popups, etc.)
        this.registerInterval(window.setInterval(() => {
            this.scanDocumentForHEIC();
        }, 300));

        // Memory Leak Cleanup
        this.registerEvent(
            this.app.workspace.on('layout-change', () => {
                this.cleanupUnusedMemory();
            })
        );
    }

    scanDocumentForHEIC() {
        // Query ALL embeds in the app, no matter what view we are in
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
        // 🔒 THE LOCK: Stop duplicate processing
        if (embed.getAttribute('data-heic-processed') === 'true') return;
        embed.setAttribute('data-heic-processed', 'true');

        // Figure out which file is currently open to resolve the link
        const activeFile = this.app.workspace.getActiveFile();
        const sourcePath = activeFile ? activeFile.path : "";

        const file = this.app.metadataCache.getFirstLinkpathDest(src, sourcePath);
        if (!(file instanceof TFile)) return;

        // Hide the default Obsidian file box
        embed.childNodes.forEach(child => {
            if (child instanceof HTMLElement) {
                child.style.display = 'none';
            }
        });

        // FAST LOAD: If it's in the RAM cache
        if (this.blobCache.has(file.path)) {
            const url = this.blobCache.get(file.path);
            this.injectImage(embed, url!, src);
            return;
        }

        // IF NOT CACHED: Lazy Loading
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
            
            const conversionResult = await heic2any({ blob, toType: "image/jpeg", quality: 0.8 });
            const resultBlob = Array.isArray(conversionResult) ? conversionResult[0] : conversionResult;
            const url = URL.createObjectURL(resultBlob);

            this.blobCache.set(file.path, url);

            placeholder.remove();
            this.injectImage(embed, url, src);

        } catch (error: any) {
            placeholder.setText(`Failed to convert ${src}.`);
            placeholder.style.color = 'red';
            placeholder.style.border = '1px solid red';
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
        
        // INTERCEPT THE CLICK for our custom zoom window
        img.addEventListener('click', (event) => {
            event.stopPropagation(); 
            event.preventDefault();
            new HeicImageModal(this.app, url).open(); 
        });

        embed.appendChild(img);
    }

    cleanupUnusedMemory() {
        const visibleImages = document.querySelectorAll('img.heic-injected');
        const activeUrls = new Set<string>();
        
        visibleImages.forEach(img => {
            activeUrls.add((img as HTMLImageElement).src);
        });

        for (const [filePath, url] of this.blobCache.entries()) {
            if (!activeUrls.has(url)) {
                URL.revokeObjectURL(url);
                this.blobCache.delete(filePath);
            }
        }
    }

    onunload() {
        this.blobCache.forEach(url => URL.revokeObjectURL(url));
        this.blobCache.clear();
    }
}

// 🖼️ OUR CUSTOM ZOOM POPUP WINDOW
class HeicImageModal extends Modal {
    imageUrl: string;

    constructor(app: App, imageUrl: string) {
        super(app);
        this.imageUrl = imageUrl;
    }

    onOpen() {
        const { contentEl } = this;
        
        contentEl.empty();
        contentEl.style.padding = '0';
        contentEl.style.display = 'flex';
        contentEl.style.justifyContent = 'center';
        contentEl.style.alignItems = 'center';
        contentEl.style.overflow = 'hidden';

        const img = contentEl.createEl('img');
        img.src = this.imageUrl;
        img.style.maxWidth = '100%';
        img.style.maxHeight = '85vh'; 
        img.style.objectFit = 'contain';
        img.style.borderRadius = 'var(--radius-m)';
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}