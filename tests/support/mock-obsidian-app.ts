/**
 * Minimal hand-rolled stand-ins for the pieces of the `obsidian` package
 * that `src/main.ts`, `src/settings.ts`, and the logger adapter import as
 * runtime values.
 *
 * `obsidian` ships types only (`node_modules/obsidian/package.json` has
 * `"main": ""`) — there is no real implementation to load in tests. Tests
 * substitute this module for the real one via:
 *
 * `vi.mock('obsidian', () => import('../support/mock-obsidian-app'));`
 *
 * Keep this intentionally small: cover only what those files currently
 * touch (`addSettingTab`, `register`, `loadData`/`saveData`, and the
 * `PluginSettingTab`/`Setting` constructors they call, plus `Notice` and
 * `normalizePath` for the logger adapter). Grow it only as those files
 * grow — do not pre-build mock surface for unused Obsidian APIs.
 */

import { StateEffect, StateField } from '@codemirror/state';
import {
	installGlobalObsidianDomHelpers,
	MockElement,
	type MockDomElementOptions,
} from './mock-dom';

// Obsidian plugin code schedules timers through `window` and constructs DOM nodes via
// global `createEl`/`createDiv`/`createSpan`; Node-based tests have neither by default.
if (typeof window === 'undefined') {
	(global as { window?: unknown }).window = global;
}
installGlobalObsidianDomHelpers();

export class Plugin {
	app: unknown;
	manifest: unknown;
	readonly registeredCleanups: Array<() => unknown> = [];
	readonly registeredEvents: unknown[] = [];
	readonly settingTabs: unknown[] = [];
	readonly postProcessors: Array<(el: HTMLElement, ctx: unknown) => unknown> = [];
	readonly codeBlockProcessors = new Map<
		string,
		(source: string, el: HTMLElement, ctx: unknown) => unknown
	>();
	readonly editorSuggests: unknown[] = [];
	readonly commands: unknown[] = [];
	readonly editorExtensions: unknown[] = [];

	constructor(app: unknown, manifest: unknown) {
		this.app = app;
		this.manifest = manifest;
	}

	addSettingTab(settingTab: unknown): void {
		this.settingTabs.push(settingTab);
	}

	register(callback: () => unknown): void {
		this.registeredCleanups.push(callback);
	}

	registerEvent(eventRef: unknown): void {
		this.registeredEvents.push(eventRef);
	}

	registerMarkdownCodeBlockProcessor(
		language: string,
		handler: (source: string, el: HTMLElement, ctx: unknown) => unknown,
	): void {
		this.codeBlockProcessors.set(language, handler);
	}

	registerMarkdownPostProcessor(
		postProcessor: (el: HTMLElement, ctx: unknown) => unknown,
	): unknown {
		this.postProcessors.push(postProcessor);
		return postProcessor;
	}

	registerEditorSuggest(editorSuggest: unknown): void {
		this.editorSuggests.push(editorSuggest);
	}

	addCommand(command: unknown): unknown {
		this.commands.push(command);
		return command;
	}

	registerEditorExtension(extension: unknown): void {
		this.editorExtensions.push(extension);
	}

	async loadData(): Promise<unknown> {
		return undefined;
	}

	async saveData(_data: unknown): Promise<void> {}
}

export class MarkdownRenderChild {
	containerEl: unknown;
	readonly cleanups: Array<() => unknown> = [];
	readonly children: MarkdownRenderChild[] = [];
	unloaded = false;

	constructor(containerEl: unknown) {
		this.containerEl = containerEl;
	}

	register(cb: () => unknown): void {
		this.cleanups.push(cb);
	}

	addChild<T extends MarkdownRenderChild>(child: T): T {
		this.children.push(child);
		return child;
	}

	removeChild<T extends MarkdownRenderChild>(child: T): T {
		const idx = this.children.indexOf(child);
		if (idx !== -1) {
			this.children.splice(idx, 1);
		}
		child.unload();
		return child;
	}

	onunload(): void {}

	unload(): void {
		if (this.unloaded) {
			return;
		}
		this.unloaded = true;
		for (const child of [...this.children]) {
			child.unload();
		}
		this.children.length = 0;
		for (const cb of [...this.cleanups]) {
			cb();
		}
		this.cleanups.length = 0;
		this.onunload();
	}
}

export const MarkdownRenderer = {
	render: async (
		_app: unknown,
		_markdown: string,
		_el: unknown,
		_sourcePath: string,
		_component: unknown,
	): Promise<void> => {},
};

/**
 * Messages passed to `Notice` constructions, in order. Tests assert on
 * this to verify user-visible failure surfaces (e.g. the persistence
 * adapter's latched untrusted-database Notice).
 */
