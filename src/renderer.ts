import '../main.css'

import { DOM, toggleSidebar, updateScrollModeClasses } from './ui.js';
import type { FileResponse } from './types/types.d.ts';

import MarkdownIt from 'markdown-it';
import texmath from 'markdown-it-texmath';
import katex from 'katex';

declare global {
    interface Window {
        pdfjsLib: any;
        marked: any;
    }
}

window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

const md = new MarkdownIt({
    html: true,
    linkify: true,
    typographer: true
}).use(texmath, {
    engine: katex,
    delimiters: 'dollars',
    katexOptions: { macros: { "\\Z": "\\mathbb{Z}" } }
});

const defaultFence = md.renderer.rules.fence || function (tokens, idx, options, env, slf) {
    return slf.renderToken(tokens, idx, options);
};

md.renderer.rules.fence = (tokens, idx, options, env, slf) => {
    const token = tokens[idx];
    const lang = token.info.trim().toLowerCase();
    
    if (lang === 'latex' || lang === 'math') {
        try {
            const renderedMath = katex.renderToString(token.content.trim(), { 
                displayMode: true, 
                throwOnError: false,
                macros: { "\\Z": "\\mathbb{Z}" }
            });
            return `<div class="my-4 overflow-x-auto flex justify-center">${renderedMath}</div>`;
        } catch (e) {
            console.error("KaTeX fence rendering error:", e);
        }
    }
    return defaultFence(tokens, idx, options, env, slf);
};

export const PdfState = {
    currentPdfUrl: null as string | null,
    currentPdfDoc: null as any,
    currentScale: 1.4,
    isSnapMode: true
};

export async function renderAllMainPages() {
    if (!PdfState.currentPdfDoc) return;
    
    let scrollContainer = document.getElementById('pdf-scroll-container');
    if (!scrollContainer) {
        DOM.mainContentNode.innerHTML = `<div id="pdf-scroll-container" class="w-full h-full overflow-y-auto flex flex-col items-center py-8 [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] scrollbar-none scroll-smooth"></div>`;
        scrollContainer = document.getElementById('pdf-scroll-container');
    } else {
        scrollContainer.innerHTML = '';
    }

    const outputScale = window.devicePixelRatio || 1;

    for (let pageNum = 1; pageNum <= PdfState.currentPdfDoc.numPages; pageNum++) {
        const page = await PdfState.currentPdfDoc.getPage(pageNum);
        const viewport = page.getViewport({ scale: PdfState.currentScale });
        
        const pageContainer = document.createElement('div');
        pageContainer.id = `page-container-${pageNum}`;
        pageContainer.className = 'pdf-page-container mb-8 shadow-lg bg-white shrink-0 snap-center';
        pageContainer.style.width = `${viewport.width}px`;
        pageContainer.style.height = `${viewport.height}px`;

        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        
        if (!ctx) continue;

        canvas.width = Math.floor(viewport.width * outputScale);
        canvas.height = Math.floor(viewport.height * outputScale);
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;
        
        const transform = outputScale !== 1 
            ? [outputScale, 0, 0, outputScale, 0, 0] 
            : undefined;

        const renderContext = {
            canvasContext: ctx,
            transform: transform,
            viewport: viewport
        };
        
        await page.render(renderContext).promise;
        pageContainer.appendChild(canvas);
        
        if (scrollContainer) {
            scrollContainer.appendChild(pageContainer);
        }
    }
    
    updateScrollModeClasses(PdfState.isSnapMode);
}

async function renderThumbnails() {
    if (!PdfState.currentPdfDoc || !DOM.sidebarContent) return;
    
    DOM.sidebarContent.innerHTML = '';
    const outputScale = window.devicePixelRatio || 1;

    for (let pageNum = 1; pageNum <= PdfState.currentPdfDoc.numPages; pageNum++) {
        const page = await PdfState.currentPdfDoc.getPage(pageNum);
        
        const viewport = page.getViewport({ scale: 1.0 }); 
        
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        
        if (!ctx) continue;

        canvas.width = Math.floor(viewport.width * outputScale);
        canvas.height = Math.floor(viewport.height * outputScale);
        
        canvas.style.width = '100%';
        canvas.style.height = 'auto';
        
        canvas.className = 'mb-4 cursor-pointer border-2 border-transparent hover:border-lavender-400 transition-colors shadow-sm rounded bg-white';
        
        canvas.onclick = () => {
            const targetPage = document.getElementById(`page-container-${pageNum}`);
            if (targetPage) {
                targetPage.scrollIntoView({ behavior: 'smooth' });
            }
        };
        
        const transform = outputScale !== 1 
            ? [outputScale, 0, 0, outputScale, 0, 0] 
            : undefined;

        await page.render({ 
            canvasContext: ctx, 
            transform: transform, 
            viewport: viewport 
        }).promise;
        
        DOM.sidebarContent.appendChild(canvas);
    }
}

export async function renderFileContent(content: FileResponse) {
    const fileName = content.name.toLowerCase();
    
    if (fileName.endsWith('.md')) {
        if (DOM.pdfTools) {
            DOM.pdfTools.classList.add('hidden');
        }
        
        const htmlContent = renderMarkdownWithCallouts(content.content || '');

        toggleSidebar('closed');
        DOM.sidebarContent.innerHTML = '';

        DOM.mainContentNode.className = "flex-1 overflow-y-auto flex justify-center bg-gray-900 p-8 transition-colors duration-300";
        DOM.mainContentNode.innerHTML = `
            <div class="w-full max-w-4xl mx-auto">
                <div class="bg-gray-800 p-8 md:p-12 rounded-xl shadow-lg border border-gray-700">
                    <article class="prose prose-slate prose-invert prose-a:text-lavender-400 max-w-none">
                        ${htmlContent}
                    </article>
                </div>
            </div>
        `;
        
    } else if (fileName.endsWith('.pdf')) {
        if (DOM.pdfTools) {
            DOM.pdfTools.classList.remove('hidden');
        }
        
        try {
            const uint8Array = new Uint8Array(content.data);
            const loadingTask = window.pdfjsLib.getDocument({ data: uint8Array });
            PdfState.currentPdfDoc = await loadingTask.promise;
            
            PdfState.currentScale = 1.4;
            if (DOM.zoomLevelSpan) {
                DOM.zoomLevelSpan.innerText = `${Math.round(PdfState.currentScale * 100)}%`;
            } 

            await renderAllMainPages();
            await renderThumbnails();
            
        } catch (error) {
            console.error("Error rendering PDF:", error);
            DOM.mainContentNode.innerHTML = `<div class="p-8 text-red-500 flex justify-center">Failed to load PDF document.</div>`;
        }
    } 
}

function renderMarkdownWithCallouts(rawMarkdown: string): string {
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
        }
    );

    return md.render(processedMd);
}

export function renderMarkdownFile(content: string) {
    if (!DOM.mainContentNode) return;
    
    if (DOM.pdfTools) DOM.pdfTools.classList.add('hidden');

    DOM.mainContentNode.innerHTML = `
        <div class="max-w-4xl mx-auto p-12 prose prose-invert">
            ${renderMarkdownWithCallouts(content)}
        </div>
    `;
}