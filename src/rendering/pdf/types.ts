export interface PdfDocumentLike {
    numPages: number;
    getPage(page: number): Promise<PdfPageLike>;
    destroy(): Promise<void>;
    getOutline(): Promise<PdfOutlineItem[] | null>;
    getDestination(name: string): Promise<unknown>;
    getPageIndex(reference: unknown): Promise<number>;
}

export interface PdfOutlineItem {
    title?: string;
    items?: PdfOutlineItem[];
    dest?: unknown;
    bold?: boolean;
    italic?: boolean;
}

export interface PdfJsLoadingTask {
    promise: Promise<PdfDocumentLike>;
    destroy(): Promise<void>;
}

export interface PdfJsModule {
    GlobalWorkerOptions: { workerSrc: string };
    getDocument(options: { data: Uint8Array }): PdfJsLoadingTask;
    TextLayer: new (options: { textContentSource: PdfTextContent; container: HTMLElement; viewport: PdfViewport }) => {
        render(): Promise<void>;
        textDivs: HTMLElement[];
    };
}

export interface PdfTextContent {
    items: Array<{ str?: string }>;
}

export interface PdfPageLike {
    view: number[];
    getTextContent(): Promise<PdfTextContent>;
    getAnnotations(): Promise<PdfAnnotation[]>;
    getViewport(options: { scale: number }): PdfViewport;
    render(options: {
        canvasContext: CanvasRenderingContext2D;
        viewport: PdfViewport;
        transform?: number[];
    }): PdfRenderTask;
}

export interface PdfViewport {
    scale: number;
    width: number;
    height: number;
    convertToViewportRectangle(rect: number[]): number[];
}

interface PdfRenderTask {
    promise: Promise<void>;
    cancel(): void;
}

interface PdfAnnotation {
    subtype: string;
    rect?: number[];
    quadPoints?: number[];
    url?: string;
    dest?: unknown;
}
