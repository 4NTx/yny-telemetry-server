const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const CLIENT_TOKEN = process.env.CLIENT_TOKEN;
const ADMIN_KEY = process.env.ADMIN_KEY;
if (!CLIENT_TOKEN || !ADMIN_KEY) throw new Error('Configure CLIENT_TOKEN e ADMIN_KEY antes de iniciar.');

app.set('trust proxy', 1);
app.use(cors());
app.use(express.json({ limit: '128kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Inicializa banco de dados SQLite persistente em pasta data/
const fs = require('fs');
const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}
const dbPath = path.join(dataDir, 'telemetry.db');

const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Erro ao conectar ao banco de dados SQLite:', err);
    } else {
        console.log(`Conectado ao banco de dados SQLite (${dbPath})`);
        initSchema();
    }
});

function initSchema() {
    db.serialize(() => {
        // Tabela de instalações únicas
        db.run(`
            CREATE TABLE IF NOT EXISTS installations (
                install_id TEXT PRIMARY KEY,
                short_id TEXT NOT NULL,
                first_seen DATETIME NOT NULL,
                last_seen DATETIME NOT NULL,
                last_nick TEXT NOT NULL,
                last_server TEXT NOT NULL,
                last_clan TEXT,
                version TEXT NOT NULL,
                total_events INTEGER DEFAULT 1,
                is_flagged INTEGER DEFAULT 0,
                notes TEXT
            )
        `);

        // Tabela de histórico de eventos de auditoria
        db.run(`
            CREATE TABLE IF NOT EXISTS telemetry_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                install_id TEXT NOT NULL,
                short_id TEXT NOT NULL,
                nick TEXT NOT NULL,
                server TEXT NOT NULL,
                clan TEXT,
                version TEXT NOT NULL,
                event_type TEXT NOT NULL,
                ip_address TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (install_id) REFERENCES installations (install_id)
            )
        `);

        // Índices para otimização de busca rápida
        db.run(`
            CREATE TABLE IF NOT EXISTS diagnostic_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                install_id TEXT NOT NULL,
                entry_id TEXT NOT NULL,
                short_id TEXT NOT NULL,
                nick TEXT NOT NULL,
                server TEXT NOT NULL,
                log_time TEXT NOT NULL,
                category TEXT NOT NULL,
                message TEXT NOT NULL,
                received_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(install_id, entry_id)
            )
        `);
        db.run(`CREATE INDEX IF NOT EXISTS idx_logs_install ON diagnostic_logs(install_id, id)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_logs_category ON diagnostic_logs(category, id)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_logs_received ON diagnostic_logs(received_at)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_install_short ON installations(short_id)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_install_nick ON installations(last_nick)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_events_install ON telemetry_events(install_id)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_events_created ON telemetry_events(created_at)`);
        pruneDiagnosticLogs();
    });
}

// Rate Limiting para proteger o endpoint de eventos (máx 30 requisições por minuto por IP)
const telemetryLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    message: { error: 'Limite de requisições excedido. Tente novamente mais tarde.' }
});

// Middleware de autenticação administrativa
function requireAdmin(req, res, next) {
    const key = req.headers['x-admin-key'];
    if (!key || key !== ADMIN_KEY) {
        return res.status(401).json({ error: 'Acesso administrativo não autorizado.' });
    }
    next();
}

/**
 * Endpoint de Coleta de Telemetria
 * Recebe eventos de utilização legítima da modpack (LAUNCH, SERVER_JOIN, SERVER_LEAVE)
 */
