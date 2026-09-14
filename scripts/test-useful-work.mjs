// Offline verification of the actual route and schema against in-memory SQLite.
// Run from the Agency checkout: node scripts/test-queue-claims.mjs
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
  async run() { return { meta: sql.prepare(this.text).run(...this.args) }; }
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
function card(id, status = 'new') {
  const columns = sql.prepare('PRAGMA table_info(ideas)').all().filter(column => column.name === 'id' || (column.notnull && !column.dflt_value));
  const names = columns.map(column => column.name);
  const values = columns.map(column => column.name === 'id' ? id : column.name === 'dedupe_key' ? 'fixture-' + id : column.type === 'INTEGER' ? 80 : 'fixture');
  sql.prepare(`INSERT INTO ideas (${names.join(',')}) VALUES (${names.map(() => '?').join(',')})`).run(...values);
  sql.prepare("UPDATE ideas SET status=?, card_html='<p>Representative offline fixture</p>',category='engineering' WHERE id=?").run(status, id);
}
const { POST } = await import(url('app/api/ideas/retire/route.ts'));
const { cardIngestMode } = await import(url('lib/blocked-card.ts'));
async function retire(ids, headers = {'x-radar-local-agent':'1'}) {
  return POST(new Request('http://127.0.0.1/api/ideas/retire', {method:'POST',headers,body:JSON.stringify({ids,reason:'User requested homework cleanup; no topic inference'})}));
}
card(1); card(2,'working'); card(3,'done');
sql.prepare("INSERT INTO agent_jobs(idea_id,action,button_label,instruction,user_feedback,card_context,status) VALUES (2,'do','Run','Run','','{}','running')").run();
assert.equal((await retire([1],{})).status,401);
assert.equal((await retire([1],{'origin':'http://127.0.0.1','x-radar-local-agent':'1'})).status,401);
assert.equal((await retire([-1])).status,400);
let response = await retire([1,2,3]); assert.equal(response.status,200);
assert.deepEqual(await response.json(),{ok:true,retired:[1],skipped:[2,3]});
assert.equal(sql.prepare('SELECT status FROM ideas WHERE id=1').get().status,'rejected');
assert.equal(sql.prepare('SELECT dedupe_key FROM ideas WHERE id=1').get().dedupe_key,'fixture-1');
assert.equal(sql.prepare('SELECT status FROM agent_jobs WHERE idea_id=2').get().status,'running');
assert.equal(sql.prepare('SELECT decision FROM feedback WHERE idea_id=1').get().decision,'retire');
await retire([1]); assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM feedback').get().n,1);
const ready = '<article data-radar-state="ready"><button data-radar-action="open" data-radar-url="/agent-assets/useful-work/'+'a'.repeat(64)+'.html">Open result</button></article>';
assert.equal(cardIngestMode(ready),'actionable');
assert.equal(cardIngestMode(ready.replace('/agent-assets/useful-work/','https://evil.example/')),null);
assert.equal(cardIngestMode(ready.replace('data-radar-state="ready"','')),null);
assert.equal(cardIngestMode(ready.replace('a'.repeat(64),'../secret')),null);
assert.equal(cardIngestMode(ready,1,1),null);
console.log(JSON.stringify({status:'passed',checks:['retirement auth','input validation','history preserved','active jobs preserved','done preserved','retirement idempotent','local ready artifact only']}));
