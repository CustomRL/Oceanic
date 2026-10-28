// Type stand-ins for the optional native compression peers, so the fork builds under npm without
// compiling them. pnpm (upstream's tool) installs peers automatically; npm does not. The real
// modules are only loaded at runtime when that compression mode is chosen.

declare module "zlib-sync" {
    namespace ZlibSync {
        class Inflate {
            err: number;
            msg: string | null;
            result: Buffer | string | null;
            constructor(options?: { chunkSize?: number; to?: "string"; windowBits?: number; });
            push(data: Buffer, flushMode?: boolean | number): boolean;
        }
        const Z_SYNC_FLUSH: number;
    }
    export = ZlibSync;
}

declare module "zstd-napi" {
    import { Transform } from "node:stream";
    export class DecompressStream extends Transform {}
}
