import { DOM, toggleSidebar } from '../ui.js';
import type { FileResponse } from '../types/types.d.ts';

import {
    PdfState,
    renderAllMainPages,
    renderThumbnails,
    renderOutline,
    resetPdfState,
    setCurrentFileName,
} from './pdfRenderer.js';
import { startBackgroundIndex, indexMarkdown } from './pdfSearch.js';
import { loadPdfjs } from '../pdfjs.js';

function attachImageFallbacks(root: HTMLElement) {
    root.querySelectorAll('img').forEach((img) => {
        const replaceWithPlaceholder = () => {
            const src = img.getAttribute('src') || '';
            const name = decodeURIComponent(src.split('/').pop() || 'image');
            const alt = img.getAttribute('alt') || name;

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

        if (img.complete) {
            if (img.naturalWidth === 0) replaceWithPlaceholder();
        } else {
            img.addEventListener('error', replaceWithPlaceholder, { once: true });
        }
    });
}

let openToken = 0;
let activeLoad: any = null;
let displayedName: string | null = null;

export async function renderFileContent(content: FileResponse) {
    const token = ++openToken;
    const stale = () => token !== openToken;
    const fileName = content.name.toLowerCase();
    const reopening = content.name === displayedName;

    if (fileName.endsWith('.md')) {
        const scrollTop = DOM.mainContentNode.scrollTop;
        const { renderMarkdownWithCallouts, initMdBreadcrumb, attachMarkdownLinks } = await import('./mdRenderer.js');
        if (stale()) return;
        resetPdfState(reopening);
        displayedName = content.name;
        if (DOM.pdfTools) DOM.pdfTools.classList.add('hidden');

        const htmlContent = renderMarkdownWithCallouts(content.content || '', content.path || '');
        setCurrentFileName(content.name);
        toggleSidebar('closed');
        if (DOM.sidebarTabs) DOM.sidebarTabs.classList.add('hidden');
        DOM.sidebarPreviews.innerHTML = '';
        DOM.sidebarSections.innerHTML = '';

        DOM.mainContentNode.className =
            'flex-1 overflow-y-auto flex justify-center bg-gray-900 pt-8 px-8 pb-20 transition-colors duration-300';
        DOM.mainContentNode.innerHTML = `
            <div class="w-full max-w-4xl mx-auto self-start">
                <div class="bg-gray-800 p-8 md:p-12 rounded-xl shadow-lg border border-gray-700">
                    <article class="prose prose-slate prose-invert prose-a:text-lavender-400 max-w-none">
                        ${htmlContent}
                    </article>
                </div>
            </div>
        `;
        attachImageFallbacks(DOM.mainContentNode);
        const article = DOM.mainContentNode.querySelector('article');
        if (article) attachMarkdownLinks(article as HTMLElement);
        initMdBreadcrumb(content.name, DOM.mainContentNode);
        indexMarkdown(DOM.mainContentNode);
        DOM.mainContentNode.scrollTop = reopening ? scrollTop : 0;
    } else if (fileName.endsWith('.pdf')) {
        const superseded = activeLoad;
        resetPdfState(reopening);
        if (DOM.pdfTools) DOM.pdfTools.classList.remove('hidden');
        if (DOM.sidebarTabs) DOM.sidebarTabs.classList.remove('hidden');
        toggleSidebar('open');

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
            const uint8Array = new Uint8Array(content.data);
            const pdfjsLib = await loadPdfjs();
            if (stale()) return;
            loadingTask = pdfjsLib.getDocument({ data: uint8Array });
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
            displayedName = content.name;
            setCurrentFileName(content.name);

            PdfState.zoomMode = 'auto';

            await renderAllMainPages();
            if (abandonIfStale()) return;
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
            console.error('Error rendering PDF:', error);
            resetPdfState();
            DOM.mainContentNode.innerHTML = `<div class="p-8 text-red-500 flex justify-center">Failed to load PDF document.</div>`;
        }
    }
}
