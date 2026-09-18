export interface FileResponse {
    data: any;
    content: any;
    path: string;
    name: string;
}

declare global {
    interface Window {
        electronAPI: {
            platform: string;
            pickAndReadFile: () => Promise<FileResponse | null>;
            onFileUpdated: (callback: (data: FileResponse) => void) => void;
            openExternal: (url: string) => Promise<void>;
            minimize: () => void;
            toggleMaximize: () => void;
            closeWindow: () => void;
            getWindowState: () => Promise<{ maximized: boolean }>;
            onWindowState: (callback: (state: { maximized: boolean }) => void) => void;
        };
        pdfjsLib: any;
    }
}
