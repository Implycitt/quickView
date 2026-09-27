import MarkdownIt from 'markdown-it';
import texmath from 'markdown-it-texmath';
import katex from 'katex';
import { DOM } from '../ui.js';
import { setBreadcrumbPath } from './pdfRenderer.js';

export const md = new MarkdownIt({
    html: true,
    linkify: true,
    typographer: true,
}).use(texmath, {
    engine: katex,
    delimiters: 'dollars',
    katexOptions: { macros: { '\\Z': '\\mathbb{Z}' } },
});

const defaultFence =
    md.renderer.rules.fence ||
    function (tokens, idx, options, _env, slf) {
        return slf.renderToken(tokens, idx, options);
    };

md.renderer.rules.fence = (tokens, idx, options, _env, slf) => {
    const token = tokens[idx];
    const lang = token.info.trim().toLowerCase();

    if (lang === 'latex' || lang === 'math') {
        try {
            const renderedMath = katex.renderToString(token.content.trim(), {
                displayMode: true,
                throwOnError: false,
                macros: { '\\Z': '\\mathbb{Z}' },
            });
            return `<div class="my-4 overflow-x-auto flex justify-center">${renderedMath}</div>`;
        } catch (e) {
            console.error('KaTeX fence rendering error:', e);
        }
    }
    return defaultFence(tokens, idx, options, _env, slf);
};

const URL_SCHEME = /^[a-z][a-z\d+.-]*:/i;

function filePathToUrl(filePath: string): URL {
    const normalizedPath = filePath.replace(/\\/g, '/');

    if (normalizedPath.startsWith('//')) {
        const [, , host, ...segments] = normalizedPath.split('/');
        return new URL(`file://${host}/${segments.map(encodeURIComponent).join('/')}`);
    }

    if (/^[a-z]:\//i.test(normalizedPath)) {
        const [drive, ...segments] = normalizedPath.split('/');
        return new URL(`file:///${drive}/${segments.map(encodeURIComponent).join('/')}`);
    }

    const encodedPath = normalizedPath
        .split('/')
        .map((segment, index) => (index === 0 && normalizedPath.startsWith('/') ? '' : encodeURIComponent(segment)))
        .join('/');
    return new URL(`file://${normalizedPath.startsWith('/') ? '' : '/'}${encodedPath}`);
}

function fileUrlToPath(url: URL): string {
    const pathname = decodeURIComponent(url.pathname);
    if (url.hostname) return `//${url.hostname}${pathname}`;
    const drive = pathname.slice(1, 3);
    return pathname.startsWith('/') && /^[a-z]:$/i.test(drive) ? pathname.slice(1) : pathname;
}

function localImageUrl(filePath: string): string {
    return `quickview-asset://media/?path=${encodeURIComponent(filePath)}`;
}

function resolveRelativeSrc(src: string, baseUrl: URL): string {
    if (!src || src.startsWith('#')) return src;
    if (/^[a-z]:[\\/]/i.test(src)) return filePathToUrl(src).href;
    if (URL_SCHEME.test(src) || src.startsWith('//')) return src;

    try {
        return new URL(src.replace(/\\/g, '/'), baseUrl).href;
    } catch {
        return src;
    }
}

function resolveImageSrc(src: string, baseUrl: URL): string {
    // DOM attribute values are already HTML-decoded; decoding again corrupts literal entity-like filenames.
    const resolved = resolveRelativeSrc(src, baseUrl);
    if (!resolved.toLowerCase().startsWith('file:')) return resolved;

    try {
        return localImageUrl(fileUrlToPath(new URL(resolved)));
    } catch {
        return resolved;
    }
}

function resolveSrcSet(srcset: string, baseUrl: URL, resolveSrc = resolveRelativeSrc): string {
    const candidates: string[] = [];
    let index = 0;

    while (index < srcset.length) {
        while (index < srcset.length && (srcset[index] === ',' || /\s/.test(srcset[index]))) index++;
        if (index >= srcset.length) break;

        let src = '';
        while (index < srcset.length && !/\s/.test(srcset[index])) src += srcset[index++];

        let hadTrailingComma = false;
        while (src.endsWith(',')) {
            src = src.slice(0, -1);
            hadTrailingComma = true;
        }

        let descriptor = '';
        if (!hadTrailingComma) {
            while (index < srcset.length && /\s/.test(srcset[index])) index++;
            while (index < srcset.length && srcset[index] !== ',') descriptor += srcset[index++];
            if (index < srcset.length) index++;
        }

        if (src) {
            const resolved = resolveSrc(src, baseUrl);
            candidates.push(descriptor.trim() ? `${resolved} ${descriptor.trim()}` : resolved);
        }
    }

    return candidates.join(', ');
}

