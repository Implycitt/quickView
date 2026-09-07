import { DOM, toggleSidebar } from '../ui.js';
import type { FileResponse } from '../types/types.d.ts';

import { renderMarkdownWithCallouts } from './mdRenderer.js';
import { PdfState, renderAllMainPages, renderThumbnails, renderOutline, resetPdfState } from './pdfRenderer.js';

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

export async function renderFileContent(content: FileResponse) {
    const fileName = content.name.toLowerCase();

    if (fileName.endsWith('.md')) {
        resetPdfState();
        if (DOM.pdfTools) DOM.pdfTools.classList.add('hidden');

        const htmlContent = renderMarkdownWithCallouts(content.content || '', content.path || '');
        toggleSidebar('closed');
        if (DOM.sidebarTabs) DOM.sidebarTabs.classList.add('hidden');
        DOM.sidebarPreviews.innerHTML = '';
        DOM.sidebarSections.innerHTML = '';

        DOM.mainContentNode.className =
            'flex-1 overflow-y-auto flex justify-center bg-gray-900 p-8 transition-colors duration-300';
        DOM.mainContentNode.innerHTML = `
            <div class="w-full max-w-4xl mx-auto">
                <div class="bg-gray-800 p-8 md:p-12 rounded-xl shadow-lg border border-gray-700">
                    <article class="prose prose-slate prose-invert prose-a:text-lavender-400 max-w-none">
                        ${htmlContent}
                    </article>
                </div>
            </div>
        `;
        attachImageFallbacks(DOM.mainContentNode);
    } else if (fileName.endsWith('.pdf')) {
        if (DOM.pdfTools) DOM.pdfTools.classList.remove('hidden');
        if (DOM.sidebarTabs) DOM.sidebarTabs.classList.remove('hidden');
        toggleSidebar('open');

        try {
            const uint8Array = new Uint8Array(content.data);
            const loadingTask = window.pdfjsLib.getDocument({ data: uint8Array });
            PdfState.currentPdfDoc = await loadingTask.promise;

            PdfState.zoomMode = 'auto';

            await renderAllMainPages();
            await renderThumbnails();
            await renderOutline();
        } catch (error) {
            console.error('Error rendering PDF:', error);
            DOM.mainContentNode.innerHTML = `<div class="p-8 text-red-500 flex justify-center">Failed to load PDF document.</div>`;
        }
    }
}
