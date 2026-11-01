import { MASTERY_LABELS, type MasteryState } from "@/src/core";
import { saveManualMastery } from "@/src/server";
import { stores } from "@/src/server";
import { emit } from "@/src/core";

export async function PUT(request: Request) {
	const body = await request.json().catch(() => ({}));
	if (typeof body?.nodeId !== "string" || !Object.hasOwn(MASTERY_LABELS, body?.state)) return Response.json({ error: "Неверный узел или статус" }, { status: 400 });
	if (!stores.graphStore.readNodes().some((n) => n.id === body.nodeId)) return Response.json({ error: "Знание не найдено" }, { status: 404 });
	saveManualMastery(body.nodeId, { state: body.state as MasteryState, at: new Date().toISOString() });
	emit("activity-changed", {});
	return Response.json({ ok: true });
}
