import { DOM, toggleSidebar } from '../ui.js';
import type { FileResponse } from '../types/types.d.ts';

import {
    PdfState,
    renderAllMainPages,
    renderThumbnails,
    renderOutline,
    resetPdfState,
    setCurrentFileName,
    setPdfZoom,
    applyPdfViewerSettings,
    restorePdfPosition,
} from './pdfRenderer.js';
import { startBackgroundIndex, indexMarkdown, runSearch } from './pdfSearch.js';
import { loadPdfjs } from '../pdfjs.js';
import { documentIdentity } from './documentIdentity.js';
import { readViewerState } from '../viewerState.js';
import type { StoredViewerState } from '../viewerState.js';

let openToken = 0;
let activeLoad: any = null;
let displayedIdentity: string | null = null;
let currentViewerIdentity: string | null = null;
let currentViewerState: StoredViewerState | null = null;

const MAIN_CONTENT_BASE_CLASSES = [
    'flex-1',
    'overflow-y-auto',
    'flex',
    'justify-center',
    'transition-colors',
    'duration-300',
    'bg-gray-900',
    'relative',
    '[&::-webkit-scrollbar]:hidden',
    '[-ms-overflow-style:none]',
    'scrollbar-none',
];

function setMainContentMode(isMarkdown: boolean) {
    DOM.mainContentNode.classList.add(...MAIN_CONTENT_BASE_CLASSES);
    DOM.mainContentNode.classList.toggle('pt-8', isMarkdown);
    DOM.mainContentNode.classList.toggle('px-8', isMarkdown);
    DOM.mainContentNode.classList.toggle('pb-20', isMarkdown);
}

export function setFileViewerState(documentId: string, state: StoredViewerState | null) {
    currentViewerIdentity = documentId;
    currentViewerState = state;
}

function mediaResourceKey(element: Element): string | null {
    const tag = element.tagName.toLowerCase();
    const attributes: Record<string, string[]> = {
        img: ['src', 'srcset', 'sizes', 'crossorigin', 'referrerpolicy'],
        iframe: ['src', 'srcdoc', 'sandbox', 'allow', 'allowfullscreen', 'credentialless', 'referrerpolicy'],
        source: ['src', 'srcset', 'sizes', 'type', 'media'],
        track: ['src', 'kind', 'srclang', 'label'],
        embed: ['src', 'type'],
        object: ['data', 'type', 'codebase', 'classid'],
        image: ['href', 'xlink:href'],
    };

    if (tag === 'audio' || tag === 'video') {
        const sources = Array.from(element.children)
            .filter((child) => child.tagName.toLowerCase() === 'source')
            .map(mediaResourceKey)
            .sort();
        return `${tag}:${JSON.stringify([element.getAttribute('src'), element.getAttribute('poster'), element.getAttribute('crossorigin'), sources])}`;
    }

    if (tag === 'object') {
        const params = Array.from(element.querySelectorAll('param')).map((param) => [
            param.getAttribute('name'),
            param.getAttribute('value'),
        ]);
        return `${tag}:${JSON.stringify([...(attributes[tag] ?? []).map((name) => element.getAttribute(name)), params])}`;
    }

    const names = attributes[tag];
    return names ? `${tag}:${JSON.stringify(names.map((name) => element.getAttribute(name)))}` : null;
}

function mediaTreeKey(element: Element, cache: WeakMap<Node, string | null>): string | null {
    if (cache.has(element)) return cache.get(element) ?? null;

    const ownKey = mediaResourceKey(element);
    if (ownKey) {
        cache.set(element, ownKey);
        return ownKey;
    }

    const descendants = Array.from(element.children).flatMap((child) => {
        const childKey = mediaTreeKey(child, cache);
        return childKey ? [`${child.tagName.toLowerCase()}:${childKey}`] : [];
    });
    descendants.sort();
    const key =
        descendants.length > 0 ? `contains:${element.tagName.toLowerCase()}:${JSON.stringify(descendants)}` : null;
    cache.set(element, key);
    return key;
}

