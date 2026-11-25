import { Temporal } from '@js-temporal/polyfill';
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	createVaultLiquidFs,
	formatMomentDate,
	isStrftimeDateFormat,
	parseRhizomeTemplatePass1,
	renderParsedRhizomeTemplate,
	renderRhizomeTemplate,
	resolveTemplateFolders,
} from '../../src/core/templates';
import { assertProperty } from '../support/assertProperty';

const validQueryNameArb = fc
	.stringMatching(/^[a-zA-Z_][a-zA-Z0-9_]{0,12}$/)
	.filter(
		(name) =>
			name !== 'this' &&
			name !== 'explain' &&
			name !== 'cutoff' &&
			name !== '__proto__' &&
			name !== 'prototype' &&
			name !== 'constructor',
	);

const validExecutableQueryBodyArb = fc.constantFrom(
	'',
	'#work',
	'tag:task',
	'[status: open]',
	'path:notes',
	'file:readme',
	'#alpha OR #beta',
);

describe('LiquidJS Template Engine & {% query %} Property Invariants', () => {
	it('Single-Pass Batching & Zero-Scan Short-Circuit Invariant: N >= 1 valid queries call runQueries once; N = 0 or parse/compile errors call runQueries 0 times', async () => {
		const querySpecArb = fc.record({
			name: validQueryNameArb,
			query: validExecutableQueryBodyArb,
		});
		const uniqueQueriesArb = fc.uniqueArray(querySpecArb, {
			selector: (item) => item.name,
			minLength: 0,
			maxLength: 5,
		});

		await assertProperty(
			'templates/engine__single-pass-batching-and-zero-scan-short-circuit',
			fc.asyncProperty(uniqueQueriesArb, async (specs) => {
				let runQueriesCalls = 0;
				let capturedBatch: Readonly<Record<string, string>> = {};

				const template = specs
					.map(
						(s) =>
							`{% query ${s.name} %}${s.query}{% endquery %}\n{{ query.${s.name}.size }}`,
					)
					.join('\n');

				const res = await renderRhizomeTemplate(template, {
					runQueries: async (batch) => {
						runQueriesCalls++;
						capturedBatch = batch;
						const out: Record<string, unknown[]> = {};
						for (const s of specs) {
							out[s.name] = [{ id: s.name }];
						}
						return out;
					},
				});

				expect(res.ok).toBe(true);
				expect(res.diagnostics).toEqual([]);
				expect(res.queries).toHaveLength(specs.length);

				if (specs.length === 0) {
					expect(runQueriesCalls).toBe(0);
				} else {
					expect(runQueriesCalls).toBe(1);
					expect(Object.keys(capturedBatch).sort()).toEqual(
						specs.map((s) => s.name).sort(),
					);
				}
			}),
		);
	});

	it('Unified Error vs. Sample Fallback Contract Invariant: production short-circuits with ok: false on failed queries while rhizome-sample binds failed queries to []', async () => {
		const queryEntryArb = fc.record({
			name: validQueryNameArb,
			query: validExecutableQueryBodyArb,
			status: fc.constantFrom<'matches' | 'empty' | 'failed'>('matches', 'empty', 'failed'),
		});
		const uniqueEntriesArb = fc.uniqueArray(queryEntryArb, {
			selector: (e) => e.name,
			minLength: 1,
			maxLength: 4,
		});

		await assertProperty(
			'templates/engine__unified-error-and-sample-fallback-contract',
			fc.asyncProperty(uniqueEntriesArb, async (entries) => {
				const template = entries
					.map(
						(e) =>
							`{% query ${e.name} %}${e.status === 'failed' ? '[unclosed' : e.query}{% endquery %}\nCOUNT_${e.name}={{ query.${e.name}.size | default: -1 }}`,
					)
					.concat([
						'HOST={{ this.file.basename }}',
						'HIDDEN_HOST={{ query["◊host"] | default: "NONE" }}',
						'RANGE={{ yesterday..tomorrow }}',
						'CMP={% if today == thisyear and yesterday < today and tomorrow > today %}OK{% endif %}',
					])
					.join('\n');

				const payload: Record<string, unknown[]> = {
					'◊host': [{ file: { basename: 'HostDoc' } }],
				};
				for (const e of entries) {
					if (e.status === 'matches') {
						payload[e.name] = [{ file: { basename: 'A' } }];
					} else if (e.status === 'empty') {
						payload[e.name] = [];
					}
				}

				const anyFailed = entries.some((e) => e.status === 'failed');
				const runtimeContext = {
					referenceTimeMs: Date.UTC(2026, 9, 31, 8, 33, 0, 0),
					timeZone: 'UTC',
				};

				const prodRes = await renderRhizomeTemplate(template, {
					runQueries: async () => payload,
					runtimeContext,
				});

				if (anyFailed) {
					expect(prodRes.ok).toBe(false);
					expect(prodRes.markdown).toContain('> [!danger] Query Error:');
					expect(prodRes.markdown).not.toContain('HOST=HostDoc');
				} else {
					expect(prodRes.ok).toBe(true);
					expect(prodRes.markdown).toContain('HOST=HostDoc');
					expect(prodRes.markdown).toContain('HIDDEN_HOST=NONE');
					expect(prodRes.markdown).toContain('RANGE=2026-10-30..2026-11-01');
					expect(prodRes.markdown).toContain('CMP=OK');
				}

				// In rhizome-sample (allowFailedQueries: true), failed queries bind to `[]` (size 0)
				const parsed = parseRhizomeTemplatePass1(template);
				const sampleRes = await renderParsedRhizomeTemplate(
					template,
					parsed,
					payload,
					runtimeContext,
					undefined,
					{ allowFailedQueries: true },
				);
				expect(sampleRes.ok).toBe(true);
				for (const e of entries) {
					const expectedCount = e.status === 'matches' ? 1 : 0;
					expect(sampleRes.markdown).toContain(`COUNT_${e.name}=${expectedCount}`);
				}
			}),
		);
	});

	it('Totality & Duplicate-Name Rejection Invariant: renderRhizomeTemplate never throws on arbitrary fuzz inputs and rejects duplicate query names with 0 vault scans', async () => {
		const fragmentArb = fc.constantFrom(
			'{% query a %}',
			'{% query a explain %}',
			'{% query a cutoff: 5 %}',
			'{% query a cutoff:0 explain %}',
			'{% query cutoff %}',
			'{% query a cutoff: -1 %}',
			'{% query a cutoff : 10 %}',
			'{% query %}',
			'{% query 123bad %}',
			'{% endquery %}',
			'{% endquery extra %}',
			'{% comment %}',
			'{% endcomment %}',
			'{% # comment %}',
			'{{ a.size }}',
			'{% for x in a %}{{ x }}{% endfor %}',
			'{% if unclosed %}',
			'{{ unclosed',
			'tag:work [status: active]',
			'\n',
		);
		const fuzzTemplateArb = fc.oneof(
			fc.string({ maxLength: 100 }),
			fc.array(fragmentArb, { minLength: 1, maxLength: 12 }).map((arr) => arr.join(' ')),
		);

		await assertProperty(
			'templates/engine__fuzz-totality-and-duplicate-name-rejection',
			fc.asyncProperty(
				fuzzTemplateArb,
				validQueryNameArb,
				validExecutableQueryBodyArb,
				validExecutableQueryBodyArb,
				async (fuzzInput, dupName, q1, q2) => {
					const fuzzRes = await renderRhizomeTemplate(fuzzInput, {
						runQueries: async () => ({}),
					});
					expect(typeof fuzzRes.ok).toBe('boolean');
					expect(typeof fuzzRes.markdown).toBe('string');
					if (!fuzzRes.ok) {
						expect(fuzzRes.diagnostics.length).toBeGreaterThan(0);
						expect(fuzzRes.markdown).toContain('[!danger]');
					}

					let dupScans = 0;
					const dupTemplate = `{% query ${dupName} %}${q1}{% endquery %}\n{% query ${dupName} %}${q2}{% endquery %}`;
					const dupRes = await renderRhizomeTemplate(dupTemplate, {
						runQueries: async () => {
							dupScans++;
							return {};
						},
					});
					expect(dupRes.ok).toBe(false);
					expect(dupScans).toBe(0);
					expect(dupRes.diagnostics.some((d) => d.code === 'DUPLICATE_QUERY_NAME')).toBe(
						true,
					);
				},
			),
		);
	});

	it('Vault FS Sandbox Containment Invariant: createVaultLiquidFs never invokes readTemplateFile for paths outside configured folders, dot-directories, or ◊Rhizome/logs', async () => {
		const pathCandidateArb = fc.oneof(
			fc.string({ maxLength: 60 }),
			fc.constantFrom(
				'../secret.md',
				'../../etc/passwd',
				'/etc/passwd',
				'C:\\Windows\\win.ini',
				'https://example.com/a.md',
				'file:///etc/passwd',
				'.config-dir/plugins/rhizome/data.json',
				'◊Rhizome/logs/123.md',
				'◊Rhizome/partials/../logs/123.md',
				'◊Rhizome/partials/valid-card',
				'sub/item.md',
			),
		);

		const folderConfigArb = fc.record({
			templatesFolder: fc.oneof(
				fc.constant(undefined),
				fc.constant('◊Rhizome/templates'),
				fc.constant('../bad'),
				fc.constant('.config-dir/templates'),
				fc.constant('◊Rhizome/logs/sub'),
				fc.constant('Custom/Templates'),
			),
			partialsFolder: fc.oneof(
				fc.constant(undefined),
				fc.constant('◊Rhizome/partials'),
				fc.constant('Custom/Partials'),
			),
			layoutsFolder: fc.oneof(
				fc.constant(undefined),
				fc.constant('◊Rhizome/layouts'),
				fc.constant('Custom/Layouts'),
			),
		});

		await assertProperty(
			'templates/vault-fs__sandbox-containment-invariant',
			fc.asyncProperty(
				folderConfigArb,
				pathCandidateArb,
				async (rawFolders, candidateFile) => {
					const resolved = resolveTemplateFolders({
						...(rawFolders.templatesFolder !== undefined
							? { templatesFolder: rawFolders.templatesFolder }
							: {}),
						...(rawFolders.partialsFolder !== undefined
							? { partialsFolder: rawFolders.partialsFolder }
							: {}),
						...(rawFolders.layoutsFolder !== undefined
							? { layoutsFolder: rawFolders.layoutsFolder }
							: {}),
						configDir: 'mock-config',
					});

					const allowedPrefixes = [
						`${resolved.templatesFolder}/`,
						`${resolved.partialsFolder}/`,
						`${resolved.layoutsFolder}/`,
					];

					const requestedPaths: string[] = [];
					const fs = createVaultLiquidFs(resolved, async (vaultPath) => {
						requestedPaths.push(vaultPath);
						return 'ok';
					});

					const resolvedPath = fs.resolve(resolved.partialsFolder, candidateFile, '.md');
					const isContained =
						fs.contains?.(resolved.partialsFolder, resolvedPath) ?? false;
					const exists = await fs.exists(resolvedPath);

					if (!isContained) {
						expect(exists).toBe(false);
					}
					for (const p of requestedPaths) {
						expect(allowedPrefixes.some((prefix) => p.startsWith(prefix))).toBe(true);
						expect(p.split('/').some((seg) => seg.startsWith('.'))).toBe(false);
						expect(p.startsWith('mock-config')).toBe(false);
						expect(p.startsWith('◊Rhizome/logs')).toBe(false);
					}
				},
			),
		);
	});

	it('Dual-Flavor Date Filter Invariant: % selects LiquidJS strftime while %-free format strings render equivalent Moment.js output', async () => {
		const epochMsArb = fc.integer({
			min: Date.UTC(1900, 0, 1, 0, 0, 0, 0),
			max: Date.UTC(2100, 11, 31, 23, 59, 59, 999),
		});

		const equivalentSpecArb = fc.constantFrom<
			readonly [momentToken: string, strftimeToken: string]
		>(
			['YYYY', '%Y'],
			['YY', '%y'],
			['MM', '%m'],
			['MMM', '%b'],
			['MMMM', '%B'],
			['DD', '%d'],
			['D', '%-d'],
			['DDDD', '%j'],
			['ddd', '%a'],
			['dddd', '%A'],
			['d', '%w'],
			['E', '%u'],
			['HH', '%H'],
			['H', '%-H'],
			['hh', '%I'],
			['h', '%-I'],
			['mm', '%M'],
			['ss', '%S'],
			['SSS', '%L'],
			['A', '%p'],
			['a', '%P'],
			['X', '%s'],
			['Z', '%:z'],
			['ZZ', '%z'],
			['[literal]', 'literal'],
			['-', '-'],
			[':', ':'],
			['/', '/'],
			[' ', ' '],
		);

		const pairListArb = fc.array(equivalentSpecArb, { minLength: 1, maxLength: 8 });

		await assertProperty(
			'templates/date-filter__moment-and-strftime-dual-flavor-equivalence',
			fc.asyncProperty(epochMsArb, pairListArb, async (ms, pairs) => {
				const momentFmt = pairs.map((p) => p[0]).join(' | ');
				const strftimeFmt = `${pairs.map((p) => p[1]).join(' | ')}%n`;

				expect(isStrftimeDateFormat(momentFmt)).toBe(false);
				expect(isStrftimeDateFormat(strftimeFmt)).toBe(true);

				const zdt = Temporal.Instant.fromEpochMilliseconds(ms).toZonedDateTimeISO('UTC');
				const isoDate = `${String(zdt.year).padStart(4, '0')}-${String(zdt.month).padStart(2, '0')}-${String(zdt.day).padStart(2, '0')}`;
				expect(formatMomentDate(ms, 'YYYY-MM-DD', 'UTC', 'UTC')).toBe(isoDate);

				const res = await renderRhizomeTemplate(
					`M={{ this.file.created | date: ${JSON.stringify(momentFmt)} }}\nS={{ this.file.created | date: ${JSON.stringify(strftimeFmt)} }}`,
					{
						runQueries: async () => ({
							'◊host': [{ file: { created: ms }, properties: {} }],
						}),
						runtimeContext: {
							sourcePath: 'Host.md',
							referenceTimeMs: ms,
							timeZone: 'UTC',
						},
					},
				);
				expect(res.ok).toBe(true);
				const expectedVal = formatMomentDate(ms, momentFmt, 'UTC', 'UTC');
				expect(res.markdown).toBe(`M=${expectedVal}\nS=${expectedVal}\n`);
			}),
		);
	});

	it('Cutoff Truncation, Immutability & Callout Quote Integrity Invariant: Pass 2 slices above active cutoff without mutating input arrays and keeps callout blockquotes intact on arbitrary sourcePath strings', async () => {
		const queryCutoffSpecArb = fc.record({
			name: validQueryNameArb,
			cutoffOpt: fc.oneof(
				fc.constant<number | null>(null),
				fc.constant(0),
				fc.integer({ min: 1, max: 15 }),
			),
			compactColon: fc.boolean(),
			matchCount: fc.integer({ min: 0, max: 25 }),
		});
		const uniqueSpecsArb = fc.uniqueArray(queryCutoffSpecArb, {
			selector: (s) => s.name,
			minLength: 1,
			maxLength: 4,
		});
		const arbitrarySourcePathArb = fc.oneof(
			fc.constant<string | undefined>(undefined),
			fc.constant(''),
			fc.constant('Notes/Clean.md'),
			fc.string({ maxLength: 40 }),
		);

		await assertProperty(
			'templates/engine__cutoff-truncation-immutability-and-callout-integrity',
			fc.asyncProperty(uniqueSpecsArb, arbitrarySourcePathArb, async (specs, sourcePath) => {
				const templateBody = specs
					.map((s) => {
						const cutoffArg =
							s.cutoffOpt === null
								? ''
								: s.compactColon
									? `cutoff:${s.cutoffOpt}`
									: `cutoff: ${s.cutoffOpt}`;
						const headerArgs = cutoffArg.length > 0 ? `${s.name} ${cutoffArg}` : s.name;
						return `{% query ${headerArgs} %}#tag{% endquery %}\nSIZE_${s.name}={{ query.${s.name}.size }}`;
					})
					.join('\n');
				const template = `BODY_START\n${templateBody}`;

				const inputArrays = new Map<string, unknown[]>();
				const rawPayload: Record<string, unknown[]> = {};
				for (const s of specs) {
					const arr = Array.from({ length: s.matchCount }, (_, idx) => ({ idx }));
					inputArrays.set(s.name, arr);
					rawPayload[s.name] = arr;
				}

				const res = await renderRhizomeTemplate(template, {
					runQueries: async () => rawPayload,
					...(sourcePath !== undefined ? { runtimeContext: { sourcePath } } : {}),
				});

				expect(res.ok).toBe(true);
				let anyWarn = false;
				for (const s of specs) {
					expect(inputArrays.get(s.name)).toHaveLength(s.matchCount);
					const effectiveCutoff = s.cutoffOpt === null ? 5_000 : s.cutoffOpt;
					const expectedSize =
						effectiveCutoff === 0
							? s.matchCount
							: Math.min(s.matchCount, effectiveCutoff);
					expect(res.markdown).toContain(`SIZE_${s.name}=${expectedSize}`);

					const shouldWarn = effectiveCutoff > 0 && s.matchCount > effectiveCutoff;
					if (shouldWarn) {
						anyWarn = true;
						expect(res.markdown).toContain(
							`> [!warning]- Query \`${s.name}\` ${s.matchCount} matches; cut-off at ${effectiveCutoff}`,
						);
					} else {
						expect(res.markdown).not.toContain(`Query \`${s.name}\``);
					}
				}

				const bodyMarkerIdx = res.markdown.indexOf('BODY_START\n');
				expect(bodyMarkerIdx).toBeGreaterThanOrEqual(0);
				if (anyWarn) {
					expect(res.markdown.startsWith('> [!warning]-')).toBe(true);
					const calloutsPrefix = res.markdown.slice(0, bodyMarkerIdx);
					expect(calloutsPrefix.endsWith('\n\n')).toBe(true);
					const trimmedPrefix = calloutsPrefix.slice(0, -2);
					for (const block of trimmedPrefix.split('\n\n')) {
						for (const line of block.split('\n')) {
							expect(line.startsWith('>')).toBe(true);
						}
					}
				} else {
					expect(bodyMarkerIdx).toBe(0);
				}
			}),
		);
	});
});
