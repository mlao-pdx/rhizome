#!/usr/bin/env node
// Audits production dependency licenses via `license-checker-rseidelsohn`
// and fails (exit 1) if any production dependency uses a license outside
// the project's permissive allowlist, or has a missing/unknown license.
//
// Never auto-writes THIRD-PARTY-NOTICES.md — that file is hand-maintained
// (same "don't script-edit hand-maintained files" principle used in
// scripts/promote-fast-check.mjs). This script only prints the resolved
// production dependency list so it can be diffed against the notices file
// by eye, and drafts a notice for anything not yet listed there.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ALLOWED_LICENSES = [
	'0BSD',
	'MIT',
	'BSD-2-Clause',
	'BSD-3-Clause',
	'Apache-2.0',
	'ISC',
	'Zlib',
];
const NOTICES_FILE = path.resolve(process.cwd(), 'THIRD-PARTY-NOTICES.md');
// Read from package.json rather than hardcoding, so a project rename never
// desyncs this exclusion from the actual package name.
const SELF_PACKAGE = JSON.parse(
	fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8'),
).name;

function runLicenseChecker(args) {
	const result = spawnSync('npx', ['license-checker-rseidelsohn', ...args], { encoding: 'utf8' });
	if (result.error) {
		console.error(`Failed to run license-checker-rseidelsohn: ${result.error.message}`);
		process.exit(1);
	}
	return result;
}

function main() {
	// First pass: resolve the full production dependency license list as
	// JSON, regardless of allowlist, so we always have data to print.
	const listResult = runLicenseChecker([
		'--production',
		'--excludePackages',
		SELF_PACKAGE,
		'--json',
	]);

	let dependencies = {};
	try {
		dependencies = JSON.parse(listResult.stdout || '{}');
	} catch {
		console.error('Could not parse license-checker-rseidelsohn output as JSON.');
		console.error(listResult.stdout);
		console.error(listResult.stderr);
		process.exit(1);
	}

	const names = Object.keys(dependencies);
	console.log(`Production dependencies (${names.length}):\n`);
	for (const name of names) {
		const info = dependencies[name];
		console.log(`  ${name} — ${info.licenses ?? 'UNKNOWN'}`);
	}
	console.log('');

	// Second pass: enforce the allowlist. --onlyAllow makes
	// license-checker-rseidelsohn exit non-zero on the first
	// non-allowlisted (or missing/unknown) license it finds.
	const enforceResult = runLicenseChecker([
		'--production',
		'--excludePackages',
		SELF_PACKAGE,
		'--onlyAllow',
		ALLOWED_LICENSES.join(';'),
		'--json',
	]);

	if (enforceResult.status !== 0) {
		console.error(
			'License audit failed: a production dependency uses a license outside the allowlist.',
		);
		console.error(`Allowlist: ${ALLOWED_LICENSES.join(', ')}`);
		console.error('');
		console.error(enforceResult.stdout || enforceResult.stderr);
		console.error('');
		console.error(
			`Review the offending package above, then either replace the dependency or, if the ` +
				`license is acceptable on inspection, update the allowlist in scripts/check-licenses.mjs ` +
				`and add an entry to ${path.relative(process.cwd(), NOTICES_FILE)}.`,
		);
		process.exit(1);
	}

	// Draft any missing THIRD-PARTY-NOTICES.md entries (print only, never
	// write the file automatically). Notices are hand-written prose, so
	// match loosely on package name + version rather than requiring the
	// exact "name@version" npm syntax.
	const noticesText = fs.existsSync(NOTICES_FILE) ? fs.readFileSync(NOTICES_FILE, 'utf8') : '';
	const missing = names.filter((name) => {
		const atIndex = name.lastIndexOf('@');
		const packageName = name.slice(0, atIndex);
		const version = name.slice(atIndex + 1);
		return !(noticesText.includes(packageName) && noticesText.includes(version));
	});

	if (missing.length > 0) {
		console.log(
			`The following production dependencies are not yet listed in ` +
				`${path.relative(process.cwd(), NOTICES_FILE)} — review and add manually:\n`,
		);
		for (const name of missing) {
			const info = dependencies[name];
			console.log(`--- Draft notice for ${name} ---`);
			console.log(`Package: ${name}`);
			console.log(`License: ${info.licenses ?? 'UNKNOWN'}`);
			if (info.repository) console.log(`Repository: ${info.repository}`);
			if (info.licenseFile)
				console.log(`License file (local, for review): ${info.licenseFile}`);
			console.log(
				'(Paste the full license text into THIRD-PARTY-NOTICES.md — release artifacts',
			);
			console.log('do not ship node_modules, so a path reference is not sufficient.)\n');
		}
		process.exit(1);
	}

	console.log(
		`License audit passed. All production dependencies are listed in ${path.relative(process.cwd(), NOTICES_FILE)}.`,
	);
}

main();
