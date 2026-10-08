import MarkdownIt from 'markdown-it';
import { resolveMarkdownMedia } from './media.js';
export { clearMdBreadcrumb, initMdBreadcrumb } from './breadcrumb.js';

type MathEngine = typeof import('katex').default;
type MarkdownRenderer = InstanceType<typeof MarkdownIt>;
type TexmathPlugin = Parameters<MarkdownRenderer['use']>[0];

const markdownOptions = { html: true, linkify: true, typographer: true };
const MATH_MACROS = { '\\Z': '\\mathbb{Z}' };

function createMarkdownRenderer(mathEngine?: MathEngine, texmathPlugin?: TexmathPlugin): MarkdownRenderer {
    const renderer = new MarkdownIt(markdownOptions);
    if (mathEngine && texmathPlugin) {
        renderer.use(texmathPlugin, {
            engine: mathEngine,
            delimiters: 'dollars',
            katexOptions: { macros: MATH_MACROS },
        });
    }

    const defaultFence =
        renderer.renderer.rules.fence ||
        function (tokens, idx, options, _env, slf) {
            return slf.renderToken(tokens, idx, options);
        };
    renderer.renderer.rules.fence = (tokens, idx, options, _env, slf) => {
        const token = tokens[idx];
        const lang = token.info.trim().toLowerCase();
        if (mathEngine && (lang === 'latex' || lang === 'math')) {
            try {
                const math = mathEngine.renderToString(token.content.trim(), {
                    displayMode: true,
                    throwOnError: false,
                    macros: MATH_MACROS,
                });
                return `<div class="my-4 overflow-x-auto flex justify-center">${math}</div>`;
            } catch (error) {
                console.error('KaTeX fence rendering error:', error);
            }
        }
        return defaultFence(tokens, idx, options, _env, slf);
    };
    return renderer;
}

const basicMarkdown = createMarkdownRenderer();
let mathMarkdown: MarkdownRenderer | null = null;
let mathMarkdownPromise: Promise<MarkdownRenderer> | null = null;

async function loadMathMarkdown(): Promise<MarkdownRenderer> {
    if (!mathMarkdownPromise) {
        mathMarkdownPromise = Promise.all([
            import('katex'),
            import('markdown-it-texmath'),
            import('katex/dist/katex.min.css'),
        ])
            .then(([mathModule, texmathModule]) => {
                const texmathPlugin = (texmathModule as unknown as { default: TexmathPlugin }).default;
                mathMarkdown = createMarkdownRenderer(mathModule.default, texmathPlugin);
                return mathMarkdown;
            })
            .catch((error: unknown) => {
                mathMarkdownPromise = null;
                throw error;
            });
    }
    return mathMarkdownPromise;
}

export async function renderMarkdownWithCallouts(rawMarkdown: string, filePath = ''): Promise<string> {
    const hasMath = /\$[^\n$]+\$|\$\$[\s\S]+?\$\$|^\s*`{3,}\s*(?:latex|math)\s*$/im.test(rawMarkdown);
    const md = hasMath ? await loadMathMarkdown() : basicMarkdown;
    const processedMd = rawMarkdown.replace(
        /^>\s*"?\s*\[!(NOTE|WARNING|TIP|IMPORTANT|CAUTION)\]\s*"?\s*([\s\S]*?)(?=\n\s*\n|$)/gm,
        (_, type: string, content: string) => {
            const colors: Record<string, string> = {
                NOTE: 'border-blue-500 bg-blue-950/40 text-blue-200',
                WARNING: 'border-yellow-500 bg-yellow-950/40 text-yellow-200',
                TIP: 'border-emerald-500 bg-emerald-950/40 text-emerald-200',
                IMPORTANT: 'border-purple-500 bg-purple-950/40 text-purple-200',
                CAUTION: 'border-red-500 bg-red-950/40 text-red-200',
            };
            let cleanContent = content.replace(/^>\s*/gm, '').trim();
            if (cleanContent.startsWith('"')) cleanContent = cleanContent.slice(1);
            if (cleanContent.endsWith('"')) cleanContent = cleanContent.slice(0, -1);
            const rendered = md.renderInline(cleanContent.trim());
            return `<div class="border-l-4 p-4 my-4 rounded-r ${colors[type] || colors.NOTE}"><p class="font-bold uppercase text-xs tracking-wider mb-1">${type}</p><p class="m-0">${rendered}</p></div>`;
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
