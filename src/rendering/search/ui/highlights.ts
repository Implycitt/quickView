import type { PageIndex, PageMatch } from '../core/types.js';

let activeMatches: Map<number, PageMatch> | null = null;

export function setActiveHighlights(matches: Map<number, PageMatch> | null) {
    activeMatches = matches;
}

function setSpanHighlight(span: HTMLElement, range: { start: number; end: number }, match: PageMatch | undefined) {
    const highlightStart = match ? Math.max(range.start, match.start) : range.end;
    const highlightEnd = match ? Math.min(range.end, match.end) : range.start;
    if (highlightEnd <= highlightStart) {
        if (span.dataset.hl === undefined || span.dataset.hl === '') return;
        span.replaceChildren(document.createTextNode(span.textContent || ''));
        span.classList.remove('pdf-hl');
        span.dataset.hl = '';
        return;
    }
    if (highlightStart === range.start && highlightEnd === range.end) {
        if (span.dataset.hl === 'full') return;
        if (span.firstElementChild) span.replaceChildren(document.createTextNode(span.textContent || ''));
        span.classList.add('pdf-hl');
        span.dataset.hl = 'full';
        return;
    }

    const key = `${highlightStart}-${highlightEnd}`;
    if (span.dataset.hl === key) return;
    span.classList.remove('pdf-hl');
    const text = span.textContent || '';
    const start = highlightStart - range.start;
    const end = highlightEnd - range.start;
    const mark = document.createElement('span');
    mark.className = 'pdf-hl';
    mark.textContent = text.slice(start, end);
    span.replaceChildren(document.createTextNode(text.slice(0, start)), mark, document.createTextNode(text.slice(end)));
    span.dataset.hl = key;
}

export function applyPdfHighlights(index: PageIndex, pageNum: number) {
    if (index.spans.length === 0) return;
    const match = activeMatches?.get(pageNum);
    for (let i = 0; i < index.ranges.length && i < index.spans.length; i++) {
        const span = index.spans[i];
        if (span) setSpanHighlight(span, index.ranges[i], match);
    }
}

export function applyMarkdownHighlights(
    blocks: readonly { element: HTMLElement }[],
    matches: Map<number, PageMatch> | null,
) {
    if (matches) {
        for (let i = 0; i < blocks.length; i++) {
            blocks[i].element.classList.toggle('md-search-hl', matches.has(i));
        }
    } else {
        for (const block of blocks) block.element.classList.remove('md-search-hl');
    }
}
