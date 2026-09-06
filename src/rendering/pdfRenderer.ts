import { DOM, getSidebarTargetWidth, updateScrollModeClasses } from '../ui.js';

window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

export const PdfState = {
    currentPdfUrl: null as string | null,
    currentPdfDoc: null as any,
    currentScale: 1.0,
    isSnapMode: true,
    zoomMode: 'auto' as 'auto' | 'manual'
};

const MAX_OUTPUT_SCALE = 2;
const RENDER_BEHIND_PAGES = 2;
const RENDER_AHEAD_PAGES = 5;
const EVICT_BEHIND_PAGES = 8;
const EVICT_AHEAD_PAGES = 16;
const RENDER_CONCURRENCY = 2;
const MEASURE_CHUNK = 15;
const THUMB_EVICT_RADIUS = 40;
const THUMB_CONCURRENCY = 2;

let scrollContainer: HTMLElement | null = null;
let pageContainers: HTMLElement[] = [];
let pageSizes = new Map<number, { width: number; height: number }>();
let renderedCanvases = new Map<number, HTMLCanvasElement>();
let pendingRenders = new Map<number, { task: any; canvas: HTMLCanvasElement }>();
let renderQueue: number[] = [];
let activeRenders = 0;
let scrollRafPending = false;
let scrollSettleTimer: any = null;
let thumbScrollRafPending = false;
let thumbSettleTimer: any = null;
let thumbCanvases = new Map<number, HTMLCanvasElement>();
let thumbPending = new Map<number, { task: any }>();
let thumbQueue: number[] = [];
let thumbActive = 0;
let measuring = false;
let viewerVersion = 0;
let savedScrollPos: { page: number; fraction: number } | null = null;

function captureScrollPos(): { page: number; fraction: number } | null {
    if (!scrollContainer || pageContainers.length === 0) return null;
    const scrollTop = scrollContainer.scrollTop;
    const page = Math.min(pageContainers.length, Math.max(1, pageAtOffset(scrollTop)));
    const container = pageContainers[page - 1];
    if (!container) return null;
    const height = container.offsetHeight || 1;
    return { page, fraction: Math.max(0, Math.min(1, (scrollTop - container.offsetTop) / height)) };
}

export function goToPage(pageNum: number) {
    if (!scrollContainer || pageContainers.length === 0 || !PdfState.currentPdfDoc) return;
    const page = Math.min(pageContainers.length, Math.max(1, Math.round(pageNum)));
    const container = pageContainers[page - 1];
    if (!container) return;
    scrollContainer.style.scrollBehavior = 'auto';
    scrollContainer.scrollTop = container.offsetTop;
    scrollContainer.style.removeProperty('scroll-behavior');
}

function syncPageCounter() {
    if (!scrollContainer || !PdfState.currentPdfDoc || !DOM.pageCounter) return;
    if (document.activeElement === DOM.pageCounter) return;
    const page = Math.min(pageContainers.length, Math.max(1, pageAtOffset(scrollContainer.scrollTop)));
    DOM.pageCounter.value = String(page);
    DOM.pageCounter.dataset.current = String(page);
}

let activeThumbPage = 0;

function syncActiveThumb() {
    if (!scrollContainer || !DOM.sidebarContent || !PdfState.currentPdfDoc) return;
    const page = Math.min(pageContainers.length, Math.max(1, pageAtOffset(scrollContainer.scrollTop)));
    if (page === activeThumbPage) return;
    activeThumbPage = page;
    const prev = DOM.sidebarContent.querySelector<HTMLElement>('.thumb-active');
    if (prev) prev.classList.remove('thumb-active');
    const thumb = DOM.sidebarContent.querySelector<HTMLElement>(`[data-page-num="${page}"]`);
    if (thumb) thumb.classList.add('thumb-active');
}

function restoreScrollPos(pos: { page: number; fraction: number } | null) {
    if (!pos || !scrollContainer || pageContainers.length === 0) return;
    const page = Math.min(pageContainers.length, Math.max(1, pos.page));
    const container = pageContainers[page - 1];
    if (!container) return;
    scrollContainer.style.scrollBehavior = 'auto';
    scrollContainer.scrollTop = container.offsetTop + pos.fraction * container.offsetHeight;
    scrollContainer.style.removeProperty('scroll-behavior');
}

