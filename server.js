const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mysql = require('mysql2/promise');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── PERSISTÊNCIA DOS POSTOS ─────────────────────────────────────────────────
const POSTOS_FILE = path.join(__dirname, 'postos.json');

function carregarPostosConfig() {
  try {
    if (fs.existsSync(POSTOS_FILE)) {
      return JSON.parse(fs.readFileSync(POSTOS_FILE, 'utf8'));
    }
  } catch (e) {}
  return [];
}

function salvarPostosConfig(configs) {
  fs.writeFileSync(POSTOS_FILE, JSON.stringify(configs, null, 2));
}

// Estado em memória
const postos = new Map();

function registrarPosto(cfg) {
  postos.set(cfg.id, {
    config: cfg,
    connection: null,
    status: 'desconectado',
    dados: null,
    ultimaAtualizacao: null,
    intervalo: null,
  });
}

// Carrega postos salvos
carregarPostosConfig().forEach(cfg => registrarPosto(cfg));

// ─── QUERY ───────────────────────────────────────────────────────────────────
async function buscarDadosPosto(posto) {
  const { config } = posto;

  try {
    if (!posto.connection) {
      posto.connection = await mysql.createConnection({
        host: config.host,
        port: config.port || 3306,
        user: config.user || 'root',
        password: config.password || '',
        database: 'POSTO',
        connectTimeout: 8000,
      });
      console.log(`[${config.nome}] ✅ MySQL conectado`);
    }

    // Pega os dois últimos registros de cada bico para calcular diff de encerrante
    const [rows] = await posto.connection.execute(`
      SELECT e.ID, e.BICO, e.TURNO, e.DATA, e.ENCERRANTE, e.ACUMULADO, e.UNITARIO, e.STATUS,
             b.DESCR AS NOME_BICO, b.PRODUTO, b.POSICAO, b.BOMBA, bm.DESCR AS NOME_BOMBA
      FROM turno.encturno e
      LEFT JOIN POSTO.bico b ON e.BICO = b.CODIGO
      LEFT JOIN POSTO.bomba bm ON b.BOMBA = bm.CODIGO
      INNER JOIN (
        SELECT e2.BICO, e2.ID,
               ROW_NUMBER() OVER (PARTITION BY e2.BICO ORDER BY e2.ID DESC) AS rn
        FROM turno.encturno e2
      ) ranked ON e.ID = ranked.ID AND ranked.rn <= 2
      ORDER BY e.BICO ASC, e.ID DESC
    `);

    // Agrupa por bico: [0] = atual (maior ID), [1] = anterior
    const porBico = new Map();
    rows.forEach(r => {
      if (!porBico.has(r.BICO)) porBico.set(r.BICO, []);
      porBico.get(r.BICO).push(r);
    });

    const dados = [];
    porBico.forEach((registros) => {
      const atual = registros[0];
      const anterior = registros[1] || null;
      const encAtual = parseFloat(atual.ENCERRANTE) || 0;
      const encAnterior = anterior ? (parseFloat(anterior.ENCERRANTE) || 0) : 0;
      const litros = Math.max(0, encAtual - encAnterior);
      const unitario = parseFloat(atual.UNITARIO) || 0;
      dados.push({
        ...atual,
        LITROS_VENDIDOS: litros.toFixed(3),
        VALOR_VENDIDO: (litros * unitario).toFixed(2),
      });
    });

    // Ordena por BOMBA, BICO
    dados.sort((a, b) => {
      const ba = String(a.BOMBA || '').padStart(4,'0');
      const bb = String(b.BOMBA || '').padStart(4,'0');
      if (ba !== bb) return ba.localeCompare(bb);
      return String(a.BICO || '').padStart(4,'0').localeCompare(String(b.BICO || '').padStart(4,'0'));
    });

    posto.status = 'conectado';
    return dados;

  } catch (err) {
    console.error(`[${config.nome}] ❌ ${err.message}`);
    posto.connection = null;
    posto.status = 'erro';
    throw err;
  }
}

// ─── POLLING ─────────────────────────────────────────────────────────────────
async function atualizarPosto(id) {
  const posto = postos.get(id);
  if (!posto) return;

  try {
    const dados = await buscarDadosPosto(posto);
    posto.dados = dados;
    posto.ultimaAtualizacao = new Date().toISOString();

    io.emit('dados_posto', {
      id,
      nome: posto.config.nome,
      host: posto.config.host,
      status: 'conectado',
      dados,
      ultimaAtualizacao: posto.ultimaAtualizacao,
    });
  } catch (err) {
    io.emit('dados_posto', {
      id,
      nome: posto.config.nome,
      host: posto.config.host,
      status: 'erro',
      erro: err.message,
      dados: [],
      ultimaAtualizacao: null,
    });
  }
}

function iniciarPollingPosto(id) {
  const posto = postos.get(id);
  if (!posto) return;
  if (posto.intervalo) clearInterval(posto.intervalo);
  atualizarPosto(id);
  posto.intervalo = setInterval(() => atualizarPosto(id), 10000);
}

// Inicia polling para todos os postos salvos
postos.forEach((_, id) => iniciarPollingPosto(id));

// ─── API ─────────────────────────────────────────────────────────────────────

// Listar postos
app.get('/api/postos', (req, res) => {
  const lista = [];
  postos.forEach((posto, id) => {
    lista.push({
      id,
      nome: posto.config.nome,
      host: posto.config.host,
      status: posto.status,
      ultimaAtualizacao: posto.ultimaAtualizacao,
      totalBicos: posto.dados ? posto.dados.length : 0,
    });
  });
  res.json(lista);
});

