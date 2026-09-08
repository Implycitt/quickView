import { DOM, getSidebarTargetWidth, updateScrollModeClasses } from '../ui.js';

window.pdfjsLib.GlobalWorkerOptions.workerSrc =
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

export const PdfState = {
    currentPdfDoc: null as any,
    currentScale: 1.0,
    isSnapMode: true,
    zoomMode: 'auto' as 'auto' | 'manual',
};

const MAX_OUTPUT_SCALE = 2;
const RENDER_BEHIND_PAGES = 2;
const RENDER_AHEAD_PAGES = 5;
const EVICT_BEHIND_PAGES = 8;
const EVICT_AHEAD_PAGES = 16;
const RENDER_CONCURRENCY = 3;
const MEASURE_CHUNK = 15;
const THUMB_EVICT_RADIUS = 40;
const THUMB_GAP = 16;
const THUMB_INSET = 16;

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
let thumbElements: HTMLElement[] = [];
let thumbTops: number[] = [];
let thumbAspects = new Map<number, number>();
let measuring = false;
let viewerVersion = 0;
let savedScrollPos: { page: number; fraction: number } | null = null;
let lastKnownPage = 1;
let currentFileName: string | null = null;

function captureScrollPos(): { page: number; fraction: number } | null {
    if (!scrollContainer || pageContainers.length === 0) return savedScrollPos;
    const scrollTop = scrollContainer.scrollTop;
    const page = currentPageAtViewport();
    const container = pageContainers[page - 1];
    if (!container) return null;
    const height = container.offsetHeight || 1;
    return { page, fraction: Math.max(0, Math.min(1, (scrollTop - container.offsetTop) / height)) };
}

export function goToPage(pageNum: number) {
    if (!scrollContainer || pageContainers.length === 0 || !PdfState.currentPdfDoc) return;
    const page = Math.min(pageContainers.length, Math.max(1, Math.round(pageNum)));
    const apply = () => {
        const container = pageContainers[page - 1];
        if (!container || !container.isConnected || !scrollContainer) return;
        scrollContainer.style.scrollBehavior = 'auto';
        scrollContainer.scrollTop = container.offsetTop;
        scrollContainer.style.removeProperty('scroll-behavior');
    };
    if (pageSizes.has(page)) {
        apply();
        return;
    }
    apply();
    void Promise.all([measurePageNow(page), whenMeasurementDone()]).then(() => {
        if (!PdfState.currentPdfDoc || Math.abs(currentPageAtViewport() - page) > 3) return;
        apply();
    });
}

function syncPageCounter() {
    if (!scrollContainer || !PdfState.currentPdfDoc || !DOM.pageCounter) return;
    if (document.activeElement === DOM.pageCounter) return;
    const page = currentPageAtViewport();
    if (DOM.pageCounter.value !== String(page)) {
        DOM.pageCounter.value = String(page);
        DOM.pageCounter.dataset.current = String(page);
    }
}

let activeThumbPage = 0;

function syncActiveThumb() {
    if (!scrollContainer || !DOM.sidebarPreviews || !PdfState.currentPdfDoc) return;
    const page = currentPageAtViewport();
    const changed = page !== activeThumbPage;
    activeThumbPage = page;
    const prev = DOM.sidebarPreviews.querySelector<HTMLElement>('.thumb-active');
    const prevPage = prev ? parseInt(prev.dataset.pageNum || '0', 10) : 0;
    if (prev && prevPage === page) return;
    if (prev) prev.classList.remove('thumb-active');
    if (!previewsPaneVisible()) return;
    const thumb = ensureThumbMounted(page);
    if (thumb) {
        thumb.classList.add('thumb-active');
        if (changed) scrollThumbIntoView(thumb);
    }
}

function previewsPaneVisible(): boolean {
    return (
        !!DOM.sidebarPreviews &&
        !DOM.sidebarPreviews.classList.contains('hidden') &&
        !!DOM.sidebar &&
        DOM.sidebar.style.width !== '0px'
    );
}

let thumbFollowSmooth = false;
let thumbFollowTimer: any = null;

function paneOffsetInSidebar(): number {
    const sidebar = document.getElementById('sidebar');
    const pane = DOM.sidebarPreviews;
    if (!sidebar || !pane) return 0;
    return pane.getBoundingClientRect().top - sidebar.getBoundingClientRect().top + sidebar.scrollTop;
}

