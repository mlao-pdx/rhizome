---
name: obsidian-plugin-patterns
description: Common Obsidian plugin code patterns (file organization, adding commands, persisting/settings-tab, vault/frontmatter, metadata events, lifecycle, secrets, destructive-action confirmation, registering listeners safely), the plugin-review guidelines checklist, and UI copy/UX guidelines for this project. Load when writing or reviewing plugin source code or user-facing strings.
---

# Obsidian plugin patterns

## Example file structure

    src/
      main.ts           # Plugin entry point, lifecycle management
      settings.ts        # Settings interface and defaults
      commands/           # Command implementations
        command1.ts
        command2.ts
      ui/                 # UI components, modals, views
        modal.ts
        view.ts
      utils/              # Utility functions, helpers
        helpers.ts
        constants.ts
      types.ts             # TypeScript interfaces and types

## Organize code across multiple files

**main.ts** (minimal, lifecycle only):

```ts
import { Plugin } from 'obsidian';
import { MySettings, DEFAULT_SETTINGS } from './settings';
import { registerCommands } from './commands';

export default class MyPlugin extends Plugin {
	settings!: MySettings;

	async onload() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			(await this.loadData()) as Partial<MySettings>,
		);
		registerCommands(this);
	}
}
```

**settings.ts**:

```ts
export interface MySettings {
	enabled: boolean;
	apiKey: string;
}

export const DEFAULT_SETTINGS: MySettings = {
	enabled: true,
	apiKey: '',
};
```

> ⚠️ `apiKey` here is a placeholder field for illustrating file structure, not
> a real secret-storage pattern — if a setting actually holds an API key or
> token, store the secret's _name_ and use `SecretStorage` instead. See
> "Store secrets" below.

**commands/index.ts**:

```ts
import { Plugin } from 'obsidian';
import { doSomething } from './my-command';

export function registerCommands(plugin: Plugin) {
	plugin.addCommand({
		id: 'do-something',
		name: 'Do something',
		callback: () => doSomething(plugin),
	});
}
```

## Add a command

```ts
this.addCommand({
	id: 'your-command-id',
	name: 'Do the thing',
	callback: () => this.doTheThing(),
});
```

## Persist settings

```ts
interface MySettings { enabled: boolean }
const DEFAULT_SETTINGS: MySettings = { enabled: true };

async onload() {
  this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData() as Partial<MySettings>);
  await this.saveData(this.settings);
}
```

## Register listeners safely

```ts
this.registerEvent(
	this.app.workspace.on('file-open', (f) => {
		/* ... */
	}),
);
this.registerDomEvent(activeWindow, 'resize', () => {
	/* ... */
});
this.registerInterval(
	window.setInterval(() => {
		/* ... */
	}, 1000),
);
```

## Vault read/write & frontmatter API

Source: `https://docs.obsidian.md/Plugins/Vault`,
`https://docs.obsidian.md/Reference/TypeScript+API/FileManager/processFrontMatter`.

```ts
// Read: cachedRead() for display-only, read() before a write-back.
const text = await vault.cachedRead(file);

// Modify: prefer process() — read+write is atomic, avoids stale overwrites.
await vault.process(file, (data) => data.replace(':)', '🙂'));

// Frontmatter: never touch it via vault.modify(). Always use the
// dedicated frontmatter API (project constraint `frontmatter_write_api_only`).
await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
	frontmatter['key1'] = value;
	delete frontmatter['key2'];
});
```

- `cachedRead()` vs `read()`: identical except when a file changed on disk from
  outside Obsidian moments before the read — `read()` always gets the latest
  bytes, `cachedRead()` may briefly lag.
- `vault.modify()` overwrites unconditionally; `vault.process()` wraps
  read+modify+write and guards against the file changing in between — prefer
  `process()` over manual `read()`/`modify()` pairs.
- `processFrontMatter()` reads, mutates, and saves frontmatter atomically via a
  synchronous callback that mutates the passed object directly; it throws
  `YAMLParseError` on malformed frontmatter — callers must handle it.
