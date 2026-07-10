declare module 'libheif-js' {
    export interface HeifImage {
        get_width(): number;
        get_height(): number;
        display(
            imageData: ImageData,
            callback: (result: ImageData | null) => void
        ): void;
    }

    export class HeifDecoder {
        decode(buffer: ArrayBuffer | Uint8Array): HeifImage[];
    }
}
