import { runEvaluationSuite } from "@/lib/judge-core";

export async function GET() {
  return Response.json(runEvaluationSuite(), {
    headers: { "Cache-Control": "no-store" },
  });
}
