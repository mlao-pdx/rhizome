/**
 * Minimal lightweight DOM node & Obsidian `createEl` / `createDiv` / `createSpan` stand-ins
 * for Node-based Vitest unit tests (`environment: 'node'`). Zero external dependencies.
 */

export interface MockDomElementOptions {
	cls?: string | string[];
	text?: string;
	attr?: Record<string, string | number | boolean | null>;
}

export class MockTextNode {
	readonly nodeType = 3;
	parentElement: MockElement | null = null;
	private value: string;

	constructor(text: string) {
		this.value = text;
	}

	get textContent(): string {
		return this.value;
	}

	set textContent(next: string) {
		this.value = next;
	}
}

export type MockChildNode = MockElement | MockTextNode;

export class MockClassList {
	private readonly set = new Set<string>();

	constructor(initial: string = '') {
		this.setFromString(initial);
	}

	setFromString(raw: string): void {
		this.set.clear();
		for (const part of raw.split(/\s+/)) {
			if (part.length > 0) {
				this.set.add(part);
			}
		}
	}

	toString(): string {
		return [...this.set].join(' ');
	}

	add(...tokens: string[]): void {
		for (const tok of tokens) {
			for (const part of tok.split(/\s+/)) {
				if (part.length > 0) {
					this.set.add(part);
				}
			}
		}
	}

	remove(...tokens: string[]): void {
		for (const tok of tokens) {
			this.set.delete(tok);
		}
	}

	contains(token: string): boolean {
		return this.set.has(token);
	}

	toggle(token: string, force?: boolean): boolean {
		const shouldHave = force ?? !this.set.has(token);
		if (shouldHave) {
			this.set.add(token);
		} else {
			this.set.delete(token);
		}
		return shouldHave;
	}
}

function matchesSimpleSelector(el: MockElement, selector: string): boolean {
	for (const rawBranch of selector.split(',')) {
		const branch = rawBranch.trim();
		if (branch.length === 0) {
			continue;
		}
		let rem = branch;
		let matched = true;

		const tagMatch = /^[a-zA-Z][a-zA-Z0-9-]*/.exec(rem);
		if (tagMatch) {
			if (el.tagName !== tagMatch[0].toUpperCase()) {
				matched = false;
			}
			rem = rem.slice(tagMatch[0].length);
		}

		while (matched && rem.length > 0) {
			if (rem.startsWith('.')) {
				const clsMatch = /^\.([a-zA-Z0-9_-]+)/.exec(rem);
				if (!clsMatch) {
					matched = false;
					break;
				}
				if (!el.classList.contains(clsMatch[1]!)) {
					matched = false;
					break;
				}
				rem = rem.slice(clsMatch[0].length);
			} else if (rem.startsWith('[')) {
				const attrMatch = /^\[([a-zA-Z0-9_-]+)(?:="([^"]*)")?\]/.exec(rem);
				if (!attrMatch) {
					matched = false;
					break;
				}
				const val = el.getAttribute(attrMatch[1]!);
				if (val === null || (attrMatch[2] !== undefined && val !== attrMatch[2])) {
					matched = false;
					break;
				}
				rem = rem.slice(attrMatch[0].length);
			} else {
				matched = false;
				break;
			}
		}

		if (matched) {
			return true;
		}
	}
	return false;
}

export class MockElement {
	readonly nodeType = 1;
	readonly tagName: string;
	readonly classList = new MockClassList();
	readonly childNodes: MockChildNode[] = [];
	parentElement: MockElement | null = null;
	private readonly attrs = new Map<string, string>();
	private readonly listeners = new Map<string, Set<(evt: unknown) => void>>();

	constructor(tag: string, options?: MockDomElementOptions | string) {
		this.tagName = tag.toUpperCase();
		if (typeof options === 'string') {
			this.classList.add(options);
		} else if (options) {
			if (typeof options.cls === 'string') {
				this.classList.add(options.cls);
			} else if (Array.isArray(options.cls)) {
				this.classList.add(...options.cls);
			}
			if (options.text !== undefined) {
				this.appendChild(new MockTextNode(options.text));
			}
			if (options.attr) {
				for (const [k, v] of Object.entries(options.attr)) {
					if (v !== null && v !== false) {
						this.attrs.set(k, v === true ? '' : String(v));
					}
				}
			}
		}
	}

	get className(): string {
		return this.classList.toString();
	}

	set className(next: string) {
		this.classList.setFromString(next);
	}

	get children(): MockElement[] {
		return this.childNodes.filter((n): n is MockElement => n instanceof MockElement);
	}

	get firstChild(): MockChildNode | null {
		return this.childNodes[0] ?? null;
	}

	get firstElementChild(): MockElement | null {
		return this.children[0] ?? null;
	}