function stableNodeKey(node: Node, cache: WeakMap<Node, string | null>): string | null {
    if (cache.has(node)) return cache.get(node) ?? null;
    if (!(node instanceof Element)) {
        cache.set(node, null);
        return null;
    }

    const key = node.id ? `id:${node.tagName.toLowerCase()}:${node.id}` : mediaTreeKey(node, cache);
    cache.set(node, key);
    return key;
}

function sameNodeShape(current: Node, target: Node): boolean {
    if (current.nodeType !== target.nodeType) return false;
    if (current instanceof Element && target instanceof Element) {
        return current.localName === target.localName && current.namespaceURI === target.namespaceURI;
    }
    return true;
}

function canMorphNode(
    current: Node,
    target: Node,
    currentKeys: WeakMap<Node, string | null>,
    targetKeys: WeakMap<Node, string | null>,
): boolean {
    if (!sameNodeShape(current, target)) return false;

    const currentKey = stableNodeKey(current, currentKeys);
    const targetKey = stableNodeKey(target, targetKeys);
    return currentKey === null && targetKey === null ? true : currentKey === targetKey;
}

function morphAttributes(current: Element, target: Element) {
    for (const attribute of Array.from(current.attributes)) {
        if (!target.hasAttribute(attribute.name)) current.removeAttribute(attribute.name);
    }
    for (const attribute of Array.from(target.attributes)) {
        if (current.getAttribute(attribute.name) !== attribute.value) {
            current.setAttribute(attribute.name, attribute.value);
        }
    }
}

function morphChildren(currentParent: Node, targetParent: Node) {
    const desiredChildren = Array.from(targetParent.childNodes);
    const currentKeys = new WeakMap<Node, string | null>();
    const targetKeys = new WeakMap<Node, string | null>();
    const desiredKeys = desiredChildren.map((child) => stableNodeKey(child, targetKeys));
    let current = currentParent.firstChild;

    const neededLater = (node: Node, targetIndex: number) => {
        const key = stableNodeKey(node, currentKeys);
        if (key === null) return false;
        return desiredKeys.slice(targetIndex + 1).includes(key);
    };

    let targetIndex = 0;
    while (targetIndex < desiredChildren.length) {
        const target = desiredChildren[targetIndex];
        const targetKey = desiredKeys[targetIndex];
        let match: Node | null = null;

        if (targetKey !== null) {
            for (let candidate = current; candidate; candidate = candidate.nextSibling) {
                if (
                    stableNodeKey(candidate, currentKeys) === targetKey &&
                    canMorphNode(candidate, target, currentKeys, targetKeys)
                ) {
                    match = candidate;
                    break;
                }
            }
        }

        if (match) {
            while (current && current !== match) {
                const next = current.nextSibling;
                if (neededLater(current, targetIndex)) {
                    currentParent.insertBefore(match, current);
                    break;
                }
                currentParent.removeChild(current);
                current = next;
            }
            morphNode(match, target);
            current = match.nextSibling;
            targetIndex++;
            continue;
        }

        if (current && neededLater(current, targetIndex)) {
            currentParent.insertBefore(target.cloneNode(true), current);
            targetIndex++;
            continue;
        }

        if (current && sameNodeShape(current, target)) {
            const next = current.nextSibling;
            morphNode(current, target);
            current = next;
            targetIndex++;
            continue;
        }

        if (current) {
            const next = current.nextSibling;
            currentParent.removeChild(current);
            current = next;
            continue;
        }

        currentParent.appendChild(target.cloneNode(true));
        targetIndex++;
    }

    while (current) {
        const next = current.nextSibling;
        currentParent.removeChild(current);
        current = next;
    }
}

function morphNode(current: Node, target: Node) {
    if (current.nodeType === Node.TEXT_NODE || current.nodeType === Node.COMMENT_NODE) {
        if (current.nodeValue !== target.nodeValue) current.nodeValue = target.nodeValue;
        return;
    }

    if (current instanceof Element && target instanceof Element) {
        morphAttributes(current, target);
        morphChildren(current, target);
    }
}

