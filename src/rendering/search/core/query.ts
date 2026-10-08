import type { SearchResult } from './types.js';

export function isWhitespace(code: number): boolean {
    return code === 32 || (code >= 9 && code <= 13);
}

export function normalizeBlock(raw: string): string {
    return raw.toLowerCase().replace(/\s+/g, ' ').trim();
}

export function parseQuery(query: string): string[] {
    return query
        .toLowerCase()
        .split(/\s+/)
        .filter((token) => token.length > 0);
}

export function tokenMatch(text: string, tokens: string[]): { score: number; start: number; end: number } | null {
    if (tokens.length === 0) return null;
    let best: { score: number; start: number; end: number } | null = null;
    for (const token of tokens) {
        const index = text.indexOf(token);
        if (index < 0) continue;
        const end = index + token.length;
        const score = index * 0.02 + text.length * 0.001;
        if (!best || score < best.score) best = { score, start: index, end };
    }
    return best;
}

export function sortResults(results: SearchResult[]) {
    results.sort((left, right) => left.score - right.score || left.page - right.page);
}
