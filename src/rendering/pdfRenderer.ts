import { DOM, getSidebarTargetWidth, updateScrollModeClasses, setSidebarFollowLabel } from '../ui.js';
import { renderPageTextLayer, clearPageSpans, resetSearchState } from './pdfSearch.js';

export const PdfState = {
    currentPdfDoc: null as any,
    currentScale: 1.0,
    isSnapMode: true,
    zoomMode: 'auto' as 'auto' | 'manual',
    sidebarFollow: true,
};

const MAX_OUTPUT_SCALE = 2;
const RENDER_CONCURRENCY = 3;
const MEASURE_CHUNK = 15;
const THUMB_EVICT_RADIUS = 40;
const THUMB_GAP = 16;
const THUMB_INSET = 16;

const MOUNT_BEHIND_PAGES = 3;
const MOUNT_AHEAD_PAGES = 6;

const LARGE_DOC_PAGES = 700;
const LARGE_DOC_MOUNT_BEHIND = 2;
const LARGE_DOC_MOUNT_AHEAD = 4;
const LARGE_DOC_THUMB_EVICT_RADIUS = 12;
const DEFAULT_PAGE_POINTS = { width: 612, height: 792 };
const DEFAULT_PAGE_PADDING = 32;
const DEFAULT_PAGE_GAP = 32;
const PAGE_CONTAINER_CLASS = 'pdf-page-container mb-8 shadow-lg bg-white shrink-0 relative';

let scrollContainer: HTMLElement | null = null;
let pageContainers: HTMLElement[] = [];
let pageCount = 0;
let mountedPages: number[] = [];
let topSpacer: HTMLElement | null = null;
let bottomSpacer: HTMLElement | null = null;
let spacerTopHeight = -1;
let spacerBottomHeight = -1;
let pageSizePoints = new Map<number, { width: number; height: number }>();
let placeholderPoints = { ...DEFAULT_PAGE_POINTS };
let renderedCanvases = new Map<number, HTMLCanvasElement>();
let pendingRenders = new Map<number, { task: any; canvas: HTMLCanvasElement }>();
let pageHandles = new Map<number, any>();
let renderQueue: number[] = [];
let activeMainRenders = 0;
let activeThumbRenders = 0;
let pageTops: number[] = [];
let pageGeometryDirty = true;
let geoLayout: { baseTop: number; gap: number } | null = null;
let scrollRafPending = false;
let scrollSettleTimer: ReturnType<typeof setTimeout> | null = null;
let thumbScrollRafPending = false;
let thumbSettleTimer: ReturnType<typeof setTimeout> | null = null;
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

function sizeForPoints(points: { width: number; height: number }): { width: number; height: number } {
    const scale = PdfState.currentScale || 1;
    return { width: points.width * scale, height: points.height * scale };
}

function pagePointSize(pageNum: number): { width: number; height: number } {
    return pageSizePoints.get(pageNum) ?? placeholderPoints;
}

function pageWidth(pageNum: number): number {
    return pagePointSize(pageNum).width * (PdfState.currentScale || 1);
}

function pageHeight(pageNum: number): number {
    return pagePointSize(pageNum).height * (PdfState.currentScale || 1);
}

function recordPagePoints(pageNum: number, points: { width: number; height: number }) {
    const existing = pageSizePoints.get(pageNum);
    if (existing && Math.abs(existing.width - points.width) < 0.5 && Math.abs(existing.height - points.height) < 0.5) {
        return;
    }
    pageSizePoints.set(pageNum, points);
    applyPageSize(pageNum);
}

function applyPageSize(pageNum: number) {
    const container = pageContainers[pageNum - 1];
    if (container) {
        container.style.width = `${pageWidth(pageNum)}px`;
        container.style.height = `${pageHeight(pageNum)}px`;
    }
    pageGeometryDirty = true;
    thumbLayoutDirty = true;
    scheduleMainWindowRender();
}

function ensurePageGeometry() {
    if (!pageGeometryDirty) return;
    pageGeometryDirty = false;
    const total = pageCount;
    if (total === 0) {
        pageTops = [];
        return;
    }
    const layout = geoLayout ?? { baseTop: DEFAULT_PAGE_PADDING, gap: DEFAULT_PAGE_GAP };
    const scale = PdfState.currentScale || 1;
    const tops = new Array<number>(total);
    let y = layout.baseTop;
    for (let i = 0; i < total; i++) {
        tops[i] = y;
        y += pagePointSize(i + 1).height * scale + layout.gap;
    }
    pageTops = tops;
}

function pageTop(pageNum: number): number {
    ensurePageGeometry();
    const top = pageTops[pageNum - 1];
    if (top !== undefined) return top;
    return geoLayout?.baseTop ?? DEFAULT_PAGE_PADDING;
}

function mountMargins(): { behind: number; ahead: number } {
    if (pageCount > LARGE_DOC_PAGES) return { behind: LARGE_DOC_MOUNT_BEHIND, ahead: LARGE_DOC_MOUNT_AHEAD };
    return { behind: MOUNT_BEHIND_PAGES, ahead: MOUNT_AHEAD_PAGES };
}

