"use client";

import { useEffect, useState } from "react";
import { DICTATION_ENGINES, MAX_DICTATION_GLOSSARY, type DictationEngine } from "@/src/core";
import { useDictationLanguage } from "./dictation-preference";
import { useDictationActive } from "./dictation-state";
import { SettingsRow } from "./settings/controls";

export function DictationOptions() {
	const { settings, saving, error, saveSettings } = useDictationLanguage();
	const active = useDictationActive();
	const [glossary, setGlossary] = useState("");
	useEffect(() => { setGlossary(settings?.glossary ?? ""); }, [settings?.glossary]);
	const disabled = active || saving || !settings;
	return <div className="space-y-2" data-testid="dictation-options">
		<SettingsRow label="Распознаватель" testid="row-dictation-engine" dimmed={active}>
			<select aria-label="Распознаватель речи" disabled={disabled} value={settings?.engine ?? "deepgram"}
				className="max-w-[65%] rounded-md border border-border bg-card px-2 py-1.5 font-ui text-xs disabled:opacity-40"
				onChange={(e) => { void saveSettings({ engine: e.target.value as DictationEngine }); }}>
				{DICTATION_ENGINES.map((engine) => <option key={engine.id} value={engine.id}>{engine.label}</option>)}
			</select>
		</SettingsRow>
		{settings && settings.engine !== "deepgram" && <div className="space-y-3 px-1 pb-2 font-ui text-xs">
			<p className="text-muted-foreground">Текст появляется после остановки записи. Пунктуация — автоматически. Одна запись — до 10 минут.</p>
			<label className="flex cursor-pointer items-center gap-2">
				<input type="checkbox" checked={settings.cleanup} disabled={disabled} onChange={(e) => { void saveSettings({ cleanup: e.target.checked }); }} />
				Убирать слова-паразиты и случайные повторы
			</label>
			<p className="text-muted-foreground">Дополнительная обработка через Groq. Если она недоступна, сохраняется исходная расшифровка. Результат можно поправить перед отправкой.</p>
			<div className="space-y-2">
				<label htmlFor="dictation-glossary" className="block">Термины и имена</label>
				<textarea id="dictation-glossary" rows={3} value={glossary} maxLength={MAX_DICTATION_GLOSSARY} disabled={disabled}
					className="w-full resize-y rounded-md border border-border bg-background px-2 py-2 disabled:opacity-40"
					placeholder="Например: Коши, коллоквиум, дифференцируемость, Python"
					onChange={(e) => setGlossary(e.target.value)} />
				<div className="flex items-center justify-between gap-2">
					<span className="text-muted-foreground">{glossary.length}/{MAX_DICTATION_GLOSSARY}</span>
					<button type="button" className="rounded-md border border-border px-2 py-1.5 hover:bg-accent disabled:opacity-40" disabled={disabled || glossary === settings.glossary}
						onClick={() => { void saveSettings({ glossary }); }}>Сохранить словарь</button>
				</div>
			</div>
		</div>}
		{saving && <p role="status" className="px-1 text-xs text-muted-foreground">Сохранение…</p>}
		{error && <p role="alert" className="px-1 text-xs text-destructive">{error}</p>}
	</div>;
}
