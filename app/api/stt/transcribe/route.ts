import { dictationReady, handleDictation } from "@/src/server";

export const GET = dictationReady;
export async function POST(req: Request) { return handleDictation(req); }