function resolveMarkdownMedia(html: string, filePath: string): string {
    if (!filePath) return html;

    const baseUrl = new URL('.', filePathToUrl(filePath));
    const template = document.createElement('template');
    template.innerHTML = html;

    const attributes: Array<[string, string, 'image' | 'image-srcset' | 'relative' | 'srcset']> = [
        ['img[src]', 'src', 'image'],
        ['img[srcset]', 'srcset', 'image-srcset'],
        ['picture source[src]', 'src', 'image'],
        ['picture source[srcset]', 'srcset', 'image-srcset'],
        ['image[href]', 'href', 'image'],
        ['image[xlink\\:href]', 'xlink:href', 'image'],
        ['source[src]', 'src', 'relative'],
        ['source[srcset]', 'srcset', 'srcset'],
        ['video[src]', 'src', 'relative'],
        ['video[poster]', 'poster', 'relative'],
        ['audio[src]', 'src', 'relative'],
        ['iframe[src]', 'src', 'relative'],
        ['embed[src]', 'src', 'relative'],
        ['object[data]', 'data', 'relative'],
    ];
    for (const [selector, attribute, resolver] of attributes) {
        template.content.querySelectorAll(selector).forEach((element) => {
            if (selector.startsWith('source[') && element.parentElement?.tagName.toLowerCase() === 'picture') return;
            const value = element.getAttribute(attribute);
            if (value === null) return;

            const resolved =
                resolver === 'image'
                    ? resolveImageSrc(value, baseUrl)
                    : resolver === 'image-srcset'
                      ? resolveSrcSet(value, baseUrl, resolveImageSrc)
                      : resolver === 'srcset'
                        ? resolveSrcSet(value, baseUrl)
                        : resolveRelativeSrc(value, baseUrl);
            element.setAttribute(attribute, resolved);
        });
    }

    return template.innerHTML;
}

export function renderMarkdownWithCallouts(rawMarkdown: string, filePath = ''): string {
    const processedMd = rawMarkdown.replace(
        /^>\s*"?\s*\[!(NOTE|WARNING|TIP|IMPORTANT|CAUTION)\]\s*"?\s*([\s\S]*?)(?=\n\s*\n|$)/gm,
        (_, type, content) => {
            const colors: Record<string, string> = {
                NOTE: 'border-blue-500 bg-blue-950/40 text-blue-200',
                WARNING: 'border-yellow-500 bg-yellow-950/40 text-yellow-200',
                TIP: 'border-emerald-500 bg-emerald-950/40 text-emerald-200',
                IMPORTANT: 'border-purple-500 bg-purple-950/40 text-purple-200',
                CAUTION: 'border-red-500 bg-red-950/40 text-red-200',
            };
            const style = colors[type] || colors.NOTE;

            let cleanContent = content.replace(/^>\s*/gm, '').trim();
            if (cleanContent.startsWith('"')) cleanContent = cleanContent.slice(1);
            if (cleanContent.endsWith('"')) cleanContent = cleanContent.slice(0, -1);
            cleanContent = cleanContent.trim();

            const renderedContent = md.renderInline(cleanContent);
            return `<div class="border-l-4 p-4 my-4 rounded-r ${style}"><p class="font-bold uppercase text-xs tracking-wider mb-1">${type}</p><p class="m-0">${renderedContent}</p></div>`;
        },
    );

    let html = resolveMarkdownMedia(md.render(processedMd), filePath);
    html = html.replace(
        /<li>\[([ xX])\]\s+/g,
        (_match, checked: string) =>
            `<li><input type="checkbox" disabled${checked.toLowerCase() === 'x' ? ' checked' : ''} class="mr-2 inline-block h-4 w-4 translate-y-0.5 accent-lavender-500" aria-label="${checked.toLowerCase() === 'x' ? 'checked' : 'unchecked'}">`,
    );
    return html;
}

export function attachMarkdownLinks(root: HTMLElement) {
    root.addEventListener('click', (event) => {
        const anchor = (event.target as HTMLElement | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
        if (!anchor) return;
        const href = anchor.getAttribute('href') ?? '';
        if (!/^(https?:|mailto:)/i.test(href)) return;
        event.preventDefault();
        void window.electronAPI.openExternal(href);
    });
}

let mdFileName: string | null = null;
let mdHeadings: HTMLElement[] = [];
let mdScrollHandler: (() => void) | null = null;

export function initMdBreadcrumb(fileName: string, scroller: HTMLElement) {
    mdFileName = fileName;
    if (mdScrollHandler) {
        scroller.removeEventListener('scroll', mdScrollHandler);
        mdScrollHandler = null;
    }
    mdHeadings = Array.from(scroller.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6'));
    syncMdBreadcrumb();
    mdScrollHandler = syncMdBreadcrumb;
    scroller.addEventListener('scroll', mdScrollHandler, { passive: true });
}

function headingLevel(el: HTMLElement): number {
    return parseInt(el.tagName.charAt(1), 10);
}

function headingPath(idx: number): string[] {
    const path: string[] = [];
    let minLevel = headingLevel(mdHeadings[idx]);
    for (let i = idx - 1; i >= 0; i--) {
        const level = headingLevel(mdHeadings[i]);
        if (level < minLevel) {
            path.unshift(mdHeadings[i].textContent?.trim() || '(untitled)');
            minLevel = level;
        }
    }
    path.push(mdHeadings[idx].textContent?.trim() || '(untitled)');
    return path;
}

function syncMdBreadcrumb() {
    if (!mdFileName) {
        setBreadcrumbPath(null);
        return;
    }
    let path = mdFileName;
    if (mdHeadings.length > 0 && DOM.mainContentNode) {
        const scroller = DOM.mainContentNode;
        const mid = scroller.scrollTop + (scroller.clientHeight || 1) / 2;
        let bestIdx = -1;
        for (let i = 0; i < mdHeadings.length; i++) {
            const top =
                mdHeadings[i].getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
            if (top <= mid) bestIdx = i;
            else break;
        }
        if (bestIdx >= 0) {
            path = `${mdFileName} ▸ ${headingPath(bestIdx).join(' ▸ ')}`;
        }
    }
    setBreadcrumbPath(path);
}
