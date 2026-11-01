/**
 * Turn liveness registry unit tests (src/server/turn-liveness.ts): one turn
 * per chat, ever — begin/end round trip, double-begin rejection, restart
 * after end. The 30-minute stale-eviction TTL is not tested (it is a leak
 * guard, not a behavior). The lifecycle-emitter pins ride the same seams:
 * turn-started on the accepted begin only, turn-settled on the live end
 * only, and the registry already consistent when the listener runs.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { beginTurn, endTurn, isTurnRunning } from "../src/server/turn-liveness.ts";
import { subscribe, type ServerEvent } from "../src/core/events.ts";
import { rememberTurnFailure, settledTurnResponse } from "../src/server/turn-runs.ts";

describe("turn liveness registry", () => {
	it("retains a late-attach failure notice until the next accepted begin", async () => {
		const id = "chat_failure_notice_unit";
		rememberTurnFailure(id, "The reply could not be saved.");
		assert.match(await settledTurnResponse(id).text(), /The reply could not be saved\./);
		assert.match(await settledTurnResponse(id).text(), /The reply could not be saved\./, "reading does not consume the notice");
		assert.equal(beginTurn(id), true);
		assert.doesNotMatch(await settledTurnResponse(id).text(), /"type":"error"/);
		endTurn(id);
	});

	it("begin/end round trip; a second begin is rejected until the turn ends", () => {
		const id = "chat_liveness_unit";
		assert.equal(isTurnRunning(id), false, "initially idle");
		assert.equal(beginTurn(id), true, "first turn accepted");
		assert.equal(isTurnRunning(id), true, "in flight");
		assert.equal(beginTurn(id), false, "no two turns for one chat");
		endTurn(id);
		assert.equal(isTurnRunning(id), false, "cleared at finish");
		assert.equal(beginTurn(id), true, "a new turn may start after the last ended");
		endTurn(id);
	});
});

describe("turn lifecycle events", () => {
	it("desktop settlement emits one private attention packet; closing IPC never breaks settlement", () => {
		const send = Object.getOwnPropertyDescriptor(process, "send"), connected = Object.getOwnPropertyDescriptor(process, "connected"), marker = process.env.LH_DESKTOP_SERVER;
		const packets: unknown[] = [];
		try {
			process.env.LH_DESKTOP_SERVER = "1";
			Object.defineProperty(process, "connected", { configurable: true, value: true });
			Object.defineProperty(process, "send", { configurable: true, value: (packet: unknown) => { packets.push(packet); } });
			beginTurn("chat_attention_unit"); endTurn("chat_attention_unit"); endTurn("chat_attention_unit");
			assert.deepEqual(packets, [{ channel: "lh:attention", chatId: "chat_attention_unit" }]);
			Object.defineProperty(process, "send", { configurable: true, value: () => { throw new Error("closed"); } });
			beginTurn("chat_attention_closed"); assert.doesNotThrow(() => endTurn("chat_attention_closed"));
			assert.equal(isTurnRunning("chat_attention_closed"), false);
		} finally {
			if (send) Object.defineProperty(process, "send", send); else delete process.send;
			if (connected) Object.defineProperty(process, "connected", connected); else delete (process as { connected?: boolean }).connected;
			if (marker === undefined) delete process.env.LH_DESKTOP_SERVER; else process.env.LH_DESKTOP_SERVER = marker;
		}
	});
	it("beginTurn emits turn-started on success only — the 409 double-begin stays silent", () => {
		const id = "chat_events_begin";
		const got: ServerEvent[] = [];
		const off = subscribe((e) => got.push(e));
		assert.equal(beginTurn(id), true, "fresh chat accepts the turn");
		assert.equal(beginTurn(id), false, "the rejected double-begin");
		assert.deepEqual(got, [{ type: "turn-started", chatId: id }], "exactly one event");
		endTurn(id); // cleanup (its settle is asserted in the next case's terms)
		off();
	});

	it("endTurn emits turn-settled only when a live entry was present", () => {
		const id = "chat_events_end";
		const got: ServerEvent[] = [];
		let runningAtSettle: boolean | undefined;
		const off = subscribe((e) => {
			got.push(e);
			// The settle must be observable as already-idle: the registry
			// write happens BEFORE the emit, so a listener that fetches truth
			// (the whole point of notify → fetch) reads consistent state.
			if (e.type === "turn-settled") runningAtSettle = isTurnRunning(id);
		});
		beginTurn(id);
		got.length = 0; // focus on the settle path
		endTurn(id); // live entry → settle
		endTurn(id); // absent entry → defensive no-op, must stay silent
		assert.deepEqual(got, [{ type: "turn-settled", chatId: id }]);
		assert.equal(runningAtSettle, false, "listener sees the registry already cleared");
		off();
	});
});
