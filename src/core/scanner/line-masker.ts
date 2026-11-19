/**
 * Masks inline code spans (backtick-delimited) and inline math spans (`$...$`, `$$...$$`)
 * on a single line with ASCII spaces of identical UTF-16 length.
 *
 * @remarks
 * Preserves exact UTF-16 code-unit offsets and column numbers while hiding delimiters
 * (`[key:: val]`, `(key:: val)`, task signifiers, `#tags`, `^block-id`) that appear
 * inside inline code or math spans. Intentionally leaves Obsidian comments (`%%...%%`)
 * and HTML comments (`<!--...-->`) unmasked so hidden Dataview and Rhizome inline
 * properties remain visible to extractors.
 */
export function maskInlineCodeAndMath(line: string): string {
	if (!line.includes('`') && !line.includes('$')) {
		return line;
	}

	const chars = line.split('');
	const len = chars.length;
	let i = 0;

	while (i < len) {
		const ch = chars[i]!;

		// 1. Inline code spans: run of k >= 1 backticks closed by an identical run of k backticks
		if (ch === '`') {
			let runLen = 1;
			while (i + runLen < len && chars[i + runLen] === '`') {
				runLen++;
			}
			let closeStart = -1;
			let j = i + runLen;
			while (j < len) {
				if (chars[j] === '`') {
					let closeRun = 1;
					while (j + closeRun < len && chars[j + closeRun] === '`') {
						closeRun++;
					}
					if (closeRun === runLen) {
						closeStart = j;
						break;
					}
					j += closeRun;
				} else {
					j++;
				}
			}

			if (closeStart !== -1) {
				const maskEnd = closeStart + runLen;
				for (let k = i; k < maskEnd; k++) {
					chars[k] = ' ';
				}
				i = maskEnd;
				continue;
			}
			i += runLen;
			continue;
		}

		// Skip backslash-escaped characters outside code spans (e.g. \$)
		if (ch === '\\') {
			i += 2;
			continue;
		}

		// 2. Inline math spans: $$...$$ or $...$
		if (ch === '$') {
			const isDisplay = i + 1 < len && chars[i + 1] === '$';
			if (isDisplay) {
				let closeStart = -1;
				let j = i + 2;
				while (j + 1 < len) {
					if (chars[j] === '\\') {
						j += 2;
						continue;
					}
					if (chars[j] === '$' && chars[j + 1] === '$') {
						closeStart = j;
						break;
					}
					j++;
				}
				if (closeStart !== -1) {
					const maskEnd = closeStart + 2;
					for (let k = i; k < maskEnd; k++) {
						chars[k] = ' ';
					}
					i = maskEnd;
					continue;
				}
				i += 2;
				continue;
			}

			// Single-$ inline math: opening '$' must not be followed by whitespace,
			// closing '$' must not be preceded by whitespace or followed by an ASCII digit.
			const nextCh = i + 1 < len ? chars[i + 1]! : '';
			if (nextCh !== '' && nextCh !== ' ' && nextCh !== '\t') {
				let closeIdx = -1;
				let j = i + 1;
				while (j < len) {
					if (chars[j] === '\\') {
						j += 2;
						continue;
					}
					if (chars[j] === '`') {
						break;
					}
					if (chars[j] === '$') {
						const prevCh = chars[j - 1]!;
						const afterCh = j + 1 < len ? chars[j + 1]! : '';
						const followedByDigit = afterCh >= '0' && afterCh <= '9';
						if (prevCh !== ' ' && prevCh !== '\t' && !followedByDigit) {
							closeIdx = j;
							break;
						}
					}
					j++;
				}
				if (closeIdx !== -1) {
					const maskEnd = closeIdx + 1;
					for (let k = i; k < maskEnd; k++) {
						chars[k] = ' ';
					}
					i = maskEnd;
					continue;
				}
			}
		}

		i++;
	}

	return chars.join('');
}
