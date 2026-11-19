import type { TaskPriority, TaskStatusType } from '../search/types';

const EMOJI_PRIORITY_RE = /(?:^|\s)(🔺|⏫|🔼|🔽|⏬)\uFE0F?$/;
const EMOJI_CREATED_RE = /(?:^|\s)➕\uFE0F? *(\d{4}-\d{2}-\d{2})$/;
const EMOJI_START_RE = /(?:^|\s)🛫\uFE0F? *(\d{4}-\d{2}-\d{2})$/;
const EMOJI_SCHEDULED_RE = /(?:^|\s)(?:⏳|⌛)\uFE0F? *(\d{4}-\d{2}-\d{2})$/;
const EMOJI_DUE_RE = /(?:^|\s)(?:📅|📆|🗓)\uFE0F? *(\d{4}-\d{2}-\d{2})$/;
const EMOJI_COMPLETION_RE = /(?:^|\s)✅\uFE0F? *(\d{4}-\d{2}-\d{2})$/;
const EMOJI_CANCELLED_RE = /(?:^|\s)❌\uFE0F? *(\d{4}-\d{2}-\d{2})$/;
const EMOJI_REPEAT_RE = /(?:^|\s)🔁\uFE0F? *([a-zA-Z0-9 !;]+)$/;
const EMOJI_ON_COMPLETION_RE = /(?:^|\s)🏁\uFE0F? *([^\s[\]()]+)$/;
const EMOJI_ID_RE = /(?:^|\s)🆔\uFE0F? *([a-zA-Z0-9-_]+)$/;
const EMOJI_DEPENDS_ON_RE = /(?:^|\s)⛔\uFE0F? *([a-zA-Z0-9-_]+(?: *, *[a-zA-Z0-9-_]+)*)$/;

const DV_PRIORITY_RE = /^(highest|high|medium|normal|none|low|lowest)$/i;
const DV_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DV_REPEAT_RE = /^[a-zA-Z0-9 !;]+$/;
const DV_ID_RE = /^[a-zA-Z0-9-_]+$/;
const DV_DEPENDS_ON_RE = /^[a-zA-Z0-9-_]+(?: *, *[a-zA-Z0-9-_]+)*$/;

export const PRIORITY_NUMBERS: Readonly<Record<TaskPriority, number>> = {
	highest: 0,
	high: 1,
	medium: 2,
	normal: 3,
	low: 4,
	lowest: 5,
};

export interface SignifierState {
	priority: TaskPriority | null;
	created: string | null;
	start: string | null;
	scheduled: string | null;
	due: string | null;
	completion: string | null;
	cancelled: string | null;
	repeat: string | null;
	onCompletion: string | null;
	id: string | null;
	dependsOn: string[] | null;
	hasEmoji: boolean;
	hasDataview: boolean;
}

export function createEmptySignifierState(): SignifierState {
	return {
		priority: null,
		created: null,
		start: null,
		scheduled: null,
		due: null,
		completion: null,
		cancelled: null,
		repeat: null,
		onCompletion: null,
		id: null,
		dependsOn: null,
		hasEmoji: false,
		hasDataview: false,
	};
}

export function mapTaskStatusSymbol(symbol: string): TaskStatusType {
	switch (symbol) {
		case ' ':
			return 'TODO';
		case '/':
			return 'IN_PROGRESS';
		case 'x':
		case 'X':
			return 'DONE';
		case '-':
			return 'CANCELLED';
		case '?':
		case 'h':
		case 'H':
			return 'ON_HOLD';
		case '~':
		case 'Q':
			return 'NON_TASK';
		default:
			return 'TODO';
	}
}

function emojiToPriority(emoji: string): TaskPriority {
	switch (emoji) {
		case '🔺':
			return 'highest';
		case '⏫':
			return 'high';
		case '🔼':
			return 'medium';
		case '🔽':
			return 'low';
		case '⏬':
			return 'lowest';
		default:
			return 'normal';
	}
}