- `delete()` removes a file without a trace; `trash()` moves it to the system
  or vault `.trash` — prefer `trash()` when the user should be able to change
  their mind.

## Metadata cache & events

Source: `https://docs.obsidian.md/Plugins/Events`, `https://docs.obsidian.md/Plugins/Vault`.

```ts
this.registerEvent(
	this.app.metadataCache.on('changed', (file) => {
		/* frontmatter/links/tags for `file` were re-resolved */
	}),
);
this.registerEvent(
	this.app.metadataCache.on('resolved', () => {
		/* the initial resolve pass across the vault completed */
	}),
);
this.registerEvent(this.app.vault.on('create', (file) => {}));
this.registerEvent(this.app.vault.on('modify', (file) => {}));
this.registerEvent(this.app.vault.on('delete', (file) => {}));
this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {}));
```

- Every listener above must go through `registerEvent()` (never a bare
  `.on()`), so it is detached automatically on unload — see "Register
  listeners safely" above.
- `vault.on('create')` fires once per file during Obsidian's own vault-scan
  startup — gate any reaction on `workspace.layoutReady`, or register the
  handler inside `onLayoutReady()` (see load-time pitfalls below), or it will
  fire for every pre-existing file in the vault on cold start.
- `metadataCache.getFileCache(file)` is the synchronous read side (frontmatter,
  tags, resolved/unresolved links) that the `changed`/`resolved` events
  signal has updated — this is what a `MetadataPort` adapter wraps.

## Plugin lifecycle / load-time

Source: `https://docs.obsidian.md/plugins/guides/load-time`,
`https://docs.obsidian.md/plugins/guides/lifecycle-management`.

```ts
export default class MyPlugin extends Plugin {
	async onload() {
		// Cheap only: command/view-type registrations, no data fetching.
		this.addCommand({ id: 'x', name: 'X', callback: () => {} });

		this.app.workspace.onLayoutReady(() => {
			// Anything that reacts to vault state (e.g. vault.on('create'))
			// or does real work belongs here, deferred until after startup.
			this.registerEvent(this.app.vault.on('create', this.onCreate, this));
		});
	}
}
```

- Obsidian loads every plugin before the user can interact with the app —
  slow `onload()` directly delays app startup for the user.
- Ship a production/minified build (`main.js`); do not ship a dev build.
- Resources created during `onload()` (or later) must be cleaned up in
  `onunload()` — global/window listeners, intervals, external connections,
  third-party library instances. Anything registered through `this.register*`
  is handled automatically; anything else needs an explicit `onunload()`.
- Prefer composing plugin logic as `Component` subclasses (`addChild()`) over
  ad-hoc fields — child components unload automatically when their parent
  unloads, so ownership and teardown order stay correct without manual wiring.

## Settings tab (declarative API, Obsidian 1.13+)

Source: `https://docs.obsidian.md/Plugins/User+interface/Settings`,
`https://docs.obsidian.md/plugins/guides/migrate-declarative-settings`.
`minAppVersion` is already `1.13.0` (`manifest.json`) — always use this API,
never the legacy imperative `display()` override.

```ts
import { App, PluginSettingTab } from 'obsidian';
import MyPlugin from './main';

export class SampleSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: MyPlugin) {
		super(app, plugin);
	}

	getSettingDefinitions() {
		return [
			// General — no heading, stays at the top (style rule below).
			{ name: 'Enable feature', control: { type: 'toggle', key: 'enabled' } },
			{
				type: 'group',
				heading: 'Advanced',
				items: [
					{
						name: 'Cache size (MB)',
						control: { type: 'number', key: 'cacheMb', min: 1, max: 500 },
					},
				],
			},
		];
	}
}
```

- Register with `this.addSettingTab(new SampleSettingTab(this.app, this))`
  in `onload()`, same as before.
