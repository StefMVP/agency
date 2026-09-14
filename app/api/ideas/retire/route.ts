import { env } from "cloudflare:workers";
import { ensureDatabase } from "../../../../db";

export async function POST(request: Request) {
  const url = new URL(request.url);
  const key = (env as unknown as { RADAR_AGENT_KEY?: string }).RADAR_AGENT_KEY;
  const authorized = !request.headers.get("origin") && ((["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) && request.headers.get("x-radar-local-agent") === "1") || (key && request.headers.get("x-radar-agent-key") === key));
  if (!authorized) return Response.json({ error: "Missing agent key" }, { status: 401 });
  const payload = await request.json() as { ids?: number[]; reason?: string };
  if (!Array.isArray(payload.ids) || !payload.ids.length || payload.ids.length > 100 || payload.ids.some(id => !Number.isSafeInteger(id) || id <= 0) || typeof payload.reason !== "string" || !payload.reason.trim() || payload.reason.length > 2000) return Response.json({ error: "IDs and retirement reason required" }, { status: 400 });
  const db = await ensureDatabase();
  const ids = [...new Set(payload.ids)];
  const retired: number[] = [];
  const skipped: number[] = [];
  for (const id of ids) {
    // The atomic update refuses active jobs and keeps the original dedupe tombstone.
    // The feedback insert is guarded by changes() within the same database batch.
    await db.batch([
      db.prepare("UPDATE ideas SET status = 'rejected', version = version + 1 WHERE id = ? AND status IN ('new', 'working') AND NOT EXISTS (SELECT 1 FROM agent_jobs WHERE idea_id = ideas.id AND status IN ('queued', 'running'))").bind(id),
      db.prepare("INSERT INTO feedback (idea_id, decision, note) SELECT ?, 'retire', ? WHERE changes() = 1").bind(id, payload.reason.trim()),
    ]);
    const row = await db.prepare("SELECT status FROM ideas WHERE id = ?").bind(id).first<{ status: string }>();
    (row?.status === "rejected" ? retired : skipped).push(id);
  }
  return Response.json({ ok: true, retired, skipped });
}
