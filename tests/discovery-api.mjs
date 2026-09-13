// Offline verification of the actual route and schema against in-memory SQLite.
// Run from the Agency checkout: node tests/discovery-api.mjs
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import ts from 'typescript';

const sql = new DatabaseSync(':memory:');
class Statement {
  constructor(text, args = []) { this.text = text; this.args = args; }
  bind(...args) { return new Statement(this.text, args); }
  async first() { return sql.prepare(this.text).get(...this.args) ?? null; }
  async all() { return { results: sql.prepare(this.text).all(...this.args) }; }
  async run() { return sql.prepare(this.text).run(...this.args); }
}
globalThis.__ackTestDB = {
  prepare: text => new Statement(text),
  batch: async statements => {
    sql.exec('BEGIN');
    try {
      const rows = [];
      for (const statement of statements) rows.push(await statement.run());
      sql.exec('COMMIT');
      return rows;
    } catch (error) {
      sql.exec('ROLLBACK');
      throw error;
    }
  },
};
const cache = new Map();
function url(file) {
  file = resolve(file);
  if (cache.has(file)) return cache.get(file);
  let source = readFileSync(file, 'utf8');
  source = source.replace('import { env } from "cloudflare:workers";', 'const env = { DB: globalThis.__ackTestDB };');
  source = source.replace(/from "(\.{1,2}\/[^"]+)"/g, (_, relative) => {
    let target = resolve(dirname(file), relative);
    if (relative.endsWith('/db')) target += '/index';
    return 'from "' + url(target + '.ts') + '"';
  });
  const js = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
  }).outputText;
  const data = 'data:text/javascript;base64,' + Buffer.from(js).toString('base64');
  cache.set(file, data);
  return data;
}
const { ensureDatabase } = await import(url('db/index.ts'));
await ensureDatabase();
const { POST } = await import(url('app/api/ideas/route.ts'));
const payload = { project: 'Test', category: 'Research', headline: 'A useful finding', dedupeKey: 'stable-key', createOnly: true,
  cardHtml: '<article><p>Representative saved review with a concrete local preparation action.</p><button data-radar-action="do">Prepare brief</button></article>',
  agentContext: { mode: 'prepare' }, rise: { reach: 5, impact: 8, strategicFit: 12, ease: 20 } };
const request = () => new Request('http://127.0.0.1/api/ideas', {method:'POST', headers:{'x-radar-local-agent':'1','content-type':'application/json'}, body: JSON.stringify(payload)});
let response = await POST(request());
assert.equal(response.status, 201);
const created = (await response.json()).idea;
for (const status of ['acknowledged','rejected','done','working']) {
 sql.prepare('UPDATE ideas SET status=? WHERE id=?').run(status, created.id);
 response = await POST(request());
 assert.equal(response.status, 200);
 assert.equal((await response.json()).created, false);
 const row = sql.prepare('SELECT status,version FROM ideas WHERE id=?').get(created.id);
 assert.equal(row.status,status); assert.equal(row.version,1);
}
const { GET } = await import(url('app/api/feedback/route.ts'));
assert.equal((await GET(new Request('http://127.0.0.1/api/feedback'))).status,401);
assert.equal((await GET(new Request('http://127.0.0.1/api/feedback',{headers:{origin:'http://evil.example','x-radar-local-agent':'1'}}))).status,401);
for (let i=0;i<105;i++) sql.prepare("INSERT INTO feedback(idea_id,decision,note) VALUES (?,'ack','handled')").run(created.id);
const feedbackRequest = after => new Request('http://127.0.0.1/api/feedback?after='+after,{headers:{'x-radar-local-agent':'1'}});
assert.equal((await GET(feedbackRequest('-1'))).status,400);
let rows = (await (await GET(feedbackRequest('0'))).json()).feedback;
assert.equal(rows.length,100); assert.equal(rows[0].decision,'ack'); assert.equal(rows[0].dedupeKey,'stable-key');
rows = (await (await GET(feedbackRequest(rows.at(-1).id))).json()).feedback;
assert.equal(rows.length,5);
console.log(JSON.stringify({status:'passed',checks:['create-only preserves ack/rejected/done/working and version','feedback auth and hostile origin','feedback invalid cursor and pagination']}));
