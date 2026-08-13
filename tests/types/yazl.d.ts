declare module 'yazl' {
    export class ZipFile {
        public addBuffer(buffer: Buffer, metadataPath: string, options?: Record<string, unknown>): void;
        public end(options?: Record<string, unknown>): void;
        public readonly outputStream: NodeJS.ReadableStream;
    }
}
