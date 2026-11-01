import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { test } from "node:test";
const { createAnswerNotifications } = createRequire(import.meta.url)("../electron/answer-notifications.cjs");

function fixture() {
	let focused = false, allowed = true, supported = true;
	let snapshot: any = { pendingQuestion: true, busy: false, compacting: false, title: "Матан", updatedAt: "1" };
	const notes: FakeNotification[] = [], opened: string[] = [], flashed: boolean[] = [];
	let restores = 0;
	class FakeNotification extends EventEmitter {
		static isSupported() { return supported; }
		constructor(readonly options: any) { super(); notes.push(this); }
		show() { this.emit("show"); }
		close() { this.emit("close"); }
	}
	const win = { isFocused: () => focused, isDestroyed: () => false, isMinimized: () => true, restore: () => { restores++; }, show() {}, focus() { focused = true; }, flashFrame: (on: boolean) => flashed.push(on) };
	const api = createAnswerNotifications({ Notification: FakeNotification, getWindow: () => win, getSnapshot: async () => snapshot, enabled: () => allowed, openChat: (id: string) => opened.push(id) });
	return { api, notes, opened, flashed, get restores() { return restores; }, focus(v: boolean) { focused = v; }, enable(v: boolean) { allowed = v; }, support(v: boolean) { supported = v; }, snapshot(v: any) { snapshot = v; } };
}
const packet = { channel: "lh:attention", chatId: "chat_example" };

test("new pending input in the background shows one native notification and click restores its chat", async () => {
	const f = fixture(); assert.equal(await f.api.receive(packet), true);
	assert.equal(f.notes.length, 1); assert.match(f.notes[0]!.options.body, /Матан/);
	await f.api.receive(packet); assert.equal(f.notes.length, 1);
	f.notes[0]!.emit("click"); assert.deepEqual(f.opened, [packet.chatId]); assert.equal(f.restores, 1); assert.deepEqual(f.flashed, [true, false]);
	f.api.dispose();
});
test("foreground and disabled notifications are consumed without delayed spam", async () => {
	for (const kind of ["focus", "enable"] as const) {
		const f = fixture(); f[kind](kind === "focus");
		assert.equal(await f.api.receive(packet), false); f.focus(false); f.enable(true);
		await f.api.receive(packet); assert.equal(f.notes.length, 0); f.api.dispose();
	}
});
test("background jobs, busy chats and answered questions do not notify", async () => {
	for (const changes of [{pendingQuestion:false},{busy:true},{compacting:true}]) {
		const f=fixture(); f.snapshot({pendingQuestion:true,updatedAt:"1",...changes});
		assert.equal(await f.api.receive(packet),false); assert.equal(f.notes.length,0); f.api.dispose();
	}
});
test("new questions can notify again; malformed packets and disposed owners cannot", async () => {
	const f=fixture(); await f.api.receive(packet);
	f.snapshot({pendingQuestion:true,title:"Python",updatedAt:"2"}); await f.api.receive(packet); assert.equal(f.notes.length,2);
	for(const bad of [{...packet,chatId:"../auth.json"},{...packet,channel:"other"},null]) assert.equal(await f.api.receive(bad),false);
	f.api.dispose(); assert.equal(await f.api.receive(packet),false);
});
test("a question deferred by compaction notifies once when its input gate clears", async () => {
	const f=fixture(); f.snapshot({pendingQuestion:true,compacting:true,updatedAt:"1"});
	assert.equal(await f.api.receive(packet),false);
	f.snapshot({pendingQuestion:true,compacting:false,updatedAt:"2"});
	assert.equal(await f.api.receive(packet),true); await f.api.receive(packet);
	assert.equal(f.notes.length,1); f.api.dispose();
});
test("test notification works while focused and does not navigate or invoke a model", async () => {
	const f=fixture(); f.focus(true); assert.equal(await f.api.test(),true);
	assert.match(f.notes[0]!.options.title,/уведомления включены/); f.notes[0]!.emit("click"); assert.deepEqual(f.opened,[]); f.api.dispose();
});
test("unsupported desktop notifications retain taskbar attention", async () => {
	const f=fixture(); f.support(false); assert.equal(await f.api.receive(packet),false); assert.deepEqual(f.flashed,[true]); assert.equal(f.notes.length,0); f.api.dispose();
});