	get textContent(): string {
		return this.childNodes.map((c) => c.textContent).join('');
	}

	set textContent(next: string) {
		this.empty();
		if (next.length > 0) {
			this.appendChild(new MockTextNode(next));
		}
	}

	setAttribute(name: string, value: string): void {
		if (name === 'class') {
			this.className = value;
			return;
		}
		this.attrs.set(name, value);
	}

	getAttribute(name: string): string | null {
		if (name === 'class') {
			return this.className;
		}
		return this.attrs.get(name) ?? null;
	}

	removeAttribute(name: string): void {
		this.attrs.delete(name);
	}

	appendChild<T extends MockChildNode>(node: T): T {
		if (node.parentElement) {
			node.parentElement.removeChild(node);
		}
		node.parentElement = this;
		this.childNodes.push(node);
		return node;
	}

	removeChild<T extends MockChildNode>(node: T): T {
		const idx = this.childNodes.indexOf(node);
		if (idx !== -1) {
			this.childNodes.splice(idx, 1);
			node.parentElement = null;
		}
		return node;
	}

	replaceWith(nextNode: MockChildNode): void {
		const parent = this.parentElement;
		if (!parent) {
			return;
		}
		const idx = parent.childNodes.indexOf(this);
		if (idx === -1) {
			return;
		}
		if (nextNode.parentElement) {
			nextNode.parentElement.removeChild(nextNode);
		}
		this.parentElement = null;
		nextNode.parentElement = parent;
		parent.childNodes.splice(idx, 1, nextNode);
	}

	empty(): void {
		for (const child of this.childNodes) {
			child.parentElement = null;
		}
		this.childNodes.length = 0;
	}

	createEl(tag: string, options?: MockDomElementOptions | string): MockElement {
		const el = new MockElement(tag, options);
		this.appendChild(el);
		return el;
	}

	createDiv(options?: MockDomElementOptions | string): MockElement {
		const el = new MockElement('div', options);
		this.appendChild(el);
		return el;
	}

	createSpan(options?: MockDomElementOptions | string): MockElement {
		const el = new MockElement('span', options);
		this.appendChild(el);
		return el;
	}

	closest(selector: string): MockElement | null {
		return findClosestAncestor(this, selector);
	}

	querySelectorAll(selector: string): MockElement[] {
		const matches: MockElement[] = [];
		const visit = (parent: MockElement): void => {
			for (const child of parent.children) {
				if (matchesSimpleSelector(child, selector)) {
					matches.push(child);
				}
				visit(child);
			}
		};
		visit(this);
		return matches;
	}

	querySelector(selector: string): MockElement | null {
		return this.querySelectorAll(selector)[0] ?? null;
	}

	addEventListener(type: string, cb: (evt: unknown) => void): void {
		let set = this.listeners.get(type);
		if (!set) {
			set = new Set();
			this.listeners.set(type, set);
		}
		set.add(cb);
	}

	removeEventListener(type: string, cb: (evt: unknown) => void): void {
		this.listeners.get(type)?.delete(cb);
	}

	dispatchEvent(
		type: string,
		init: Record<string, unknown> = {},
	): {
		defaultPrevented: boolean;
		propagationStopped: boolean;
	} {
		let defaultPrevented = false;
		let propagationStopped = false;
		const evt = {
			type,
			target: init.target ?? this,
			button: init.button ?? 0,
			preventDefault: () => {
				defaultPrevented = true;
			},
			stopPropagation: () => {
				propagationStopped = true;
			},
			...init,
		};
		for (const cb of [...(this.listeners.get(type) ?? [])]) {
			cb(evt);
		}
		return { defaultPrevented, propagationStopped };
	}
}

function findClosestAncestor(start: MockElement, selector: string): MockElement | null {
	let cur: MockElement | null = start;
	while (cur !== null) {
		if (matchesSimpleSelector(cur, selector)) {
			return cur;
		}
		cur = cur.parentElement;
	}
	return null;
}

export function createMockElement(
	tag: string,
	options?: MockDomElementOptions | string,
): HTMLElement {
	return new MockElement(tag, options) as unknown as HTMLElement;
}

export function createMockTextNode(text: string): Node {
	return new MockTextNode(text) as unknown as Node;
}

export function installGlobalObsidianDomHelpers(): void {
	const g = window as unknown as Record<string, unknown>;
	if (typeof g.createEl !== 'function') {
		g.createEl = (tag: string, options?: MockDomElementOptions | string) =>
			createMockElement(tag, options);
	}
	if (typeof g.createDiv !== 'function') {
		g.createDiv = (options?: MockDomElementOptions | string) =>
			createMockElement('div', options);
	}
	if (typeof g.createSpan !== 'function') {
		g.createSpan = (options?: MockDomElementOptions | string) =>
			createMockElement('span', options);
	}
}
