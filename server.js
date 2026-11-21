// Moun Moun — controle das aplicações de Mounjaro
const http = require('http');
const fs = require('fs');
const path = require('path');
const webpush = require('web-push');

const PORT = process.env.PORT || 3111;
const PIN = process.env.MOUNMOUN_PIN || '';
const DATA_DIR = process.env.DATA_DIR || path.join(process.env.HOME, 'mounmoun-data');
const DB = path.join(DATA_DIR, 'db.json');
const PUB = path.join(__dirname, 'public');
fs.mkdirSync(DATA_DIR, { recursive: true });

// Chaves VAPID para push (geradas uma vez e guardadas)
const VAPID_FILE = path.join(DATA_DIR, 'vapid.json');
if (!fs.existsSync(VAPID_FILE)) fs.writeFileSync(VAPID_FILE, JSON.stringify(webpush.generateVAPIDKeys()));
const vapid = JSON.parse(fs.readFileSync(VAPID_FILE));
webpush.setVapidDetails('mailto:mounmoun@example.com', vapid.publicKey, vapid.privateKey);

const padrao = {
  config: { mgPorAmpola: 15, dosesPorAmpola: 3, mgPadrao: 5 },
  estoque: { ampolas: 0, seringas: 0 },        // ampolas FECHADAS + seringas
  ampolaAtual: null,                             // { mgRestante, doses }
  aplicacoes: [],                                // { id, data, lado, mg, peso }
  avisos: { ampola: false, seringa: false },     // lista de compras
  subs: []
};
const load = () => { try { return { ...padrao, ...JSON.parse(fs.readFileSync(DB)) }; } catch { return structuredClone(padrao); } };
const save = d => { fs.writeFileSync(DB + '.tmp', JSON.stringify(d, null, 1)); fs.renameSync(DB + '.tmp', DB); };

async function notificar(d, titulo, corpo) {
  const vivos = [];
  for (const s of d.subs) {
    try { await webpush.sendNotification(s, JSON.stringify({ titulo, corpo })); vivos.push(s); }
    catch (e) { if (e.statusCode !== 404 && e.statusCode !== 410) vivos.push(s); }
  }
  d.subs = vivos;
}

function estado(d) {
  const { subs, ...resto } = d;
  const ord = [...d.aplicacoes].sort((a, b) => a.data.localeCompare(b.data));
  const ult = ord[ord.length - 1];
  return { ...resto, proximoLado: ult ? (ult.lado === 'E' ? 'D' : 'E') : 'E', vapidPublic: vapid.publicKey };
}

async function registrarDose(d, { lado, mg, peso, data }) {
  mg = Number(mg); const c = d.config; const msgs = [];
  if (!(mg > 0)) throw new Error('Informe os mg');
  data = data || new Date().toISOString();
  const dia = s => new Date(s).toLocaleDateString('sv', { timeZone: 'America/Sao_Paulo' });
  // dose de dia anterior a hoje: só entra no histórico, não mexe no estoque
  if (dia(data) < dia(new Date().toISOString())) {
    d.aplicacoes.push({ id: Date.now(), data, lado, mg, peso: peso ? Number(peso) : null, passada: true });
    return;
  }
  if (d.estoque.seringas <= 0) throw new Error('Sem seringas no estoque');
  // abre ampola nova se não houver uma em uso com mg suficiente
  if (!d.ampolaAtual || d.ampolaAtual.mgRestante < mg - 1e-9) {
    if (d.estoque.ampolas <= 0) throw new Error('Sem ampolas no estoque');
    d.estoque.ampolas--;
    d.ampolaAtual = { mgRestante: c.mgPorAmpola, doses: 0 };
  }
  d.ampolaAtual.mgRestante = Math.round((d.ampolaAtual.mgRestante - mg) * 100) / 100;
  d.ampolaAtual.doses++;
  d.estoque.seringas--;
  d.aplicacoes.push({ id: Date.now(), data, lado, mg, peso: peso ? Number(peso) : null });

  // Penúltima ampola, 1ª dose: a em uso + só 1 fechada sobrando
  if (d.ampolaAtual.doses === 1 && d.estoque.ampolas === 1) {
    d.avisos.ampola = true; msgs.push(['Compre mais uma ampola 💉', 'Você está na penúltima ampola.']);
  }
  if (d.estoque.ampolas === 0 && d.ampolaAtual.doses === 1) d.avisos.ampola = true;
  if (d.estoque.seringas <= 2) {
    d.avisos.seringa = true; msgs.push(['Compre seringas 🛒', `Restam só ${d.estoque.seringas} seringa(s).`]);
  }
  for (const [t, b] of msgs) await notificar(d, t, b);
}

function body(req) {
  return new Promise(r => { let s = ''; req.on('data', c => s += c); req.on('end', () => { try { r(JSON.parse(s || '{}')); } catch { r({}); } }); });
}
const tipos = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  if (url.pathname.startsWith('/api/')) {
    if (PIN && req.headers['x-pin'] !== PIN) return send(401, { erro: 'PIN' });
    const d = load(); const b = req.method === 'POST' ? await body(req) : {};
    try {
      switch (url.pathname) {
        case '/api/estado': break;
        case '/api/dose': await registrarDose(d, b); break;
        case '/api/estoque': // soma (compra) ou define
          if (b.ampolas != null) d.estoque.ampolas = Math.max(0, b.modo === 'somar' ? d.estoque.ampolas + Number(b.ampolas) : Number(b.ampolas));
          if (b.seringas != null) d.estoque.seringas = Math.max(0, b.modo === 'somar' ? d.estoque.seringas + Number(b.seringas) : Number(b.seringas));
          if (d.estoque.seringas > 2) d.avisos.seringa = false;
          if (d.estoque.ampolas >= 2) d.avisos.ampola = false;
          break;
        case '/api/comprei': d.avisos[b.item] = false; break;
        case '/api/config': Object.assign(d.config, Object.fromEntries(Object.entries(b).map(([k, v]) => [k, Number(v)]))); break;
        case '/api/ampola': d.ampolaAtual = b.mgRestante == null ? null : { mgRestante: Number(b.mgRestante), doses: Number(b.doses || 0) }; break;
        case '/api/apagar': d.aplicacoes = d.aplicacoes.filter(a => a.id !== b.id); break;
        case '/api/reset': d.aplicacoes = []; d.ampolaAtual = null; d.estoque = { ampolas: 0, seringas: 0 }; d.avisos = { ampola: false, seringa: false }; break;
        case '/api/sub': if (!d.subs.find(s => s.endpoint === b.endpoint)) d.subs.push(b); break;
        case '/api/teste': await notificar(d, 'Moun Moun', 'Notificações funcionando ✅'); break;
        default: return send(404, { erro: 'rota' });
      }
      save(d); return send(200, estado(d));
    } catch (e) { return send(400, { erro: e.message }); }
  }
  let f = path.normalize(path.join(PUB, url.pathname === '/' ? 'index.html' : url.pathname));
  if (!f.startsWith(PUB) || !fs.existsSync(f)) f = path.join(PUB, 'index.html');
  res.writeHead(200, { 'Content-Type': tipos[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
}).listen(PORT, () => console.log('Moun Moun na porta ' + PORT));
