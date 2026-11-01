export interface SelectedPassage {
	sourceMessageId: string;
	quote: string;
	left: number;
	top: number;
}

const BLOCKS = /^(P|DIV|LI|UL|OL|PRE|BLOCKQUOTE|H[1-6]|TR)$/;

/** Copy visible prose once, and preserve formula source instead of KaTeX's
 * duplicate MathML/HTML text. Only the selected fragment is walked. */
export function quoteFragment(fragment: DocumentFragment, formulas: string[] = []): string {
	Array.from(fragment.querySelectorAll(".katex")).forEach((math, i) => {
		const tex = math.querySelector('annotation[encoding="application/x-tex"]')?.textContent || formulas[i];
		if (tex) math.replaceWith(fragment.ownerDocument.createTextNode(` $${tex}$ `));
	});
	fragment.querySelectorAll("script, style, button, .katex-mathml, [hidden], .sr-only").forEach((el) => el.remove());
	const text = (node: Node): string => {
		if (node.nodeType === 3) return node.textContent ?? "";
		if (node.nodeType === 1 && (node as Element).tagName === "BR") return "\n";
		const content = Array.from(node.childNodes).map(text).join("");
		return node.nodeType === 1 && BLOCKS.test((node as Element).tagName) ? `\n${content}\n` : content;
	};
	return text(fragment).replace(/\u00a0/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

export function selectedPassage(scope: HTMLElement, selection: Selection | null): SelectedPassage | null {
	if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return null;
	const range = selection.getRangeAt(0);
	const element = (node: Node): Element | null => node.nodeType === 1 ? node as Element : node.parentElement;
	const first = element(range.startContainer)?.closest<HTMLElement>(".lh-source-passage[data-source-message-id]");
	const last = element(range.endContainer)?.closest<HTMLElement>(".lh-source-passage[data-source-message-id]");
	if (!first || !last || !scope.contains(first) || !scope.contains(last) || first.dataset.sourceMessageId !== last.dataset.sourceMessageId) return null;
	if (element(range.startContainer)?.closest("button, input, textarea, [contenteditable=true]")) return null;
	const formula = element(range.commonAncestorContainer)?.closest(".katex");
	const formulaText = formula?.querySelector('annotation[encoding="application/x-tex"]')?.textContent;
	const root = element(range.commonAncestorContainer)!;
	const formulas = Array.from(root.querySelectorAll(".katex")).filter((m) => range.intersectsNode(m)).map((m) => m.querySelector('annotation[encoding="application/x-tex"]')?.textContent ?? "");
	const quote = formulaText ? `$${formulaText}$` : quoteFragment(range.cloneContents(), formulas);
	if (!quote) return null;
	const rect = range.getBoundingClientRect();
	return { sourceMessageId: first.dataset.sourceMessageId!, quote, left: rect.left, top: rect.top };
}