- A `control` definition (`key` names a property on `this.plugin.settings`)
  reads, writes, and calls `saveData()` for you — no `onChange` plumbing.
  Control types: `toggle`, `text`, `textarea`, `number`, `slider`, `dropdown`,
  `file`, `folder`, `color`. Every control accepts `defaultValue` and an
  optional `validate: (value) => string | void` (return a message to reject).
- `control`, `render`, and `action` on one definition are mutually exclusive.
  Use `render(setting)` only for side effects/custom UI beyond a simple bind
  (it does **not** auto-save — call `saveData()` yourself); use `action` for
  a clickable row (common inside `type: 'list'`).
- `visible` (hide entirely) vs `disabled` (grey out but keep legible) are
  both `boolean | () => boolean`, re-evaluated automatically after any
  `control` change. Use `visible` when the setting is irrelevant right now;
  `disabled` when it's meaningful but currently locked.
- `type: 'group'` = heading + nested items. `type: 'list'` = same, plus
  `onDelete`/`onReorder`/`emptyState`/`addItem` for user-managed rows (watched
  folders, aliases). `type: 'page'` = a navigable sub-page — use sparingly,
  only for a self-contained section too long for the parent tab.
- **`getSettingDefinitions()` must stay cheap** — it also runs once at tab
  registration to index global settings search. No I/O, no network, no heavy
  computation. Call `this.update()` when the _set_ of rows changes; call
  `this.refreshDomState()` after mutating state a `visible`/`disabled`
  predicate depends on, without a full re-render.
- Style rules (enforced in review, see below): sentence case everywhere: no
  top-level "General"/plugin-name heading; no "settings" inside heading text
  (`Advanced`, not `Advanced settings`); one control per row; save on every
  change, never on a submit button; keep `desc` to one sentence — link out or
  use a confirmation `Modal` instead of inlining a warning.

## Store secrets

Source: `https://docs.obsidian.md/plugins/guides/secret-storage`. Never store
an API key/token as a plain settings string — use `SecretStorage` so the
value lives in local storage (not `data.json`) and can be shared across
plugins instead of duplicated.

```ts
import { App, PluginSettingTab, SecretComponent, Setting } from 'obsidian';

// Settings interface stores the secret's *name*, not its value.
interface MySettings {
	apiKeySecretName: string;
}

// In a render callback (SecretComponent needs `app`, so it can't be a plain `control`):
{
	name: 'API key',
	desc: 'Select a secret from SecretStorage',
	render: (setting) =>
		setting.addComponent((el) =>
			new SecretComponent(this.app, el)
				.setValue(this.plugin.settings.apiKeySecretName)
				.onChange(async (value) => {
					this.plugin.settings.apiKeySecretName = value;
					await this.plugin.saveData(this.plugin.settings);
				}),
		),
}

// Retrieve the actual secret only when needed:
const secret = this.app.secretStorage.getSecret(this.plugin.settings.apiKeySecretName);
if (secret) {
	/* use secret */
}
```

## Confirming destructive actions

Source: `obsidian.d.ts` (`ConfirmationModal`, `ConfirmationButton`,
`ButtonComponent.setDestructive`) — new in **Obsidian 1.13.0**, superseding
the old `setWarning()` pattern. Use this any time an action deletes data or
is otherwise hard to undo (per `Settings.md`'s style guide: put the warning
in a modal with an explicit confirm step, not in a settings `desc`).

```ts
import { App, ConfirmationModal, Notice } from 'obsidian';

function confirmDelete(app: App, itemName: string, onConfirm: () => void) {
	new ConfirmationModal(app)
		.setTitle(`Delete "${itemName}"?`)
		.setContent('This cannot be undone.')
		.addButton((btn) =>
			btn
				.setButtonText('Delete')
				.setDestructive() // styles the button as destructive (replaces setWarning())
				.setInitialFocus() // only if Delete, not Cancel, should be the safe default
				.onClick(() => onConfirm()),
		)
		.addCancelButton() // dedicated dismissal button; defaults to "Cancel"
		.open();
}
```

