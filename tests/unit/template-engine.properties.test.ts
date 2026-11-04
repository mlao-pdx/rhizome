import { Temporal } from '@js-temporal/polyfill';
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	createVaultLiquidFs,
	formatMomentDate,
	isStrftimeDateFormat,
	renderRhizomeTemplate,
	resolveTemplateFolders,
} from '../../src/core/templates';
import { assertProperty } from '../support/assertProperty';

const validQueryNameArb = fc
	.stringMatching(/^[a-zA-Z_][a-zA-Z0-9_]{0,12}$/)
	.filter(
		(name) =>
			name !== 'explain' &&
			name !== '__proto__' &&
			name !== 'prototype' &&
			name !== 'constructor',
	);

const safeQueryBodyArb = fc
	.string({ maxLength: 40 })
	.map((s) => s.replace(/\{%|%\}|\{\{|\}\}/g, ' '));

describe('LiquidJS Template Engine & {% query %} Property Invariants', () => {
	it('Single-Pass Batching & Zero-Scan Short-Circuit Invariant: N >= 1 valid queries call runQueries once; N = 0 or parse errors call runQueries 0 times', async () => {
		const querySpecArb = fc.record({
			name: validQueryNameArb,
			query: safeQueryBodyArb,
			explain: fc.boolean(),
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
							`{% query ${s.name}${s.explain ? ' explain' : ''} %}${s.query}{% endquery %}\n{{ query.${s.name}.size }}`,
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
					explainQuery: async (_q, heading) => `EXPLAIN(${heading})`,
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

	it('Missing vs. Empty Payload Contract Invariant: valid, explain, and failed queries obey exact inline output and variable binding semantics', async () => {
		const queryEntryArb = fc.record({
			name: validQueryNameArb,
			query: safeQueryBodyArb,
			explain: fc.boolean(),
			status: fc.constantFrom<'matches' | 'empty' | 'failed'>('matches', 'empty', 'failed'),
		});
		const uniqueEntriesArb = fc.uniqueArray(queryEntryArb, {
			selector: (e) => e.name,
			minLength: 1,
			maxLength: 4,
		});

		await assertProperty(
			'templates/engine__missing-vs-empty-payload-contract',
			fc.asyncProperty(uniqueEntriesArb, async (entries) => {
				const explainedNames: string[] = [];
				const template = entries
					.map(
						(e) =>
							`{% query ${e.name}${e.explain ? ' explain' : ''} %}${e.query}{% endquery %}\nCOUNT_${e.name}={{ query.${e.name}.size | default: -1 }}`,
					)
					.concat([
						'HOST={{ file.basename }}',
						'HIDDEN_HOST={{ query["◊host"] | default: "NONE" }}',
						'RANGE={{ yesterday..tomorrow }}',
						'CMP={% if today == thisyear and yesterday < today and tomorrow > today %}OK{% endif %}',
					])
					.join('\n');

				const res = await renderRhizomeTemplate(template, {
					runQueries: async () => {
						const payload: Record<string, unknown[]> = {
							'◊host': [{ file: { basename: 'HostDoc' } }],
						};
						for (const e of entries) {
							if (e.status === 'matches') {
								payload[e.name] = [{ file: { basename: 'A' } }];
							} else if (e.status === 'empty') {
								payload[e.name] = [];
							}
							// 'failed' is omitted from payload
						}
						return payload;
					},
					explainQuery: async (_q, heading) => {
						explainedNames.push(heading);
						return `PLAN[${heading}]`;
					},
					runtimeContext: {
						referenceTimeMs: Date.UTC(2026, 9, 31, 8, 33, 0, 0),
						timeZone: 'UTC',
					},
				});

				expect(res.ok).toBe(true);
				expect(res.markdown).toContain('HOST=HostDoc');
				expect(res.markdown).toContain('HIDDEN_HOST=NONE');
				expect(res.markdown).toContain('RANGE=2026-10-30..2026-11-01');
				expect(res.markdown).toContain('CMP=OK');
				for (const e of entries) {
					const shouldExplain = e.explain || e.status === 'failed';
					const marker = `PLAN[Query Explain Plan: ${e.name}]`;
					if (shouldExplain) {
						expect(res.markdown).toContain(marker);
					} else {
						expect(res.markdown).not.toContain(marker);
					}

					if (e.status === 'matches') {
						expect(res.markdown).toContain(`COUNT_${e.name}=1`);
					} else if (e.status === 'empty') {
						expect(res.markdown).toContain(`COUNT_${e.name}=0`);
					} else {
						expect(res.markdown).toContain(`COUNT_${e.name}=-1`);
					}
				}
			}),
		);
	});

	it('Totality & Duplicate-Name Rejection Invariant: renderRhizomeTemplate never throws on arbitrary fuzz inputs and rejects duplicate query names with 0 vault scans', async () => {
		const fragmentArb = fc.constantFrom(
			'{% query a %}',
			'{% query a explain %}',
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
				safeQueryBodyArb,
				safeQueryBodyArb,
				async (fuzzInput, dupName, q1, q2) => {
					const fuzzRes = await renderRhizomeTemplate(fuzzInput, {
						runQueries: async () => ({}),
						explainQuery: async () => 'EXPLAIN',
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
						explainQuery: async () => '',
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
					`M={{ file.created | date: ${JSON.stringify(momentFmt)} }}\nS={{ file.created | date: ${JSON.stringify(strftimeFmt)} }}`,
					{
						runQueries: async () => ({
							'◊host': [{ file: { created: ms }, properties: {} }],
						}),
						explainQuery: async () => '',
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
});
