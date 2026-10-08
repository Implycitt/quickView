import type { PdfPageLayout } from '../layout.js';
import type { PdfDocumentLike } from '../types.js';

const MEASURE_CHUNK = 15;

interface PdfMeasurementDependencies {
    getDocument: () => PdfDocumentLike | null;
    layout: Pick<PdfPageLayout, 'isPageMeasured' | 'setPagePoints'>;
    getViewerVersion: () => number;
    scheduleThumbnails: () => void;
}

export function createPdfMeasurement(deps: PdfMeasurementDependencies) {
    let measureChain: Promise<void> = Promise.resolve();

    function measureAllPages(version: number): Promise<void> {
        const run = async () => {
            const doc = deps.getDocument();
            if (!doc) return;
            for (let start = 1; start <= doc.numPages; start += MEASURE_CHUNK) {
                if (version !== deps.getViewerVersion()) return;
                const end = Math.min(start + MEASURE_CHUNK, doc.numPages + 1);
                const targets: number[] = [];
                for (let page = start; page < end; page++) {
                    if (!deps.layout.isPageMeasured(page)) targets.push(page);
                }
                if (targets.length === 0) continue;
                const pages = await Promise.all(targets.map((page) => doc.getPage(page).catch(() => null)));
                if (version !== deps.getViewerVersion()) return;
                for (let index = 0; index < pages.length; index++) {
                    const page = pages[index];
                    const pageNumber = targets[index];
                    if (!page || deps.layout.isPageMeasured(pageNumber)) continue;
                    const viewport = page.getViewport({ scale: 1 });
                    deps.layout.setPagePoints(pageNumber, { width: viewport.width, height: viewport.height });
                }
                if (version !== deps.getViewerVersion()) return;
                deps.scheduleThumbnails();
            }
        };
        const measurement = measureChain.then(run, run);
        measureChain = measurement;
        return measurement;
    }

    function whenMeasurementDone(): Promise<void> {
        return measureChain;
    }

    async function measurePageNow(pageNumber: number): Promise<void> {
        const doc = deps.getDocument();
        if (!doc || deps.layout.isPageMeasured(pageNumber)) return;
        try {
            const page = await doc.getPage(pageNumber);
            if (!page || deps.getDocument() !== doc || deps.layout.isPageMeasured(pageNumber)) return;
            const viewport = page.getViewport({ scale: 1 });
            deps.layout.setPagePoints(pageNumber, { width: viewport.width, height: viewport.height });
            deps.scheduleThumbnails();
        } catch {}
    }

    return { measureAllPages, measurePageNow, whenMeasurementDone };
}
