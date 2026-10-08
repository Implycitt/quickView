import { PdfState, isPdfViewerBusy } from '../../pdf/state.js';
import type { PageMatch, SearchResult } from '../core/types.js';
import { ensureIndexed, pageIndexes } from './pageIndexStore.js';
import { sortResults, tokenMatch } from '../core/query.js';

const SCAN_CHUNK = 60;
const BUSY_DELAY = 120;

export async function scanPdf(
    tokens: string[],
    isCurrent: () => boolean,
    onUpdate: (results: SearchResult[], matches: Map<number, PageMatch>, done: number, total: number) => void,
) {
    const doc = PdfState.currentPdfDoc;
    if (!doc) return;
    const total = doc.numPages;
    const results: SearchResult[] = [];
    const matches = new Map<number, PageMatch>();

    const addMatch = (page: number, text: string) => {
        const match = tokenMatch(text, tokens);
        if (!match) return;
        results.push({ page, score: match.score, start: match.start, end: match.end });
        matches.set(page, { start: match.start, end: match.end });
    };

    for (let page = 1; page <= total; page++) {
        const index = pageIndexes.get(page);
        if (index?.text) addMatch(page, index.text);
    }
    sortResults(results);
    if (!isCurrent() || PdfState.currentPdfDoc !== doc) return;
    onUpdate(results, matches, 0, total);

    let checked = 0;
    for (let page = 1; page <= total; page++) {
        if (!isCurrent() || PdfState.currentPdfDoc !== doc) return;
        checked++;
        if (!pageIndexes.has(page)) {
            const index = await ensureIndexed(page);
            if (!isCurrent()) return;
            if (index?.text) addMatch(page, index.text);
        }

        if (checked % SCAN_CHUNK === 0) {
            sortResults(results);
            onUpdate(results, matches, checked, total);
            await new Promise<void>((resolve) => setTimeout(resolve, isPdfViewerBusy() ? BUSY_DELAY : 0));
        }
    }
    if (!isCurrent()) return;
    sortResults(results);
    onUpdate(results, matches, total, total);
}
