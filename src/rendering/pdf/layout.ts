const DEFAULT_PAGE_POINTS = { width: 612, height: 792 };
const DEFAULT_PAGE_PADDING = 32;
const DEFAULT_PAGE_GAP = 32;
const PAGE_CONTAINER_CLASS = 'pdf-page-container mb-8 shadow-lg bg-white shrink-0 relative';
const MOUNT_BEHIND_PAGES = 3;
const MOUNT_AHEAD_PAGES = 6;
const LARGE_DOC_PAGES = 700;
const LARGE_DOC_MOUNT_BEHIND = 2;
const LARGE_DOC_MOUNT_AHEAD = 4;

interface PdfPageLayoutDependencies {
    getScale: () => number;
    getSnapMode: () => boolean;
    isSnapSuspended: () => boolean;
    onPageSizeChanged: (page: number) => void;
    onPageUnmounted: (page: number) => void;
}

export function createPdfPageLayout(deps: PdfPageLayoutDependencies) {
    const pageSizePoints = new Map<number, { width: number; height: number }>();
    let scrollContainer: HTMLElement | null = null;
    let pageContainers: Array<HTMLElement | undefined> = [];
    let pageCount = 0;
    let mountedPages: number[] = [];
    let topSpacer: HTMLElement | null = null;
    let bottomSpacer: HTMLElement | null = null;
    let spacerTopHeight = -1;
    let spacerBottomHeight = -1;
    let placeholderPoints = { ...DEFAULT_PAGE_POINTS };
    let pageTops: number[] = [];
    let pageGeometryDirty = true;
    let geoLayout: { baseTop: number; gap: number } | null = null;

    function pagePointSize(pageNumber: number) {
        return pageSizePoints.get(pageNumber) ?? placeholderPoints;
    }

    function pageWidth(pageNumber: number): number {
        return pagePointSize(pageNumber).width * (deps.getScale() || 1);
    }

    function pageHeight(pageNumber: number): number {
        return pagePointSize(pageNumber).height * (deps.getScale() || 1);
    }

    function setPlaceholderPoints(points: { width: number; height: number }) {
        placeholderPoints = points;
    }

    function clearPageSizes() {
        pageSizePoints.clear();
        pageTops = [];
        pageGeometryDirty = true;
        placeholderPoints = { ...DEFAULT_PAGE_POINTS };
    }

    function setPagePoints(pageNumber: number, points: { width: number; height: number }) {
        const existing = pageSizePoints.get(pageNumber);
        if (
            existing &&
            Math.abs(existing.width - points.width) < 0.5 &&
            Math.abs(existing.height - points.height) < 0.5
        ) {
            return false;
        }
        pageSizePoints.set(pageNumber, points);
        const container = pageContainers[pageNumber - 1];
        if (container) {
            container.style.width = `${pageWidth(pageNumber)}px`;
            container.style.height = `${pageHeight(pageNumber)}px`;
        }
        pageGeometryDirty = true;
        deps.onPageSizeChanged(pageNumber);
        return true;
    }

    function setViewer(scroll: HTMLElement, totalPages: number, top: HTMLElement, bottom: HTMLElement) {
        scrollContainer = scroll;
        pageCount = totalPages;
        pageContainers = new Array<HTMLElement | undefined>(totalPages);
        mountedPages = [];
        topSpacer = top;
        bottomSpacer = bottom;
        spacerTopHeight = -1;
        spacerBottomHeight = -1;
        pageTops = [];
        pageGeometryDirty = true;
        geoLayout = null;
    }

    function clearViewer() {
        scrollContainer = null;
        pageContainers = [];
        mountedPages = [];
        pageCount = 0;
        topSpacer = null;
        bottomSpacer = null;
        spacerTopHeight = -1;
        spacerBottomHeight = -1;
        pageTops = [];
        pageGeometryDirty = true;
        geoLayout = null;
    }

    function ensureGeometry() {
        if (!pageGeometryDirty) return;
        pageGeometryDirty = false;
        if (pageCount === 0) {
            pageTops = [];
            return;
        }
        const layout = geoLayout ?? { baseTop: DEFAULT_PAGE_PADDING, gap: DEFAULT_PAGE_GAP };
        const scale = deps.getScale() || 1;
        const tops = new Array<number>(pageCount);
        let y = layout.baseTop;
        for (let index = 0; index < pageCount; index++) {
            tops[index] = y;
            y += pagePointSize(index + 1).height * scale + layout.gap;
        }
        pageTops = tops;
    }

    function pageTop(pageNumber: number): number {
        ensureGeometry();
        return pageTops[pageNumber - 1] ?? geoLayout?.baseTop ?? DEFAULT_PAGE_PADDING;
    }

    function pageBottom(pageNumber: number): number {
        return pageTop(pageNumber) + pageHeight(pageNumber);
    }

    function pageAtOffset(offset: number): number {
        if (pageCount === 0) return 1;
        ensureGeometry();
        const target = Math.max(0, Math.min(pageBottom(pageCount), offset));
        let low = 1;
        let high = pageCount;
        while (low < high) {
            const middle = Math.floor((low + high) / 2);
            if (pageBottom(middle) <= target) low = middle + 1;
            else high = middle;
        }
        return low;
    }

    function getMountMargins() {
        return pageCount > LARGE_DOC_PAGES
            ? { behind: LARGE_DOC_MOUNT_BEHIND, ahead: LARGE_DOC_MOUNT_AHEAD }
            : { behind: MOUNT_BEHIND_PAGES, ahead: MOUNT_AHEAD_PAGES };
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

    function createContainer(pageNumber: number): HTMLElement {
        const size = pagePointSize(pageNumber);
        const scale = deps.getScale() || 1;
        const container = document.createElement('div');
        container.id = `page-container-${pageNumber}`;
        container.className = PAGE_CONTAINER_CLASS;
        container.dataset.pageNum = String(pageNumber);
        container.style.width = `${size.width * scale}px`;
        container.style.height = `${size.height * scale}px`;
        if (deps.getSnapMode() && !deps.isSnapSuspended()) container.classList.add('snap-center');
        return container;
    }

    function mountPage(pageNumber: number) {
        if (!scrollContainer || !bottomSpacer || pageContainers[pageNumber - 1]) return;
        const container = createContainer(pageNumber);
        let inserted = false;
        for (const mounted of mountedPages) {
            if (mounted > pageNumber) {
                pageContainers[mounted - 1]?.before(container);
                inserted = true;
                break;
            }
        }
        if (!inserted) bottomSpacer.before(container);
        pageContainers[pageNumber - 1] = container;
        mountedPages.push(pageNumber);
        mountedPages.sort((left, right) => left - right);
    }

    function unmountPage(pageNumber: number) {
        pageContainers[pageNumber - 1]?.remove();
        pageContainers[pageNumber - 1] = undefined;
        const index = mountedPages.indexOf(pageNumber);
        if (index >= 0) mountedPages.splice(index, 1);
        deps.onPageUnmounted(pageNumber);
    }

    function unmountAllPages() {
        for (const pageNumber of [...mountedPages]) unmountPage(pageNumber);
    }

    function syncMountedPages(first: number, last: number) {
        if (!scrollContainer || pageCount === 0) return;
        first = Math.max(1, Math.min(pageCount, first));
        last = Math.max(first, Math.min(pageCount, last));
        const needed = last - first + 1;
        if (
            mountedPages.length === needed &&
            mountedPages[0] === first &&
            mountedPages[mountedPages.length - 1] === last
        ) {
            updateSpacers();
            return;
        }
        const overlaps = mountedPages.some((pageNumber) => pageNumber >= first && pageNumber <= last);
        if (!overlaps) unmountAllPages();
        for (const pageNumber of [...mountedPages]) {
            if (pageNumber < first || pageNumber > last) unmountPage(pageNumber);
        }
        for (let pageNumber = first; pageNumber <= last; pageNumber++) {
            if (!pageContainers[pageNumber - 1]) mountPage(pageNumber);
        }
        updateSpacers();
    }

    function mountAroundPage(pageNumber: number) {
        const margin = getMountMargins();
        syncMountedPages(pageNumber - margin.behind, pageNumber + margin.ahead);
    }

    function applySnapClasses() {
        const enabled = deps.getSnapMode() && !deps.isSnapSuspended();
        scrollContainer?.classList.toggle('snap-y', enabled);
        scrollContainer?.classList.toggle('snap-mandatory', enabled);
        for (const pageNumber of mountedPages) {
            pageContainers[pageNumber - 1]?.classList.toggle('snap-center', enabled);
        }
    }

    function sampleLayout() {
        if (!scrollContainer || mountedPages.length === 0) return;
        const scrollerTop = scrollContainer.getBoundingClientRect().top;
        const contentOffset = (element: HTMLElement) =>
            element.getBoundingClientRect().top - scrollerTop + scrollContainer!.scrollTop;
        const first = mountedPages[0];
        const firstElement = pageContainers[first - 1];
        if (!firstElement) return;
        const spacerAbove = Math.max(0, pageTop(first) - (geoLayout?.baseTop ?? DEFAULT_PAGE_PADDING));
        const baseTop = contentOffset(firstElement) - spacerAbove;
        let gap = geoLayout?.gap ?? DEFAULT_PAGE_GAP;
        const nextElement = pageContainers[first];
        if (nextElement && mountedPages.includes(first + 1)) {
            const measured = contentOffset(nextElement) - contentOffset(firstElement) - pageHeight(first);
            if (measured >= 0 && measured < 200) gap = measured;
        }
        if (geoLayout && Math.abs(geoLayout.baseTop - baseTop) < 0.5 && Math.abs(geoLayout.gap - gap) < 0.5) return;
        geoLayout = { baseTop, gap };
        pageGeometryDirty = true;
        ensureGeometry();
        updateSpacers();
    }

    function currentPageAtViewport(lastKnownPage: number): number {
        if (pageCount === 0 || !scrollContainer) return lastKnownPage;
        const middle = scrollContainer.scrollTop + (scrollContainer.clientHeight || 1) / 2;
        return pageAtOffset(middle);
    }

    return {
        clearPageSizes,
        clearViewer,
        currentPageAtViewport,
        getMountMargins,
        getPageContainer: (pageNumber: number) => pageContainers[pageNumber - 1] ?? null,
        getPageCount: () => pageCount,
        getPageHeight: pageHeight,
        getPageHeightPoints: (pageNumber: number) => pageSizePoints.get(pageNumber)?.height,
        getPagePointSize: pagePointSize,
        getPageTop: pageTop,
        getScrollContainer: () => scrollContainer,
        isPageMeasured: (pageNumber: number) => pageSizePoints.has(pageNumber),
        mountAroundPage,
        pageAtOffset,
        sampleLayout,
        setPagePoints,
        setPlaceholderPoints,
        setViewer,
        syncMountedPages,
        applySnapClasses,
        updateSpacers,
    };
}

export type PdfPageLayout = ReturnType<typeof createPdfPageLayout>;
