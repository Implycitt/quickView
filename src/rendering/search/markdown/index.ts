import { normalizeBlock, sortResults, tokenMatch } from '../core/query.js';
import type { PageMatch, SearchResult } from '../core/types.js';

const MD_BLOCK_SELECTOR = 'h1, h2, h3, h4, h5, h6, p, li, pre, blockquote, td, th, dt, dd';

export interface MarkdownBlock {
    text: string;
    element: HTMLElement;
}

export let markdownBlocks: MarkdownBlock[] = [];

export function indexMarkdown(root: HTMLElement) {
    markdownBlocks = [];
    const candidates = Array.from(root.querySelectorAll<HTMLElement>(MD_BLOCK_SELECTOR));
    for (const element of candidates) {
        if (element.querySelector(MD_BLOCK_SELECTOR)) continue;
        const text = normalizeBlock(element.textContent || '');
        if (text.length > 0) markdownBlocks.push({ text, element });
    }
}

export function clearMarkdownIndex() {
    markdownBlocks = [];
}

export function markdownBlockLabel(index: number): string {
    const block = markdownBlocks[index];
    if (!block) return '';
    for (let current = index; current >= 0; current--) {
        const tag = markdownBlocks[current].element.tagName;
        if (/^H[1-6]$/.test(tag)) {
            const heading = (markdownBlocks[current].element.textContent || '').trim();
            return heading ? heading.slice(0, 40) : 'Heading';
        }
    }

    const tag = block.element.tagName;
    if (tag === 'PRE') return 'Code block';
    if (tag === 'LI') return 'List item';
    if (tag === 'BLOCKQUOTE') return 'Quote';
    if (tag === 'TD' || tag === 'TH') return 'Table cell';
    if (tag === 'DT') return 'Term';
    if (tag === 'DD') return 'Definition';
    return 'Paragraph';
}

export function scanMarkdown(tokens: string[]): { results: SearchResult[]; matches: Map<number, PageMatch> } {
    const results: SearchResult[] = [];
    const matches = new Map<number, PageMatch>();
    for (let index = 0; index < markdownBlocks.length; index++) {
        const match = tokenMatch(markdownBlocks[index].text, tokens);
        if (!match) continue;
        results.push({ page: index, score: match.score, start: match.start, end: match.end });
        matches.set(index, { start: match.start, end: match.end });
    }
    sortResults(results);
    return { results, matches };
}