export function getFitToScreenScale(page: any, container: HTMLElement): number {
    const unscaledViewport = page.getViewport({ scale: 1.0 });
    const padding = 64;
    const scaleX = (container.clientWidth - padding) / unscaledViewport.width;
    const scaleY = (container.clientHeight - padding) / unscaledViewport.height;
    return Math.min(scaleX, scaleY);
}

function getOutputScale(): number {
    return Math.min(window.devicePixelRatio || 1, MAX_OUTPUT_SCALE);
}

function cancelPendingRenders() {
    for (const { task } of pendingRenders.values()) {
        try { task?.cancel(); } catch { /* already finished */ }
    }
    pendingRenders.clear();
    renderQueue = [];
    activeRenders = 0;
}

function cancelThumbRenders() {
    for (const { task } of thumbPending.values()) {
        try { task?.cancel(); } catch { /* already finished */ }
    }
    thumbPending.clear();
    thumbQueue = [];
    thumbActive = 0;
}

function resetViewer() {
    viewerVersion++;
    cancelPendingRenders();
    renderedCanvases.clear();
    pageSizes.clear();
    pageContainers = [];
    if (scrollContainer) {
        scrollContainer.onscroll = null;
        scrollContainer.innerHTML = '';
        scrollContainer.remove();
        scrollContainer = null;
    }
    if (scrollSettleTimer) {
        clearTimeout(scrollSettleTimer);
        scrollSettleTimer = null;
    }
}

function pageAtOffset(y: number): number {
    if (pageContainers.length === 0) return 1;
    let lo = 0;
    let hi = pageContainers.length - 1;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (pageContainers[mid].offsetTop < y) lo = mid + 1;
        else hi = mid;
    }
    return lo + 1;
}

export async function renderAllMainPages() {
    if (!PdfState.currentPdfDoc || !DOM.mainContentNode) return;

    const restore = savedScrollPos;
    resetViewer();
    const version = viewerVersion;

    scrollContainer = document.createElement('div');
    scrollContainer.id = 'pdf-scroll-container';
    scrollContainer.className =
        'w-full h-full overflow-y-auto flex flex-col items-center py-8 [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] scrollbar-none scroll-smooth';
    DOM.mainContentNode.innerHTML = '';
    DOM.mainContentNode.appendChild(scrollContainer);

    const total = PdfState.currentPdfDoc.numPages;

    let placeholder = { width: 612, height: 792 };
    try {
        const firstPage = await PdfState.currentPdfDoc.getPage(1);
        if (version !== viewerVersion) return;
        if (PdfState.zoomMode === 'auto') {
            PdfState.currentScale = getFitToScreenScale(firstPage, DOM.mainContentNode);
        }
        const viewport = firstPage.getViewport({ scale: PdfState.currentScale });
        placeholder = { width: viewport.width, height: viewport.height };
        pageSizes.set(1, placeholder);
    } catch (err) {
        console.error('Error measuring first page:', err);
    }

    if (version !== viewerVersion) return;

    if (DOM.zoomLevelSpan) {
        DOM.zoomLevelSpan.value = `${Math.round(PdfState.currentScale * 100)}%`;
    }
    if (DOM.pageCounter) {
        DOM.pageCounter.value = '1';
    }
    if (DOM.pageTotal) {
        DOM.pageTotal.textContent = `/ ${total}`;
    }

    const fragment = document.createDocumentFragment();
    for (let pageNum = 1; pageNum <= total; pageNum++) {
        const container = document.createElement('div');
        container.id = `page-container-${pageNum}`;
        container.className = 'pdf-page-container mb-8 shadow-lg bg-white shrink-0 snap-center';
        container.dataset.pageNum = String(pageNum);
        container.style.width = `${placeholder.width}px`;
        container.style.height = `${placeholder.height}px`;
        fragment.appendChild(container);
    }
    scrollContainer.appendChild(fragment);
    pageContainers = Array.from(scrollContainer.children) as HTMLElement[];

    scrollContainer.addEventListener('scroll', onMainScroll, { passive: true });

    measureAllPages(version);
    restoreScrollPos(restore);
    scheduleMainWindowRender();

    updateScrollModeClasses(PdfState.isSnapMode);
}

