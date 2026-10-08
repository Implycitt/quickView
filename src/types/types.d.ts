export type ColorScheme = {
    name: string;
    background: string;
    panel: string;
    stage: string;
    border: string;
    text: string;
    muted: string;
    accent: string;
    action: string;
};

export type FileResponse = {
    name: string;
    path: string;
} & ({ data: Uint8Array; content?: never } | { content: string; data?: never });

declare global {
    interface Window {
        electronAPI: {
            platform: string;
            getColorSchemes: () => Promise<{ path: string; schemes: ColorScheme[]; usingDefaults: boolean }>;
            openColorSchemes: () => Promise<string>;
            pickAndReadFile: () => Promise<FileResponse | null>;
            readFile: (path: string) => Promise<FileResponse>;
            getLaunchPath: () => Promise<string | null>;
            onFileUpdated: (callback: (data: FileResponse) => void) => void;
            onFileUnavailable: (callback: (path: string) => void) => void;
            openExternal: (url: string) => Promise<void>;
            minimize: () => void;
            toggleMaximize: () => void;
            closeWindow: () => void;
            getWindowState: () => Promise<{ maximized: boolean }>;
            onWindowState: (callback: (state: { maximized: boolean }) => void) => void;
        };
    }
}
