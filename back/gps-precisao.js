// Validacao compartilhada do GPS. Dados rejeitados nunca mudam o estado da viagem.
'use strict';
const RECENTE_MS = 5 * 60000;
const SINCRONIA_MS = 60000;
const FUTURO_MS = 60000;
const SALTO_KMH = 160;
const numero = v => v !== null && v !== undefined && String(v).trim() !== '' && Number.isFinite(Number(v));
function coordenadaValida(p) {
  return !!p && numero(p.lat) && numero(p.lng) && Math.abs(Number(p.lat)) <= 90 && Math.abs(Number(p.lng)) <= 180 && !(Number(p.lat) === 0 && Number(p.lng) === 0);
}
function distanciaM(a, b) {
  const rad = Math.PI / 180;
  const h = Math.sin((Number(b.lat) - Number(a.lat)) * rad / 2) ** 2 + Math.cos(Number(a.lat) * rad) * Math.cos(Number(b.lat) * rad) * Math.sin((Number(b.lng) - Number(a.lng)) * rad / 2) ** 2;
  return 12742000 * Math.asin(Math.sqrt(Math.min(1, Math.max(0, h))));
}
function motivoInvalido(p, {agora = Date.now(), maxIdadeMs = Infinity} = {}) {
  if (!coordenadaValida(p)) return 'coordenadas invalidas';
  const t = p.posicao_em ? new Date(p.posicao_em).getTime() : NaN;
  if (!Number.isFinite(t)) return 'horario invalido';
  if (t > agora + FUTURO_MS) return 'horario no futuro';
  if (agora - t > maxIdadeMs) return 'sinal antigo';
  if (!numero(p.velocidade) || Number(p.velocidade) < 0 || Number(p.velocidade) > 220) return 'velocidade invalida';
  if (p.valid === false) return 'posicao sem fix GPS';
  if (numero(p.accuracy) && Number(p.accuracy) > 100) return 'incerteza maior que 100 m';
  return null;
}
function salto(a, b) {
  const dt = new Date(b.posicao_em) - new Date(a.posicao_em);
  if (dt <= 0) return false;
  const d = distanciaM(a, b);
  return d > 100 && (d - 100) / dt * 3600 > SALTO_KMH;
}
function criarFiltro() {
  const ultimas = new Map();
  const contagens = new Map();
  const chaveDe = p => String(p.fonte || '') + ':' + String(p.device_id ?? p.placa ?? '');
  const confirmar = p => ultimas.set(chaveDe(p), {...p});
  function avaliar(p, opcoes = {}) {
    let motivo = motivoInvalido(p, opcoes);
    const chave = chaveDe(p);
    const a = ultimas.get(chave);
    if (!motivo && a && new Date(p.posicao_em) < new Date(a.posicao_em)) motivo = 'horario regressivo';
    if (!motivo && a && new Date(p.posicao_em).getTime() === new Date(a.posicao_em).getTime()) motivo = 'leitura repetida';
    if (!motivo && a && salto(a, p)) motivo = 'salto impossivel';
    if (motivo) {
      if (motivo !== 'leitura repetida') {
        const c = contagens.get(chave) || {fonte: p.fonte, device_id: p.device_id, placa: p.placa, rejeitadas: 0, motivos: {}, ultima_rejeicao: null};
        c.rejeitadas++; c.motivos[motivo] = (c.motivos[motivo] || 0) + 1; c.ultima_rejeicao = new Date().toISOString();
        contagens.set(chave, c);
      }
      return {ok: false, motivo};
    }
    if (opcoes.confirmar !== false) confirmar(p);
    return {ok: true, motivo: null};
  }
  return {avaliar, confirmar, diagnostico: () => [...contagens.values()]};
}
function poligonoValido(pontos) {
  if (!Array.isArray(pontos) || pontos.length < 3 || pontos.length > 100) return false;
  if (!pontos.every(p => Array.isArray(p) && p.length === 2 && coordenadaValida({lat:p[0], lng:p[1]}))) return false;
  const cruz = (a,b,c) => (Number(b[1])-Number(a[1]))*(Number(c[0])-Number(a[0]))-(Number(b[0])-Number(a[0]))*(Number(c[1])-Number(a[1]));
  for(let i=0;i<pontos.length;i++) for(let j=i+1;j<pontos.length;j++) {
    const ni=(i+1)%pontos.length,nj=(j+1)%pontos.length;
    if(i===nj || j===ni) continue;
    if(cruz(pontos[i],pontos[ni],pontos[j])*cruz(pontos[i],pontos[ni],pontos[nj])<0 && cruz(pontos[j],pontos[nj],pontos[i])*cruz(pontos[j],pontos[nj],pontos[ni])<0) return false;
  }
  const area = pontos.reduce((s,p,i) => {const q = pontos[(i+1)%pontos.length]; return s + Number(p[0])*Number(q[1])-Number(q[0])*Number(p[1]);},0);
  return Math.abs(area) > 1e-10;
}
function dentroPoligono(pos, pontos) {
  let dentro = false;
  const y = Number(pos.lat), x = Number(pos.lng);
  for (let i=0, j=pontos.length-1; i<pontos.length; j=i++) {
    const yi = Number(pontos[i][0]), xi = Number(pontos[i][1]), yj = Number(pontos[j][0]), xj = Number(pontos[j][1]);
    if ((yi > y) !== (yj > y) && x < (xj-xi)*(y-yi)/(yj-yi)+xi) dentro = !dentro;
  }
  return dentro;
}
function distanciaBorda(pos, pontos) {
  const rad = Math.PI/180, scaleY = 6371000*rad, scaleX = scaleY*Math.cos(Number(pos.lat)*rad);
  let min = Infinity;
  for (let i=0;i<pontos.length;i++) {
    const a=pontos[i], b=pontos[(i+1)%pontos.length];
    const ax=(Number(a[1])-Number(pos.lng))*scaleX, ay=(Number(a[0])-Number(pos.lat))*scaleY;
    const bx=(Number(b[1])-Number(pos.lng))*scaleX, by=(Number(b[0])-Number(pos.lat))*scaleY;
    const dx=bx-ax, dy=by-ay, den=dx*dx+dy*dy;
    const t=den ? Math.max(0,Math.min(1,-(ax*dx+ay*dy)/den)) : 0;
    min=Math.min(min,Math.hypot(ax+t*dx,ay+t*dy));
  }
  return min;
}
function raioEntrada(l) { return numero(l.raio_entrada_m) && Number(l.raio_entrada_m)>=20 ? Number(l.raio_entrada_m) : 250; }
function raioSaida(l) { return numero(l.raio_saida_m) && Number(l.raio_saida_m)>raioEntrada(l) ? Number(l.raio_saida_m) : Math.max(400,raioEntrada(l)+50); }
function dentroLugar(pos, l, saida = false) {
  if (!coordenadaValida(pos) || !coordenadaValida(l)) return false;
  if (poligonoValido(l.poligono)) return dentroPoligono(pos,l.poligono) || distanciaBorda(pos,l.poligono) <= (saida ? 40 : 0.5);
  const d=distanciaM(pos,l);
  if(d <= (saida ? raioSaida(l) : raioEntrada(l)))return true;
  const ajuste=l.ajuste_proximidade;
  if(!ajuste?.reduzida || l.area_personalizada || !ajuste.vizinhas?.length)return false;
  const limite=saida?ajuste.raio_saida_configurado_m:ajuste.raio_entrada_configurado_m;
  // Pontos aprendidos têm dispersão registrada: Niterói II tem 65 m de
  // variação nas amostras. Ela só vale no setor inequivocamente desta loja,
  // com pelo menos três amostras e dispersão dentro do limite do aprendizado.
  const tolerancia=l.origem==='rastreador' && Number(l.amostras)>=3 && numero(l.dispersao_m) && Number(l.dispersao_m)>=0 && Number(l.dispersao_m)<=80 ? Number(l.dispersao_m) : 0;
  if(!numero(limite) || d>Number(limite)+tolerancia)return false;
  // A reducao protege o lado entre lojas, sem apagar o ponto de descarga
  // no lado oposto. Entrada exige 20 m de vantagem sobre TODAS as vizinhas;
  // saida usa a divisoria para manter a histerese durante pequenas oscilacoes.
  return ajuste.vizinhas.every(v=>coordenadaValida(v) && distanciaM(pos,v)>d+(saida?0:20));
}
function perfilPonto(tipo) {
  const t=String(tipo || '').trim().toUpperCase();
  if(t==='SHOPPING' || t==='SHOPPING/GALERIA') return {perfil:'shopping',raio_entrada_m:200,raio_saida_m:300};
  if(t==='RUA') return {perfil:'rua',raio_entrada_m:80,raio_saida_m:150};
  return {perfil:'padrao',raio_entrada_m:250,raio_saida_m:400};
}
// Areas circulares de lojas vizinhas: o raio acompanha a distancia entre os
// pontos de descarga. Nao altera coordenadas, configuracoes salvas ou patios.
function ajustarAreasProximas(lugares) {
  const ehLoja = l => l.codigo !== 'FABRICA' && !['CSG','DJOFFER'].includes(l.codigo)
    && !String(l.codigo || '').startsWith('FILIAL_') && l.loja_cadastrada !== false && coordenadaValida(l);
  return lugares.map(l => {
    if (!ehLoja(l) || poligonoValido(l.poligono)) return l;
    let vizinha = null, distancia = Infinity;
    const vizinhas=[];
    for (const outra of lugares) {
      if (outra.codigo === l.codigo || !ehLoja(outra)) continue;
      const d = distanciaM(l, outra);
      if(d<500)vizinhas.push({codigo:outra.codigo,lat:Number(outra.lat),lng:Number(outra.lng)});
      if (d < distancia) { distancia = d; vizinha = outra; }
    }
    if (!vizinha || distancia >= 500) return l;
    const entradaOriginal = raioEntrada(l), saidaOriginal = raioSaida(l);
    // Ate 50 m na entrada e 100 m na saida; pares mais proximos encolhem
    // ainda mais. O piso de 20 m evita uma cerca menor que o ruido do GPS.
    const limiteEntrada = Math.max(20, Math.min(50, Math.floor(distancia * .4)));
    const entrada = l.area_personalizada ? entradaOriginal : Math.min(entradaOriginal, limiteEntrada);
    const limiteSaida = Math.max(entrada + 20, Math.min(100, Math.floor(distancia * .75)));
    const saida = l.area_personalizada ? saidaOriginal : Math.min(saidaOriginal, limiteSaida);
    return {...l, raio_entrada_m: entrada, raio_saida_m: saida,
      ajuste_proximidade: {vizinha_codigo: vizinha.codigo, vizinha_nome: vizinha.nome || vizinha.codigo,
        distancia_m: Math.round(distancia), limite_entrada_m: limiteEntrada, limite_saida_m: limiteSaida,
        raio_entrada_configurado_m: entradaOriginal, raio_saida_configurado_m: saidaOriginal,
        reduzida: entrada < entradaOriginal || saida < saidaOriginal, sobreposicao_inevitavel: distancia <= 40,vizinhas}};
  });
}
module.exports = {ajustarAreasProximas,perfilPonto,RECENTE_MS,SINCRONIA_MS,FUTURO_MS,numero,coordenadaValida,motivoInvalido,distanciaM,salto,criarFiltro,poligonoValido,dentroPoligono,distanciaBorda,dentroLugar,raioEntrada,raioSaida};
