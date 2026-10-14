const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const sqlite3 = require('sqlite3').verbose();
const path = require('node:path');

(async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  new Function(html.split('<script>')[1].split('</script>')[0]);
  const dir = fs.mkdtempSync(path.join(__dirname, 'yny-logs-'));
  const port = 39000 + Math.floor(Math.random() * 1000);
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, PORT: String(port), DATA_DIR: dir, CLIENT_TOKEN: 'test-client', ADMIN_KEY: 'test-admin' },
    stdio: 'ignore'
  });
  const base = `http://127.0.0.1:${port}`;
  try {
    let ready = false;
    for (let i = 0; i < 50; i++) {
      await new Promise(resolve => setTimeout(resolve, 100));
      try {
        const response = await fetch(`${base}/api/admin/stats`, { headers: { 'x-admin-key': 'test-admin' } });
        if (response.ok) { ready = true; break; }
      } catch (_) { }
    }
    assert.ok(ready, 'server did not start');
    const body = {
      installId: 'test-install', shortId: 'ABC123', nick: 'Tester', server: 'local',
      entries: [{ id: 'entry-1', time: '2026-10-14 12:00:00.000', category: 'Combat', message: 'event=hit', nick: 'OriginalPlayer', server: 'pvp.example' }]
    };
    const denied = await fetch(`${base}/api/telemetry/logs`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
    });
    assert.equal(denied.status, 403);
    const adminDenied = await fetch(`${base}/api/admin/logs`);
    assert.equal(adminDenied.status, 401);
    for (let i = 0; i < 2; i++) {
      const response = await fetch(`${base}/api/telemetry/logs`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-client-token': 'test-client' },
        body: JSON.stringify(body)
      });
      assert.equal(response.status, 200);
    }
    const response = await fetch(`${base}/api/admin/logs?installId=test-install`, {
      headers: { 'x-admin-key': 'test-admin' }
    });
    assert.equal(response.status, 200);
    const rows = await response.json();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].category, 'Combat');
    assert.equal(rows[0].nick, 'OriginalPlayer');
    assert.equal(rows[0].server, 'pvp.example');
    assert.equal(rows[0].message, 'event=hit');
    const dbPath = path.join(dir, 'telemetry.db');
    await new Promise((resolve, reject) => {
      const db = new sqlite3.Database(dbPath);
      db.run("UPDATE diagnostic_logs SET received_at = datetime('now', '-31 minutes') WHERE entry_id = ?", ['entry-1'], err => {
        db.close();
        err ? reject(err) : resolve();
      });
    });
    const oldResponse = await fetch(`${base}/api/admin/logs?installId=test-install`, {
      headers: { 'x-admin-key': 'test-admin' }
    });
    assert.equal(oldResponse.status, 200);
    const oldRows = await oldResponse.json();
    assert.equal(oldRows.length, 1);
    assert.equal(oldRows[0].message, 'event=hit');
    const remaining = await new Promise((resolve, reject) => {
      const db = new sqlite3.Database(dbPath);
      db.get('SELECT COUNT(*) AS count FROM diagnostic_logs', (err, row) => {
        db.close();
        err ? reject(err) : resolve(row.count);
      });
    });
    assert.equal(remaining, 1, 'remote logs must remain in SQLite');
    console.log('PASS: ingest, deduplication, admin query and indefinite remote retention');
  } finally {
    child.kill();
    await new Promise(resolve => child.once('exit', resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
