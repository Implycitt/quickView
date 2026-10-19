import { DOM, toggleSidebar } from '../../ui/core/dom.js';
import { clearMarkdownIndex, indexMarkdown } from '../search/markdown/index.js';
import { runSearch } from '../search/controller.js';
import { resetPdfState, setCurrentFileName } from '../pdf/renderer.js';
import { insertMarkdownChunks, isLargeMarkdownDocument, updateMarkdownArticle } from './domMorph.js';
import { attachImageFallbacks } from './imageFallback.js';
import { renderMarkdownChunks, initMdBreadcrumb, attachMarkdownLinks } from './renderer.js';
import type { FileResponse } from '../../types/types.d.ts';
import type { StoredViewerState } from '../../viewer/state.js';

function setMarkdownLayout() {
    DOM.mainContentNode.classList.remove('qv-html-viewer');
    DOM.mainContentNode.classList.add('pt-8', 'px-8', 'pb-20');
}

function ensureArticle(): { article: HTMLElement; isFirstRender: boolean } | null {
    let article = DOM.mainContentNode.querySelector('article');
    if (article) return { article, isFirstRender: false };

    DOM.mainContentNode.innerHTML = `
        <div class="w-full max-w-4xl mx-auto self-start">
            <div class="qv-document-sheet bg-gray-800 p-8 md:p-12 rounded-xl">
                <article
                    class="prose prose-slate prose-invert prose-a:text-lavender-400 max-w-none qv-document-prose"
                ></article>
            </div>
        </div>
    `;
    article = DOM.mainContentNode.querySelector('article');
    return article ? { article, isFirstRender: true } : null;
}

export async function renderMarkdownDocument(
    content: FileResponse,
    viewerState: StoredViewerState | null,
    reopening: boolean,
    isStale: () => boolean,
): Promise<boolean> {
    const previousScrollTop = DOM.mainContentNode.scrollTop;
    if (isStale()) return false;

    if (!reopening) resetPdfState();
    if (DOM.pdfTools) DOM.pdfTools.classList.add('hidden');

    const chunks = await renderMarkdownChunks(content.content || '', content.path || '');
    if (isStale()) return false;
    setCurrentFileName(content.name);
    if (!reopening) toggleSidebar('closed');
    DOM.sidebarTabs?.classList.add('hidden');
    DOM.sidebarPreviews.innerHTML = '';
    DOM.sidebarSections.innerHTML = '';
    setMarkdownLayout();

    const rendered = ensureArticle();
    if (!rendered) return false;
    if (!reopening && isLargeMarkdownDocument(chunks)) {
        clearMarkdownIndex();
        if (!(await insertMarkdownChunks(rendered.article, chunks, isStale))) return false;
    } else {
        updateMarkdownArticle(rendered.article, chunks.join(''));
    }
    attachImageFallbacks(rendered.article);
    if (rendered.isFirstRender) attachMarkdownLinks(rendered.article);
    initMdBreadcrumb(content.name, DOM.mainContentNode);
    indexMarkdown(DOM.mainContentNode);

    const searchInput = document.getElementById('search-input') as HTMLInputElement | null;
    runSearch(searchInput?.value ?? '');
    DOM.mainContentNode.scrollTop =
        viewerState?.documentType === 'markdown'
            ? (viewerState.markdownScrollTop ?? 0)
            : reopening
              ? previousScrollTop
              : 0;
    return true;
}
