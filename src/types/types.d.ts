export{};

export interface FileResponse {
  binary: Uint8Array;
  text: string;
}

declare global {
  interface Window {
    electronAPI: {
      readFile: (filePath: string) => Promise<FileResponse>;
    }
  }
}