function onMainScroll() {
    if (scrollRafPending) return;
    scrollRafPending = true;
    requestAnimationFrame(() => {
        scrollRafPending = false;
        renderVisibleWindow();
    });
    if (scrollSettleTimer) clearTimeout(scrollSettleTimer);
    scrollSettleTimer = setTimeout(() => {
        scrollSettleTimer = null;
        renderVisibleWindow();
    }, 200);
}

function renderVisibleWindow() {
    if (!scrollContainer || !PdfState.currentPdfDoc) return;
    savedScrollPos = captureScrollPos();
    syncPageCounter();
    syncActiveThumb();
    const scrollTop = scrollContainer.scrollTop;
    const clientHeight = scrollContainer.clientHeight || 1;
    const first = Math.max(1, pageAtOffset(scrollTop) - RENDER_BEHIND_PAGES);
    const last = Math.min(pageContainers.length, pageAtOffset(scrollTop + clientHeight) + RENDER_AHEAD_PAGES);

    evictOutside(first, last);
    renderQueue = renderQueue.filter(
        (p) => p >= first - EVICT_BEHIND_PAGES - 2 && p <= last + EVICT_AHEAD_PAGES + 2
    );

    for (let pageNum = first; pageNum <= last; pageNum++) {
        queuePageRender(pageNum);
    }
}

function scheduleMainWindowRender() {
    if (scrollRafPending) return;
    scrollRafPending = true;
    requestAnimationFrame(() => {
        scrollRafPending = false;
        renderVisibleWindow();
    });
}

async function measureAllPages(version: number) {
    if (!PdfState.currentPdfDoc || measuring) return;
    measuring = true;
    try {
        const total = PdfState.currentPdfDoc.numPages;
        for (let start = 1; start <= total; start += MEASURE_CHUNK) {
            if (version !== viewerVersion) return;
            const end = Math.min(start + MEASURE_CHUNK, total + 1);
            const pages = await Promise.all(
                Array.from({ length: end - start }, (_, i) =>
                    PdfState.currentPdfDoc.getPage(start + i).catch(() => null)
                )
            );
            for (let i = 0; i < pages.length; i++) {
                if (version !== viewerVersion) return;
                const page = pages[i];
                const pageNum = start + i;
                if (!page || pageSizes.has(pageNum)) continue;
                const viewport = page.getViewport({ scale: PdfState.currentScale });
                pageSizes.set(pageNum, { width: viewport.width, height: viewport.height });
                const container = pageContainers[pageNum - 1];
                if (container) {
                    container.style.width = `${viewport.width}px`;
                    container.style.height = `${viewport.height}px`;
                }
            }
            await new Promise((resolve) => setTimeout(resolve, 0));
        }
    } finally {
        measuring = false;
    }
}

function queuePageRender(pageNum: number) {
    if (renderedCanvases.has(pageNum) || pendingRenders.has(pageNum)) return;
    const container = pageContainers[pageNum - 1];
    if (!container || !container.isConnected) return;
    pendingRenders.set(pageNum, { task: null, canvas: null as any });
    renderQueue.push(pageNum);
    pumpRenderQueue();
}

function pumpRenderQueue() {
    while (activeRenders < RENDER_CONCURRENCY && renderQueue.length > 0) {
        const pageNum = renderQueue.shift()!;
        if (!pendingRenders.has(pageNum)) continue;
        if (renderedCanvases.has(pageNum)) {
            pendingRenders.delete(pageNum);
            continue;
        }
        activeRenders++;
        void renderPage(pageNum).finally(() => {
            activeRenders--;
            pendingRenders.delete(pageNum);
            pumpRenderQueue();
        });
    }
}

