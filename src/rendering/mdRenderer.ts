import MarkdownIt from 'markdown-it';
import texmath from 'markdown-it-texmath';
import katex from 'katex';
import { DOM } from '../ui.js';

export const md = new MarkdownIt({
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

export function renderMarkdownWithCallouts(rawMarkdown: string): string {
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