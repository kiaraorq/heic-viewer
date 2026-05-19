import { Plugin, MarkdownPostProcessorContext, TFile } from 'obsidian';
import heic2any from 'heic2any';

export default class HeicViewerPlugin extends Plugin {
    async onload() {
        console.log('Loading HEIC Viewer plugin');

        this.registerMarkdownPostProcessor(async (element: HTMLElement, context: MarkdownPostProcessorContext) => {
            // Find Obsidian's native internal embeds (e.g., ![[image.heic]])
            const embeds = element.querySelectorAll('.internal-embed');

            for (let i = 0; i < embeds.length; i++) {
                const embed = embeds[i] as HTMLElement;
                const src = embed.getAttribute('src');

                if (src && (src.toLowerCase().endsWith('.heic') || src.toLowerCase().endsWith('.heif'))) {
                    await this.processHeicEmbed(embed, src, context.sourcePath);
                }
            }
        });
    }

    async processHeicEmbed(embed: HTMLElement, src: string, sourcePath: string) {
        // Resolve the file path relative to the current note
        const file = this.app.metadataCache.getFirstLinkpathDest(src, sourcePath);
        
        if (file instanceof TFile) {
            try {
                // Show a loading state
                embed.empty();
                embed.createEl('span', { text: 'Converting HEIC...' });

                // Read the binary data of the HEIC file
                const arrayBuffer = await this.app.vault.readBinary(file);
                const blob = new Blob([arrayBuffer]);
                
                // Convert HEIC to JPEG on the fly
                const conversionResult = await heic2any({
                    blob,
                    toType: "image/jpeg",
                    quality: 0.8
                });

                const resultBlob = Array.isArray(conversionResult) ? conversionResult[0] : conversionResult;
                const url = URL.createObjectURL(resultBlob);

                // Create a new image element to display the JPEG
                const img = document.createElement('img');
                img.src = url;
                img.alt = src;
                img.style.maxWidth = '100%';
                img.style.borderRadius = 'var(--radius-m)';

                // ✅ MEMORY CLEANUP CODE ADDED HERE
                // This tells the browser it can delete the image from RAM 
                // as soon as it is safely drawn on the screen.
                img.onload = () => {
                    URL.revokeObjectURL(url);
                };

                // Replace the loading text with the image
                embed.empty();
                embed.appendChild(img);

            } catch (error) {
                console.error("Error converting HEIC image:", error);
                embed.empty();
                embed.createEl('span', { text: `Error loading HEIC: ${src}. Check console for details.`, cls: 'color-error' });
            }
        }
    }

    onunload() {
        console.log('Unloading HEIC Viewer plugin');
    }
}