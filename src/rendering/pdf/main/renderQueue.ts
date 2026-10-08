import { addPageLinkLayer } from '../links.js';
import type { PdfDocumentLike, PdfPageLike, PdfViewport } from '../types.js';
import type { PdfPageLayout } from '../layout.js';

interface PendingRender {
    task: { cancel?: () => void } | null;
    canvas: HTMLCanvasElement | null;
}

interface MainPageRendererDependencies {
    getDocument: () => PdfDocumentLike | null;
    getScale: () => number;
    layout: Pick<PdfPageLayout, 'getPageContainer' | 'setPagePoints'>;
    getOutputScale: () => number;
    renderConcurrency: number;
    getActiveThumbnailRenders: () => number;
    renderTextLayer: (
        page: PdfPageLike,
        container: HTMLElement,
        viewport: PdfViewport,
        pageNumber: number,
    ) => Promise<void>;
    clearPageSpans: (pageNumber: number) => void;
    resolveDestination: (destination: unknown) => Promise<{ page: number; y: number | null } | null>;
    isObsoleteRender: (error: unknown, doc: unknown) => boolean;
    onRenderSettled: () => void;
}

export function createMainPageRenderer(deps: MainPageRendererDependencies) {
    const renderedCanvases = new Map<number, HTMLCanvasElement>();
    const pendingRenders = new Map<number, PendingRender>();
    const pageHandles = new Map<number, PdfPageLike>();
    let renderQueue: number[] = [];
    let activeRenders = 0;

    function releasePage(pageNumber: number) {
        if (pendingRenders.has(pageNumber) || renderedCanvases.has(pageNumber)) return;
        const page = pageHandles.get(pageNumber);
        if (!page) return;
        pageHandles.delete(pageNumber);
        try {
            (page as PdfPageLike & { cleanup?: () => void }).cleanup?.();
        } catch {}
    }

    function onPageUnmounted(pageNumber: number) {
        const entry = pendingRenders.get(pageNumber);
        if (entry) {
            try {
                entry.task?.cancel?.();
            } catch {}
            entry.canvas?.remove();
            pendingRenders.delete(pageNumber);
        }
        renderQueue = renderQueue.filter((queuedPage) => queuedPage !== pageNumber);
        renderedCanvases.delete(pageNumber);
        deps.clearPageSpans(pageNumber);
        releasePage(pageNumber);
    }

    function queuePage(pageNumber: number) {
        if (renderedCanvases.has(pageNumber) || pendingRenders.has(pageNumber)) return;
        const container = deps.layout.getPageContainer(pageNumber);
        if (!container?.isConnected) return;
        pendingRenders.set(pageNumber, { task: null, canvas: null });
        renderQueue.push(pageNumber);
        pump();
    }

    function pump() {
        while (renderQueue.length > 0) {
            if (activeRenders + deps.getActiveThumbnailRenders() >= deps.renderConcurrency) return;
            const page = renderQueue.shift()!;
            if (!pendingRenders.has(page)) continue;
            if (renderedCanvases.has(page)) {
                pendingRenders.delete(page);
                continue;
            }
            const entry = pendingRenders.get(page);
            if (!entry) continue;
            activeRenders++;
            void renderPage(page, entry).finally(() => {
                activeRenders = Math.max(0, activeRenders - 1);
                if (pendingRenders.get(page) === entry) pendingRenders.delete(page);
                pump();
                deps.onRenderSettled();
            });
        }
    }

    async function renderPage(pageNumber: number, entry: PendingRender) {
        const container = deps.layout.getPageContainer(pageNumber);
        const doc = deps.getDocument();
        const isCurrent = () =>
            pendingRenders.get(pageNumber) === entry &&
            container?.isConnected === true &&
            deps.layout.getPageContainer(pageNumber) === container &&
            deps.getDocument() === doc;
        if (!container?.isConnected || !doc) return;
        let canvas: HTMLCanvasElement | null = null;
        try {
            const page = await doc.getPage(pageNumber);
            if (!isCurrent()) return;
            pageHandles.set(pageNumber, page);
            const viewport = page.getViewport({ scale: deps.getScale() });
            const scale = deps.getScale() || 1;
            deps.layout.setPagePoints(pageNumber, { width: viewport.width / scale, height: viewport.height / scale });
            canvas = document.createElement('canvas');
            const context = canvas.getContext('2d');
            if (!context) return;
            const outputScale = deps.getOutputScale();
            canvas.width = Math.floor(viewport.width * outputScale);
            canvas.height = Math.floor(viewport.height * outputScale);
            canvas.style.width = `${Math.floor(viewport.width)}px`;
            canvas.style.height = `${Math.floor(viewport.height)}px`;
            const transform = outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : undefined;
            container.appendChild(canvas);
            const task = page.render({ canvasContext: context, transform, viewport });
            entry.canvas = canvas;
            entry.task = task;
            await task.promise;
            if (!isCurrent()) {
                canvas.remove();
                return;
            }
            renderedCanvases.set(pageNumber, canvas);
            await deps.renderTextLayer(page, container, viewport, pageNumber);
            if (!isCurrent()) return;
            await addPageLinkLayer(page, container, viewport, deps.resolveDestination);
            if (!isCurrent()) return;
        } catch (error) {
            canvas?.remove();
            if (pendingRenders.get(pageNumber) === entry && !deps.isObsoleteRender(error, doc)) {
                console.error(`Error rendering page ${pageNumber}:`, error);
            }
        }
    }

    function cancel() {
        for (const { task } of pendingRenders.values()) {
            try {
                task?.cancel?.();
            } catch {}
        }
        pendingRenders.clear();
        renderQueue = [];
    }

    function clear() {
        renderedCanvases.clear();
        pageHandles.clear();
    }

    function retainQueuedPages(first: number, last: number) {
        renderQueue = renderQueue.filter((pageNumber) => pageNumber >= first && pageNumber <= last);
    }

    return {
        cancel,
        clear,
        getActivity: () => ({
            queueLength: renderQueue.length,
            pendingCount: pendingRenders.size,
            activeCount: activeRenders,
        }),
        onPageUnmounted,
        pump,
        queuePage,
        releasePage,
        retainQueuedPages,
    };
}

export type MainPageRenderer = ReturnType<typeof createMainPageRenderer>;