- `ConfirmationButton` (returned by `addButton`'s callback) auto-closes the
  modal after the click handler resolves — return a truthy value from the
  handler to keep it open instead (e.g. to surface a validation error inline).
- `setInitialFocus()` marks which button is focused when the modal opens; if
  several are marked, the last one wins. Prefer focusing **Cancel**, not the
  destructive action, unless the action is genuinely the expected/safe path.
- `setSecondary()` places a button away from the primary/cancel pair — use it
  for a tertiary action, not the destructive one itself.
- On a plain `ButtonComponent` (outside a `ConfirmationModal`, e.g. a settings
  row), the same styling is `setDestructive()`/`removeDestructive()`; compose
  with `setCta()` for a destructive _primary_ action. `setWarning()` still
  exists but is deprecated in favor of `setDestructive()`.

## Plugin review guidelines (why, not just what)

Source: `https://docs.obsidian.md/plugins/releasing/plugin-guidelines` — the
actual review-comment checklist Obsidian's plugin reviewers use. Each rule
below is a correctness/security reason, not a style nitpick:

- **Never use the global `app`/`window.app`.** Always `this.app`. The global
  is for debugging only and may be removed later.
- **Never `innerHTML`/`outerHTML`/`insertAdjacentHTML` with any string that
  contains user or vault-derived data** — arbitrary script injection risk.
  Use `createEl()`/`createDiv()`/`createSpan()` (see `HTML elements`) or
  `el.empty()` to clear, never string concatenation into HTML.
- **Prefer `Vault.process()`/`FileManager.processFrontMatter()` over
  `Vault.modify()`** — not just for the frontmatter-write constraint already
  in `AGENTS.md`, but because `process()`/`processFrontMatter()` are atomic
  and avoid clobbering a concurrent write from another plugin.
- **Prefer the `Editor` API over `Vault.modify()` for the _active_ file** —
  `Vault.modify()` loses cursor position, selection, and folded state that
  `Editor` preserves; only reach for `Vault.process()` when the file being
  edited is not the one currently open.
- **No hardcoded inline styles** (`el.style.color = 'red'`) — breaks user
  themes/snippets. Use a CSS class plus Obsidian's CSS variables (see
  `CSS variables`); only define a custom variable if no existing one fits.
- **`normalizePath()`** on any user-supplied or self-constructed vault path —
  collapses slash variants, strips leading/trailing slashes, normalizes
  non-breaking spaces. Never build a path by hand and skip this.
- **Never iterate `vault.getFiles()` to find one path** — use
  `getFileByPath()`/`getFolderByPath()`/`getAbstractFileByPath()` instead;
  the former is O(n) per lookup and doesn't scale to large vaults.
- **Never read `workspace.activeLeaf` directly** — use
  `getActiveViewOfType(MarkdownView)` or `workspace.activeEditor?.editor`.
- **`const`/`let` over `var`; `async`/`await` over `.then()` chains** —
  already covered by `AGENTS.md`'s TypeScript rules, repeated here because
  it's an explicit review criterion, not just house style.
- **No default hotkeys** (`Command.hotkeys`) — reinforces this project's
  rule (see `AGENTS.md`): a default can conflict with the user's own
  bindings or another plugin's, and there is no cross-platform-safe default
  to pick. Binding is always the user's choice, made in Obsidian's own
  Hotkeys settings.
- Use `callback` for a command that always runs, `checkCallback` when it must
  conditionally hide from the palette, and `editorCallback`/
  `editorCheckCallback` when it requires an open Markdown editor — don't
  reimplement that gating inside a plain `callback`.

## UX & copy guidelines (for UI text, commands, settings)

- Prefer sentence case for headings, buttons, and titles.
- Use clear, action-oriented imperatives in step-by-step copy.
- Use **bold** to indicate literal UI labels. Prefer "select" for interactions.
- Use arrow notation for navigation: **Settings → Community plugins**.
- Keep in-app strings short, consistent, and free of jargon.