export const noticeMessages: string[] = [];

export class Notice {
	constructor(message?: string) {
		if (message !== undefined) {
			noticeMessages.push(message);
		}
	}
}

export const openedModals: Modal[] = [];

class ModalContentElement extends MockElement {
	private readonly ownerModal: Modal;

	constructor(ownerModal: Modal) {
		super('div');
		this.ownerModal = ownerModal;
	}

	override empty(): void {
		this.ownerModal.paragraphs.length = 0;
		super.empty();
	}

	override createEl(tag: string, options?: MockDomElementOptions | string): MockElement {
		if (options && typeof options === 'object' && options.text !== undefined) {
			this.ownerModal.paragraphs.push(options.text);
		}
		return super.createEl(tag, options);
	}
}

export class Modal {
	app: unknown;
	title = '';
	isOpen = false;
	readonly paragraphs: string[] = [];
	contentEl: ModalContentElement;

	constructor(app: unknown) {
		this.app = app;
		this.contentEl = new ModalContentElement(this);
	}

	setTitle(title: string): this {
		this.title = title;
		return this;
	}

	onOpen(): void {}

	onClose(): void {}

	open(): void {
		this.isOpen = true;
		openedModals.push(this);
		this.onOpen();
	}

	close(): void {
		this.isOpen = false;
		this.onClose();
	}
}

export class FuzzySuggestModal<T> extends Modal {
	placeholder = '';

	setPlaceholder(placeholder: string): void {
		this.placeholder = placeholder;
	}

	getItems(): T[] {
		return [];
	}

	getItemText(_item: T): string {
		return '';
	}

	renderSuggestion(_item: { item: T }, _el: HTMLElement): void {}

	onChooseItem(_item: T, _evt: MouseEvent | KeyboardEvent): void {}
}

export class PluginSettingTab {
	app: unknown;
	plugin: unknown;

	constructor(app: unknown, plugin: unknown) {
		this.app = app;
		this.plugin = plugin;
	}

	getSettingDefinitions(): unknown[] {
		return [];
	}

	update(): void {}

	getControlValue(_key: string): unknown {
		return undefined;
	}

	setControlValue(_key: string, _value: unknown): void | Promise<void> {}
}

export const createdSettings: Setting[] = [];

export class Setting {
	name = '';
	desc = '';
	readonly dropdowns: MockDropdownComponent[] = [];
	readonly buttons: MockButtonComponent[] = [];

	constructor(_containerEl: unknown) {
		createdSettings.push(this);
	}

	setName(name: string): this {
		this.name = name;
		return this;
	}

	setDesc(desc: string): this {
		this.desc = desc;
		return this;
	}

	addDropdown(configure: (component: MockDropdownComponent) => unknown): this {
		const dropdown = new MockDropdownComponent();
		this.dropdowns.push(dropdown);
		configure(dropdown);
		return this;
	}

	addButton(configure: (component: MockButtonComponent) => unknown): this {
		const button = new MockButtonComponent();
		this.buttons.push(button);
		configure(button);
		return this;
	}
}

/** Minimal stand-in for Obsidian's `DropdownComponent`. */
export class MockDropdownComponent {
	readonly options: Array<{ value: string; display: string }> = [];
	value = '';
	changeHandler: ((value: string) => unknown) | undefined;

	addOption(value: string, display: string): this {
		this.options.push({ value, display });
		return this;
	}

	setValue(value: string): this {
		this.value = value;
		return this;
	}

	onChange(callback: (value: string) => unknown): this {
		this.changeHandler = callback;
		return this;
	}
}

/** Minimal stand-in for Obsidian's `ButtonComponent`. */
export class MockButtonComponent {
	buttonText = '';
	isCta = false;
	isDestructive = false;
	clickHandler: ((evt: MouseEvent) => unknown) | undefined;

	setButtonText(text: string): this {
		this.buttonText = text;
		return this;
	}

	setCta(): this {
		this.isCta = true;
		return this;
	}

	setDestructive(): this {
		this.isDestructive = true;
		return this;
	}

	onClick(callback: (evt: MouseEvent) => unknown): this {
		this.clickHandler = callback;
		return this;
	}
}

/**
 * Minimal stand-in for Obsidian's `normalizePath`: collapses repeated
 * slashes and strips a trailing slash. Sufficient for the logger
 * adapter's path joins in tests; the real implementation additionally
 * handles Windows separators and `.`/`..` segments, which nothing here
 * exercises.
 */
export function normalizePath(path: string): string {
	return path.replace(/\/+/g, '/').replace(/\/$/, '');
}

export function getLanguage(): string {
	return 'en';
}