// Adicionar posto
app.post('/api/postos', (req, res) => {
  const { nome, host, port = 3306, user = 'root', password = '' } = req.body;
  if (!nome || !host) return res.status(400).json({ erro: 'Nome e IP são obrigatórios' });

  const id = `posto_${Date.now()}`;
  const cfg = { id, nome, host, port: parseInt(port), user, password };

  registrarPosto(cfg);

  // Salva no arquivo
  const configs = carregarPostosConfig();
  configs.push(cfg);
  salvarPostosConfig(configs);

  iniciarPollingPosto(id);

  res.json({ ok: true, id, nome, host });
});

// Remover posto
app.delete('/api/postos/:id', (req, res) => {
  const posto = postos.get(req.params.id);
  if (!posto) return res.status(404).json({ erro: 'Não encontrado' });

  if (posto.intervalo) clearInterval(posto.intervalo);
  if (posto.connection) posto.connection.end().catch(() => {});
  postos.delete(req.params.id);

  // Remove do arquivo
  const configs = carregarPostosConfig().filter(c => c.id !== req.params.id);
  salvarPostosConfig(configs);

  io.emit('posto_removido', { id: req.params.id });
  res.json({ ok: true });
});

// Busca cupom no posto
app.get('/api/resgate/:postoId', async (req, res) => {
  const posto = postos.get(req.params.postoId);
  if (!posto) return res.status(404).json({ erro: 'Posto não encontrado' });

  const { tipo, valor, data } = req.query;
  if (!tipo || !valor) return res.status(400).json({ erro: 'Parâmetros tipo e valor são obrigatórios' });

  try {
    if (!posto.connection) {
      posto.connection = await mysql.createConnection({
        host: posto.config.host,
        port: posto.config.port || 3306,
        user: posto.config.user || 'root',
        password: posto.config.password || '',
        database: 'controle',
        connectTimeout: 8000,
      });
    } else {
      // Troca database para controle
      await posto.connection.query('USE controle');
    }

    // Constrói query baseada no tipo de busca
    let where = '';
    let params = [];

    if (tipo === 'cupom') {
      where = 'CUPOM = ?';
      params = [valor];
    } else if (tipo === 'bico') {
      where = 'BICO = ?';
      params = [valor];
    } else if (tipo === 'litros') {
      const v = parseFloat(valor);
      where = 'QUANT BETWEEN ? AND ?';
      params = [v - 0.1, v + 0.1];
    } else if (tipo === 'valor') {
      const v = parseFloat(valor.replace(',', '.'));
      where = 'VALORITEM BETWEEN ? AND ?';
      params = [v - 0.01, v + 0.01];
    } else if (tipo === 'cf') {
      where = 'CF = ?';
      params = [valor];
    } else {
      return res.status(400).json({ erro: 'Tipo inválido' });
    }

    if (data) {
      where += ' AND EMISSAO = ?';
      params.push(data);
    }

    const [rows] = await posto.connection.execute(
      `SELECT ID, CUPOM, BICO, DESCR, QUANT, UNITARIO, VALORITEM, EMISSAO, NOME, STATUS, ENTREGA, CF, TURNO, INICIANTE, ENCERRANTE, CAIXA
       FROM controle.cupom WHERE ${where} ORDER BY EMISSAO DESC, ID DESC LIMIT 100`,
      params
    );

    // Volta para POSTO
    await posto.connection.query('USE POSTO');

    res.json({ ok: true, total: rows.length, registros: rows });
  } catch (err) {
    console.error(`[Resgate ${posto.config.nome}] ❌ ${err.message}`);
    posto.connection = null;
    res.status(500).json({ erro: err.message });
  }
});

// ─── SOCKET ──────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  postos.forEach((posto, id) => {
    if (posto.dados !== null) {
      socket.emit('dados_posto', {
        id,
        nome: posto.config.nome,
        host: posto.config.host,
        status: posto.status,
        dados: posto.dados,
        ultimaAtualizacao: posto.ultimaAtualizacao,
      });
    }
  });
});

// ─── START ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`\n🚀 SuperPosto Dashboard em http://localhost:${PORT}\n`);
  iniciarPingCentral();
});

// ─── PING CENTRAL ─────────────────────────────────────────────────────────────
const os = require('os');
const https = require('https');

const CENTRAL_URL = process.env.CENTRAL_URL || 'https://superposto-central.up.railway.app';
const VERSAO = '1.0.0';

function iniciarPingCentral() {
  pingCentral(); // ping imediato ao iniciar
  setInterval(pingCentral, 5 * 60 * 1000); // a cada 5 minutos
}

function pingCentral() {
  try {
    const hostname = os.hostname();
    const interfaces = os.networkInterfaces();
    let ip = 'desconhecido';
    for (const iface of Object.values(interfaces)) {
      for (const addr of iface) {
        if (addr.family === 'IPv4' && !addr.internal) {
          ip = addr.address;
          break;
        }
      }
      if (ip !== 'desconhecido') break;
    }

    const payload = JSON.stringify({
      hostname,
      ip,
      versao: VERSAO,
      postos: postos.size,
    });

    const url = new URL('/api/ping', CENTRAL_URL);
    const options = {
      hostname: url.hostname,
      port: 443,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    };

    const req = https.request(options, (res) => {
      console.log(`[Central] ✅ Ping enviado (${hostname})`);
    });
    req.on('error', (e) => {
      console.log(`[Central] ⚠️ Ping falhou: ${e.message}`);
    });
    req.setTimeout(5000, () => req.destroy());
    req.write(payload);
    req.end();
  } catch(e) {
    console.log(`[Central] ⚠️ Erro no ping: ${e.message}`);
  }
}
