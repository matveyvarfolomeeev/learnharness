/** Nova-3 monolingual language codes, including documented locale aliases.
 * Source: https://developers.deepgram.com/docs/models-languages-overview
 * Multilingual is a separate mode; its supported language set differs.
 */
const NOVA_3_LANGUAGES = [
	["Afrikaans", ["af", "af-ZA"]],
	["Arabic", ["ar", "ar-AE", "ar-SA", "ar-QA", "ar-KW", "ar-SY", "ar-LB", "ar-PS", "ar-JO", "ar-EG", "ar-SD", "ar-TD", "ar-MA", "ar-DZ", "ar-TN", "ar-IQ", "ar-IR"]],
	["Armenian", ["hy"]],
	["Assamese", ["as", "as-IN"]],
	["Belarusian", ["be"]],
	["Bengali", ["bn"]],
	["Bosnian", ["bs"]],
	["Bulgarian", ["bg"]],
	["Catalan", ["ca"]],
	["Chinese (Cantonese, Traditional)", ["zh-HK"]],
	["Chinese (Mandarin, Simplified)", ["zh", "zh-CN", "zh-Hans"]],
	["Chinese (Mandarin, Traditional)", ["zh-TW", "zh-Hant"]],
	["Croatian", ["hr"]],
	["Czech", ["cs", "cs-CZ"]],
	["Danish", ["da", "da-DK"]],
	["Dutch", ["nl"]],
	["English", ["en", "en-US", "en-AU", "en-GB", "en-IN", "en-NZ"]],
	["Estonian", ["et"]],
	["Finnish", ["fi"]],
	["Flemish", ["nl-BE"]],
	["French", ["fr", "fr-CA"]],
	["Georgian", ["ka", "ka-GE"]],
	["German", ["de"]],
	["German (Switzerland)", ["de-CH"]],
	["Greek", ["el"]],
	["Gujarati", ["gu", "gu-IN"]],
	["Hebrew", ["he"]],
	["Hindi", ["hi"]],
	["Hungarian", ["hu"]],
	["Indonesian", ["id"]],
	["Italian", ["it"]],
	["Japanese", ["ja"]],
	["Kannada", ["kn"]],
	["Kazakh", ["kk", "kk-KZ"]],
	["Korean", ["ko", "ko-KR"]],
	["Latvian", ["lv"]],
	["Lithuanian", ["lt"]],
	["Macedonian", ["mk"]],
	["Malay", ["ms"]],
	["Marathi", ["mr"]],
	["Mongolian", ["mn"]],
	["Nepali", ["ne"]],
	["Norwegian", ["no"]],
	["Pashto", ["ps", "ps-AF"]],
	["Persian", ["fa"]],
	["Polish", ["pl"]],
	["Portuguese", ["pt", "pt-BR", "pt-PT"]],
	["Punjabi", ["pa", "pa-IN"]],
	["Romanian", ["ro"]],
	["Russian", ["ru"]],
	["Serbian", ["sr"]],
	["Slovak", ["sk"]],
	["Slovenian", ["sl"]],
	["Spanish", ["es", "es-419"]],
	["Swedish", ["sv", "sv-SE"]],
	["Tagalog", ["tl"]],
	["Tamil", ["ta"]],
	["Telugu", ["te"]],
	["Thai", ["th", "th-TH"]],
	["Turkish", ["tr", "tr-TR"]],
	["Ukrainian", ["uk"]],
	["Urdu", ["ur"]],
	["Vietnamese", ["vi"]],
] as const;

export type DictationLanguage = "multi" | (typeof NOVA_3_LANGUAGES)[number][1][number];

export const DICTATION_LANGUAGES: readonly { code: DictationLanguage; label: string }[] = [
	{ code: "multi", label: "Multilingual" },
	...NOVA_3_LANGUAGES.flatMap(([name, codes]) =>
		codes.map((code, i) => ({ code, label: i === 0 ? name : `${name} (${code})` })),
	).sort((a, b) => a.label.localeCompare(b.label, "en")),
];

export function isDictationLanguage(value: unknown): value is DictationLanguage {
	return DICTATION_LANGUAGES.some(({ code }) => code === value);
}

export const DICTATION_ENGINES = [
	{ id: "deepgram", label: "Deepgram Nova-3" },
	{ id: "whisper-large-v3", label: "Whisper large-v3 · Groq" },
	{ id: "whisper-large-v3-turbo", label: "Whisper Turbo · Groq" },
] as const;
export type DictationEngine = typeof DICTATION_ENGINES[number]["id"];
export function isDictationEngine(value: unknown): value is DictationEngine {
	return DICTATION_ENGINES.some((engine) => engine.id === value);
}
export const MAX_DICTATION_GLOSSARY = 600;
export const MAX_DICTATION_PCM_BYTES = 16000 * 2 * 60 * 10;
export const GROQ_DICTATION_KEYLESS = "Для Whisper нужен ключ Groq";

/** PCM frames from the existing capture worklet; no codec dependency needed. */
export function dictationWav(frames: readonly (ArrayBuffer | Int16Array)[]): ArrayBuffer {
	const bytes = frames.reduce((n, frame) => n + frame.byteLength, 0);
	if (bytes > MAX_DICTATION_PCM_BYTES || bytes % 2) throw new Error("Invalid dictation audio size");
	const result = new ArrayBuffer(44 + bytes);
	const view = new DataView(result);
	const ascii = (offset: number, value: string) => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)); };
	ascii(0, "RIFF"); view.setUint32(4, 36 + bytes, true); ascii(8, "WAVEfmt ");
	view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
	view.setUint32(24, 16000, true); view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
	ascii(36, "data"); view.setUint32(40, bytes, true);
	const output = new Uint8Array(result);
	let offset = 44;
	for (const frame of frames) {
		output.set(frame instanceof ArrayBuffer ? new Uint8Array(frame) : new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength), offset);
		offset += frame.byteLength;
	}
	return result;
}

/** Only language varies. Keep the owner's tuned streaming parameters. */
export function deepgramListenUrl(language: DictationLanguage): string {
	return "wss://api.deepgram.com/v1/listen" +
		"?model=nova-3&encoding=linear16&sample_rate=16000&channels=1" +
		"&smart_format=true&punctuate=true&endpointing=300" +
		`&language=${encodeURIComponent(language)}`;
}
