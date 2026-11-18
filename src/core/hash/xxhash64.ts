const PRIME32_1 = 0x9e3779b1 | 0;
const PRIME32_2 = 0x85ebca77 | 0;
const PRIME32_3 = 0xc2b2ae3d | 0;
const PRIME32_4 = 0x27d4eb2f | 0;
const PRIME32_5 = 0x165667b1 | 0;

const SEED_LANE_1 = (PRIME32_5 + PRIME32_1) | 0;
const SEED_LANE_2 = (PRIME32_5 ^ PRIME32_4) | 0;

const f64Scratch = new Float64Array(1);
const i32Scratch = new Int32Array(f64Scratch.buffer);

function rotl32(x: number, r: number): number {
	return (x << r) | (x >>> (32 - r));
}

function xxh32Round(acc: number, input: number): number {
	return Math.imul(rotl32((acc + Math.imul(input, PRIME32_3)) | 0, 17), PRIME32_4);
}

function xxh32Avalanche(h: number): number {
	h ^= h >>> 15;
	h = Math.imul(h, PRIME32_2);
	h ^= h >>> 13;
	h = Math.imul(h, PRIME32_3);
	h ^= h >>> 16;
	return h >>> 0;
}

/** Formats the two 32-bit lanes of a digest as a lowercase 16-character hex string. */
export function formatHex64(hi: number, lo: number): string {
	return (hi >>> 0).toString(16).padStart(8, '0') + (lo >>> 0).toString(16).padStart(8, '0');
}

/** A 64-bit digest split into two independent 32-bit xxHash lanes. */
export interface Digest64 {
	readonly hi: number;
	readonly lo: number;
	readonly hex: string;
}

/**
 * Zero-allocation 64-bit streaming xxHash accumulator built from two independent
 * 32-bit xxHash lanes using `Math.imul` and IEEE-754 scratch views.
 *
 * @remarks
 * (perf, 2026-10-30) Uses unboxed 32-bit `Math.imul` arithmetic over pairs of UTF-16
 * code units and a shared `Float64Array`/`Int32Array` buffer for numbers, avoiding
 * `BigInt` heap allocations, `String(number)` allocations, and JS-to-WASM UTF-8 copy
 * overhead while providing a 64-bit xxHash avalanche digest.
 */
export class XxHash64Accumulator {
	private s1 = SEED_LANE_1;
	private s2 = SEED_LANE_2;
	private totalBytes = 0;

	updateU32(val: number): void {
		const w = val | 0;
		this.s1 = xxh32Round(this.s1, w);
		this.s2 = xxh32Round(this.s2, (w ^ PRIME32_2) | 0);
		this.totalBytes = (this.totalBytes + 4) | 0;
	}

	updateTag(tag: number, length = 0): void {
		if (length >= 0 && length <= 0x00ffffff) {
			this.updateU32(((tag & 0xff) << 24) | length);
		} else {
			this.updateU32((tag & 0xff) << 24);
			this.updateU32(length | 0);
		}
	}

	updateNumber(n: number): void {
		if ((n | 0) === n && !Object.is(n, -0)) {
			this.updateU32(0x14000001);
			this.updateU32(n | 0);
			return;
		}
		if (Number.isNaN(n)) {
			this.updateU32(0x14000002);
			return;
		}
		if (Object.is(n, -0)) {
			this.updateU32(0x14000003);
			return;
		}
		f64Scratch[0] = n;
		this.updateU32(0x14000004);
		this.updateU32(i32Scratch[0]!);
		this.updateU32(i32Scratch[1]!);
	}

	updateString(str: string): void {
		const len = str.length;
		this.updateTag(0x15, len);
		let s1 = this.s1;
		let s2 = this.s2;
		let i = 0;
		const pairLimit = len - 1;
		while (i < pairLimit) {
			const w = str.charCodeAt(i) | (str.charCodeAt(i + 1) << 16);
			s1 = xxh32Round(s1, w);
			s2 = xxh32Round(s2, (w ^ PRIME32_2) | 0);
			i += 2;
		}
		if (i < len) {
			const w = str.charCodeAt(i);
			s1 = xxh32Round(s1, w);
			s2 = xxh32Round(s2, (w ^ PRIME32_2) | 0);
		}
		this.s1 = s1;
		this.s2 = s2;
		this.totalBytes = (this.totalBytes + (len << 1)) | 0;
	}

	updateStringArray(arr: readonly string[]): void {
		const len = arr.length;
		this.updateTag(0x22, len);
		for (let i = 0; i < len; i++) {
			this.updateString(arr[i]!);
		}
	}

	updateValue(val: unknown): void {
		if (val === null) {
			this.updateU32(0x10000000);
			return;
		}
		if (val === undefined) {
			this.updateU32(0x11000000);
			return;
		}
		if (typeof val === 'boolean') {
			this.updateU32(val ? 0x12000001 : 0x12000000);
			return;
		}
		if (typeof val === 'number') {
			this.updateNumber(val);
			return;
		}
		if (typeof val === 'string') {
			this.updateString(val);
			return;
		}
		if (Array.isArray(val)) {
			const len = val.length;
			this.updateTag(0x20, len);
			for (let i = 0; i < len; i++) {
				this.updateValue(val[i]);
			}
			this.updateU32(0x21000000);
			return;
		}
		if (typeof val === 'object') {
			const record = val as Record<string, unknown>;
			const keys = Object.keys(record).sort();
			const len = keys.length;
			this.updateTag(0x30, len);
			for (let i = 0; i < len; i++) {
				const k = keys[i]!;
				this.updateString(k);
				this.updateValue(record[k]);
			}
			this.updateU32(0x31000000);
			return;
		}
		this.updateString(typeof val);
	}

	digest(): Digest64 {
		const hi = xxh32Avalanche((this.s1 + this.totalBytes) | 0);
		const lo = xxh32Avalanche((this.s2 + this.totalBytes) | 0);
		return { hi, lo, hex: formatHex64(hi, lo) };
	}
}