function updateSpacers() {
    if (!topSpacer || !bottomSpacer || mountedPages.length === 0 || pageCount === 0) return;
    const first = mountedPages[0];
    const last = mountedPages[mountedPages.length - 1];
    const base = geoLayout?.baseTop ?? DEFAULT_PAGE_PADDING;
    const top = Math.max(0, pageTop(first) - base);
    const bottom = Math.max(0, pageTop(pageCount) + pageHeight(pageCount) - pageTop(last) - pageHeight(last));
    if (spacerTopHeight !== top) {
        spacerTopHeight = top;
        topSpacer.style.height = `${top}px`;
    }
    if (spacerBottomHeight !== bottom) {
        spacerBottomHeight = bottom;
        bottomSpacer.style.height = `${bottom}px`;
    }
}

function createPageContainer(pageNum: number): HTMLElement {
    const size = sizeForPoints(pagePointSize(pageNum));
    const container = document.createElement('div');
    container.id = `page-container-${pageNum}`;
    container.className = PAGE_CONTAINER_CLASS;
    container.dataset.pageNum = String(pageNum);
    container.style.width = `${size.width}px`;
    container.style.height = `${size.height}px`;
    if (PdfState.isSnapMode && !snapSuspended) container.classList.add('snap-center');
    return container;
}

function mountPage(pageNum: number): void {
    if (!scrollContainer || !bottomSpacer || pageContainers[pageNum - 1]) return;
    const container = createPageContainer(pageNum);
    let inserted = false;
    for (const mounted of mountedPages) {
        if (mounted > pageNum) {
            pageContainers[mounted - 1].before(container);
            inserted = true;
            break;
        }
    }
    if (!inserted) bottomSpacer.before(container);
    pageContainers[pageNum - 1] = container;
    mountedPages.push(pageNum);
    mountedPages.sort((a, b) => a - b);
}

function unmountPage(pageNum: number) {
    pageContainers[pageNum - 1]?.remove();
    pageContainers[pageNum - 1] = undefined as any;
    const idx = mountedPages.indexOf(pageNum);
    if (idx >= 0) mountedPages.splice(idx, 1);
    const entry = pendingRenders.get(pageNum);
    if (entry) {
        try {
            entry.task?.cancel();
        } catch {}
        entry.canvas?.remove();
        pendingRenders.delete(pageNum);
    }
    if (renderQueue.length > 0) renderQueue = renderQueue.filter((p) => p !== pageNum);
    renderedCanvases.delete(pageNum);
    clearPageSpans(pageNum);
    releasePage(pageNum);
}

function unmountAllPages() {
    for (const pageNum of [...mountedPages]) unmountPage(pageNum);
}

function syncMountedPages(first: number, last: number) {
    if (!scrollContainer || pageCount === 0) return;
    first = Math.max(1, Math.min(pageCount, first));
    last = Math.max(first, Math.min(pageCount, last));
    const needed = last - first + 1;
    if (mountedPages.length === needed && mountedPages[0] === first && mountedPages[mountedPages.length - 1] === last) {
        updateSpacers();
        return;
    }
    const overlaps = mountedPages.some((p) => p >= first && p <= last);
    if (!overlaps) unmountAllPages();
    for (const pageNum of [...mountedPages]) {
        if (pageNum < first || pageNum > last) unmountPage(pageNum);
    }
    for (let pageNum = first; pageNum <= last; pageNum++) {
        if (!pageContainers[pageNum - 1]) mountPage(pageNum);
    }
    updateSpacers();
}

function mountAroundPage(pageNum: number) {
    const margins = mountMargins();
    syncMountedPages(pageNum - margins.behind, pageNum + margins.ahead);
}

function applySnapClassesToMounted() {
    const on = PdfState.isSnapMode && !snapSuspended;
    for (const pageNum of mountedPages) {
        pageContainers[pageNum - 1]?.classList.toggle('snap-center', on);
    }
}

function samplePageLayout() {
    if (!scrollContainer || mountedPages.length === 0) return;
    const scroller = scrollContainer;
    const scrollerTop = scroller.getBoundingClientRect().top;
    const contentOffset = (el: HTMLElement) => el.getBoundingClientRect().top - scrollerTop + scroller.scrollTop;
    const first = mountedPages[0];
    const firstEl = pageContainers[first - 1];
    if (!firstEl) return;
    const spacerAbove = Math.max(0, pageTop(first) - (geoLayout?.baseTop ?? DEFAULT_PAGE_PADDING));
    const baseTop = contentOffset(firstEl) - spacerAbove;
    let gap = geoLayout?.gap ?? DEFAULT_PAGE_GAP;
    const nextEl = pageContainers[first];
    if (nextEl && mountedPages.includes(first + 1)) {
        const measured = contentOffset(nextEl) - contentOffset(firstEl) - pageHeight(first);
        if (measured >= 0 && measured < 200) gap = measured;
    }
    if (geoLayout && Math.abs(geoLayout.baseTop - baseTop) < 0.5 && Math.abs(geoLayout.gap - gap) < 0.5) return;
    geoLayout = { baseTop, gap };
    pageGeometryDirty = true;
    ensurePageGeometry();
    updateSpacers();
}

