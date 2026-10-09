import { type ChildProcessWithoutNullStreams } from 'node:child_process';
import { type VoiceConfig, type WhisperRuntime } from './voice.js';
export declare const UV_VERSION = "0.6.17";
export declare const PYTHON_VERSION = "3.12.10";
export declare const PYTHON_PACKAGES: readonly ["faster-whisper==1.2.1", "ctranslate2==4.6.0", "av==16.0.1", "onnxruntime==1.22.1", "numpy==2.2.6", "tokenizers==0.21.4", "huggingface-hub==0.34.4", "hf-xet==1.1.9", "setuptools==80.9.0", "pyyaml==6.0.2", "tqdm==4.67.1", "filelock==3.19.1", "fsspec==2025.9.0", "packaging==25.0", "typing-extensions==4.15.0", "requests==2.32.4", "charset-normalizer==3.4.3", "idna==3.10", "urllib3==2.5.0", "certifi==2025.8.3", "coloredlogs==15.0.1", "humanfriendly==10.0", "flatbuffers==25.2.10", "protobuf==6.32.0", "sympy==1.14.0", "mpmath==1.3.0"];
export interface HostPlatform {
    platform: string;
    arch: string;
    glibc?: string;
    osRelease?: string;
}
export declare function supportedTarget(host?: HostPlatform): string;
export declare function runtimePaths(env?: NodeJS.ProcessEnv, home?: string, platform?: NodeJS.Platform): {
    data: string;
    cache: string;
};
/** Extract only the expected regular binary, not arbitrary archive paths/symlinks. */
export declare function extractUv(archive: Uint8Array, target: string, checksum?: string | undefined): Buffer;
export declare function downloadUv(target: string, signal: AbortSignal, fetcher?: typeof fetch): Promise<Buffer>;
/** POSIX process group ownership: cancellation kills descendants and waits for close.
 * stderr is deliberately discarded, never attached to errors or application logs.
 */
export declare class OwnedProcess {
    readonly child: ChildProcessWithoutNullStreams;
    readonly closed: Promise<number | null>;
    private exited;
    constructor(executable: string, args: string[], env: NodeJS.ProcessEnv, cwd: string);
    stop(): Promise<void>;
}
export interface WhisperRuntimeDependencies {
    paths?: ReturnType<typeof runtimePaths>;
    prepare?: (signal: AbortSignal, progress: (text: string) => void) => Promise<string>;
    createProcess?: (executable: string, args: string[], env: NodeJS.ProcessEnv, cwd: string) => OwnedProcess;
    workerTimeoutMs?: number;
}
export declare class ManagedWhisperRuntime implements WhisperRuntime {
    private readonly dependencies;
    constructor(dependencies?: WhisperRuntimeDependencies);
    private process;
    private workerConfig;
    private buffered;
    private receive;
    private paths;
    private seq;
    private environment;
    private command;
    private prepare;
    private worker;
    transcribe(audio: Uint8Array, config: VoiceConfig, signal: AbortSignal, notify: (text: string) => void): Promise<string>;
    stop(): Promise<void>;
}
//# sourceMappingURL=whisper-runtime.d.ts.map