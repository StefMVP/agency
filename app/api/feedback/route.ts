import { env } from "cloudflare:workers";
import { ensureDatabase } from "../../../db";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const origin = request.headers.get("origin");
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  const key = (env as unknown as { RADAR_AGENT_KEY?: string }).RADAR_AGENT_KEY;
  const authorized = !origin && ((loopback && request.headers.get("x-radar-local-agent") === "1") || (key && request.headers.get("x-radar-agent-key") === key));
  if (!authorized) return Response.json({ error: "Missing agent key" }, { status: 401 });
  const after = Number(url.searchParams.get("after") ?? "0");
  if (!Number.isSafeInteger(after) || after < 0) return Response.json({ error: "Invalid cursor" }, { status: 400 });
  const db = await ensureDatabase();
  const rows = await db.prepare(`SELECT f.id, f.idea_id AS ideaId, f.decision, f.note,
    f.created_at AS createdAt, i.category, i.headline, i.dedupe_key AS dedupeKey
    FROM feedback f JOIN ideas i ON i.id = f.idea_id WHERE f.id > ? ORDER BY f.id LIMIT 100`).bind(after).all();
  return Response.json({ feedback: rows.results });
}