function scrollThumbIntoView(thumb: HTMLElement) {
    const sidebar = document.getElementById('sidebar');
    if (!sidebar || !previewsPaneVisible()) return;
    const paneTop = paneOffsetInSidebar();
    const viewTop = sidebar.scrollTop - paneTop;
    const viewBottom = viewTop + sidebar.clientHeight;
    const thumbTop = thumb.offsetTop;
    const thumbBottom = thumbTop + thumb.offsetHeight;
    if (thumbTop >= viewTop && thumbBottom <= viewBottom) {
        thumbFollowSmooth = false;
        return;
    }
    const target = Math.max(0, thumbTop - (sidebar.clientHeight - thumb.offsetHeight) / 2 + paneTop);
    const dist = Math.abs(sidebar.scrollTop - target);
    if (dist <= sidebar.clientHeight && !thumbFollowSmooth) {
        thumbFollowSmooth = true;
        sidebar.scrollTo({ top: target, behavior: 'smooth' });
        if (thumbFollowTimer) clearTimeout(thumbFollowTimer);
        thumbFollowTimer = setTimeout(
            () => {
                thumbFollowSmooth = false;
            },
            Math.min(900, 250 + dist * 0.5),
        );
    } else {
        sidebar.style.scrollBehavior = 'auto';
        sidebar.scrollTop = target;
        sidebar.style.removeProperty('scroll-behavior');
        thumbFollowSmooth = false;
    }
}

function restoreScrollPos(pos: { page: number; fraction: number } | null) {
    if (!pos || !scrollContainer || pageContainers.length === 0) return;
    const page = Math.min(pageContainers.length, Math.max(1, pos.page));
    const container = pageContainers[page - 1];
    if (!container) return;
    let target: number;
    if (PdfState.isSnapMode && !snapSuspended) {
        target = container.offsetTop + (container.offsetHeight - scrollContainer.clientHeight) / 2;
        target = Math.max(0, target);
    } else {
        target = container.offsetTop + pos.fraction * container.offsetHeight;
    }
    scrollContainer.style.scrollBehavior = 'auto';
    scrollContainer.scrollTop = target;
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
        try {
            task?.cancel();
        } catch {}
    }
    pendingRenders.clear();
    renderQueue = [];
    activeRenders = 0;
}

function cancelThumbRenders() {
    for (const { task } of thumbPending.values()) {
        try {
            task?.cancel();
        } catch {}
    }
    thumbPending.clear();
    thumbQueue = [];
}

