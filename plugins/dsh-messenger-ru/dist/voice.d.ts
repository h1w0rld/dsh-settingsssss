export interface VoiceConfig {
    enabled: boolean;
    model: 'tiny' | 'base' | 'small' | 'medium' | 'large-v3' | 'turbo';
    device: 'auto' | 'cpu' | 'cuda';
}
export declare const DEFAULT_VOICE_CONFIG: VoiceConfig;
export interface VoiceTranscriber {
    transcribe(request: {
        loadAudio: (signal: AbortSignal) => Promise<Uint8Array>;
        signal: AbortSignal;
        onProgress: (text: string) => void;
    }): Promise<string>;
    dispose(): Promise<void>;
}
export interface WhisperRuntime {
    transcribe(audio: Uint8Array, config: VoiceConfig, signal: AbortSignal, onProgress: (text: string) => void): Promise<string>;
    stop(): Promise<void>;
}
/** Test seam; construction of the default runtime performs no IO. */
export interface VoiceDependencies {
    createRuntime?: () => WhisperRuntime;
    requestTimeoutMs?: number;
    audioTimeoutMs?: number;
}
type Request = Parameters<VoiceTranscriber['transcribe']>[0];
interface Task {
    owner: LocalWhisperTranscriber;
    request: Request;
    controller: AbortController;
    resolve: (text: string) => void;
    reject: (error: Error) => void;
    detach: () => void;
}
export declare function voiceAbortError(): Error;
/** Also bounds a loader which fails to honour its signal. Never expose its errors. */
export declare function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T>;
export declare class LocalWhisperTranscriber implements VoiceTranscriber {
    private readonly config;
    private readonly dependencies;
    private runtime;
    private disposed;
    private readonly pending;
    constructor(config: VoiceConfig, dependencies?: VoiceDependencies);
    transcribe(request: Request): Promise<string>;
    /** Internal scheduler entry point, public only to avoid a second scheduler API. */
    run(task: Task): Promise<string>;
    stopRuntime(): Promise<void>;
    dispose(): Promise<void>;
}
export {};
//# sourceMappingURL=voice.d.ts.map