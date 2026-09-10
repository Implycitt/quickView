import { PdfState, jumpToPage } from './pdfRenderer.js';
import { DOM, toggleSidebar } from '../ui.js';

interface PageIndex {
    text: string;
    ranges: { start: number; end: number }[];
    spans: (HTMLElement | null)[];
}

interface PageMatch {
    start: number;
    end: number;
}

interface SearchResult {
    page: number;
    score: number;
    start: number;
    end: number;
}

const pageIndexes = new Map<number, PageIndex>();
const inflightIndex = new Map<number, Promise<PageIndex | null>>();
let indexVersion = 0;
let searchVersion = 0;
let searchOpen = false;
let sidebarRestore = false;
let activeSearch: { matches: Map<number, PageMatch> } | null = null;
let currentResults: SearchResult[] = [];
let selectedIndex = 0;
let pendingScroll: { page: number; start: number; end: number } | null = null;

const MAX_RESULTS = 40;
const SCAN_CHUNK = 60;
const INDEX_BATCH = 8;
const MD_BLOCK_SELECTOR = 'h1, h2, h3, h4, h5, h6, p, li, pre, blockquote, td, th, dt, dd';

interface MdBlock {
    text: string;
    el: HTMLElement;
}

let mdBlocks: MdBlock[] = [];
let searchMode: 'pdf' | 'md' | null = null;

function isWs(c: number): boolean {
    return c === 32 || (c >= 9 && c <= 13);
}

function normalizeBlock(raw: string): string {
    return raw.toLowerCase().replace(/\s+/g, ' ').trim();
}

export function indexMarkdown(root: HTMLElement) {
    mdBlocks = [];
    const candidates = Array.from(root.querySelectorAll<HTMLElement>(MD_BLOCK_SELECTOR));
    for (const el of candidates) {
        if (el.querySelector(MD_BLOCK_SELECTOR)) continue;
        const text = normalizeBlock(el.textContent || '');
        if (text.length > 0) mdBlocks.push({ text, el });
    }
}

function mdBlockLabel(idx: number): string {
    const block = mdBlocks[idx];
    if (!block) return '';
    for (let i = idx; i >= 0; i--) {
        const tag = mdBlocks[i].el.tagName;
        if (/^H[1-6]$/.test(tag)) {
            const t = (mdBlocks[i].el.textContent || '').trim();
            return t ? t.slice(0, 40) : 'Heading';
        }
    }
    const tag = block.el.tagName;
    if (tag === 'PRE') return 'Code block';
    if (tag === 'LI') return 'List item';
    if (tag === 'BLOCKQUOTE') return 'Quote';
    if (tag === 'TD' || tag === 'TH') return 'Table cell';
    if (tag === 'DT') return 'Term';
    if (tag === 'DD') return 'Definition';
    return 'Paragraph';
}

function buildPageIndex(textContent: any): PageIndex {
    let text = '';
    const ranges: { start: number; end: number }[] = [];
    for (const item of textContent.items) {
        if (typeof item.str !== 'string' || item.str.length === 0) {
            ranges.push({ start: text.length, end: text.length });
            continue;
        }
        const lower = item.str.toLowerCase();
        const prev = text.length > 0 ? text.charCodeAt(text.length - 1) : -1;
        const first = lower.charCodeAt(0);
        if (text.length > 0 && !isWs(prev) && !isWs(first)) {
            text += ' ';
        }
        const start = text.length;
        text += lower;
        ranges.push({ start, end: text.length });
    }
    return { text, ranges, spans: [] };
}

function setPageIndex(pageNum: number, index: PageIndex) {
    const existing = pageIndexes.get(pageNum);
    if (existing) {
        if (existing.text.length === 0) {
            existing.text = index.text;
            existing.ranges = index.ranges;
        }
        return;
    }
    pageIndexes.set(pageNum, index);
}