export function resetPdfState() {
    cancelThumbRenders();
    thumbCanvases.clear();
    thumbElements = [];
    thumbTops = [];
    thumbAspects.clear();
    savedScrollPos = null;
    lastKnownPage = 1;
    currentFileName = null;
    syncOutlineBreadcrumb();
    PdfState.currentPdfDoc = null;
    PdfState.zoomMode = 'auto';
    resetViewer();
    const sidebar = document.getElementById('sidebar');
    if (sidebar) sidebar.removeEventListener('scroll', onThumbScroll);
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

function currentPageAtViewport(): number {
    if (pageContainers.length === 0 || !scrollContainer) return lastKnownPage;
    const top = scrollContainer.scrollTop;
    const bottom = top + (scrollContainer.clientHeight || 1);
    const mid = (top + bottom) / 2;
    let best = pageAtOffset(mid);
    let bestVisible = -1;
    const start = Math.max(1, best - 1);
    const end = Math.min(pageContainers.length, best + 1);
    for (let p = start; p <= end; p++) {
        const el = pageContainers[p - 1];
        const elTop = el.offsetTop;
        const elBottom = elTop + el.offsetHeight;
        const visible = Math.min(elBottom, bottom) - Math.max(elTop, top);
        if (visible > bestVisible) {
            bestVisible = visible;
            best = p;
        }
    }
    lastKnownPage = best;
    return best;
}

let mainRenderInFlight: Promise<void> | null = null;

export function whenMainRenderIdle(): Promise<void> {
    return mainRenderInFlight ?? Promise.resolve();
}

export async function renderAllMainPages() {
    if (!PdfState.currentPdfDoc || !DOM.mainContentNode) return;
    const run = runRenderAllMainPages();
    mainRenderInFlight = run.finally(() => {
        if (mainRenderInFlight === run) mainRenderInFlight = null;
    });
    return mainRenderInFlight;
}

async function runRenderAllMainPages() {
    const restore = savedScrollPos;
    const version = viewerVersion + 1;
    viewerVersion = version;
    cancelPendingRenders();
    renderedCanvases.clear();
    pageSizes.clear();
    pageContainers = [];
    if (scrollSettleTimer) {
        clearTimeout(scrollSettleTimer);
        scrollSettleTimer = null;
    }

    const scroller = document.createElement('div');
    scroller.id = 'pdf-scroll-container';
    scroller.className =
        'w-full h-full overflow-y-auto flex flex-col items-center py-8 [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] scrollbar-none';

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
        DOM.pageCounter.value = String(lastKnownPage);
        DOM.pageCounter.dataset.current = String(lastKnownPage);
    }
    if (DOM.pageTotal) {
        DOM.pageTotal.textContent = `/ ${total}`;
    }

    const fragment = document.createDocumentFragment();
    for (let pageNum = 1; pageNum <= total; pageNum++) {
        const container = document.createElement('div');
        container.id = `page-container-${pageNum}`;
        container.className = 'pdf-page-container mb-8 shadow-lg bg-white shrink-0 snap-center relative';
        container.dataset.pageNum = String(pageNum);
        container.style.width = `${placeholder.width}px`;
        container.style.height = `${placeholder.height}px`;
        fragment.appendChild(container);
    }
    scroller.appendChild(fragment);

    const old = scrollContainer;
    scrollContainer = scroller;
    pageContainers = Array.from(scroller.children) as HTMLElement[];
    if (old) {
        old.removeEventListener('scroll', onMainScroll);
        old.remove();
    }
    DOM.mainContentNode.innerHTML = '';
    DOM.mainContentNode.appendChild(scroller);

    scroller.addEventListener('scroll', onMainScroll, { passive: true });

    restoreScrollPos(restore);
    scheduleMainWindowRender();
    updateScrollModeClasses(PdfState.isSnapMode);
    if (snapSuspended) {
        scroller.classList.remove('snap-y', 'snap-mandatory');
    }

    await measureAllPages(version);
    if (version !== viewerVersion) return;
    restoreScrollPos(restore ?? savedScrollPos);
    scheduleMainWindowRender();
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
    syncActiveOutline();
    syncOutlineBreadcrumb();
    const scrollTop = scrollContainer.scrollTop;
    const clientHeight = scrollContainer.clientHeight || 1;
    const first = Math.max(1, pageAtOffset(scrollTop) - RENDER_BEHIND_PAGES);
    const last = Math.min(pageContainers.length, pageAtOffset(scrollTop + clientHeight) + RENDER_AHEAD_PAGES);

    evictOutside(first, last);
    renderQueue = renderQueue.filter((p) => p >= first - EVICT_BEHIND_PAGES - 2 && p <= last + EVICT_AHEAD_PAGES + 2);

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

let measureChain: Promise<void> = Promise.resolve();

function measureAllPages(version: number): Promise<void> {
    const run = async () => {
        if (!PdfState.currentPdfDoc) return;
        measuring = true;
        try {
            const total = PdfState.currentPdfDoc.numPages;
            const pending: { pageNum: number; size: { width: number; height: number } }[] = [];
            for (let start = 1; start <= total; start += MEASURE_CHUNK) {
                if (version !== viewerVersion) return;
                const end = Math.min(start + MEASURE_CHUNK, total + 1);
                const pages = await Promise.all(
                    Array.from({ length: end - start }, (_, i) =>
                        PdfState.currentPdfDoc.getPage(start + i).catch(() => null),
                    ),
                );
                for (let i = 0; i < pages.length; i++) {
                    if (version !== viewerVersion) return;
                    const page = pages[i];
                    const pageNum = start + i;
                    if (!page || pageSizes.has(pageNum)) continue;
                    const viewport = page.getViewport({ scale: PdfState.currentScale });
                    pending.push({ pageNum, size: { width: viewport.width, height: viewport.height } });
                }
            }
            if (version !== viewerVersion) return;
            for (const { pageNum, size } of pending) {
                pageSizes.set(pageNum, size);
                const container = pageContainers[pageNum - 1];
                if (container) {
                    container.style.width = `${size.width}px`;
                    container.style.height = `${size.height}px`;
                }
            }
            scheduleThumbWindowRender();
        } finally {
            measuring = false;
            const resolvers = measureWaiters;
            measureWaiters = [];
            for (const resolve of resolvers) resolve();
        }
    };
    measureChain = measureChain.then(run, run);
    return measureChain;
}

let measureWaiters: (() => void)[] = [];

function whenMeasurementDone(): Promise<void> {
    if (!measuring) return Promise.resolve();
    return new Promise((resolve) => measureWaiters.push(resolve));
}

export async function measurePageNow(pageNum: number) {
    if (!PdfState.currentPdfDoc || pageSizes.has(pageNum)) return;
    try {
        const page = await PdfState.currentPdfDoc.getPage(pageNum);
        if (!page || pageSizes.has(pageNum)) return;
        const viewport = page.getViewport({ scale: PdfState.currentScale });
        pageSizes.set(pageNum, { width: viewport.width, height: viewport.height });
        const container = pageContainers[pageNum - 1];
        if (container && container.isConnected) {
            container.style.width = `${viewport.width}px`;
            container.style.height = `${viewport.height}px`;
        }
        scheduleThumbWindowRender();
    } catch {}
}

export function refreshSidebarSync() {
    if (!PdfState.currentPdfDoc) return;
    syncActiveThumb();
    syncActiveOutline();
    syncOutlineBreadcrumb();
    if (!previewsPaneVisible()) return;
    scheduleThumbWindowRender();
    const active = DOM.sidebarPreviews.querySelector<HTMLElement>('.thumb-active');
    if (active) scrollThumbIntoView(active);
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
            activeRenders = Math.max(0, activeRenders - 1);
            pendingRenders.delete(pageNum);
            pumpRenderQueue();
            pumpThumbQueue();
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
        if (!pageSizes.has(pageNum) && !measuring) {
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
        await addPageLinkLayer(page, container, viewport);
    } catch (err: any) {
        if (err?.name !== 'RenderingCancelledException') {
            console.error(`Error rendering page ${pageNum}:`, err);
        }
    }
}

async function addPageLinkLayer(page: any, container: HTMLElement, viewport: any) {
    try {
        const annotations = await page.getAnnotations();
        const links = annotations.filter((a: any) => a.subtype === 'Link');
        if (links.length === 0) return;
        container.querySelectorAll('.pdf-link-layer').forEach((l) => l.remove());
        const layer = document.createElement('div');
        layer.className = 'pdf-link-layer';
        for (const ann of links) {
            if (!ann.rect || ann.rect.length !== 4) continue;
            const [x1, y1, x2, y2] = viewport.convertToViewportRectangle(ann.rect);
            const el = document.createElement('a');
            el.className = 'pdf-link';
            el.style.left = `${Math.min(x1, x2)}px`;
            el.style.top = `${Math.min(y1, y2)}px`;
            el.style.width = `${Math.abs(x2 - x1)}px`;
            el.style.height = `${Math.abs(y2 - y1)}px`;
            if (ann.url) {
                el.href = ann.url;
                el.target = '_blank';
                el.rel = 'noopener';
            } else if (ann.dest) {
                el.href = '#';
                el.addEventListener('click', (e) => {
                    e.preventDefault();
                    void resolveOutlineDest(ann.dest).then((t) => {
                        if (t) jumpToPage(t.page, t.y);
                    });
                });
            }
            layer.appendChild(el);
        }
        container.appendChild(layer);
    } catch {}
}

let snapSuspended = false;

function suspendSnap() {
    if (!PdfState.isSnapMode || snapSuspended || !scrollContainer) return;
    if (!scrollContainer.classList.contains('snap-mandatory')) return;
    snapSuspended = true;
    scrollContainer.classList.remove('snap-y', 'snap-mandatory');
    const resume = () => {
        snapSuspended = false;
        window.removeEventListener('wheel', resume, { capture: true });
        window.removeEventListener('keydown', resume, { capture: true });
        if (!scrollContainer || !PdfState.isSnapMode) return;
        scrollContainer.classList.add('snap-y', 'snap-mandatory');
    };
    window.addEventListener('wheel', resume, { capture: true, passive: true });
    window.addEventListener('keydown', resume, { capture: true });
}

function jumpToPage(pageNum: number, yCss: number | null = null) {
    const jump = () => {
        const target = document.getElementById(`page-container-${pageNum}`);
        if (!target || !scrollContainer) return;
        const y = yCss == null ? 0 : Math.max(0, Math.min(yCss, target.offsetHeight - 1));
        const top = target.offsetTop + y;
        if (y > 0) suspendSnap();
        const dist = Math.abs(top - scrollContainer.scrollTop);
        if (dist > (scrollContainer.clientHeight || 1) * 1.5) {
            scrollContainer.style.scrollBehavior = 'auto';
            scrollContainer.scrollTop = top;
            scrollContainer.style.removeProperty('scroll-behavior');
        } else {
            scrollContainer.scrollTo({ top, behavior: 'smooth' });
        }
    };
    if (pageSizes.has(pageNum)) {
        jump();
        return;
    }
    jump();
    void Promise.all([measurePageNow(pageNum), whenMeasurementDone()]).then(() => {
        if (!PdfState.currentPdfDoc || Math.abs(currentPageAtViewport() - pageNum) > 3) return;
        jump();
    });
}

async function resolveOutlineDest(dest: any): Promise<{ page: number; y: number | null } | null> {
    try {
        if (!dest) return null;
        if (typeof dest === 'string') {
            const resolved = await PdfState.currentPdfDoc.getDestination(dest);
            return resolveOutlineDest(resolved);
        }
        if (Array.isArray(dest)) {
            const ref = dest[0];
            if (ref && typeof ref === 'object' && 'num' in ref) {
                const pageIndex = await PdfState.currentPdfDoc.getPageIndex(ref);
                return withOutlinePosition(pageIndex + 1, dest);
            }
            if (typeof ref === 'number') {
                return withOutlinePosition(Math.round(ref), dest);
            }
        }
    } catch {}
    return null;
}

async function withOutlinePosition(pageNum: number, dest: any[]): Promise<{ page: number; y: number | null } | null> {
    const doc = PdfState.currentPdfDoc;
    if (!doc) return null;
    const page = Math.min(doc.numPages, Math.max(1, pageNum));
    const mode = dest[1]?.name ?? dest[1];
    let top: number | null = null;
    if (mode === 'XYZ' && typeof dest[3] === 'number') top = dest[3];
    else if ((mode === 'FitH' || mode === 'FitBH') && typeof dest[2] === 'number') top = dest[2];
    if (top === null) return { page, y: null };
    let pageHeightPts: number;
    const cached = pageSizes.get(page);
    if (cached) {
        pageHeightPts = cached.height / PdfState.currentScale;
    } else {
        const p = await doc.getPage(page);
        pageHeightPts = p.view[3] - p.view[1];
    }
    const yPts = pageHeightPts - top;
    if (yPts <= 1) return { page, y: null };
    return { page, y: yPts * PdfState.currentScale };
}

const outlineDests = new Map<HTMLElement, any>();
const outlinePositions = new Map<HTMLElement, { page: number; y: number }>();
const outlineParentRow = new Map<HTMLElement, HTMLElement | null>();
let activeOutlineRow: HTMLElement | null = null;
let outlineFollowSmooth = false;
let outlineFollowTimer: any = null;

function currentViewPosition(): { page: number; y: number } {
    const page = currentPageAtViewport();
    const container = pageContainers[page - 1];
    if (!scrollContainer || !container) return { page, y: 0 };
    const mid = scrollContainer.scrollTop + (scrollContainer.clientHeight || 1) / 2;
    return { page, y: Math.max(0, mid - container.offsetTop) };
}

function bestOutlineRow(rows: HTMLElement[]): HTMLElement | null {
    const pos = currentViewPosition();
    let best: HTMLElement | null = null;
    let bestPage = 0;
    let bestY = -Infinity;
    for (const row of rows) {
        const p = outlinePositions.get(row);
        if (!p) continue;
        if (p.page > pos.page || (p.page === pos.page && p.y > pos.y)) continue;
        if (p.page > bestPage || (p.page === bestPage && p.y >= bestY)) {
            bestPage = p.page;
            bestY = p.y;
            best = row;
        }
    }
    return best;
}

function sectionsPaneVisible(): boolean {
    return (
        !!DOM.sidebarSections &&
        !DOM.sidebarSections.classList.contains('hidden') &&
        !!DOM.sidebar &&
        DOM.sidebar.style.width !== '0px'
    );
}

function sectionsPaneOffsetInSidebar(): number {
    const sidebar = document.getElementById('sidebar');
    const pane = DOM.sidebarSections;
    if (!sidebar || !pane) return 0;
    return pane.getBoundingClientRect().top - sidebar.getBoundingClientRect().top + sidebar.scrollTop;
}

function scrollOutlineRowIntoView(row: HTMLElement) {
    const sidebar = document.getElementById('sidebar');
    if (!sidebar || !sectionsPaneVisible()) return;
    const paneTop = sectionsPaneOffsetInSidebar();
    const viewTop = sidebar.scrollTop - paneTop;
    const viewBottom = viewTop + sidebar.clientHeight;
    const rowTop = row.getBoundingClientRect().top - DOM.sidebarSections.getBoundingClientRect().top;
    const rowBottom = rowTop + row.offsetHeight;
    if (rowTop >= viewTop && rowBottom <= viewBottom) {
        outlineFollowSmooth = false;
        return;
    }
    const target = Math.max(0, rowTop - (sidebar.clientHeight - row.offsetHeight) / 2 + paneTop);
    const dist = Math.abs(sidebar.scrollTop - target);
    if (dist <= sidebar.clientHeight && !outlineFollowSmooth) {
        outlineFollowSmooth = true;
        sidebar.scrollTo({ top: target, behavior: 'smooth' });
        if (outlineFollowTimer) clearTimeout(outlineFollowTimer);
        outlineFollowTimer = setTimeout(
            () => {
                outlineFollowSmooth = false;
            },
            Math.min(900, 250 + dist * 0.5),
        );
    } else {
        sidebar.style.scrollBehavior = 'auto';
        sidebar.scrollTop = target;
        sidebar.style.removeProperty('scroll-behavior');
        outlineFollowSmooth = false;
    }
}

function syncActiveOutline() {
    if (!scrollContainer || !DOM.sidebarSections) return;
    if (DOM.sidebarSections.classList.contains('hidden')) return;
    const rows = Array.from(DOM.sidebarSections.querySelectorAll<HTMLElement>('.outline-item'));
    if (rows.length === 0) return;
    const best = bestOutlineRow(rows);
    if (best !== activeOutlineRow) {
        if (activeOutlineRow) activeOutlineRow.classList.remove('outline-active');
        activeOutlineRow = best;
        if (best) {
            best.classList.add('outline-active');
            let node = best.parentElement;
            while (node && node !== DOM.sidebarSections) {
                if (node.classList.contains('outline-children') && node.classList.contains('hidden')) {
                    node.classList.remove('hidden');
                    node.previousElementSibling?.classList.remove('outline-collapsed');
                }
                node = node.parentElement;
            }
        }
    }
    if (best) scrollOutlineRowIntoView(best);
}

export function setCurrentFileName(name: string | null) {
    currentFileName = name;
    syncOutlineBreadcrumb();
}

export function setBreadcrumbPath(path: string | null) {
    const el = DOM.breadcrumb;
    if (!el) return;
    if (!path) {
        el.classList.add('hidden');
        if (el.textContent) {
            el.textContent = '';
            el.title = '';
        }
        return;
    }
    if (el.textContent !== path) {
        el.textContent = path;
        el.title = path;
    }
    el.classList.remove('hidden');
}

function syncOutlineBreadcrumb() {
    if (!currentFileName) {
        setBreadcrumbPath(null);
        return;
    }
    let path = currentFileName;
    if (scrollContainer && PdfState.currentPdfDoc) {
        const rows = Array.from(DOM.sidebarSections.querySelectorAll<HTMLElement>('.outline-item'));
        const best = bestOutlineRow(rows);
        if (best) {
            const parts: string[] = [];
            let cur: HTMLElement | null = best;
            while (cur) {
                parts.unshift(cur.querySelector('.outline-label')?.textContent || '(untitled)');
                cur = outlineParentRow.get(cur) ?? null;
            }
            path = `${currentFileName} ▸ ${parts.join(' ▸ ')}`;
        }
    }
    setBreadcrumbPath(path);
}

async function linkOutlinePages() {
    if (!DOM.sidebarSections) return;
    const rows = Array.from(DOM.sidebarSections.querySelectorAll<HTMLElement>('.outline-item'));
    for (const row of rows) {
        const dest = outlineDests.get(row);
        if (!dest) continue;
        const target = await resolveOutlineDest(dest);
        if (target) {
            row.dataset.page = String(target.page);
            outlinePositions.set(row, { page: target.page, y: target.y ?? 0 });
        }
    }
}

export async function renderOutline() {
    if (!PdfState.currentPdfDoc || !DOM.sidebarSections) return;
    DOM.sidebarSections.innerHTML = '';
    activeOutlineRow = null;
    outlineDests.clear();
    outlinePositions.clear();
    outlineParentRow.clear();
    let outline: any[] | null = null;
    try {
        outline = await PdfState.currentPdfDoc.getOutline();
    } catch {
        outline = null;
    }
    if (!outline || outline.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'text-gray-500 text-xs italic p-2';
        empty.textContent = 'No sections in this document';
        DOM.sidebarSections.appendChild(empty);
        syncOutlineBreadcrumb();
        return;
    }
    const fragment = document.createDocumentFragment();
    for (const item of outline) fragment.appendChild(buildOutlineItem(item, 0, null));
    DOM.sidebarSections.appendChild(fragment);
    await linkOutlinePages();
    syncActiveOutline();
    syncOutlineBreadcrumb();
}

function buildOutlineItem(item: any, depth: number, parentRow: HTMLElement | null): HTMLElement {
    const node = document.createElement('div');
    node.className = 'outline-node';

    const row = document.createElement('div');
    row.className = 'outline-item';
    row.style.paddingLeft = `${depth * 12 + 4}px`;
    outlineParentRow.set(row, parentRow);

    const hasKids = Array.isArray(item.items) && item.items.length > 0;

    const caret = document.createElement('span');
    caret.className = hasKids ? 'outline-caret' : 'outline-caret outline-caret-placeholder';
    if (hasKids) caret.textContent = '▸';
    row.appendChild(caret);

    const label = document.createElement('span');
    label.className = 'outline-label';
    label.textContent = item.title || '(untitled)';
    if (item.bold) label.style.fontWeight = '700';
    if (item.italic) label.style.fontStyle = 'italic';
    row.appendChild(label);

    node.appendChild(row);

    if (hasKids) {
        const wrapper = document.createElement('div');
        wrapper.className = 'outline-children';
        for (const child of item.items) wrapper.appendChild(buildOutlineItem(child, depth + 1, row));
        node.appendChild(wrapper);
        caret.addEventListener('click', (e) => {
            e.stopPropagation();
            wrapper.classList.toggle('hidden');
            row.classList.toggle('outline-collapsed');
        });
    }

    if (item.dest) {
        outlineDests.set(row, item.dest);
        row.addEventListener('click', () => {
            void resolveOutlineDest(item.dest).then((t) => {
                if (t) jumpToPage(t.page, t.y);
            });
        });
    }

    return node;
}

function evictOutside(first: number, last: number) {
    for (const [pageNum, canvas] of renderedCanvases) {
        if (pageNum < first - EVICT_BEHIND_PAGES || pageNum > last + EVICT_AHEAD_PAGES) {
            canvas.remove();
            pageContainers[pageNum - 1]?.querySelector('.pdf-link-layer')?.remove();
            renderedCanvases.delete(pageNum);
        }
    }
    for (const [pageNum, entry] of pendingRenders) {
        if (pageNum < first - EVICT_BEHIND_PAGES - 2 || pageNum > last + EVICT_AHEAD_PAGES + 2) {
            try {
                entry.task?.cancel();
            } catch {}
            entry.canvas?.remove();
            pendingRenders.delete(pageNum);
        }
    }
}

function thumbHeightFor(pageNum: number, width = getSidebarTargetWidth()): number {
    const size = pageSizes.get(pageNum);
    const aspect = thumbAspects.get(pageNum) ?? (size ? size.height / size.width : 792 / 612);
    return Math.round(Math.max(120, width - THUMB_INSET * 2) * aspect);
}

let thumbLayoutWidth = 280;

function rebuildThumbLayout() {
    if (!PdfState.currentPdfDoc || !DOM.sidebarPreviews) return;
    const total = PdfState.currentPdfDoc.numPages;
    thumbLayoutWidth = getSidebarTargetWidth();
    const tops = new Array<number>(total);
    let y = THUMB_INSET;
    for (let i = 0; i < total; i++) {
        tops[i] = y;
        y += thumbHeightFor(i + 1, thumbLayoutWidth) + THUMB_GAP;
    }
    thumbTops = tops;
    DOM.sidebarPreviews.style.height = `${y + THUMB_INSET - THUMB_GAP}px`;
    for (const canvas of thumbElements) {
        const pageNum = parseInt(canvas.dataset.pageNum || '0', 10);
        canvas.style.top = `${tops[pageNum - 1] ?? 0}px`;
    }
}

function captureSidebarAnchor(): { page: number; frac: number } | null {
    const sidebar = document.getElementById('sidebar');
    if (!sidebar || thumbTops.length === 0) return null;
    const paneTop = paneOffsetInSidebar();
    const center = sidebar.scrollTop + sidebar.clientHeight / 2 - paneTop;
    const idx = thumbIndexAt(Math.max(0, center));
    const top = thumbTops[idx];
    const height = thumbHeightFor(idx + 1, thumbLayoutWidth) + THUMB_GAP;
    const frac = height > 0 ? Math.max(0, Math.min(1, (center - top) / height)) : 0;
    return { page: idx + 1, frac };
}

function restoreSidebarAnchor(anchor: { page: number; frac: number } | null): number {
    const sidebar = document.getElementById('sidebar');
    if (!anchor || !sidebar) return 0;
    const paneTop = paneOffsetInSidebar();
    const target =
        thumbTops[anchor.page - 1] +
        anchor.frac * (thumbHeightFor(anchor.page) + THUMB_GAP) -
        sidebar.clientHeight / 2 +
        paneTop;
    const max = Math.max(0, sidebar.scrollHeight - sidebar.clientHeight);
    return Math.max(0, Math.min(max, target));
}

function ensureThumbMounted(pageNum: number): HTMLCanvasElement | null {
    if (!DOM.sidebarPreviews || !PdfState.currentPdfDoc) return null;
    const existing = DOM.sidebarPreviews.querySelector<HTMLCanvasElement>(`[data-page-num="${pageNum}"]`);
    if (existing) return existing;
    const total = PdfState.currentPdfDoc.numPages;
    if (pageNum < 1 || pageNum > total) return null;
    if (thumbTops.length !== total) rebuildThumbLayout();
    const canvas = document.createElement('canvas');
    canvas.className =
        'cursor-pointer border-2 border-transparent hover:border-lavender-400 transition-colors shadow-sm rounded bg-white';
    canvas.dataset.pageNum = String(pageNum);
    canvas.style.position = 'absolute';
    canvas.style.left = `${THUMB_INSET}px`;
    canvas.style.width = `calc(100% - ${THUMB_INSET * 2}px)`;
    canvas.style.top = `${thumbTops[pageNum - 1]}px`;
    canvas.style.height = `${thumbHeightFor(pageNum)}px`;
    canvas.onclick = () => {
        jumpToPage(pageNum);
    };
    DOM.sidebarPreviews.appendChild(canvas);
    thumbElements.push(canvas);
    return canvas;
}

export async function renderThumbnails() {
    if (!PdfState.currentPdfDoc || !DOM.sidebarPreviews) return;

    thumbCanvases.clear();
    cancelThumbRenders();
    thumbElements = [];

    const sidebar = document.getElementById('sidebar');
    const savedAnchor = previewsPaneVisible() ? captureSidebarAnchor() : null;
    DOM.sidebarPreviews.innerHTML = '';
    DOM.sidebarPreviews.style.position = 'relative';

    if (sidebar) {
        sidebar.onscroll = null;
    }
    if (thumbSettleTimer) {
        clearTimeout(thumbSettleTimer);
        thumbSettleTimer = null;
    }

    const total = PdfState.currentPdfDoc.numPages;
    rebuildThumbLayout();

    if (sidebar) {
        if (savedAnchor) sidebar.scrollTop = restoreSidebarAnchor(savedAnchor);
        sidebar.removeEventListener('scroll', onThumbScroll);
        sidebar.addEventListener('scroll', onThumbScroll, { passive: true });
        scheduleThumbWindowRender();
    } else {
        for (let i = 1; i <= total; i++) {
            ensureThumbMounted(i);
            queueThumbRender(i);
        }
    }

    activeThumbPage = 0;
    thumbFollowSmooth = true;
    syncActiveThumb();
    thumbFollowSmooth = false;
}

function thumbIndexAt(y: number): number {
    const tops = thumbTops;
    if (tops.length === 0) return 0;
    let lo = 0;
    let hi = tops.length - 1;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (tops[mid] < y) lo = mid + 1;
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
    if (!sidebar || !DOM.sidebarPreviews || !PdfState.currentPdfDoc) return;
    if (!previewsPaneVisible()) return;
    rebuildThumbLayout();
    const total = PdfState.currentPdfDoc.numPages;
    if (total === 0) return;
    const paneScroll = Math.max(0, sidebar.scrollTop - paneOffsetInSidebar());
    const first = Math.max(0, thumbIndexAt(paneScroll) - 2);
    const last = Math.min(total - 1, thumbIndexAt(paneScroll + sidebar.clientHeight) + 5);

    for (let i = first; i <= last; i++) ensureThumbMounted(i + 1);
    evictThumbs(first, last);
    thumbQueue = thumbQueue.filter(
        (p) => p - 1 >= first - THUMB_EVICT_RADIUS - 5 && p - 1 <= last + THUMB_EVICT_RADIUS + 5,
    );

    for (let pageNum = first + 1; pageNum <= last + 1; pageNum++) {
        queueThumbRender(pageNum);
    }
    syncActiveThumb();
}

function queueThumbRender(pageNum: number) {
    if (thumbCanvases.has(pageNum) || thumbPending.has(pageNum)) return;
    thumbPending.set(pageNum, { task: null });
    thumbQueue.push(pageNum);
    pumpThumbQueue();
}

function pumpThumbQueue() {
    while (activeRenders < RENDER_CONCURRENCY && thumbQueue.length > 0) {
        const pageNum = thumbQueue.shift()!;
        if (!thumbPending.has(pageNum)) continue;
        if (thumbCanvases.has(pageNum)) {
            thumbPending.delete(pageNum);
            continue;
        }
        activeRenders++;
        void renderThumb(pageNum).finally(() => {
            activeRenders = Math.max(0, activeRenders - 1);
            thumbPending.delete(pageNum);
            pumpRenderQueue();
            pumpThumbQueue();
        });
    }
}

async function renderThumb(pageNum: number) {
    const thumb = DOM.sidebarPreviews?.querySelector<HTMLCanvasElement>(`[data-page-num="${pageNum}"]`);
    if (!thumb || !thumb.isConnected || !PdfState.currentPdfDoc) return;
    try {
        const page = await PdfState.currentPdfDoc.getPage(pageNum);
        if (!thumb.isConnected || !PdfState.currentPdfDoc) return;
        const baseViewport = page.getViewport({ scale: 1 });
        const targetWidth = Math.max(120, getSidebarTargetWidth() - THUMB_INSET * 2);
        const scale = (targetWidth / baseViewport.width) * getOutputScale();
        const viewport = page.getViewport({ scale });
        thumb.width = Math.max(1, Math.floor(viewport.width));
        thumb.height = Math.max(1, Math.floor(viewport.height));
        const cssHeight = Math.max(1, Math.floor(viewport.height / getOutputScale()));
        thumbAspects.set(pageNum, baseViewport.height / baseViewport.width);
        if (thumb.style.height !== `${cssHeight}px`) {
            thumb.style.height = `${cssHeight}px`;
            scheduleThumbWindowRender();
        }
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
    for (let i = thumbElements.length - 1; i >= 0; i--) {
        const canvas = thumbElements[i];
        const pageNum = parseInt(canvas.dataset.pageNum || '0', 10);
        if (pageNum - 1 >= first - THUMB_EVICT_RADIUS && pageNum - 1 <= last + THUMB_EVICT_RADIUS) continue;
        canvas.remove();
        thumbElements.splice(i, 1);
        thumbCanvases.delete(pageNum);
    }
    for (const [pageNum, entry] of thumbPending) {
        if (pageNum - 1 < first - THUMB_EVICT_RADIUS - 5 || pageNum - 1 > last + THUMB_EVICT_RADIUS + 5) {
            try {
                entry.task?.cancel();
            } catch {}
            thumbPending.delete(pageNum);
        }
    }
}
