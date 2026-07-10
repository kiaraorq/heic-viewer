# HEIC Viewer for Obsidian

An Obsidian plugin that allows you to view `.heic` and `.heif` images directly inside your notes. 

Obsidian does not natively support HEIC images due to Chromium licensing restrictions. This plugin solves that by seamlessly converting HEIC files to JPEGs on the fly using the `heic2any` library (powered by WebAssembly), allowing you to drag and drop photos straight from your iPhone or camera into your vault.

## Features
* **Seamless Integration:** Renders standard Obsidian embeds (e.g., `![[image.heic]]`) exactly like standard images.
* **Lazy Loading:** Images only process and convert when you scroll them into view. This ensures your notes open instantly without freezing the app, even if you have multiple HEIC files in one document.
* **Privacy First:** Conversions happen entirely locally on your device's RAM. No images are sent to external servers, and no extra cache files are written to your hard drive.

## Manual Installation
1. Download the `main.js` and `manifest.json` files from the latest [Release](https://github.com/kiaraorq/heic-viewer/releases).
2. Create a folder named `heic-viewer` inside your vault's `.obsidian/plugins/` directory.
3. Place both downloaded files into that new folder.
4. Open Obsidian, go to **Settings > Community Plugins**, and toggle on **HEIC Viewer**.

## Usage
Simply embed your HEIC images into your notes just like you normally would:
`![[my-photo.heic]]`

When you scroll to the image, the plugin will briefly display a "Converting HEIC..." placeholder while it decodes the image in the background, and then the native image will seamlessly appear.

## Limitations
Because HEIC files use heavy video-compression algorithms, decoding them via WebAssembly takes a moment. Large photos (12MP+) might take a second or two to render when scrolling into view.

[![Support me on Ko-fi](kofi-button-cute.png)](https://ko-fi.com/L7G522XOY8)
[![Support me on Ko-fi](support_me_on_kofi_beige.png)](https://ko-fi.com/L7G522XOY8)