async function renderPage(pageNum: number) {
    const container = pageContainers[pageNum - 1];
    if (!container || !container.isConnected || !PdfState.currentPdfDoc) return;
    try {
        const page = await PdfState.currentPdfDoc.getPage(pageNum);
        if (!container.isConnected || !PdfState.currentPdfDoc) return;
        const viewport = page.getViewport({ scale: PdfState.currentScale });
        if (!pageSizes.has(pageNum)) {
            pageSizes.set(pageNum, { width: viewport.width, height: viewport.height });
            container.style.width = `${viewport.width}px`;
            container.style.height = `${viewport.height}px`;
        }

        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        const outputScale = getOutputScale();
        canvas.width = Math.floor(viewport.width * outputScale);
        canvas.height = Math.floor(viewport.height * outputScale);
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;
        const transform = outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : undefined;

        container.appendChild(canvas);
        const entry = pendingRenders.get(pageNum);
        const task = page.render({ canvasContext: ctx, transform, viewport });
        if (entry) entry.canvas = canvas;
        if (entry) entry.task = task;
        await task.promise;
        renderedCanvases.set(pageNum, canvas);
    } catch (err: any) {
        if (err?.name !== 'RenderingCancelledException') {
            console.error(`Error rendering page ${pageNum}:`, err);
        }
    }
}

function evictOutside(first: number, last: number) {
    for (const [pageNum, canvas] of renderedCanvases) {
        if (pageNum < first - EVICT_BEHIND_PAGES || pageNum > last + EVICT_AHEAD_PAGES) {
            canvas.remove();
            renderedCanvases.delete(pageNum);
        }
    }
    for (const [pageNum, entry] of pendingRenders) {
        if (pageNum < first - EVICT_BEHIND_PAGES - 2 || pageNum > last + EVICT_AHEAD_PAGES + 2) {
            try { entry.task?.cancel(); } catch { /* already finished */ }
            entry.canvas?.remove();
            pendingRenders.delete(pageNum);
        }
    }
}

export async function renderThumbnails() {
    if (!PdfState.currentPdfDoc || !DOM.sidebarContent) return;

    thumbCanvases.clear();
    cancelThumbRenders();

    const sidebar = document.getElementById('sidebar');
    const savedScrollTop = sidebar ? sidebar.scrollTop : 0;
    DOM.sidebarContent.innerHTML = '';

    if (sidebar) {
        sidebar.onscroll = null;
    }
    if (thumbSettleTimer) {
        clearTimeout(thumbSettleTimer);
        thumbSettleTimer = null;
    }

    const total = PdfState.currentPdfDoc.numPages;
    DOM.sidebarContent.style.position = 'relative';

    const thumbTargetWidth = Math.max(160, getSidebarTargetWidth() - 32);
    const fragment = document.createDocumentFragment();
    for (let pageNum = 1; pageNum <= total; pageNum++) {
        const canvas = document.createElement('canvas');
        canvas.className =
            'mb-4 cursor-pointer border-2 border-transparent hover:border-lavender-400 transition-colors shadow-sm rounded bg-white w-full h-auto';
        canvas.dataset.pageNum = String(pageNum);
        const size = pageSizes.get(pageNum);
        const aspect = size ? size.height / size.width : 792 / 612;
        canvas.style.height = `${Math.round(thumbTargetWidth * aspect)}px`;
        canvas.onclick = () => {
            const target = document.getElementById(`page-container-${pageNum}`);
            if (target) target.scrollIntoView({ behavior: 'smooth' });
        };
        fragment.appendChild(canvas);
    }
    DOM.sidebarContent.appendChild(fragment);

    activeThumbPage = 0;
    syncActiveThumb();

    if (sidebar) {
        sidebar.scrollTop = savedScrollTop;
        sidebar.addEventListener('scroll', onThumbScroll, { passive: true });
        scheduleThumbWindowRender();
    } else {
        for (let i = 1; i <= total; i++) queueThumbRender(i);
    }
}

