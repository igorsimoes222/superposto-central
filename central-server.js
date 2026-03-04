const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const DB_FILE = path.join(__dirname, 'clientes.json');

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function lerDB() {
  try {
    if (fs.existsSync(DB_FILE)) return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch(e) {}
  return {};
}

function salvarDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

function agora() {
  return new Date().toISOString();
}

// ─── PING - recebe heartbeat dos clientes ─────────────────────────────────────
app.post('/api/ping', (req, res) => {
  const { hostname, ip, versao, postos } = req.body;
  if (!hostname) return res.status(400).json({ erro: 'hostname obrigatorio' });

  const db = lerDB();
  const id = crypto.createHash('md5').update(hostname).digest('hex').slice(0, 8);

  db[id] = {
    id,
    hostname,
    ip: ip || 'desconhecido',
    versao: versao || '1.0.0',
    postos: postos || 0,
    ultimoPing: agora(),
    primeiroAcesso: db[id]?.primeiroAcesso || agora(),
    online: true,
  };

  salvarDB(db);
  res.json({ ok: true, id });
});

// ─── STATUS - painel consulta isso ───────────────────────────────────────────
app.get('/api/status', (req, res) => {
  // Verifica token simples
  const token = req.headers['x-token'];
  if (token !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ erro: 'nao autorizado' });
  }

  const db = lerDB();
  const agora5min = Date.now() - 5 * 60 * 1000;

  const clientes = Object.values(db).map(c => ({
    ...c,
    online: new Date(c.ultimoPing).getTime() > agora5min,
  }));

  const online = clientes.filter(c => c.online).length;
  const total  = clientes.length;

  res.json({ ok: true, online, total, clientes });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Central rodando na porta ${PORT}`));
