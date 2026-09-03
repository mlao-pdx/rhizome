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

	constructor(app: unknown, manifest: unknown) {
		this.app = app;
		this.manifest = manifest;
	}

	addSettingTab(_settingTab: unknown): void {}

	register(callback: () => unknown): void {
		this.registeredCleanups.push(callback);
	}

	async loadData(): Promise<unknown> {
		return undefined;
	}

	async saveData(_data: unknown): Promise<void> {}
}

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

export class Setting {
	constructor(_containerEl: unknown) {}

	setName(_name: string): this {
		return this;
	}

	setDesc(_desc: string): this {
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
		configure(new MockDropdownComponent());
		return this;
	}

	addButton(configure: (component: MockButtonComponent) => unknown): this {
		configure(new MockButtonComponent());
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
	addOption(_value: string, _display: string): this {
		return this;
	}

	setValue(_value: string): this {
		return this;
	}

	setDisabled(_disabled: boolean): this {
		return this;
	}

	onChange(_callback: (value: string) => unknown): this {
		return this;
	}
}

/** Minimal stand-in for Obsidian's `ButtonComponent`. */
export class MockButtonComponent {
	setButtonText(_text: string): this {
		return this;
	}

	setWarning(): this {
		return this;
	}

	onClick(_callback: (evt: MouseEvent) => unknown): this {
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
 * Minimal stand-in for Obsidian's `FileSystemAdapter`. `MyPlugin` is
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
}

/** A minimal `app` value sufficient for `MyPlugin`'s current `onload()`. */
export function createMockApp(): unknown {
	return {
		vault: {
			adapter: new FileSystemAdapter(),
		},
	};
}

/** A minimal `manifest` value sufficient to construct `MyPlugin`. */
export function createMockManifest(): unknown {
	return {
		id: 'sample-plugin',
		name: 'Sample Plugin',
		version: '0.0.0-test',
		minAppVersion: '0.0.0',
		author: 'test',
		description: 'Test manifest for smoke tests.',
	};
}
