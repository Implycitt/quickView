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

export function updateMarkdownArticle(article: HTMLElement, html: string) {
    const template = document.createElement('template');
    template.innerHTML = html;
    morphChildren(article, template.content);
}