function ensureIndexed(pageNum: number): Promise<PageIndex | null> {
    const existing = pageIndexes.get(pageNum);
    if (existing) return Promise.resolve(existing);
    let pending = inflightIndex.get(pageNum);
    if (!pending) {
        pending = (async (): Promise<PageIndex | null> => {
            const doc = PdfState.currentPdfDoc;
            if (!doc) return null;
            try {
                const page = await doc.getPage(pageNum);
                const textContent = await page.getTextContent();
                if (PdfState.currentPdfDoc !== doc) return null;
                const index = buildPageIndex(textContent);
                setPageIndex(pageNum, index);
                return index;
            } catch {
                return null;
            }
        })();
        inflightIndex.set(pageNum, pending);
        void pending.finally(() => inflightIndex.delete(pageNum));
    }
    return pending;
}

export function startBackgroundIndex() {
    indexVersion++;
    const doc = PdfState.currentPdfDoc;
    if (!doc) return;
    const version = indexVersion;
    const total = doc.numPages;
    let page = 1;
    const tick = () => {
        if (indexVersion !== version || PdfState.currentPdfDoc !== doc || page > total) return;
        const end = Math.min(page + INDEX_BATCH, total + 1);
        for (let p = page; p < end; p++) {
            if (pageIndexes.has(p)) continue;
            void ensureIndexed(p);
        }
        page = end;
        setTimeout(tick, 0);
    };
    setTimeout(tick, 0);
}

export async function renderPageTextLayer(
    page: any,
    container: HTMLElement,
    viewport: any,
    pageNum: number,
): Promise<void> {
    try {
        const textContent = await page.getTextContent();
        if (!container.isConnected) return;
        const index = buildPageIndex(textContent);
        setPageIndex(pageNum, index);
        if (index.text.length === 0) return;
        const layer = document.createElement('div');
        layer.className = 'text-layer';
        const spans: (HTMLElement | null)[] = [];
        for (const item of textContent.items) {
            if (typeof item.str !== 'string' || item.str.length === 0) {
                spans.push(null);
                continue;
            }
            const span = document.createElement('span');
            span.textContent = item.str;
            const tf = item.transform || [1, 0, 0, 1, 0, 0];
            const fontHeight = Math.hypot(tf[2], tf[3]) || 11;
            const point = viewport.convertToViewportPoint(tf[4], tf[5]);
            span.style.left = `${point[0]}px`;
            span.style.top = `${point[1] - fontHeight * 0.8 * PdfState.currentScale}px`;
            span.style.fontSize = `${fontHeight * PdfState.currentScale}px`;
            layer.appendChild(span);
            spans.push(span);
        }
        if (spans.length === 0) return;
        container.appendChild(layer);
        setPageSpans(pageNum, spans);
    } catch {
        return;
    }
}

export function setPageSpans(pageNum: number, spans: (HTMLElement | null)[]) {
    const index = pageIndexes.get(pageNum);
    if (index) index.spans = spans;
    applyHighlightsToPage(pageNum);
    if (pendingScroll && pendingScroll.page === pageNum) {
        const { start, end } = pendingScroll;
        pendingScroll = null;
        const container = document.getElementById(`page-container-${pageNum}`);
        const idx = pageIndexes.get(pageNum);
        if (container && idx) {
            const ranges = idx.ranges;
            for (let i = 0; i < ranges.length; i++) {
                if (ranges[i].end > start && ranges[i].start < end) {
                    const span = spans[i];
                    if (span) {
                        const sRect = span.getBoundingClientRect();
                        const cRect = container.getBoundingClientRect();
                        jumpToPage(pageNum, sRect.top - cRect.top + span.offsetHeight / 2, true);
                    }
                    break;
                }
            }
        }
    }
}

export function clearPageSpans(pageNum: number) {
    const index = pageIndexes.get(pageNum);
    if (index) index.spans = [];
}