export function parseDataviewSignifier(
	lowerKey: string,
	val: string | null,
): { matched: true; apply: (state: SignifierState) => void } | { matched: false } {
	if (val === null) return { matched: false };
	switch (lowerKey) {
		case 'priority': {
			if (!DV_PRIORITY_RE.test(val)) return { matched: false };
			const norm = val.toLowerCase();
			const p: TaskPriority = norm === 'none' ? 'normal' : (norm as TaskPriority);
			return {
				matched: true,
				apply: (s) => {
					if (s.priority === null) s.priority = p;
				},
			};
		}
		case 'created':
			return DV_DATE_RE.test(val)
				? { matched: true, apply: (s) => (s.created ??= val) }
				: { matched: false };
		case 'start':
			return DV_DATE_RE.test(val)
				? { matched: true, apply: (s) => (s.start ??= val) }
				: { matched: false };
		case 'scheduled':
			return DV_DATE_RE.test(val)
				? { matched: true, apply: (s) => (s.scheduled ??= val) }
				: { matched: false };
		case 'due':
			return DV_DATE_RE.test(val)
				? { matched: true, apply: (s) => (s.due ??= val) }
				: { matched: false };
		case 'completion':
			return DV_DATE_RE.test(val)
				? { matched: true, apply: (s) => (s.completion ??= val) }
				: { matched: false };
		case 'cancelled':
			return DV_DATE_RE.test(val)
				? { matched: true, apply: (s) => (s.cancelled ??= val) }
				: { matched: false };
		case 'repeat':
			return DV_REPEAT_RE.test(val)
				? { matched: true, apply: (s) => (s.repeat ??= val.trim()) }
				: { matched: false };
		case 'oncompletion':
			return val.length > 0
				? { matched: true, apply: (s) => (s.onCompletion ??= val.trim()) }
				: { matched: false };
		case 'id':
			return DV_ID_RE.test(val)
				? { matched: true, apply: (s) => (s.id ??= val) }
				: { matched: false };
		case 'dependson':
			return DV_DEPENDS_ON_RE.test(val)
				? {
						matched: true,
						apply: (s) => {
							if (s.dependsOn === null) {
								s.dependsOn = val.split(',').map((id) => id.trim());
							}
						},
					}
				: { matched: false };
		default:
			return { matched: false };
	}
}

const EMOJI_SIGNIFIER_RULES: ReadonlyArray<{
	readonly re: RegExp;
	readonly onMatch: (state: SignifierState, captured: string) => void;
}> = [
	{
		re: EMOJI_PRIORITY_RE,
		onMatch: (state, c) => {
			if (state.priority === null) state.priority = emojiToPriority(c);
		},
	},
	{ re: EMOJI_CREATED_RE, onMatch: (state, c) => (state.created ??= c) },
	{ re: EMOJI_START_RE, onMatch: (state, c) => (state.start ??= c) },
	{ re: EMOJI_SCHEDULED_RE, onMatch: (state, c) => (state.scheduled ??= c) },
	{ re: EMOJI_DUE_RE, onMatch: (state, c) => (state.due ??= c) },
	{ re: EMOJI_COMPLETION_RE, onMatch: (state, c) => (state.completion ??= c) },
	{ re: EMOJI_CANCELLED_RE, onMatch: (state, c) => (state.cancelled ??= c) },
	{ re: EMOJI_REPEAT_RE, onMatch: (state, c) => (state.repeat ??= c.trim()) },
	{ re: EMOJI_ON_COMPLETION_RE, onMatch: (state, c) => (state.onCompletion ??= c.trim()) },
	{ re: EMOJI_ID_RE, onMatch: (state, c) => (state.id ??= c) },
	{
		re: EMOJI_DEPENDS_ON_RE,
		onMatch: (state, c) => {
			if (state.dependsOn === null) {
				state.dependsOn = c.split(',').map((id) => id.trim());
			}
		},
	},
];

export function tryPeelEmojiSignifier(
	rawBody: string,
	maskedBody: string,
	state: SignifierState,
): { nextRaw: string; nextMasked: string } | null {
	for (const rule of EMOJI_SIGNIFIER_RULES) {
		const m = rule.re.exec(maskedBody);
		if (m && m[1] !== undefined) {
			const capOffset = maskedBody.lastIndexOf(m[1]);
			const rawCaptured =
				capOffset >= m.index ? rawBody.slice(capOffset, capOffset + m[1].length) : m[1];
			rule.onMatch(state, rawCaptured);
			state.hasEmoji = true;
			const nextRaw = rawBody.slice(0, m.index).replace(/[ \t]+$/, '');
			return { nextRaw, nextMasked: maskedBody.slice(0, nextRaw.length) };
		}
	}
	return null;
}