export const Platform = {
	isDesktop: true,
	isMobile: false,
	isDesktopApp: true,
	isMobileApp: false,
	isIosApp: false,
	isAndroidApp: false,
	isPhone: false,
	isTablet: false,
	isMacOS: true,
	isWin: false,
	isLinux: false,
	isSafari: false,
	resourcePathPrefix: 'app://local/',
};

export class App {}

export function setTooltip(el: HTMLElement, tooltip: string): void {
	if (el && typeof el.setAttribute === 'function') {
		el.setAttribute('data-tooltip', tooltip);
	}
}

export class EditorSuggest<T> {
	app: unknown;
	context: {
		editor: unknown;
		file: unknown;
		start: { line: number; ch: number };
		end: { line: number; ch: number };
		query: string;
	} | null = null;
	limit = 20;
	isOpen = false;

	constructor(app: unknown) {
		this.app = app;
	}

	open(): void {
		this.isOpen = true;
	}

	close(): void {
		this.isOpen = false;
	}

	onTrigger(_cursor: unknown, _editor: unknown, _file: unknown): unknown {
		return null;
	}

	getSuggestions(_context: unknown): T[] | Promise<T[]> {
		return [];
	}

	renderSuggestion(_value: T, _el: HTMLElement): void {}

	selectSuggestion(_value: T, _evt: MouseEvent | KeyboardEvent): void {}
}

/**
 * Helper effect allowing CodeMirror 6 tests to toggle `editorLivePreviewField` dynamically.
 */
export const setMockLivePreviewEffect = StateEffect.define<boolean>();

/**
 * Stand-in for Obsidian's `editorLivePreviewField` (`StateField<boolean>`).
 */
export const editorLivePreviewField = StateField.define<boolean>({
	create: () => false,
	update(value, tr) {
		for (const eff of tr.effects) {
			if (eff.is(setMockLivePreviewEffect)) {
				return eff.value;
			}
		}
		return value;
	},
});

/**
 * Helper effect allowing CodeMirror 6 tests to update `editorInfoField` dynamically.
 */
export const setMockEditorInfoEffect = StateEffect.define<{ file: TFile | null }>();

/**
 * Stand-in for Obsidian's `editorInfoField` state field (`StateField<{ file: TFile | null }>`),
 * usable both in real `EditorState` instances and via reference equality in fake `state.field()` mocks.
 */
export const editorInfoField = StateField.define<{ file: TFile | null }>({
	create: () => ({ file: null }),
	update(value, tr) {
		for (const eff of tr.effects) {
			if (eff.is(setMockEditorInfoEffect)) {
				return eff.value;
			}
		}
		return value;
	},
});

export class TAbstractFile {
	path = '';
}

export class TFolder extends TAbstractFile {
	name = '';
	children: TAbstractFile[] = [];
}

export class TFile extends TAbstractFile {
	name = '';
	basename = '';
	extension = '';
	parent: { path: string } | null = null;
	stat = { ctime: 0, mtime: 0, size: 0 };
	deleted?: boolean;
}

export class MarkdownView {
	file: TFile | null = null;
	editor: {
		setCursor?: (pos: { line: number; ch: number }) => void;
		getCursor?: (pos?: string) => { line: number; ch: number };
		replaceSelection?: (text: string) => void;
	} = {};
}

/**
 * Minimal stand-in for Obsidian's `FileSystemAdapter`. `RhizomePlugin` is
 * desktop-only, so `onload()` narrows `vault.adapter` to this class via
 * `instanceof` and reads the vault root from it.
 */
export class FileSystemAdapter {
	getBasePath(): string {
		return '/mock/vault';
	}

	getFullPath(normalizedPath: string): string {
		return normalizedPath === '' ? '/mock/vault' : `/mock/vault/${normalizedPath}`;
	}

	async read(_normalizedPath: string): Promise<string> {
		throw new Error('File not found');
	}
}

function createEventBus() {
	const listeners = new Map<string, Array<(...args: unknown[]) => unknown>>();
	return {
		on: (event: string, callback: (...args: unknown[]) => unknown) => {
			let list = listeners.get(event);
			if (!list) {
				list = [];
				listeners.set(event, list);
			}
			list.push(callback);
			return { event, callback };
		},
		trigger: (event: string, ...args: unknown[]) => {
			for (const cb of listeners.get(event) ?? []) {
				cb(...args);
			}
		},
	};
}