app.post('/api/telemetry/event', telemetryLimiter, (req, res) => {
    const clientToken = req.headers['x-client-token'];
    if (CLIENT_TOKEN && clientToken !== CLIENT_TOKEN) {
        return res.status(403).json({ error: 'Token de cliente inválido.' });
    }

    const { installId, shortId, nick, server, clan, version, eventType, timestamp } = req.body;

    if (!installId || !shortId || !nick || !eventType) {
        return res.status(400).json({ error: 'Dados incompletos no evento.' });
    }

    // Sanitização de entradas
    const sInstallId = String(installId).substring(0, 64);
    const sShortId = String(shortId).substring(0, 16);
    const sNick = String(nick).substring(0, 32);
    const sServer = String(server || 'offline').substring(0, 64);
    const sClan = clan ? String(clan).substring(0, 16) : '';
    const sVersion = String(version || '1.0.0').substring(0, 16);
    const sEventType = String(eventType).substring(0, 24);
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';

    const nowIso = new Date().toISOString();

    db.serialize(() => {
        // Registra ou atualiza a instalação
        const upsertQuery = `
            INSERT INTO installations (install_id, short_id, first_seen, last_seen, last_nick, last_server, last_clan, version, total_events)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
            ON CONFLICT(install_id) DO UPDATE SET
                short_id = excluded.short_id,
                last_seen = excluded.last_seen,
                last_nick = excluded.last_nick,
                last_server = excluded.last_server,
                last_clan = excluded.last_clan,
                version = excluded.version,
                total_events = installations.total_events + 1
        `;

        db.run(upsertQuery, [sInstallId, sShortId, nowIso, nowIso, sNick, sServer, sClan, sVersion], function (err) {
            if (err) {
                console.error('Erro ao atualizar instalação:', err);
            }
        });

        // Insere o evento no log de auditoria
        const insertEventQuery = `
            INSERT INTO telemetry_events (install_id, short_id, nick, server, clan, version, event_type, ip_address)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `;

        db.run(insertEventQuery, [sInstallId, sShortId, sNick, sServer, sClan, sVersion, sEventType, ip], function (err) {
            if (err) {
                console.error('Erro ao inserir evento:', err);
                return res.status(500).json({ error: 'Erro ao registrar evento.' });
            }
            res.json({ ok: true, id: this.lastID });
        });
    });
});

/**
 * Endpoints Administrativos (Painel de Auditoria)
 */

// Estatísticas globais
app.get('/api/admin/stats', requireAdmin, (req, res) => {
    const stats = {};
    db.get('SELECT COUNT(*) as totalInstallations FROM installations', (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        stats.totalInstallations = row.totalInstallations;

        db.get('SELECT COUNT(DISTINCT nick) as distinctNicks FROM telemetry_events', (err2, row2) => {
            if (err2) return res.status(500).json({ error: err2.message });
            stats.distinctNicks = row2.distinctNicks;

            // Ativos nos últimos 15 minutos
            const fifteenMinAgo = new Date(Date.now() - 15 * 60 * 1000).toISOString();
            db.get('SELECT COUNT(*) as activeRecently FROM installations WHERE last_seen >= ?', [fifteenMinAgo], (err3, row3) => {
                if (err3) return res.status(500).json({ error: err3.message });
                stats.activeRecently = row3.activeRecently;

                // Total de eventos
                db.get('SELECT COUNT(*) as totalEvents FROM telemetry_events', (err4, row4) => {
                    if (err4) return res.status(500).json({ error: err4.message });
                    stats.totalEvents = row4.totalEvents;
                    res.json(stats);
                });
            });
        });
    });
});