function setSpanHighlight(span: HTMLElement, range: { start: number; end: number }, match: PageMatch | undefined) {
    const hlStart = match ? Math.max(range.start, match.start) : range.end;
    const hlEnd = match ? Math.min(range.end, match.end) : range.start;
    if (hlEnd <= hlStart) {
        if (span.dataset.hl === undefined || span.dataset.hl === '') return;
        span.replaceChildren(document.createTextNode(span.textContent || ''));
        span.classList.remove('pdf-hl');
        span.dataset.hl = '';
        return;
    }
    if (hlStart === range.start && hlEnd === range.end) {
        if (span.dataset.hl === 'full') return;
        if (span.firstElementChild) span.replaceChildren(document.createTextNode(span.textContent || ''));
        span.classList.add('pdf-hl');
        span.dataset.hl = 'full';
        return;
    }
    const key = `${hlStart}-${hlEnd}`;
    if (span.dataset.hl === key) return;
    span.classList.remove('pdf-hl');
    const orig = span.textContent || '';
    const a = hlStart - range.start;
    const b = hlEnd - range.start;
    const mark = document.createElement('span');
    mark.className = 'pdf-hl';
    mark.textContent = orig.slice(a, b);
    span.replaceChildren(document.createTextNode(orig.slice(0, a)), mark, document.createTextNode(orig.slice(b)));
    span.dataset.hl = key;
}

function applyHighlightsToPage(pageNum: number) {
    const index = pageIndexes.get(pageNum);
    const spans = index?.spans;
    if (!spans || spans.length === 0) return;
    const match = activeSearch?.matches.get(pageNum);
    const ranges = index.ranges;
    for (let i = 0; i < ranges.length && i < spans.length; i++) {
        const s = spans[i];
        if (s) setSpanHighlight(s, ranges[i], match);
    }
}

function applyMdHighlights() {
    if (!activeSearch) return;
    for (let i = 0; i < mdBlocks.length; i++) {
        mdBlocks[i].el.classList.toggle('md-search-hl', activeSearch.matches.has(i));
    }
}

function clearMdHighlights() {
    for (const block of mdBlocks) block.el.classList.remove('md-search-hl');
}

function applyAllHighlights() {
    for (const pageNum of pageIndexes.keys()) applyHighlightsToPage(pageNum);
    applyMdHighlights();
}

function clearAllHighlights() {
    for (const index of pageIndexes.values()) {
        const spans = index.spans;
        if (spans.length === 0) continue;
        const ranges = index.ranges;
        for (let i = 0; i < ranges.length && i < spans.length; i++) {
            const s = spans[i];
            if (s) setSpanHighlight(s, ranges[i], undefined);
        }
    }
    clearMdHighlights();
}

function tokenMatch(text: string, tokens: string[]): { score: number; start: number; end: number } | null {
    if (tokens.length === 0) return null;
    let best: { score: number; start: number; end: number } | null = null;
    for (const token of tokens) {
        const idx = text.indexOf(token);
        if (idx < 0) continue;
        const end = idx + token.length;
        const score = idx * 0.02 + text.length * 0.001;
        if (!best || score < best.score) best = { score, start: idx, end };
    }
    return best;
}

function sortResults(results: SearchResult[]) {
    results.sort((a, b) => a.score - b.score || a.page - b.page);
}

function renderEmpty() {
    const list = document.getElementById('search-results');
    const count = document.getElementById('search-count');
    if (!list || !count) return;
    list.innerHTML = '';
    count.textContent = '';
    const hint = document.createElement('div');
    hint.className = 'search-result-empty';
    hint.textContent = 'Type to fuzzy search…';
    list.appendChild(hint);
}

export function runSearch(query: string) {
    const version = ++searchVersion;
    const tokens = query
        .toLowerCase()
        .split(/\s+/)
        .filter((t) => t.length > 0);
    const hasDoc = !!PdfState.currentPdfDoc;
    const hasMd = mdBlocks.length > 0;
    if (!hasDoc && !hasMd) return;
    if (tokens.length === 0) {
        currentResults = [];
        activeSearch = null;
        renderEmpty();
        clearAllHighlights();
        return;
    }
    if (hasDoc) {
        searchMode = 'pdf';
        void scanPages(tokens, version);
    } else {
        searchMode = 'md';
        void scanMarkdown(tokens, version);
    }
}

async function scanMarkdown(tokens: string[], version: number) {
    const total = mdBlocks.length;
    const results: SearchResult[] = [];
    const matches = new Map<number, PageMatch>();
    for (let i = 0; i < total; i++) {
        const m = tokenMatch(mdBlocks[i].text, tokens);
        if (m) {
            results.push({ page: i, score: m.score, start: m.start, end: m.end });
            matches.set(i, { start: m.start, end: m.end });
        }
    }
    sortResults(results);
    if (version !== searchVersion) return;
    activeSearch = { matches };
    currentResults = results;
    renderResults(results, total, total);
    applyAllHighlights();
}