export interface MockAppOptions {
	/** All vault files (`vault.getFiles()`), including non-Markdown files. */
	files?: unknown[];
	/** Markdown files (`vault.getMarkdownFiles()`); defaults to `files` whose path ends in `.md`. */
	markdownFiles?: unknown[];
	/** Inverse-link metadata keyed by source path then target path. */
	resolvedLinks?: Record<string, Record<string, number>>;
	/** Per-path metadata cache entries returned by `getFileCache`/`getCache`. */
	fileCache?: Map<string, unknown> | Record<string, unknown>;
	/** Optional `getFileCache` override, taking precedence over `fileCache`. */
	getFileCache?: (file: { path?: string }) => unknown;
}

function lookupFileCache(
	fileCache: MockAppOptions['fileCache'],
	path: string | undefined,
): unknown {
	if (!path) return null;
	if (fileCache instanceof Map) {
		return fileCache.get(path) ?? null;
	}
	if (fileCache && Object.prototype.hasOwnProperty.call(fileCache, path)) {
		return fileCache[path] ?? null;
	}
	return null;
}

/** A minimal `app` value sufficient for `RhizomePlugin`'s current `onload()` and `query()`. */
export function createMockApp(options: MockAppOptions = {}): unknown {
	const vaultEvents = createEventBus();
	const metadataEvents = createEventBus();
	const files = options.files ?? [];
	const markdownFiles =
		options.markdownFiles ??
		files.filter((file) => {
			const path = (file as { path?: unknown }).path;
			return typeof path === 'string' && path.toLowerCase().endsWith('.md');
		});
	const metadataCache = {
		resolvedLinks: options.resolvedLinks ?? {},
		getFileCache: (file: { path?: string }): unknown =>
			options.getFileCache
				? options.getFileCache(file)
				: lookupFileCache(options.fileCache, file?.path),
		getCache: (path: string): unknown => metadataCache.getFileCache({ path }),
		getFirstLinkpathDest: () => null,
		on: metadataEvents.on,
		trigger: metadataEvents.trigger,
	};
	return {
		loadLocalStorage: () => 'en',
		fileManager: {
			getNewFileParent: () => ({ path: '' }),
		},
		vault: {
			configDir: 'mock-config',
			adapter: new FileSystemAdapter(),
			getName: () => 'MockVault',
			getFiles: () => files,
			getMarkdownFiles: () => markdownFiles,
			getFileByPath: (path: string) =>
				files.find((file) => (file as { path?: string }).path === path) ?? null,
			getAbstractFileByPath: (path: string) =>
				files.find((file) => (file as { path?: string }).path === path) ?? null,
			on: vaultEvents.on,
			trigger: vaultEvents.trigger,
		},
		metadataCache,
		workspace: {
			onLayoutReady: (cb: () => unknown) => {
				cb();
			},
			getLeavesOfType: () => [],
			revealLeaf: async () => {},
		},
	};
}

/** Minimal YAML serializer stand-in for `stringifyYaml` imported from `'obsidian'`. */
export function stringifyYaml(value: unknown): string {
	const formatScalar = (v: unknown): string => {
		if (v === null || v === undefined) return 'null';
		if (typeof v === 'boolean' || typeof v === 'number') return String(v);
		if (typeof v === 'string') return JSON.stringify(v);
		return JSON.stringify(v);
	};
	const renderNode = (node: unknown, indent: string): string[] => {
		if (Array.isArray(node)) {
			if (node.length === 0) return [`${indent}[]`];
			return node.flatMap((item) => {
				if (item && typeof item === 'object' && !Array.isArray(item)) {
					const sub = renderNode(item, `${indent}  `);
					return sub.map((l, idx) => (idx === 0 ? `${indent}- ${l.trimStart()}` : l));
				}
				return [`${indent}- ${formatScalar(item)}`];
			});
		}
		if (node && typeof node === 'object') {
			const keys = Object.keys(node);
			if (keys.length === 0) return [`${indent}{}`];
			const out: string[] = [];
			for (const k of keys) {
				const child = (node as Record<string, unknown>)[k];
				if (Array.isArray(child)) {
					if (child.length === 0) {
						out.push(`${indent}${k}: []`);
					} else {
						out.push(`${indent}${k}:`);
						out.push(...renderNode(child, `${indent}  `));
					}
				} else if (child && typeof child === 'object') {
					out.push(`${indent}${k}:`);
					out.push(...renderNode(child, `${indent}  `));
				} else {
					out.push(`${indent}${k}: ${formatScalar(child)}`);
				}
			}
			return out;
		}
		return [`${indent}${formatScalar(node)}`];
	};
	return `${renderNode(value, '').join('\n')}\n`;
}

/** A minimal `manifest` value sufficient to construct `RhizomePlugin`. */
export function createMockManifest(): unknown {
	return {
		id: 'rhizome',
		name: 'Rhizome',
		version: '0.0.0-test',
		minAppVersion: '0.0.0',
		author: 'test',
		description: 'Test manifest for smoke tests.',
	};
}