function thumbIndexAt(y: number): number {
    if (!DOM.sidebarContent) return 0;
    const thumbs = Array.from(DOM.sidebarContent.children) as HTMLElement[];
    if (thumbs.length === 0) return 0;
    let lo = 0;
    let hi = thumbs.length - 1;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (thumbs[mid].offsetTop < y) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

function onThumbScroll() {
    if (thumbScrollRafPending) return;
    thumbScrollRafPending = true;
    requestAnimationFrame(() => {
        thumbScrollRafPending = false;
        renderVisibleThumbs();
    });
    if (thumbSettleTimer) clearTimeout(thumbSettleTimer);
    thumbSettleTimer = setTimeout(() => {
        thumbSettleTimer = null;
        renderVisibleThumbs();
    }, 200);
}

function scheduleThumbWindowRender() {
    if (thumbScrollRafPending) return;
    thumbScrollRafPending = true;
    requestAnimationFrame(() => {
        thumbScrollRafPending = false;
        renderVisibleThumbs();
    });
}

function renderVisibleThumbs() {
    const sidebar = document.getElementById('sidebar');
    if (!sidebar || !DOM.sidebarContent || DOM.sidebarContent.children.length === 0) return;
    const first = Math.max(0, thumbIndexAt(sidebar.scrollTop) - 2);
    const last = Math.min(DOM.sidebarContent.children.length - 1, thumbIndexAt(sidebar.scrollTop + sidebar.clientHeight) + 5);


    evictThumbs(first, last);
    thumbQueue = thumbQueue.filter(
        (p) => p - 1 >= first - THUMB_EVICT_RADIUS - 5 && p - 1 <= last + THUMB_EVICT_RADIUS + 5
    );

    for (let pageNum = first + 1; pageNum <= last + 1; pageNum++) {
        queueThumbRender(pageNum);
    }
}

function queueThumbRender(pageNum: number) {
    if (thumbCanvases.has(pageNum) || thumbPending.has(pageNum)) return;
    thumbPending.set(pageNum, { task: null });
    thumbQueue.push(pageNum);
    pumpThumbQueue();
}

function pumpThumbQueue() {
    while (thumbActive < THUMB_CONCURRENCY && thumbQueue.length > 0) {
        const pageNum = thumbQueue.shift()!;
        if (!thumbPending.has(pageNum)) continue;
        if (thumbCanvases.has(pageNum)) {
            thumbPending.delete(pageNum);
            continue;
        }
        thumbActive++;
        void renderThumb(pageNum).finally(() => {
            thumbActive--;
            thumbPending.delete(pageNum);
            pumpThumbQueue();
        });
    }
}

async function renderThumb(pageNum: number) {
    const thumb = DOM.sidebarContent?.querySelector<HTMLCanvasElement>(`[data-page-num="${pageNum}"]`);
    if (!thumb || !thumb.isConnected || !PdfState.currentPdfDoc) return;
    try {
        const page = await PdfState.currentPdfDoc.getPage(pageNum);
        if (!thumb.isConnected || !PdfState.currentPdfDoc) return;
        const baseViewport = page.getViewport({ scale: 1 });
        const targetWidth = Math.max(160, getSidebarTargetWidth() - 32); 
        const scale = (targetWidth / baseViewport.width) * getOutputScale();
        const viewport = page.getViewport({ scale });
        thumb.width = Math.max(1, Math.floor(viewport.width));
        thumb.height = Math.max(1, Math.floor(viewport.height));
        thumb.style.height = `${Math.max(1, Math.floor(viewport.height / getOutputScale()))}px`;
        const ctx = thumb.getContext('2d');
        if (!ctx) return;
        const task = page.render({ canvasContext: ctx, viewport });
        const entry = thumbPending.get(pageNum);
        if (entry) entry.task = task;
        await task.promise;
        thumbCanvases.set(pageNum, thumb);
        thumb.dataset.rendered = '1';
    } catch (err: any) {
        if (err?.name !== 'RenderingCancelledException') {
            console.error(`Error rendering thumbnail ${pageNum}:`, err);
        }
    }
}

function evictThumbs(first: number, last: number) {
    for (const [pageNum, thumb] of thumbCanvases) {
        if (pageNum - 1 < first - THUMB_EVICT_RADIUS || pageNum - 1 > last + THUMB_EVICT_RADIUS) {
            thumb.width = 0;
            thumb.height = 0;
            thumbCanvases.delete(pageNum);
        }
    }
    for (const [pageNum, entry] of thumbPending) {
        if (pageNum - 1 < first - THUMB_EVICT_RADIUS - 5 || pageNum - 1 > last + THUMB_EVICT_RADIUS + 5) {
            try { entry.task?.cancel(); } catch { /* already finished */ }
            thumbPending.delete(pageNum);
        }
    }
}