function updateMarkdownArticle(article: HTMLElement, html: string) {
    const template = document.createElement('template');
    template.innerHTML = html;
    morphChildren(article, template.content);
}

const imageFallbackListeners = new WeakMap<HTMLImageElement, { sourceKey: string; listener: () => void }>();

function imageSourceKey(img: HTMLImageElement): string {
    return JSON.stringify([img.getAttribute('src'), img.getAttribute('srcset'), img.getAttribute('sizes')]);
}

function imageDisplayName(img: HTMLImageElement): string {
    try {
        const src = img.currentSrc || img.getAttribute('src') || '';
        const url = new URL(src, document.baseURI);
        const name = decodeURIComponent(url.pathname.split('/').pop() || 'image');
        return img.getAttribute('alt') || name;
    } catch {
        return img.getAttribute('alt') || img.getAttribute('src') || 'image';
    }
}

function attachImageFallbacks(root: HTMLElement) {
    root.querySelectorAll('img').forEach((img) => {
        const sourceKey = imageSourceKey(img);
        const existing = imageFallbackListeners.get(img);
        if (existing?.sourceKey === sourceKey) return;
        if (existing) img.removeEventListener('error', existing.listener);

        const replaceWithPlaceholder = () => {
            if (!img.isConnected || img.naturalWidth > 0 || imageSourceKey(img) !== sourceKey) return;
            const alt = imageDisplayName(img);
            const placeholder = document.createElement('span');
            placeholder.className = 'md-img-placeholder';
            placeholder.setAttribute('role', 'img');
            placeholder.setAttribute('aria-label', `${alt} (image not found)`);

            const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            icon.setAttribute('viewBox', '0 0 24 24');
            icon.setAttribute('width', '16');
            icon.setAttribute('height', '16');
            icon.setAttribute('fill', 'none');
            icon.setAttribute('stroke', 'currentColor');
            icon.setAttribute('stroke-width', '1.8');
            icon.innerHTML =
                '<rect x="3" y="4" width="18" height="16" rx="2"></rect>' +
                '<path d="M8 10h.01M8.5 15l3-3 2.5 2.5 3-3 1.5 1.5"></path>' +
                '<path d="M4 4l16 16" stroke-linecap="round"></path>';
            const label = document.createElement('span');
            label.textContent = alt;
            const hint = document.createElement('span');
            hint.className = 'md-img-placeholder-hint';
            hint.textContent = 'not found';
            placeholder.append(icon, label, hint);
            img.replaceWith(placeholder);
        };

        // Let the browser finish resolving the URL before deciding the image failed.
        imageFallbackListeners.set(img, { sourceKey, listener: replaceWithPlaceholder });
        img.addEventListener('error', replaceWithPlaceholder, { once: true });
    });
}