async function scanPages(tokens: string[], version: number) {
    const doc = PdfState.currentPdfDoc;
    if (!doc) return;
    const total = doc.numPages;
    const results: SearchResult[] = [];
    const matches = new Map<number, PageMatch>();
    for (let page = 1; page <= total; page++) {
        const index = pageIndexes.get(page);
        if (!index || index.text.length === 0) continue;
        const m = tokenMatch(index.text, tokens);
        if (m) {
            results.push({ page, score: m.score, start: m.start, end: m.end });
            matches.set(page, { start: m.start, end: m.end });
        }
    }
    sortResults(results);
    if (version !== searchVersion || PdfState.currentPdfDoc !== doc) return;
    activeSearch = { matches };
    currentResults = results;
    renderResults(results, 0, total);
    applyAllHighlights();
    let checked = 0;
    for (let page = 1; page <= total; page++) {
        if (version !== searchVersion || PdfState.currentPdfDoc !== doc) return;
        checked++;
        if (pageIndexes.has(page)) continue;
        const index = await ensureIndexed(page);
        if (version !== searchVersion) return;
        if (index && index.text.length > 0) {
            const m = tokenMatch(index.text, tokens);
            if (m) {
                results.push({ page, score: m.score, start: m.start, end: m.end });
                matches.set(page, { start: m.start, end: m.end });
            }
        }
        if (checked % SCAN_CHUNK === 0) {
            sortResults(results);
            if (version === searchVersion) {
                activeSearch = { matches };
                currentResults = results;
                renderResults(results, checked, total);
                applyAllHighlights();
            }
            await new Promise((r) => setTimeout(r, 0));
        }
    }
    if (version !== searchVersion) return;
    sortResults(results);
    activeSearch = { matches };
    currentResults = results;
    renderResults(results, total, total);
    applyAllHighlights();
}

function renderResults(results: SearchResult[], done: number, total: number) {
    const list = document.getElementById('search-results');
    const count = document.getElementById('search-count');
    if (!list || !count) return;
    selectedIndex = Math.min(selectedIndex, Math.max(0, results.length - 1));
    list.innerHTML = '';
    const top = results.slice(0, MAX_RESULTS);
    if (top.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'search-result-empty';
        empty.textContent = done === 0 ? 'No matches yet…' : 'No matches';
        list.appendChild(empty);
        count.textContent = done < total ? `${done}/${total} pages scanned` : 'No matches';
        return;
    }
    count.textContent = `${results.length} match${results.length === 1 ? '' : 'es'}${
        done < total ? ` · ${done}/${total} scanned` : ''
    }`;
    for (let i = 0; i < top.length; i++) {
        const row = document.createElement('button');
        row.className = 'search-result';
        if (i === selectedIndex) row.classList.add('search-result-selected');
        row.addEventListener('mousedown', (e) => e.preventDefault());
        const result = top[i];
        row.addEventListener('click', () => {
            selectedIndex = i;
            jumpToResult(result);
        });
        const head = document.createElement('span');
        head.className = 'search-result-head';
        const pageEl = document.createElement('span');
        pageEl.className = 'search-result-page';
        pageEl.textContent = searchMode === 'md' ? mdBlockLabel(result.page) : `Page ${result.page}`;
        const indexEl = document.createElement('span');
        indexEl.className = 'search-result-index';
        indexEl.textContent = `${i + 1}/${results.length}`;
        head.append(pageEl, indexEl);
        const snippet = document.createElement('span');
        snippet.className = 'search-result-snippet';
        const index = pageIndexes.get(result.page);
        const t = searchMode === 'md' ? (mdBlocks[result.page]?.text ?? '') : index ? index.text : '';
        const s = Math.max(0, result.start - 32);
        const e = Math.min(t.length, result.end + 64);
        if (s < result.start) snippet.append(document.createTextNode(t.slice(s, result.start)));
        const mark = document.createElement('mark');
        mark.textContent = t.slice(result.start, result.end);
        snippet.append(mark);
        if (result.end < e) snippet.append(document.createTextNode(t.slice(result.end, e)));
        row.append(head, snippet);
        list.appendChild(row);
    }
    const selectedRow = list.children[selectedIndex] as HTMLElement | undefined;
    selectedRow?.scrollIntoView({ block: 'nearest' });
}

