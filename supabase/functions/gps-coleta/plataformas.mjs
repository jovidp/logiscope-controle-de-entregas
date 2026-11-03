import { lerLinha } from './vendor/t4s-parser.mjs';
import { lerVeiculo } from './vendor/sat-parser.mjs';
import { criar as criarT4sApi } from './vendor/t4s-api.mjs';
import { motivoInvalido } from './vendor/gps-precisao.mjs';

export function placaMercosul(valor) {
  const p = String(valor || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return /^[A-Z]{3}\d{4}$/.test(p) ? p.slice(0, 4) + 'ABCDEFGHIJ'[Number(p[4])] + p.slice(5) : p;
}

export function normalizar(lista, fonte, agora = Date.now()) {
  return lista.filter(p => Number.isSafeInteger(Number(p.device_id)) && Number(p.device_id) > 0
    && /^[A-Z]{3}\d[A-Z0-9]\d{2}$/.test(placaMercosul(p.placa))
    && !motivoInvalido(p, { agora, maxIdadeMs: 24 * 3600000 }))
    .map(p => ({ fonte, device_id: Number(p.device_id), placa: placaMercosul(p.placa),
      nome: String(p.nome || '').slice(0, 200), lat: Number(p.lat), lng: Number(p.lng),
      velocidade: Number(p.velocidade), rumo: Number.isFinite(Number(p.rumo)) ? Math.round(Number(p.rumo)) : 0,
      motor: ['ligado', 'desligado'].includes(p.motor) ? p.motor : null,
      online: String(p.online || '').slice(0, 30), parado_seg: Math.max(0, Math.round(Number(p.parado_seg) || 0)),
      posicao_em: new Date(p.posicao_em).toISOString() }));
}

export function mapearSrf(grupos) {
  if (!Array.isArray(grupos)) throw new Error('SRF: formato de resposta inesperado');
  return grupos.flatMap(g => g.items || []).map(d => ({
    device_id: Number(d.id), nome: String(d.name || ''),
    placa: placaMercosul((String(d.name || '').toUpperCase().match(/[A-Z]{3}-?[0-9][A-Z0-9][0-9]{2}/) || [])[0]
      || d.device_data?.plate_number),
    lat: Number(d.lat), lng: Number(d.lng), velocidade: Number(d.speed) || 0, rumo: Number(d.course) || 0,
    posicao_em: d.timestamp ? new Date(Number(d.timestamp) * 1000) : null,
    online: String(d.online || ''), motor: d.engine_status === true ? 'ligado' : d.engine_status === false ? 'desligado' : null,
    parado_seg: Number(d.stop_duration_sec) || 0,
  }));
}

function renovarCookies(resposta, cookie, nomes) {
  const mapa = new Map(String(cookie).split(/;\s*/).map(p => {
    const i = p.indexOf('='); return [p.slice(0, i).trim(), p.slice(i + 1).trim()];
  }));
  for (const sc of resposta.headers.getSetCookie?.() || []) {
    const par = sc.split(';')[0], i = par.indexOf('=');
    const nome = par.slice(0, i), valor = par.slice(i + 1);
    const exp = /expires=([^;]+)/i.exec(sc);
    if (nomes.includes(nome) && valor && (!exp || new Date(exp[1]) > new Date())) mapa.set(nome, valor);
  }
  return nomes.filter(n => mapa.get(n)).map(n => `${n}=${mapa.get(n)}`).join('; ');
}

export function criarPlataformas({ env, fetcher = fetch, sessoes = {}, salvarSessao = async () => {} }) {
  const oficial = criarT4sApi({ env, fetcher });
  let srfHash = null;
  const url = (nome, padrao) => {
    const u = new URL(env[nome] || padrao);
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash
      || u.pathname !== '/') throw new Error(`${nome}: origem invalida`);
    return u.origin;
  };
  const pedido = async (endereco, opcoes = {}) => {
    const r = await fetcher(endereco, { ...opcoes, redirect: 'manual', signal: AbortSignal.timeout(12000) });
    if (!r.ok) throw new Error(`Plataforma respondeu HTTP ${r.status}`);
    return r;
  };
  const cookieAtual = fonte => {
    const inicial = env[fonte === 't4s' ? 'T4S_COOKIE' : 'SAT_COOKIE'] || '';
    return sessoes[fonte]?.origem === inicial ? sessoes[fonte].cookie : inicial;
  };
  const renovar = async (fonte, r, usado, nomes) => {
    const cookie = renovarCookies(r, usado, nomes);
    if (cookie && cookie !== usado) {
      const origem = env[fonte === 't4s' ? 'T4S_COOKIE' : 'SAT_COOKIE'] || '';
      await salvarSessao(fonte, { cookie, origem });
      sessoes[fonte] = { cookie, origem };
    }
  };
  return {
    configuradas: () => [
      ...(env.SRF_URL && env.SRF_EMAIL && env.SRF_SENHA ? ['srf'] : []),
      ...(oficial.configurado() || env.T4S_COOKIE ? ['t4s'] : []),
      ...(env.SAT_COOKIE ? ['sat'] : []),
    ],
    async srf() {
      const base = url('SRF_URL');
      for (let tentativa = 0; tentativa < 2; tentativa++) {
        if (!srfHash) {
          const r = await pedido(`${base}/api/login`, { method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ email: env.SRF_EMAIL, password: env.SRF_SENHA }) });
          srfHash = (await r.json()).user_api_hash;
          if (!srfHash) throw new Error('SRF: login recusado');
        }
        const q = new URLSearchParams({ user_api_hash: srfHash, lang: 'pt' });
        const r = await fetcher(`${base}/api/get_devices?${q}`, { redirect: 'manual', signal: AbortSignal.timeout(12000) });
        if ([401, 403].includes(r.status) && !tentativa) { srfHash = null; continue; }
        if (!r.ok) throw new Error(`SRF: HTTP ${r.status}`);
        return mapearSrf(await r.json());
      }
      throw new Error('SRF: login recusado');
    },
    async t4s() {
      if (oficial.configurado()) return oficial.listarPosicoes(12000);
      const base = url('T4S_URL', 'https://rastreamento.t4stecnologia.com.br');
      const cookie = cookieAtual('t4s');
      const corpo = new URLSearchParams({ SelectAll: 'false', PlatesSelected: '', VehicleInstallationsSelected: '',
        GPRSDatetimeFrom: '', GPRSDatetimeTo: '', Plate: '', DeviceId: '', CompanyIdArray: '', ProductTypeId: '' });
      const r = await pedido(`${base}/Home/List`, { method: 'POST', headers: { Cookie: cookie,
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest',
        Accept: 'text/html, */*; q=0.01', Referer: `${base}/` }, body: corpo.toString() });
      const html = await r.text();
      if (/Account\/Login/i.test(html) && !/linha_grid/.test(html)) throw new Error('T4S: sessao expirada');
      if (!/linha_grid|checkboxVehicle/.test(html)) throw new Error('T4S: tabela de veiculos nao encontrada');
      const lista = html.split('<tr class="linha_grid">').slice(1).map(lerLinha).filter(Boolean);
      await renovar('t4s', r, cookie, ['.ASPXAUTH', 'u_token']);
      return lista;
    },
    async sat() {
      const base = url('SAT_URL', 'https://satfleet.satcompany.app'), cookie = cookieAtual('sat');
      const r = await pedido(`${base}/vehicles/index_with_state`, { headers: { Cookie: cookie,
        Accept: 'application/json, text/javascript, */*; q=0.01', 'X-Requested-With': 'XMLHttpRequest',
        Referer: `${base}/mobile/vehicles`, 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/154.0.0.0 Safari/537.36' } });
      const j = await r.json();
      if (!Array.isArray(j)) throw new Error('Sat: formato de veiculos inesperado');
      const lista = j.map(lerVeiculo).filter(Boolean);
      await renovar('sat', r, cookie, ['remember_user_token', '_session_id']);
      return lista;
    },
  };
}
