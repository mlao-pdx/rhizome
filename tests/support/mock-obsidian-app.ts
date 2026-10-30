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

export class Plugin {
	app: unknown;
	manifest: unknown;
	readonly registeredCleanups: Array<() => unknown> = [];
	readonly registeredEvents: unknown[] = [];

	constructor(app: unknown, manifest: unknown) {
		this.app = app;
		this.manifest = manifest;
	}

	addSettingTab(_settingTab: unknown): void {}

	register(callback: () => unknown): void {
		this.registeredCleanups.push(callback);
	}

	registerEvent(eventRef: unknown): void {
		this.registeredEvents.push(eventRef);
	}

	registerMarkdownCodeBlockProcessor(
		_language: string,
		_handler: (source: string, el: HTMLElement, ctx: unknown) => unknown,
	): void {}

	registerEditorExtension(_extension: unknown): void {}

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

export class Modal {
	app: unknown;
	title = '';
	isOpen = false;
	readonly paragraphs: string[] = [];
	contentEl = {
		empty: () => {
			this.paragraphs.length = 0;
		},
		createEl: (_tag: string, options?: { text?: string }) => {
			if (options?.text !== undefined) {
				this.paragraphs.push(options.text);
			}
			return {};
		},
	};

	constructor(app: unknown) {
		this.app = app;
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

export class PluginSettingTab {
	app: unknown;
	plugin: unknown;
	containerEl = {
		empty: () => {},
		createEl: (_tag: string, _options?: unknown) => ({}),
	};

	constructor(app: unknown, plugin: unknown) {
		this.app = app;
		this.plugin = plugin;
	}
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

	addText(_configure: (component: unknown) => unknown): this {
		return this;
	}

	addToggle(configure: (component: MockToggleComponent) => unknown): this {
		configure(new MockToggleComponent());
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

	setHeading(): this {
		return this;
	}
}

/** Minimal stand-in for Obsidian's `ToggleComponent`. */
export class MockToggleComponent {
	setValue(_value: boolean): this {
		return this;
	}

	onChange(_callback: (value: boolean) => unknown): this {
		return this;
	}
}

/** Minimal stand-in for Obsidian's `DropdownComponent`. */
export class MockDropdownComponent {
	readonly options: Array<{ value: string; display: string }> = [];
	value = '';
	disabled = false;
	changeHandler: ((value: string) => unknown) | undefined;

	addOption(value: string, display: string): this {
		this.options.push({ value, display });
		return this;
	}

	setValue(value: string): this {
		this.value = value;
		return this;
	}

	setDisabled(disabled: boolean): this {
		this.disabled = disabled;
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
	isWarning = false;
	clickHandler: ((evt: MouseEvent) => unknown) | undefined;

	setButtonText(text: string): this {
		this.buttonText = text;
		return this;
	}

	setCta(): this {
		this.isCta = true;
		return this;
	}

	setWarning(): this {
		this.isWarning = true;
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

export class App {}

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

/** A minimal `app` value sufficient for `RhizomePlugin`'s current `onload()` and `query()`. */
export function createMockApp(): unknown {
	const vaultEvents = createEventBus();
	const metadataEvents = createEventBus();
	return {
		vault: {
			configDir: 'mock-config',
			adapter: new FileSystemAdapter(),
			getMarkdownFiles: () => [],
			on: vaultEvents.on,
			trigger: vaultEvents.trigger,
		},
		metadataCache: {
			getFileCache: () => null,
			getFirstLinkpathDest: () => null,
			on: metadataEvents.on,
			trigger: metadataEvents.trigger,
		},
		workspace: {
			onLayoutReady: (cb: () => unknown) => {
				cb();
			},
			getLeavesOfType: () => [],
			revealLeaf: async () => {},
		},
	};
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
