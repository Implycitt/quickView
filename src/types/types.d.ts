export interface FileResponse {
    data: any;
    content: any;
    path: string;
    name: string;
}

declare global {
    interface Window {
        electronAPI: {
            pickAndReadFile: () => Promise<FileResponse | null>;
            onFileUpdated: (callback: (data: FileResponse) => void) => void;
        };
        pdfjsLib: any;
    }
}
