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
const { POST, GET } = await import(url('app/api/agent-jobs/route.ts'));
async function claim(id) {
  return POST(new Request('http://127.0.0.1/api/agent-jobs', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-radar-local-agent': '1' },
    body: JSON.stringify({ id, status: 'running' }),
  }));
}
function job(idea) {
  return Number(sql.prepare("INSERT INTO agent_jobs(idea_id,action,button_label,instruction,user_feedback,card_context,status) VALUES (?,'do','Run','Run','','{}','queued')").run(idea).lastInsertRowid);
}
card(1, 'working');
const older = job(1), newer = job(1);
assert.equal((await claim(older)).status, 409);
assert.equal(sql.prepare('SELECT status FROM agent_jobs WHERE id=?').get(older).status, 'queued');
assert.equal((await claim(newer)).status, 200);
assert.equal(sql.prepare('SELECT status FROM agent_jobs WHERE id=?').get(newer).status, 'running');
for (const status of ['rejected', 'acknowledged', 'done']) {
  card(10 + ['rejected', 'acknowledged', 'done'].indexOf(status), status);
  assert.equal((await claim(job(10 + ['rejected', 'acknowledged', 'done'].indexOf(status)))).status, 409);
}
card(20, 'working');
const raced = job(20);
const originalFirst = Statement.prototype.first;
let injected = false;
Statement.prototype.first = async function () {
  const result = await originalFirst.call(this);
  if (!injected && this.text.startsWith('SELECT idea_id AS ideaId')) {
    injected = true;
    job(20); // New click after initial status read, immediately before atomic claim.
  }
  return result;
};
assert.equal((await claim(raced)).status, 409);
assert.equal(sql.prepare('SELECT status FROM agent_jobs WHERE id=?').get(raced).status, 'queued');
const available = await (await GET(new Request('http://127.0.0.1/api/agent-jobs', {headers:{'x-radar-local-agent':'1'}}))).json();
assert.ok(available.jobs.every(job => job.ideaId === 20));
console.log(JSON.stringify({status:'passed', checks:['superseded approval rejected','latest approval runs','dismissed or completed idea rejected','new click between read and claim rejected']}));