function thumbEvictRadius(): number {
    const total = PdfState.currentPdfDoc?.numPages ?? 0;
    return total > LARGE_DOC_PAGES ? LARGE_DOC_THUMB_EVICT_RADIUS : THUMB_EVICT_RADIUS;
}

export function isViewerBusy(): boolean {
    return (
        scrollRafPending ||
        thumbScrollRafPending ||
        scrollSettleTimer !== null ||
        thumbSettleTimer !== null ||
        activeMainRenders > 0 ||
        activeThumbRenders > 0 ||
        pendingRenders.size > 0 ||
        renderQueue.length > 0 ||
        thumbQueue.length > 0
    );
}

function releasePage(pageNum: number) {
    if (pendingRenders.has(pageNum) || renderedCanvases.has(pageNum) || thumbPending.has(pageNum)) return;
    const page = pageHandles.get(pageNum);
    if (!page) return;
    pageHandles.delete(pageNum);
    try {
        page.cleanup();
    } catch {}
}

function captureScrollPos(): { page: number; fraction: number } | null {
    if (!scrollContainer || pageCount === 0) return savedScrollPos;
    const scrollTop = scrollContainer.scrollTop;
    const page = currentPageAtViewport();
    const height = pageHeight(page) || 1;
    return { page, fraction: Math.max(0, Math.min(1, (scrollTop - pageTop(page)) / height)) };
}

export function goToPage(pageNum: number) {
    if (!scrollContainer || pageCount === 0 || !PdfState.currentPdfDoc) return;
    followOverrideUntil = Date.now() + 600;
    const page = Math.min(pageCount, Math.max(1, Math.round(pageNum)));
    mountAroundPage(page);
    const apply = () => {
        if (!scrollContainer) return;
        scrollContainer.style.scrollBehavior = 'auto';
        scrollContainer.scrollTop = pageTop(page);
        scrollContainer.style.removeProperty('scroll-behavior');
    };
    apply();
    scheduleMainWindowRender();
    if (pageSizePoints.has(page)) return;
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
let thumbDoc: any = null;
let followSuppressed = false;
let followOverrideUntil = 0;

export function setSidebarFollowSuppressed(suppressed: boolean) {
    followSuppressed = suppressed;
}

export function toggleSidebarFollow(): boolean {
    PdfState.sidebarFollow = !PdfState.sidebarFollow;
    setSidebarFollowLabel(PdfState.sidebarFollow);
    if (PdfState.sidebarFollow) {
        followOverrideUntil = Date.now() + 800;
        refreshSidebarSync(true);
    }
    return PdfState.sidebarFollow;
}

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
        if (changed && !followSuppressed && (PdfState.sidebarFollow || Date.now() < followOverrideUntil)) {
            scrollThumbIntoView(thumb);
        }
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
let thumbFollowTimer: ReturnType<typeof setTimeout> | null = null;

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
    if (!pos || !scrollContainer || pageCount === 0) return;
    const page = Math.min(pageCount, Math.max(1, pos.page));
    mountAroundPage(page);
    const height = pageHeight(page);
    let target: number;
    if (PdfState.isSnapMode && !snapSuspended) {
        target = pageTop(page) + (height - scrollContainer.clientHeight) / 2;
        target = Math.max(0, target);
    } else {
        target = pageTop(page) + pos.fraction * height;
    }
    scrollContainer.style.scrollBehavior = 'auto';
    scrollContainer.scrollTop = target;
    scrollContainer.style.removeProperty('scroll-behavior');
}

function getFitToScreenScale(page: any, container: HTMLElement): number {
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
    activeMainRenders = 0;
}

function cancelThumbRenders() {
    for (const { task } of thumbPending.values()) {
        try {
            task?.cancel();
        } catch {}
    }
    thumbPending.clear();
    thumbQueue = [];
    activeThumbRenders = 0;
}

function isObsoleteRender(err: any, doc: any): boolean {
    return err?.name === 'RenderingCancelledException' || PdfState.currentPdfDoc !== doc;
}

export function resetPdfState(keepPosition = false) {
    const outgoing = PdfState.currentPdfDoc;
    const kept = keepPosition ? captureScrollPos() : null;
    resetSearchState();
    followSuppressed = false;
    thumbDoc = null;
    cancelThumbRenders();
    thumbCanvases.clear();
    thumbElements = [];
    thumbTops = [];
    thumbAspects.clear();
    thumbLayoutDirty = true;
    outlineRows = [];
    activeOutlineRow = null;
    pageSizePoints.clear();
    pageHandles.clear();
    pageTops = [];
    pageGeometryDirty = true;
    geoLayout = null;
    placeholderPoints = { ...DEFAULT_PAGE_POINTS };
    savedScrollPos = kept;
    lastKnownPage = kept?.page ?? 1;
    currentFileName = null;
    syncOutlineBreadcrumb();
    PdfState.currentPdfDoc = null;
    PdfState.zoomMode = 'auto';
    resetViewer();
    const sidebar = document.getElementById('sidebar');
    if (sidebar) sidebar.removeEventListener('scroll', onThumbScroll);
    if (outgoing) void outgoing.destroy().catch(() => {});
}

