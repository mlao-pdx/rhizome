#!/usr/bin/env node
// Cross-references `npm audit --json` vulnerability findings against the
// esbuild production bundle (`meta.json`) to distinguish advisories in
// code shipped inside `main.js` from dev-only or unbundled CLI dependencies.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const META_FILE = path.resolve(process.cwd(), 'meta.json');

/**
 * Extracts the npm package name (scoped or unscoped) from a relative input
 * path in `meta.json` (e.g. `node_modules/@js-temporal/polyfill/dist/index.mjs`
 * -> `@js-temporal/polyfill`), using the last `node_modules/` segment to handle
 * nested node_modules trees.
 *
 * @param {string} inputPath
 * @returns {string | null}
 */
function extractPackageName(inputPath) {
	const normalized = inputPath.replace(/\\/g, '/');
	const marker = 'node_modules/';
	const lastIdx = normalized.lastIndexOf(marker);
	if (lastIdx === -1) {
		return null;
	}
	const remainder = normalized.slice(lastIdx + marker.length);
	const parts = remainder.split('/').filter(Boolean);
	if (parts.length === 0) {
		return null;
	}
	if (parts[0].startsWith('@')) {
		return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null;
	}
	return parts[0];
}

/**
 * Formats the `fixAvailable` field from `npm audit --json`.
 *
 * @param {boolean | { name: string; version: string; isSemVerMajor: boolean }} fixAvailable
 * @returns {string}
 */
function formatFixAvailable(fixAvailable) {
	if (!fixAvailable) {
		return 'No fix available';
	}
	if (typeof fixAvailable === 'object') {
		const breaking = fixAvailable.isSemVerMajor ? ' (breaking/--force)' : '';
		return `${fixAvailable.name}@${fixAvailable.version}${breaking}`;
	}
	return 'Yes (npm audit fix)';
}

function main() {
	if (!fs.existsSync(META_FILE)) {
		console.error(
			`Missing ${path.relative(process.cwd(), META_FILE)} — run "npm run build" first to generate bundle metadata.`,
		);
		process.exit(1);
	}

	let metafile;
	try {
		metafile = JSON.parse(fs.readFileSync(META_FILE, 'utf8'));
	} catch (err) {
		console.error(
			`Failed to parse ${path.relative(process.cwd(), META_FILE)}: ${err instanceof Error ? err.message : String(err)}`,
		);
		process.exit(1);
	}

	const inputPaths = Object.keys(metafile.inputs ?? {});
	const bundledPackages = new Set();
	for (const inputPath of inputPaths) {
		const pkg = extractPackageName(inputPath);
		if (pkg) {
			bundledPackages.add(pkg);
		}
	}

	const sortedBundled = [...bundledPackages].sort();
	console.log(`Bundled packages in main.js (${sortedBundled.length}):\n`);
	for (const pkg of sortedBundled) {
		console.log(`  - ${pkg}`);
	}
	console.log('');

	const auditResult = spawnSync('npm', ['audit', '--json'], { encoding: 'utf8' });
	if (auditResult.error) {
		console.error(`Failed to run npm audit: ${auditResult.error.message}`);
		process.exit(1);
	}

	let report;
	try {
		report = JSON.parse(auditResult.stdout || '{}');
	} catch {
		console.error('Could not parse `npm audit --json` output.');
		if (auditResult.stderr) {
			console.error(auditResult.stderr);
		}
		process.exit(1);
	}

	if (report.error) {
		console.error(
			`npm audit returned an error: ${report.error.summary ?? JSON.stringify(report.error)}`,
		);
		process.exit(1);
	}

	const vulnerabilities = Object.values(report.vulnerabilities ?? {});
	if (vulnerabilities.length === 0) {
		console.log('Bundle audit passed: 0 vulnerabilities reported by npm audit.');
		process.exit(0);
	}

	const shippedVulns = [];
	const devOrUnbundledVulns = [];

	const rows = vulnerabilities.map((vuln) => {
		const inBundle = bundledPackages.has(vuln.name);
		if (inBundle) {
			shippedVulns.push(vuln);
		} else {
			devOrUnbundledVulns.push(vuln);
		}
		return {
			Package: vuln.name,
			Severity: vuln.severity ?? 'unknown',
			'In main.js': inBundle ? 'YES (SHIPPED)' : 'no (dev/unbundled)',
			'Fix Available': formatFixAvailable(vuln.fixAvailable),
		};
	});

	console.table(rows);

	const criticalDevVulns = devOrUnbundledVulns.filter((v) => v.severity === 'critical');

	if (shippedVulns.length > 0 || criticalDevVulns.length > 0) {
		if (shippedVulns.length > 0) {
			console.error(
				`Bundle audit FAILED: ${shippedVulns.length} vulnerable package(s) are bundled into main.js: ` +
					shippedVulns.map((v) => `${v.name} (${v.severity})`).join(', '),
			);
		}
		if (criticalDevVulns.length > 0) {
			console.error(
				`Bundle audit FAILED: ${criticalDevVulns.length} critical vulnerability(ies) in dev/unbundled dependencies: ` +
					criticalDevVulns.map((v) => v.name).join(', '),
			);
		}
		process.exit(1);
	}

	console.log(
		`Bundle audit passed: 0 vulnerabilities in main.js (${devOrUnbundledVulns.length} non-critical dev/unbundled advisory(ies) do not reach production).`,
	);
}

main();
