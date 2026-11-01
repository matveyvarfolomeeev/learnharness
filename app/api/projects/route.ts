import { projectsView, updateProjects } from "@/src/server";

export const dynamic = "force-dynamic";
export async function GET() { return Response.json(projectsView()); }
export async function PUT(request: Request) {
	const body = await request.json().catch(() => null);
	if (!body || typeof body !== "object" || Array.isArray(body)) return Response.json({ error: "Нужен объект" }, { status: 400 });
	const result = updateProjects(body);
	return Response.json(result, { status: result.status });
}