function resetViewer() {
    viewerVersion++;
    cancelPendingRenders();
    renderedCanvases.clear();
    pageHandles.clear();
    pageContainers = [];
    pageCount = 0;
    mountedPages = [];
    topSpacer = null;
    bottomSpacer = null;
    spacerTopHeight = -1;
    spacerBottomHeight = -1;
    pageTops = [];
    pageGeometryDirty = true;
    geoLayout = null;
    invalidateOutlineLayout();
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
    if (pageCount === 0) return 1;
    ensurePageGeometry();
    let lo = 0;
    let hi = pageTops.length - 1;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (pageTops[mid] < y) lo = mid + 1;
        else hi = mid;
    }
    return lo + 1;
}

function currentPageAtViewport(): number {
    if (pageCount === 0 || !scrollContainer) return lastKnownPage;
    const top = scrollContainer.scrollTop;
    const bottom = top + (scrollContainer.clientHeight || 1);
    const mid = (top + bottom) / 2;
    let best = pageAtOffset(mid);
    let bestVisible = -1;
    const start = Math.max(1, best - 1);
    const end = Math.min(pageCount, best + 1);
    for (let p = start; p <= end; p++) {
        const elTop = pageTop(p);
        const elBottom = elTop + pageHeight(p);
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
    pageHandles.clear();
    pageContainers = [];
    mountedPages = [];
    pageCount = 0;
    pageTops = [];
    pageGeometryDirty = true;
    geoLayout = null;
    if (scrollSettleTimer) {
        clearTimeout(scrollSettleTimer);
        scrollSettleTimer = null;
    }

    const scroller = document.createElement('div');
    scroller.id = 'pdf-scroll-container';
    scroller.className =
        'w-full h-full overflow-y-auto flex flex-col items-center py-8 [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] scrollbar-none';

    const total = PdfState.currentPdfDoc.numPages;

    placeholderPoints = { ...DEFAULT_PAGE_POINTS };
    try {
        const firstPage = await PdfState.currentPdfDoc.getPage(1);
        if (version !== viewerVersion) return;
        if (PdfState.zoomMode === 'auto') {
            PdfState.currentScale = getFitToScreenScale(firstPage, DOM.mainContentNode);
        }
        const baseViewport = firstPage.getViewport({ scale: 1 });
        placeholderPoints = { width: baseViewport.width, height: baseViewport.height };
        pageSizePoints.set(1, placeholderPoints);
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

    topSpacer = document.createElement('div');
    topSpacer.className = 'w-full shrink-0';
    bottomSpacer = document.createElement('div');
    bottomSpacer.className = 'w-full shrink-0';
    spacerTopHeight = -1;
    spacerBottomHeight = -1;
    scroller.append(topSpacer, bottomSpacer);

    const old = scrollContainer;
    scrollContainer = scroller;
    pageContainers = new Array<HTMLElement>(total);
    pageCount = total;
    if (old) {
        old.removeEventListener('scroll', onMainScroll);
        old.remove();
    }
    DOM.mainContentNode.innerHTML = '';
    DOM.mainContentNode.appendChild(scroller);

    scroller.addEventListener('scroll', onMainScroll, { passive: true });

    ensurePageGeometry();
    mountAroundPage(restore?.page ?? lastKnownPage ?? 1);
    samplePageLayout();
    updateSpacers();
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
    if (!scrollContainer || !PdfState.currentPdfDoc || pageCount === 0) return;
    savedScrollPos = captureScrollPos();
    syncPageCounter();
    syncActiveThumb();
    syncOutline(currentViewPosition());
    const margins = mountMargins();
    const scrollTop = scrollContainer.scrollTop;
    const clientHeight = scrollContainer.clientHeight || 1;
    const viewFirst = pageAtOffset(scrollTop);
    const viewLast = pageAtOffset(scrollTop + clientHeight);
    const first = Math.max(1, viewFirst - margins.behind);
    const last = Math.min(pageCount, viewLast + margins.ahead);

    syncMountedPages(first, last);
    renderQueue = renderQueue.filter((p) => p >= first && p <= last);

    for (let pageNum = viewFirst; pageNum <= viewLast; pageNum++) {
        queuePageRender(pageNum);
    }
    for (let delta = 1; delta <= Math.max(margins.behind, margins.ahead); delta++) {
        const before = viewFirst - delta;
        const after = viewLast + delta;
        if (before >= first) queuePageRender(before);
        if (after <= last) queuePageRender(after);
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
            const doc = PdfState.currentPdfDoc;
            const total = doc.numPages;
            for (let start = 1; start <= total; start += MEASURE_CHUNK) {
                if (version !== viewerVersion) return;
                const end = Math.min(start + MEASURE_CHUNK, total + 1);
                const targets: number[] = [];
                for (let p = start; p < end; p++) {
                    if (!pageSizePoints.has(p)) targets.push(p);
                }
                if (targets.length === 0) continue;
                const pages = await Promise.all(targets.map((p) => doc.getPage(p).catch(() => null)));
                if (version !== viewerVersion) return;
                for (let i = 0; i < pages.length; i++) {
                    const page = pages[i];
                    if (!page) continue;
                    const pageNum = targets[i];
                    if (pageSizePoints.has(pageNum)) continue;
                    const viewport = page.getViewport({ scale: 1 });
                    recordPagePoints(pageNum, { width: viewport.width, height: viewport.height });
                }
                if (version !== viewerVersion) return;
                scheduleThumbWindowRender();
            }
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

async function measurePageNow(pageNum: number) {
    if (!PdfState.currentPdfDoc || pageSizePoints.has(pageNum)) return;
    try {
        const page = await PdfState.currentPdfDoc.getPage(pageNum);
        if (!page) return;
        if (pageSizePoints.has(pageNum)) return;
        const viewport = page.getViewport({ scale: 1 });
        recordPagePoints(pageNum, { width: viewport.width, height: viewport.height });
        scheduleThumbWindowRender();
    } catch {}
}

export function refreshSidebarSync(scrollToActive = false) {
    if (!PdfState.currentPdfDoc) return;
    invalidateSidebarViewport();
    invalidateOutlineLayout();
    syncActiveThumb();
    syncOutline(currentViewPosition());
    if (!previewsPaneVisible()) return;
    scheduleThumbWindowRender();
    if (scrollToActive && !followSuppressed && (PdfState.sidebarFollow || Date.now() < followOverrideUntil)) {
        const active = DOM.sidebarPreviews.querySelector<HTMLElement>('.thumb-active');
        if (active) scrollThumbIntoView(active);
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
    while (renderQueue.length > 0) {
        if (activeMainRenders + activeThumbRenders >= RENDER_CONCURRENCY) return;
        const pageNum = renderQueue.shift()!;
        if (!pendingRenders.has(pageNum)) continue;
        if (renderedCanvases.has(pageNum)) {
            pendingRenders.delete(pageNum);
            continue;
        }
        activeMainRenders++;
        void renderPage(pageNum).finally(() => {
            activeMainRenders = Math.max(0, activeMainRenders - 1);
            pendingRenders.delete(pageNum);
            pumpRenderQueue();
            pumpThumbQueue();
        });
    }
}

async function renderPage(pageNum: number) {
    const container = pageContainers[pageNum - 1];
    const doc = PdfState.currentPdfDoc;
    if (!container || !container.isConnected || !doc) return;
    try {
        const page = await doc.getPage(pageNum);
        if (!container.isConnected || PdfState.currentPdfDoc !== doc) return;
        pageHandles.set(pageNum, page);
        const viewport = page.getViewport({ scale: PdfState.currentScale });
        const scale = PdfState.currentScale || 1;
        recordPagePoints(pageNum, { width: viewport.width / scale, height: viewport.height / scale });

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
        if (!container.isConnected || PdfState.currentPdfDoc !== doc) return;
        renderedCanvases.set(pageNum, canvas);
        await renderPageTextLayer(page, container, viewport, pageNum);
        if (PdfState.currentPdfDoc !== doc) return;
        await addPageLinkLayer(page, container, viewport);
    } catch (err: any) {
        if (!isObsoleteRender(err, doc)) {
            console.error(`Error rendering page ${pageNum}:`, err);
        }
    }
}

const LINK_PAD_X = 1;
const LINK_PAD_Y = 0.5;

interface LineBox {
    left: number;
    right: number;
    top: number;
    bottom: number;
}

function linkHotspotRects(rect: number[], quadPoints: any): number[][] {
    const rects: number[][] = [];
    if (quadPoints && quadPoints.length >= 8) {
        for (let i = 2; i + 3 < quadPoints.length; i += 8) {
            const trX = quadPoints[i];
            const trY = quadPoints[i + 1];
            const blX = quadPoints[i + 2];
            const blY = quadPoints[i + 3];
            rects.push([Math.min(blX, trX), Math.min(blY, trY), Math.max(blX, trX), Math.max(blY, trY)]);
        }
    }
    if (rects.length === 0) rects.push(rect);
    return rects;
}

function textLineBoxes(container: HTMLElement): LineBox[] {
    const layer = container.querySelector('.text-layer');
    if (!layer) return [];
    const origin = container.getBoundingClientRect();
    const lines: LineBox[] = [];
    for (const span of layer.querySelectorAll<HTMLElement>('span')) {
        if (span.classList.contains('markedContent') || !span.textContent) continue;
        const rect = span.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;
        const box = {
            left: rect.left - origin.left,
            right: rect.right - origin.left,
            top: rect.top - origin.top,
            bottom: rect.bottom - origin.top,
        };
        const line = lines.find((l) => box.top < l.bottom - 1 && box.bottom > l.top + 1);
        if (line) {
            line.left = Math.min(line.left, box.left);
            line.right = Math.max(line.right, box.right);
            line.top = Math.min(line.top, box.top);
            line.bottom = Math.max(line.bottom, box.bottom);
        } else {
            lines.push({ ...box });
        }
    }
    return lines;
}

function clipHotspotToText(box: number[], lines: LineBox[], out: number[][]) {
    if (lines.length === 0) {
        out.push(box);
        return;
    }
    const [x, y, width, height] = box;
    const right = x + width;
    const bottom = y + height;
    let covered = false;
    for (const line of lines) {
        const left = Math.max(x, line.left);
        const lineRight = Math.min(right, line.right);
        const top = Math.max(y, line.top);
        const lineBottom = Math.min(bottom, line.bottom);
        if (lineRight - left < 1 || lineBottom - top < 1) continue;
        covered = true;
        out.push([
            left - LINK_PAD_X,
            top - LINK_PAD_Y,
            lineRight - left + LINK_PAD_X * 2,
            lineBottom - top + LINK_PAD_Y * 2,
        ]);
    }
    if (!covered) out.push(box);
}

async function addPageLinkLayer(page: any, container: HTMLElement, viewport: any) {
    try {
        const annotations = await page.getAnnotations();
        const links = annotations.filter((a: any) => a.subtype === 'Link');
        if (links.length === 0) return;
        container.querySelectorAll('.pdf-link-layer').forEach((l) => l.remove());
        const layer = document.createElement('div');
        layer.className = 'pdf-link-layer';
        const lines = textLineBoxes(container);
        for (const ann of links) {
            if (!ann.rect || ann.rect.length !== 4) continue;
            const href = typeof ann.url === 'string' && ann.url.length > 0 ? ann.url : null;
            const dest = href ? null : ann.dest;
            if (!href && !dest) continue;
            const boxes: number[][] = [];
            for (const rect of linkHotspotRects(ann.rect, ann.quadPoints)) {
                const [x1, y1, x2, y2] = viewport.convertToViewportRectangle(rect);
                const width = Math.abs(x2 - x1);
                const height = Math.abs(y2 - y1);
                if (width < 0.5 || height < 0.5) continue;
                clipHotspotToText([Math.min(x1, x2), Math.min(y1, y2), width, height], lines, boxes);
            }
            for (const [x, y, width, height] of boxes) {
                const el = document.createElement('a');
                el.className = 'pdf-link';
                el.style.left = `${x}px`;
                el.style.top = `${y}px`;
                el.style.width = `${width}px`;
                el.style.height = `${height}px`;
                if (href) {
                    el.href = href;
                    el.target = '_blank';
                    el.rel = 'noopener';
                    el.title = href;
                    el.addEventListener('click', (e) => {
                        e.preventDefault();
                        void window.electronAPI.openExternal(href);
                    });
                } else {
                    el.href = '#';
                    el.addEventListener('click', (e) => {
                        e.preventDefault();
                        void resolveOutlineDest(dest).then((t) => {
                            if (t) jumpToPage(t.page, t.y);
                        });
                    });
                }
                layer.appendChild(el);
            }
        }
        if (layer.childElementCount > 0) container.appendChild(layer);
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
        applySnapClassesToMounted();
    };
    window.addEventListener('wheel', resume, { capture: true, passive: true });
    window.addEventListener('keydown', resume, { capture: true });
}

export function jumpToPage(pageNum: number, yCss: number | null = null, center = false) {
    followOverrideUntil = Date.now() + 600;
    if (pageCount === 0 || !PdfState.currentPdfDoc) return;
    pageNum = Math.max(1, Math.min(pageCount, Math.round(pageNum)));
    mountAroundPage(pageNum);
    scheduleMainWindowRender();
    const jump = () => {
        const target = document.getElementById(`page-container-${pageNum}`);
        if (!target || !scrollContainer) return;
        const y = yCss == null ? 0 : Math.max(0, Math.min(yCss, pageHeight(pageNum) - 1));
        const base = pageTop(pageNum);
        const top = center ? Math.max(0, base + y - scrollContainer.clientHeight / 2) : base + y;
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
    jump();
    if (pageSizePoints.has(pageNum)) return;
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
    if (pageSizePoints.has(page)) {
        pageHeightPts = pagePointSize(page).height;
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
let outlineRows: HTMLElement[] = [];
let lastBreadcrumbRow: HTMLElement | null = null;
let lastBreadcrumbName: string | null | undefined;
let outlineFollowSmooth = false;
let outlineFollowTimer: ReturnType<typeof setTimeout> | null = null;
let outlineLayoutValid = false;
let sidebarViewportValid = false;
let outlineRowBoxes = new Map<HTMLElement, { top: number; height: number }>();
let sidebarScrollTop = 0;
let sidebarViewportHeight = 0;
let outlinePaneTop = 0;
let sidebarObserversInstalled = false;

function currentViewPosition(): { page: number; y: number } {
    const page = currentPageAtViewport();
    if (!scrollContainer || pageCount === 0) return { page, y: 0 };
    const mid = scrollContainer.scrollTop + (scrollContainer.clientHeight || 1) / 2;
    return { page, y: Math.max(0, mid - pageTop(page)) };
}

function bestOutlineRow(rows: HTMLElement[], pos: { page: number; y: number }): HTMLElement | null {
    const posY = pos.y / PdfState.currentScale;
    let best: HTMLElement | null = null;
    let bestPage = 0;
    let bestY = -Infinity;
    for (const row of rows) {
        const p = outlinePositions.get(row);
        if (!p) continue;
        if (p.page > pos.page || (p.page === pos.page && p.y > posY)) continue;
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

function invalidateOutlineLayout() {
    outlineLayoutValid = false;
    outlineRowBoxes.clear();
}

function invalidateSidebarViewport() {
    sidebarViewportValid = false;
}

function installSidebarObservers() {
    if (sidebarObserversInstalled || typeof ResizeObserver === 'undefined') return;
    const sidebar = document.getElementById('sidebar');
    if (!sidebar) return;
    sidebarObserversInstalled = true;
    new ResizeObserver(() => invalidateSidebarViewport()).observe(sidebar);
    if (DOM.sidebarSections) new ResizeObserver(() => invalidateOutlineLayout()).observe(DOM.sidebarSections);
}

function ensureSidebarMetrics() {
    if (sidebarViewportValid) return;
    const sidebar = document.getElementById('sidebar');
    if (!sidebar) return;
    sidebarViewportValid = true;
    sidebarScrollTop = sidebar.scrollTop;
    sidebarViewportHeight = sidebar.clientHeight;
}

function ensureOutlineLayout() {
    if (outlineLayoutValid) return;
    outlineLayoutValid = true;
    outlineRowBoxes.clear();
    const sidebar = document.getElementById('sidebar');
    const pane = DOM.sidebarSections;
    if (!sidebar || !pane || !sectionsPaneVisible() || outlineRows.length === 0) return;
    const paneTop = pane.getBoundingClientRect().top;
    outlinePaneTop = paneTop - sidebar.getBoundingClientRect().top + sidebarScrollTop;
    for (const row of outlineRows) {
        const rect = row.getBoundingClientRect();
        outlineRowBoxes.set(row, { top: rect.top - paneTop, height: rect.height });
    }
}

function scrollOutlineRowIntoView(row: HTMLElement) {
    const sidebar = document.getElementById('sidebar');
    if (!sidebar || !sectionsPaneVisible()) return;
    ensureSidebarMetrics();
    ensureOutlineLayout();
    const box = outlineRowBoxes.get(row);
    if (!box || box.height <= 0) return;
    const viewTop = sidebarScrollTop - outlinePaneTop;
    const viewBottom = viewTop + sidebarViewportHeight;
    if (box.top >= viewTop && box.top + box.height <= viewBottom) {
        outlineFollowSmooth = false;
        return;
    }
    const target = Math.max(0, box.top - (sidebarViewportHeight - box.height) / 2 + outlinePaneTop);
    const dist = Math.abs(sidebarScrollTop - target);
    if (dist <= sidebarViewportHeight && !outlineFollowSmooth) {
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
        sidebarScrollTop = target;
        outlineFollowSmooth = false;
    }
}

function syncOutline(pos: { page: number; y: number } | null = null) {
    if (!scrollContainer || !DOM.sidebarSections) return;
    if (outlineRows.length === 0) {
        syncOutlineBreadcrumb(null);
        return;
    }
    const best = bestOutlineRow(outlineRows, pos ?? currentViewPosition());
    const visible = sectionsPaneVisible();
    if (visible && best !== activeOutlineRow) {
        if (activeOutlineRow) activeOutlineRow.classList.remove('outline-active');
        activeOutlineRow = best;
        if (best) {
            best.classList.add('outline-active');
            let node = best.parentElement;
            let expanded = false;
            while (node && node !== DOM.sidebarSections) {
                if (node.classList.contains('outline-children') && node.classList.contains('hidden')) {
                    node.classList.remove('hidden');
                    node.previousElementSibling?.classList.remove('outline-collapsed');
                    expanded = true;
                }
                node = node.parentElement;
            }
            if (expanded) invalidateOutlineLayout();
        }
    }
    if (best && visible && !followSuppressed && (PdfState.sidebarFollow || Date.now() < followOverrideUntil)) {
        scrollOutlineRowIntoView(best);
    }
    syncOutlineBreadcrumb(best);
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

function syncOutlineBreadcrumb(row?: HTMLElement | null) {
    const best = row !== undefined ? row : activeOutlineRow;
    if (best === lastBreadcrumbRow && currentFileName === lastBreadcrumbName) return;
    lastBreadcrumbRow = best;
    lastBreadcrumbName = currentFileName;
    if (!currentFileName) {
        setBreadcrumbPath(null);
        return;
    }
    let path = currentFileName;
    if (best) {
        const parts: string[] = [];
        let cur: HTMLElement | null = best;
        while (cur) {
            parts.unshift(cur.querySelector('.outline-label')?.textContent || '(untitled)');
            cur = outlineParentRow.get(cur) ?? null;
        }
        path = `${currentFileName} ▸ ${parts.join(' ▸ ')}`;
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
            outlinePositions.set(row, { page: target.page, y: (target.y ?? 0) / PdfState.currentScale });
        }
    }
}

export async function renderOutline() {
    if (!PdfState.currentPdfDoc || !DOM.sidebarSections) return;
    installSidebarObservers();
    DOM.sidebarSections.innerHTML = '';
    invalidateSidebarViewport();
    invalidateOutlineLayout();
    activeOutlineRow = null;
    outlineRows = [];
    lastBreadcrumbRow = null;
    lastBreadcrumbName = undefined;
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
    outlineRows = Array.from(DOM.sidebarSections.querySelectorAll<HTMLElement>('.outline-item'));
    await linkOutlinePages();
    syncOutline();
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
            invalidateOutlineLayout();
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

function thumbHeightFor(pageNum: number, width = getSidebarTargetWidth()): number {
    const points = pagePointSize(pageNum);
    const aspect = thumbAspects.get(pageNum) ?? points.height / points.width;
    return Math.round(Math.max(120, width - THUMB_INSET * 2) * aspect);
}

let thumbLayoutWidth = 280;
let thumbLayoutDirty = true;

function rebuildThumbLayout(force = false) {
    if (!PdfState.currentPdfDoc || !DOM.sidebarPreviews) return;
    const total = PdfState.currentPdfDoc.numPages;
    const width = getSidebarTargetWidth();
    if (!force && !thumbLayoutDirty && thumbTops.length === total && width === thumbLayoutWidth) return;
    thumbLayoutDirty = false;
    thumbLayoutWidth = width;
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
    thumbLayoutDirty = true;

    const sidebar = document.getElementById('sidebar');
    if (!sidebar) return;
    const savedAnchor = previewsPaneVisible() ? captureSidebarAnchor() : null;
    DOM.sidebarPreviews.innerHTML = '';
    DOM.sidebarPreviews.style.position = 'relative';

    sidebar.onscroll = null;
    if (thumbSettleTimer) {
        clearTimeout(thumbSettleTimer);
        thumbSettleTimer = null;
    }

    rebuildThumbLayout();

    if (savedAnchor) sidebar.scrollTop = restoreSidebarAnchor(savedAnchor);
    sidebar.removeEventListener('scroll', onThumbScroll);
    sidebar.addEventListener('scroll', onThumbScroll, { passive: true });
    scheduleThumbWindowRender();

    const freshDoc = PdfState.currentPdfDoc !== thumbDoc;
    thumbDoc = PdfState.currentPdfDoc;
    if (freshDoc) followOverrideUntil = Date.now() + 2000;
    activeThumbPage = freshDoc ? 0 : activeThumbPage;
    thumbFollowSmooth = freshDoc;
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
    const sidebar = document.getElementById('sidebar');
    if (sidebar) sidebarScrollTop = sidebar.scrollTop;
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
    const radius = thumbEvictRadius();
    thumbQueue = thumbQueue.filter((p) => p - 1 >= first - radius - 5 && p - 1 <= last + radius + 5);

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
    while (thumbQueue.length > 0) {
        const mainBusy = renderQueue.length > 0 || pendingRenders.size > 0;
        const free = RENDER_CONCURRENCY - activeMainRenders - activeThumbRenders;
        const limit = mainBusy ? 1 : RENDER_CONCURRENCY;
        if (free <= 0 || activeThumbRenders >= limit) return;
        const pageNum = thumbQueue.shift()!;
        if (!thumbPending.has(pageNum)) continue;
        if (thumbCanvases.has(pageNum)) {
            thumbPending.delete(pageNum);
            continue;
        }
        activeThumbRenders++;
        void renderThumb(pageNum).finally(() => {
            activeThumbRenders = Math.max(0, activeThumbRenders - 1);
            thumbPending.delete(pageNum);
            pumpRenderQueue();
            pumpThumbQueue();
        });
    }
}

async function renderThumb(pageNum: number) {
    const thumb = DOM.sidebarPreviews?.querySelector<HTMLCanvasElement>(`[data-page-num="${pageNum}"]`);
    const doc = PdfState.currentPdfDoc;
    if (!thumb || !thumb.isConnected || !doc) return;
    try {
        const page = await doc.getPage(pageNum);
        if (!thumb.isConnected || PdfState.currentPdfDoc !== doc) return;
        const baseViewport = page.getViewport({ scale: 1 });
        const targetWidth = Math.max(120, getSidebarTargetWidth() - THUMB_INSET * 2);
        const scale = (targetWidth / baseViewport.width) * getOutputScale();
        const viewport = page.getViewport({ scale });
        thumb.width = Math.max(1, Math.floor(viewport.width));
        thumb.height = Math.max(1, Math.floor(viewport.height));
        const cssHeight = Math.max(1, Math.floor(viewport.height / getOutputScale()));
        const aspect = baseViewport.height / baseViewport.width;
        if (thumbAspects.get(pageNum) !== aspect) {
            thumbAspects.set(pageNum, aspect);
            thumbLayoutDirty = true;
        }
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
        if (!thumb.isConnected || PdfState.currentPdfDoc !== doc) return;
        thumbCanvases.set(pageNum, thumb);
        thumb.dataset.rendered = '1';
    } catch (err: any) {
        if (!isObsoleteRender(err, doc)) {
            console.error(`Error rendering thumbnail ${pageNum}:`, err);
        }
    }
}

function evictThumbs(first: number, last: number) {
    const radius = thumbEvictRadius();
    for (let i = thumbElements.length - 1; i >= 0; i--) {
        const canvas = thumbElements[i];
        const pageNum = parseInt(canvas.dataset.pageNum || '0', 10);
        if (pageNum - 1 >= first - radius && pageNum - 1 <= last + radius) continue;
        canvas.remove();
        thumbElements.splice(i, 1);
        thumbCanvases.delete(pageNum);
        releasePage(pageNum);
    }
    for (const [pageNum, entry] of thumbPending) {
        if (pageNum - 1 < first - radius - 5 || pageNum - 1 > last + radius + 5) {
            try {
                entry.task?.cancel();
            } catch {}
            thumbPending.delete(pageNum);
        }
    }
}
