export interface ThumbnailDependencies {
    getDocument: () => { numPages: number } | null;
    getPagePointSize: (page: number) => { width: number; height: number };
    getSidebarTargetWidth: () => number;
    getOutputScale: () => number;
}

export interface ThumbnailLayout {
    height: (page: number, width?: number) => number;
    invalidate: () => void;
    rebuild: (force?: boolean) => void;
    tops: number[];
    elements: HTMLCanvasElement[];
    ensureMounted: (page: number, onClick: () => void) => HTMLCanvasElement | null;
    updateAspect: (page: number, aspect: number) => boolean;
    reset: () => void;
}