function jumpToResult(result: SearchResult) {
    if (searchMode === 'md') {
        const block = mdBlocks[result.page]?.el;
        if (block) block.scrollIntoView({ block: 'center' });
        return;
    }
    const container = document.getElementById(`page-container-${result.page}`);
    const index = pageIndexes.get(result.page);
    let y: number | null = null;
    if (container && index) {
        const ranges = index.ranges;
        for (let i = 0; i < ranges.length; i++) {
            if (ranges[i].end > result.start && ranges[i].start < result.end) {
                const span = index.spans[i];
                if (span) {
                    const sRect = span.getBoundingClientRect();
                    const cRect = container.getBoundingClientRect();
                    y = sRect.top - cRect.top + span.offsetHeight / 2;
                }
                break;
            }
        }
    }
    if (y === null) pendingScroll = { page: result.page, start: result.start, end: result.end };
    jumpToPage(result.page, y, true);
}

function moveSelection(delta: number) {
    const list = document.getElementById('search-results');
    if (!list || list.children.length === 0) return;
    selectedIndex = Math.max(0, Math.min(list.children.length - 1, selectedIndex + delta));
    for (let i = 0; i < list.children.length; i++) {
        list.children[i].classList.toggle('search-result-selected', i === selectedIndex);
    }
    (list.children[selectedIndex] as HTMLElement).scrollIntoView({ block: 'nearest' });
    const result = currentResults[selectedIndex];
    if (result) jumpToResult(result);
}

export function initSearch() {
    const overlay = document.getElementById('search-overlay');
    const input = document.getElementById('search-input') as HTMLInputElement;
    if (!overlay || !input) return;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    input.addEventListener('input', () => {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => runSearch(input.value), 120);
    });
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            e.preventDefault();
            closeSearch();
        } else if (e.key === 'Enter') {
            e.preventDefault();
            const result = currentResults[selectedIndex];
            if (result) {
                jumpToResult(result);
                input.focus();
            }
        } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            moveSelection(1);
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            moveSelection(-1);
        }
    });
    document.addEventListener('keydown', (e) => {
        if (searchOpen && e.key === 'Escape') closeSearch();
    });
}

export function openSearch() {
    if (!PdfState.currentPdfDoc && mdBlocks.length === 0) return;
    const overlay = document.getElementById('search-overlay');
    const input = document.getElementById('search-input') as HTMLInputElement;
    if (!overlay || !input) return;
    if (searchOpen) {
        input.focus();
        return;
    }
    sidebarRestore = DOM.sidebar && DOM.sidebar.style.width !== '0px';
    if (sidebarRestore) toggleSidebar('closed');
    searchOpen = true;
    overlay.classList.remove('hidden');
    input.value = '';
    selectedIndex = 0;
    runSearch('');
    input.focus();
}

export function closeSearch() {
    if (!searchOpen) return;
    searchVersion++;
    searchOpen = false;
    currentResults = [];
    const overlay = document.getElementById('search-overlay');
    if (overlay) overlay.classList.add('hidden');
    const input = document.getElementById('search-input') as HTMLInputElement;
    if (input) input.value = '';
    activeSearch = null;
    pendingScroll = null;
    clearAllHighlights();
    if (sidebarRestore) {
        sidebarRestore = false;
        if (DOM.sidebar && DOM.sidebar.style.width === '0px') toggleSidebar('open');
    }
}

export function resetSearchState() {
    searchVersion++;
    indexVersion++;
    searchOpen = false;
    pageIndexes.clear();
    inflightIndex.clear();
    mdBlocks = [];
    searchMode = null;
    currentResults = [];
    activeSearch = null;
    pendingScroll = null;
    const overlay = document.getElementById('search-overlay');
    if (overlay) overlay.classList.add('hidden');
    if (sidebarRestore) {
        sidebarRestore = false;
        if (DOM.sidebar && DOM.sidebar.style.width === '0px') toggleSidebar('open');
    }
}
