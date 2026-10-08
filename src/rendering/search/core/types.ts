export interface PageIndex {
    text: string;
    ranges: { start: number; end: number }[];
    spans: (HTMLElement | null)[];
}

export interface PageMatch {
    start: number;
    end: number;
}

export interface SearchResult {
    page: number;
    score: number;
    start: number;
    end: number;
}

export type SearchMode = 'pdf' | 'md';