export async function renderFileContent(content: FileResponse) {
    const token = ++openToken;
    const stale = () => token !== openToken;
    const fileName = content.name.toLowerCase();
    const type = fileName.endsWith('.pdf') ? 'pdf' : fileName.endsWith('.md') ? 'markdown' : null;
    const identity = type ? documentIdentity(content.path, content.name, type) : null;
    const reopening = identity !== null && identity === displayedIdentity;
    const viewerState =
        identity === currentViewerIdentity ? currentViewerState : identity ? readViewerState(identity) : null;

    if (type === 'markdown') {
        const previousScrollTop = DOM.mainContentNode.scrollTop;
        const { renderMarkdownWithCallouts, initMdBreadcrumb, attachMarkdownLinks } = await import('./mdRenderer.js');
        if (stale()) return;
        if (!reopening) resetPdfState();
        displayedIdentity = identity;
        if (DOM.pdfTools) DOM.pdfTools.classList.add('hidden');

        const html = renderMarkdownWithCallouts(content.content || '', content.path || '');
        setCurrentFileName(content.name);
        if (!reopening) toggleSidebar('closed');
        if (DOM.sidebarTabs) DOM.sidebarTabs.classList.add('hidden');
        DOM.sidebarPreviews.innerHTML = '';
        DOM.sidebarSections.innerHTML = '';
        setMainContentMode(true);
        let article = DOM.mainContentNode.querySelector('article');
        const isFirstMarkdownRender = !article;
        if (!article) {
            DOM.mainContentNode.innerHTML = `
                <div class="w-full max-w-4xl mx-auto self-start">
                    <div class="bg-gray-800 p-8 md:p-12 rounded-xl shadow-lg border border-gray-700">
                        <article class="prose prose-slate prose-invert prose-a:text-lavender-400 max-w-none"></article>
                    </div>
                </div>
            `;
            article = DOM.mainContentNode.querySelector('article');
        }
        if (!article) return;
        updateMarkdownArticle(article, html);
        attachImageFallbacks(article);
        if (isFirstMarkdownRender) attachMarkdownLinks(article);
        initMdBreadcrumb(content.name, DOM.mainContentNode);
        indexMarkdown(DOM.mainContentNode);
        const searchInput = document.getElementById('search-input') as HTMLInputElement | null;
        if (searchInput?.value) runSearch(searchInput.value);
        DOM.mainContentNode.scrollTop =
            viewerState?.documentType === 'markdown'
                ? (viewerState.markdownScrollTop ?? 0)
                : reopening
                  ? previousScrollTop
                  : 0;
        return;
    }

    if (type !== 'pdf') return;

    setMainContentMode(false);
    const superseded = activeLoad;
    resetPdfState(reopening);
    if (DOM.pdfTools) DOM.pdfTools.classList.remove('hidden');
    if (DOM.sidebarTabs) DOM.sidebarTabs.classList.remove('hidden');

    let loadingTask: any = null;
    let openedDoc: any = null;
    const abandonIfStale = () => {
        if (!stale()) return false;
        const doc = openedDoc;
        openedDoc = null;
        if (doc) {
            if (PdfState.currentPdfDoc === doc) PdfState.currentPdfDoc = null;
            void doc.destroy().catch(() => {});
        }
        return true;
    };

    try {
        const pdfjsLib = await loadPdfjs();
        if (stale()) return;
        loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(content.data) });
        activeLoad = loadingTask;
        if (superseded) void superseded.destroy().catch(() => {});
        const doc = await loadingTask.promise;
        if (stale()) {
            void loadingTask.destroy().catch(() => {});
            return;
        }

        PdfState.currentPdfDoc = doc;
        openedDoc = doc;
        activeLoad = null;
        loadingTask = null;
        displayedIdentity = identity;
        setCurrentFileName(content.name);

        const pdfState = viewerState?.documentType === 'pdf' ? viewerState : null;
        if (pdfState) {
            setPdfZoom(pdfState.location?.scale ?? 1, pdfState.zoomMode);
            applyPdfViewerSettings({
                isSnapMode: pdfState.isSnapMode,
                snapSuspended: pdfState.snapSuspended,
                sidebarFollow: pdfState.sidebarFollow,
            });
        } else if (!reopening) {
            setPdfZoom(1, 'auto');
            applyPdfViewerSettings({ isSnapMode: true, snapSuspended: false, sidebarFollow: true });
        }

        await renderAllMainPages();
        if (abandonIfStale()) return;
        if (pdfState?.location) restorePdfPosition(pdfState.location);
        await renderThumbnails();
        if (abandonIfStale()) return;
        await renderOutline();
        if (abandonIfStale()) return;
        openedDoc = null;
        startBackgroundIndex();
    } catch (error) {
        if (activeLoad === loadingTask) activeLoad = null;
        if (loadingTask) void loadingTask.destroy().catch(() => {});
        if (abandonIfStale()) return;
        displayedIdentity = identity;
        console.error('Error rendering PDF:', error);
        resetPdfState();
        DOM.mainContentNode.innerHTML =
            '<div class="p-8 text-red-500 flex justify-center">Failed to load PDF document.</div>';
    }
}
