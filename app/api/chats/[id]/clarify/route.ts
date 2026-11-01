import { handleClarification } from "@/src/server";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
	return handleClarification(req, (await params).id);
}
