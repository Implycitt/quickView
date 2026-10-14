declare module '*.css';
declare module '*?url' {
    const url: string;
    export default url;
}
declare module '*.html?raw' {
    const content: string;
    export default content;
}
declare module 'markdown-it-texmath';
