"use strict";

/** Native attention only; the existing server API remains the authority for pending input. */
function createAnswerNotifications({ Notification, getWindow, getSnapshot, enabled, openChat, log = () => {} }) {
	const seen = new Map();
	const revisions = new Map();
	const visible = new Map();
	let disposed = false;
	function close(id) { const note = visible.get(id); visible.delete(id); note?.close(); }
	function show(id, title, preview = false) {
		const win = getWindow();
		if (!win || win.isDestroyed() || disposed) return Promise.resolve(false);
		if (!preview) win.flashFrame(true);
		if (!Notification.isSupported()) return Promise.resolve(false);
		close(id);
		return new Promise((resolve) => {
			let note;
			const timer = setTimeout(() => resolve(false), 5000);
			timer.unref?.();
			const finish = (ok) => { clearTimeout(timer); resolve(ok); };
			try {
				note = new Notification({
					title: preview ? "LearnHarness — уведомления включены" : "LearnHarness — нужен твой ответ",
					body: preview ? "Так появится уведомление, когда будет готов новый вопрос." : `${title}\nПоявился вопрос. Нажми, чтобы открыть диалог.`,
					silent: false,
				});
				visible.set(id, note);
				note.once("show", () => { log("answer notification shown"); finish(true); });
				note.once("failed", () => { log("answer notification failed"); finish(false); if (visible.get(id) === note) visible.delete(id); });
				note.once("close", () => { if (visible.get(id) === note) visible.delete(id); });
				note.once("click", () => {
					if (win.isDestroyed()) return;
					if (win.isMinimized()) win.restore();
					win.show(); win.focus(); win.flashFrame(false);
					if (!preview) openChat(id);
					close(id);
				});
				note.show();
			} catch { log("answer notification failed"); finish(false); }
		});
	}
	return {
		async receive(packet) {
			if (disposed || packet?.channel !== "lh:attention" || typeof packet.chatId !== "string" || !/^chat_[a-zA-Z0-9_-]{1,120}$/.test(packet.chatId)) return false;
			const id = packet.chatId;
			const revision = (revisions.get(id) ?? 0) + 1;
			revisions.set(id, revision);
			try {
				const snapshot = await getSnapshot(id);
				if (disposed || revisions.get(id) !== revision) return false;
				if (!snapshot?.pendingQuestion || snapshot.busy || snapshot.compacting) { close(id); return false; }
				if (typeof snapshot.updatedAt !== "string" || seen.get(id) === snapshot.updatedAt) return false;
				seen.set(id, snapshot.updatedAt);
				const win = getWindow();
				if (!enabled() || !win || win.isDestroyed() || win.isFocused()) return false;
				return await show(id, String(snapshot.title ?? "Учебный диалог").slice(0, 160));
			} catch { log("answer notification state unavailable"); return false; }
		},
		test: () => show("preview", "", true),
		dispose() { disposed = true; for (const id of [...visible.keys()]) close(id); seen.clear(); revisions.clear(); },
	};
}

module.exports = { createAnswerNotifications };