// Lista todas as instalações com agregação dos nicks utilizados
app.get('/api/admin/installations', requireAdmin, (req, res) => {
    const search = req.query.search ? `%${req.query.search}%` : '%';
    const query = `
        SELECT 
            i.install_id,
            i.short_id,
            i.first_seen,
            i.last_seen,
            i.last_nick,
            i.last_server,
            i.last_clan,
            i.version,
            i.total_events,
            (SELECT GROUP_CONCAT(DISTINCT nick) FROM telemetry_events WHERE install_id = i.install_id) as all_nicks
        FROM installations i
        WHERE i.install_id LIKE ? OR i.short_id LIKE ? OR i.last_nick LIKE ? OR i.last_server LIKE ?
        ORDER BY i.last_seen DESC
        LIMIT 200
    `;
    db.all(query, [search, search, search, search], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// Histórico de eventos de telemetria
app.get('/api/admin/events', requireAdmin, (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const search = req.query.search ? `%${req.query.search}%` : '%';
    const query = `
        SELECT id, install_id, short_id, nick, server, clan, version, event_type, created_at
        FROM telemetry_events
        WHERE short_id LIKE ? OR nick LIKE ? OR server LIKE ? OR install_id LIKE ?
        ORDER BY id DESC
        LIMIT ?
    `;
    db.all(query, [search, search, search, search, limit], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

/** Receives bounded batches from the durable client log spool. */
app.post('/api/telemetry/logs', telemetryLimiter, (req, res) => {
    if (CLIENT_TOKEN && req.headers['x-client-token'] !== CLIENT_TOKEN) {
        return res.status(403).json({ error: 'Token de cliente inválido.' });
    }
    const { installId, shortId, nick, server, entries } = req.body || {};
    if (typeof installId !== 'string' || !installId || typeof shortId !== 'string' || !shortId ||
        !Array.isArray(entries) || entries.length < 1 || entries.length > 25) {
        return res.status(400).json({ error: 'Lote inválido.' });
    }
    const rows = [];
    for (const entry of entries) {
        if (!entry || typeof entry.id !== 'string' || typeof entry.time !== 'string' ||
            typeof entry.category !== 'string' || typeof entry.message !== 'string' ||
            entry.id.length > 48 || entry.time.length > 32 || entry.category.length > 64 ||
            entry.message.length > 8192) {
            return res.status(400).json({ error: 'Registro inválido.' });
        }
        rows.push([installId.slice(0, 64), entry.id, shortId.slice(0, 16),
            String(entry.nick || nick || 'Jogador').slice(0, 32), String(entry.server || server || 'local').slice(0, 128),
            entry.time, entry.category, entry.message]);
    }
    db.serialize(() => {
        db.run('BEGIN IMMEDIATE', err => {
            if (err) return res.status(500).json({ error: 'Banco indisponível.' });
            const stmt = db.prepare(`INSERT OR IGNORE INTO diagnostic_logs
                (install_id, entry_id, short_id, nick, server, log_time, category, message)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
            for (const row of rows) stmt.run(row);
            stmt.finalize(err2 => {
                if (err2) return db.run('ROLLBACK', () => res.status(500).json({ error: 'Falha ao gravar lote.' }));
                db.run('COMMIT', err3 => {
                    if (err3) return res.status(500).json({ error: 'Falha ao confirmar lote.' });
                    res.json({ ok: true, accepted: rows.length });
                });
            });
        });
    });
});

const LOG_RETENTION_SQL = "DELETE FROM diagnostic_logs WHERE received_at <= datetime('now', '-30 minutes')";

function pruneDiagnosticLogs(callback) {
    db.run(LOG_RETENTION_SQL, err => {
        if (err) console.error('Falha ao remover logs expirados:', err);
        if (callback) callback(err);
    });
}

const logPruneTimer = setInterval(pruneDiagnosticLogs, 30 * 1000);
logPruneTimer.unref();
app.get('/api/admin/logs', requireAdmin, (req, res) => {
    const limit = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 100, 500));
    const before = Math.max(1, parseInt(req.query.before, 10) || Number.MAX_SAFE_INTEGER);
    const installId = String(req.query.installId || '');
    const category = String(req.query.category || '');
    const search = String(req.query.search || '').slice(0, 100);
    pruneDiagnosticLogs(err => {
        if (err) return res.status(500).json({ error: 'Falha ao limpar logs expirados.' });
        db.all(`SELECT id, install_id, short_id, nick, server, log_time, category, message, received_at
            FROM diagnostic_logs WHERE received_at > datetime('now', '-30 minutes')
            AND id < ? AND (? = '' OR install_id = ? OR short_id = ?)
            AND (? = '' OR category = ?) AND (? = '' OR message LIKE ?)
            ORDER BY id DESC LIMIT ?`,
            [before, installId, installId, installId, category, category, search, `%${search}%`, limit],
            (queryErr, rows) => queryErr ? res.status(500).json({ error: queryErr.message }) : res.json(rows));
    });
});
app.listen(PORT, () => {
    console.log(`=======================================================`);
    console.log(`  Servidor de Telemetria e Auditoria YNY Modpack`);
    console.log(`  Porta: http://localhost:${PORT}`);
    console.log(`  Painel Web: http://localhost:${PORT}/index.html`);
    console.log(`=======================================================`);
});
