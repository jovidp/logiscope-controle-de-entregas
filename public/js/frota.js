// ================================================================
// frota.js (front) — aba 🛰 Frota: gestao detalhada da frota.
// ----------------------------------------------------------------
// O painel "Frota agora" do TMS continua como esta; aqui fica o detalhe:
//   - mapa ao vivo (Leaflet, carregado so ao abrir a aba) com veiculos,
//     lojas, fabrica e pontos extras (CSG, filiais);
//   - rastro de cada veiculo pelos sinais do rastreador (uma cor por carro,
//     mais forte = mais recente, tracejado = sinal espacado), na janela
//     escolhida (1 h, 3 h, dia todo ou desligado);
//   - lista por veiculo: situacao, viagem do TMS, km/paradas/lojas do dia e o
//     sinal de cada plataforma (SRF/T4S);
//   - registro de CHEGADA e SAIDA em cada loja (do veiculo selecionado e da
//     frota toda, com exportacao para Excel) e, na bolinha da loja, quem
//     passou por ela no dia;
//   - clique no veiculo: trajeto do dia no mapa (cor por velocidade) com os
//     lugares numerados iguais a tabela;
//   - saude dos rastreadores (quem esta mudo e em qual plataforma).
// Dados: GET /frota/painel e /frota/trajeto (back/frota.js). Se o servidor
// ainda nao tiver essas rotas (antes do restart), cai para o "agora" de
// /tms/rastreador/posicoes. Servidor mais antigo que esta tela (sem rastro ou
// sem registro de visitas): cada parte avisa "depois do restart".
// Prefixo frt.
// ================================================================
(function () {
  "use strict";

  const API = () => window.location.origin;
  // jsdelivr (como Chart.js/xlsx): o cdnjs nao abre na rede da empresa.
  const LEAFLET = "https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/";
  const LS_FILTRO = "controleEntregaFrota:filtro";
  const LS_OUTROS = "controleEntregaFrota:verOutros";
  const LS_LOJAS = "controleEntregaFrota:lojas";
  const LS_RASTRO = "controleEntregaFrota:rastro";
  const LS_REG_FAB = "controleEntregaFrota:registroFabrica";
  const LS_VER = "controleEntregaFrota:ver"; // carros marcados para o mapa: [[placa, cor], ...]
  const JANELAS = [["off", "Desligado"], ["1", "1 h"], ["3", "3 h"], ["dia", "Dia todo"]];
  // Cores do rastro SEM os tons de situacao (verde rodando, laranja parado,
  // roxo loja, azul fabrica): com eles a etiqueta verde de um carro "puxava"
  // o olho para a linha verde de outro.
  const PALETA_RASTRO = ["#e6194b", "#0fa5c4", "#e0349a", "#9a6324", "#469990", "#7a7a00", "#d4a000", "#ff7a93"];
  const OPAC_RASTRO = [0.38, 0.58, 0.78, 1]; // faixas de idade: antigo -> recente
  const LOJAS_SEPARACAO_PX = 18; // espaco entre marcadores individuais sobrepostos
  const NO_LUGAR_M = 250;
  const MUDO_MIN = 15;          // sinal mais velho que isso = "sem sinal"
  const MUDO_DIA_MIN = 24 * 60; // mais de 1 dia = aparelho pede manutencao
  const JUNTA_MAPA_M = 150;     // veiculos a ate 150 m dividem um marcador...
  const JUNTA_PX = { x: 78, y: 20 }; // ...ou quando as etiquetas se encostariam na tela
  const ENQUADRO_M = 40000;     // 1o enquadramento: so quem esta a ate 40 km do "centro" da frota
  const RECARGA_MIN_MS = 30000; // nao recarrega o painel mais de 1x a cada 30 s
  // Distancia aproximada em metros (equiretangular: sobra para 40 km).
  const distM = (a, b) => {
    const k = Math.PI / 180, x = (b[1] - a[1]) * k * Math.cos(((a[0] + b[0]) / 2) * k), y = (b[0] - a[0]) * k;
    return Math.sqrt(x * x + y * y) * 6371000;
  };
  const mediana = (l) => { const s = [...l].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };

  const esc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const hhmm = (d) => (d ? new Date(d).toLocaleString("pt-BR", { ...(variosDias() ? {day:"2-digit",month:"2-digit"} : {}), hour: "2-digit", minute: "2-digit", timeZone:"America/Sao_Paulo" }) : "—");
  const hojeISO = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  const num = (n, casas = 0) => Number(n || 0).toLocaleString("pt-BR", { minimumFractionDigits: casas, maximumFractionDigits: casas });
  const lsGet = (k, padrao) => { try { const v = localStorage.getItem(k); return v == null ? padrao : v; } catch (_) { return padrao; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (_) {} };
  const rastroSalvo = () => { const r = lsGet(LS_RASTRO, "dia"); return JANELAS.some(([j]) => j === r) ? r : "dia"; };

  function duracao(min) {
    if (min == null) return "—";
    min = Math.round(min);
    if (min < 60) return `${min} min`;
    if (min < 48 * 60) return `${Math.floor(min / 60)} h${min % 60 ? " " + String(min % 60).padStart(2, "0") : ""}`;
    return `${Math.round(min / 1440)} dias`;
  }
  const ICONE_TIPO = { caminhao: "🚛", utilitario: "🚐", carro: "🚗", moto: "🏍️", onibus: "🚌" };
  const ICONE_REG = { loja: "🏬", fabrica: "🏭", ponto: "📍", fora: "⏸" };

  const st = {
    iniciado: false, data: hojeISO(), fim: null, seguirHoje: true, dados: null, modo: null,
    filtro: lsGet(LS_FILTRO, "todos"), verOutros: lsGet(LS_OUTROS, "0") === "1", outrosN: 0, busca: "", regBusca: "", fabBusca: "", regFabrica: lsGet(LS_REG_FAB, "0") === "1",
    sel: null, trajeto: null, trajAssin: null, trajDesenhado: null, seqTraj: 0,
    carregando: false, pendente: false, ultimaCarga: 0, timer: null,
    rastro: rastroSalvo(), rastros: new Map(), cores: new Map(), legendaRastro: false,
    ver: lerVer(),
    lugares: [], lugaresV: null, lugaresMudou: false,
    mapa: null, mapaP: null, camVeiculos: null, camLugares: null, camTrajeto: null, camRastros: null, rendRastro: null,
    marcadores: new Map(), enquadrou: false, avisoTile: false, popupPlaca: null,
  };

  const fimPeriodo = () => st.fim || st.data;
  const variosDias = () => fimPeriodo() !== st.data;
  const periodoTexto = () => st.data.split('-').reverse().join('/') + (variosDias() ? ' até ' + fimPeriodo().split('-').reverse().join('/') : '');
  const periodoArquivo = () => st.data + (variosDias() ? '_a_' + fimPeriodo() : '');

  // ---------------------------------------------------------- carros marcados
  // O usuario escolhe quais carros ver: so eles aparecem no mapa e so eles tem
  // rastro (com 20 carros o mapa virava um emaranhado). Cada carro marcado
  // ganha a 1a cor livre e fica com ela enquanto estiver marcado.
  function lerVer() {
    try {
      const l = JSON.parse(lsGet(LS_VER, "[]"));
      return new Map(Array.isArray(l) ? l.filter((x) => Array.isArray(x) && x[0]).map(([p, c]) => [String(p), PALETA_RASTRO.includes(c) ? c : PALETA_RASTRO[0]]) : []);
    } catch (_) { return new Map(); }
  }
  const salvarVer = () => lsSet(LS_VER, JSON.stringify([...st.ver.entries()]));
  function corLivre() {
    const usadas = new Set(st.ver.values());
    return PALETA_RASTRO.find((c) => !usadas.has(c)) || PALETA_RASTRO[st.ver.size % PALETA_RASTRO.length];
  }
  function marcar(placa, sim) {
    if (sim && !st.ver.has(placa)) st.ver.set(placa, corLivre());
    if (!sim) st.ver.delete(placa);
    salvarVer();
  }
  function aposMudarVer(enquadrar) {
    prepararRastros();
    renderVerBar();
    renderRastroCtl();
    renderLista();
    renderRegistro();
    renderFabrica();
    desenharMapa().then(() => { if (enquadrar) enquadrarMarcados(); });
  }
  const filtrandoMapa = () => st.ver.size > 0;

  // ---------------------------------------------------------- rastro
  function atribuirCores() { st.cores = new Map(st.ver); }
  function corDoVeiculo(placa) {
    if (st.cores.has(placa)) return st.cores.get(placa);
    let h = 2166136261; // FNV-1a (so para quem nao tem rastro no dia)
    for (const c of String(placa || "")) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
    return PALETA_RASTRO[(h >>> 0) % PALETA_RASTRO.length];
  }

  // Servidor ja reiniciado com o rastro? (o de antes nao manda dia_inicio)
  const temRastroNoServidor = () => !!(st.dados && st.modo === "completo" && st.dados.dia_inicio);

  // Janela do rastro valendo agora. Em dia passado "1 h/3 h" nao fazem sentido
  // (relativas a quando?): vale o dia todo.
  function janelaRastro() {
    if (st.rastro === "off" || !temRastroNoServidor()) return null;
    const diaIni = Date.parse(st.dados.dia_inicio);
    if (!Number.isFinite(diaIni)) return null;
    const jan = !st.dados.hoje && st.rastro !== "dia" ? "dia" : st.rastro;
    const comRastro = st.dados.veiculos.filter((v) => Array.isArray(v.rastro) && v.rastro.length > 1);
    if (!comRastro.length) return null;
    let fim = st.dados.hoje ? Math.round((Date.now() - diaIni) / 1000) : 0;
    if (!st.dados.hoje) comRastro.forEach((v) => { fim = Math.max(fim, v.rastro[v.rastro.length - 1][2]); });
    let ini = fim - Number(jan) * 3600;
    if (jan === "dia") { ini = Infinity; comRastro.forEach((v) => { ini = Math.min(ini, v.rastro[0][2]); }); }
    return { jan, diaIni, ini, fim, faixa: Math.max(1, fim - ini) };
  }

  // Pedacos do rastro de um veiculo dentro da janela: cada pedaco tem um
  // estilo so (cheio/tracejado) e uma faixa de idade so (opacidade).
  function pedacosRastro(v, J) {
    const resultado = window.frtRastroUtils.recortarRastro(v.rastro, J);
    return resultado.pedacos.length ? Object.assign(resultado.pedacos, {t0:resultado.t0,t1:resultado.t1,J}) : [];
  }

  // Uma vez por render (lista e mapa usam o mesmo resultado).
  function prepararRastros() {
    st.rastros = new Map();
    const J = janelaRastro();
    if (!J) return;
    for (const v of st.dados.veiculos) {
      if (!st.ver.has(v.placa) && v.placa !== st.sel) continue; // inclui a reserva do selecionado
      const p = pedacosRastro(v, J);
      if (p.length) st.rastros.set(v.placa, p);
    }
  }

  function desenharRastros() {
    if (!st.mapa || !st.camRastros) return;
    st.camRastros.clearLayers();
    if (!st.rastros.size) return;
    const L = window.L;
    const selecionado = st.dados?.veiculos.find(v => v.placa === st.sel);
    const detalheAtual = st.trajDesenhado && st.trajAssin === assinatura(selecionado) ? st.trajDesenhado : null;
    const desenhar = [...st.rastros.entries()].filter(([placa]) => placa !== detalheAtual);
    const apaga = detalheAtual ? 0.3 : 1;
    // 1a passada: contorno (claro no tema claro, escuro no escuro) sob TODOS os
    // rastros — sem ele a linha some sobre as ruas do mapa. Numa passada so, o
    // contorno de um carro cortaria a linha de outro no cruzamento.
    const contorno = document.documentElement.dataset.tema === "escuro" ? "#0b1220" : "#ffffff";
    for (const [, pedacos] of desenhar) {
      for (const p of pedacos) {
        L.polyline(p.coords, {
          renderer: st.rendRastro, color: contorno, weight: p.lig === 1 ? 5 : 7, opacity: 0.7 * OPAC_RASTRO[p.banda] * apaga,
          lineCap: "round", lineJoin: "round", interactive: false,
        }).addTo(st.camRastros);
      }
    }
    for (const [placa, pedacos] of desenhar) {
      const cor = corDoVeiculo(placa);
      const hora = (s) => hhmm(pedacos.J.diaIni + s * 1000);
      const dica = `<b>${esc(placa)}</b> · rastro ${hora(pedacos.t0)} → ${hora(pedacos.t1)}`;
      for (const p of pedacos) {
        L.polyline(p.coords, {
          renderer: st.rendRastro, color: cor, weight: p.lig === 1 ? 3 : 4, opacity: OPAC_RASTRO[p.banda] * apaga,
          dashArray: p.lig === 1 ? "5 7" : null, lineCap: "round", lineJoin: "round",
        })
          .bindTooltip(dica + (p.lig === 1 ? "<br><i>sinal espaçado: caminho aproximado</i>" : ""), { sticky: true })
          .on("click", () => selecionar(placa))
          .addTo(st.camRastros);
      }
    }
  }

  function renderRastroCtl() {
    const el = document.getElementById("frtRastroCtl");
    if (!el || !st.dados) return;
    if (!temRastroNoServidor()) {
      el.innerHTML = `<span class="frt-mudo" title="As rotas novas do servidor entram no ar com o restart">Rastro: depois do restart</span>`;
      renderLegendas();
      return;
    }
    const passado = !st.dados.hoje;
    const efetiva = passado && st.rastro !== "off" ? "dia" : st.rastro;
    el.innerHTML = `<span>Rastro:</span><span class="frt-seg" role="group" aria-label="Rastro dos veículos">${JANELAS
      .filter(([j]) => !passado || j === "off" || j === "dia")
      .map(([j, r]) => `<button type="button" data-j="${j}" class="${efetiva === j ? "ativo" : ""}" aria-pressed="${efetiva === j}">${j === "dia" && variosDias() ? "Período todo" : r}</button>`).join("")}</span>
      <button type="button" class="frt-rastro-dica" id="frtLegendaBtn" aria-expanded="${st.legendaRastro}" aria-controls="frtLegendaRastro" title="O que as linhas e cores significam">ⓘ</button>
      ${!filtrandoMapa() && st.rastro !== "off" ? `<span class="frt-dica-ver">☑ marque os carros na lista para ver o rastro</span>` : ""}`;
    el.querySelectorAll("[data-j]").forEach((b) => {
      b.onclick = () => {
        const j = b.dataset.j;
        if (j === efetiva) return;
        const antes = st.rastro;
        st.rastro = j;
        // Em dia passado so existem Desligado/Dia todo: a escolha nao apaga a
        // preferencia "1 h/3 h" de quem acompanha o dia de hoje.
        if (!passado) lsSet(LS_RASTRO, j);
        const faltam = j !== "off" && st.dados.veiculos.every((v) => !Array.isArray(v.rastro));
        if (antes === "off" && faltam) carregar();
        else { prepararRastros(); renderRastroCtl(); renderLista(); desenharMapa(); }
      };
    });
    el.querySelector("#frtLegendaBtn").onclick = () => { st.legendaRastro = !st.legendaRastro; renderRastroCtl(); };
    renderLegendas();
  }

  // Legendas visiveis (nao so em "title", que nao aparece no toque nem no teclado).
  function renderLegendas() {
    const r = document.getElementById("frtLegendaRastro");
    if (r) {
      r.hidden = !st.legendaRastro;
      r.innerHTML = `<b>Rastro:</b> cada carro tem uma cor (a mesma da faixa na placa e do traço na lista) ·
        mais forte = mais recente, mais claro = mais antigo · <span class="frt-tracejado"></span> tracejado = o rastreador mandou sinal espaçado (mais de 5 min), o caminho exato não se sabe.`;
    }
    const s = document.getElementById("frtLegendaSel");
    if (s) {
      s.hidden = !st.sel;
      if (st.sel) {
        s.innerHTML = `<b>${esc(st.sel)}:</b> <i class="frt-lin" style="background:#2563eb"></i> trajeto ·
          <i class="frt-lin" style="background:#dc2626"></i> ≥ ${esc((st.dados && st.dados.vel_excesso) || 90)} km/h ·
          <span class="frt-tl-n">1</span> loja <span class="frt-tl-n fab">1</span> fábrica <span class="frt-tl-n ponto">1</span> ponto <span class="frt-tl-n fora">1</span> parado fora de loja
          · <button type="button" class="frt-link" id="frtIrDetalhe">↓ chegadas e saídas</button>`;
        s.querySelector("#frtIrDetalhe").onclick = () => { const d = document.getElementById("frtDetalhe"); if (d) d.scrollIntoView({ behavior: "smooth", block: "start" }); };
      }
    }
  }

  // ---------------------------------------------------------- situacao
  // Classifica o veiculo AGORA (ou no fim do dia, em data passada).
  function situacao(v) {
    const a = v.atual;
    if (!st.dados || !st.dados.hoje) return v.dia && v.dia.pontos ? { cls: "parado", rotulo: variosDias() ? "Último sinal do período" : "Fim do dia", cor: "#64748b" } : { cls: "sem", rotulo: variosDias() ? "Sem pontos no período" : "Sem pontos no dia", cor: "#94a3b8" };
    if (!a || a.estado === "sem_sinal" || a.fonte_motivo === "ultimo_sinal_antigo") return { cls: "sem", rotulo: a && a.idade_min != null ? `${a.estado === "sem_sinal" ? 'Sem sinal' : 'Sinal antigo'} há ${duracao(a.idade_min)}` : "Sem sinal", cor: "#94a3b8" };
    const perto = a.perto_de && (typeof a.perto_de.dentro==='boolean' ? a.perto_de.dentro : a.perto_de.m <= NO_LUGAR_M) ? a.perto_de : null;
    // parado_min 0/nulo = a plataforma nao informou ha quanto tempo (T4S nao manda).
    const tempo = a.parado_min > 0 ? duracao(a.parado_min) : "";
    if (a.estado === "movendo") return { cls: "rodando", rotulo: `Rodando · ${num(a.velocidade)} km/h`, cor: "#16a34a" };
    if (perto && perto.codigo === "FABRICA") return { cls: "fabrica", rotulo: `Na fábrica${tempo ? " · " + tempo : ""}`, cor: "#2563eb", lugar: perto };
    if (perto) return { cls: "loja", rotulo: `Em ${perto.nome}${perto.ambigua ? " · confirmar loja" : ""}${tempo ? " · " + tempo : ""}`, cor: "#9333ea", lugar: perto };
    return { cls: "parado", rotulo: `Parado${tempo ? " há " + tempo : ""}`, cor: "#d97706" };
  }
  const FILTROS = [
    ["todos", "Todos"], ["rodando", "Rodando"], ["parado", "Parados"], ["loja", "Em loja"], ["fabrica", "Na fábrica"], ["sem", "Sem sinal"],
  ];

  // ---------------------------------------------------------- registro de visitas
  // Servidor ja reiniciado com o registro? (o de antes nao manda "visitas")
  const temRegistro = () => !!(st.dados && st.modo === "completo" && st.dados.veiculos.some((v) => Array.isArray(v.visitas)));
  const extras = () => new Set(st.lugares.filter((l) => l.origem === "manual" && l.codigo !== "FABRICA").map((l) => l.codigo));
  function tipoVisita(x, ext) {
    if (x.fabrica) return "fabrica";
    return ext.has(x.codigo) ? "ponto" : "loja";
  }
  const lojasDoDia = (v) => (v.visitas || []).filter((x) => !x.sem_registro && !x.fabrica).length;

  // Minutos de atraso da chegada sobre o horario previsto da viagem (so com chegada vista).
  function atrasoMin(x) {
    if (!x.prevista || !x.chegada_vista || !x.chegou) return null;
    const m = String(x.prevista).match(/^(\d{1,2}):(\d{2})/);
    if (!m) return null;
    const d = new Date(x.chegou);
    return d.getHours() * 60 + d.getMinutes() - (Number(m[1]) * 60 + Number(m[2]));
  }

  // Textos de chegada/saida/tempo de uma visita (iguais na tabela e no CSV).
  // Visita -> veiculo dono (para saber se ele esta sem sinal). Montado no render.
  let donoVisita = new WeakMap();
  // Visita ainda aberta de carro SEM SINAL: nao da para dizer "ainda la" (o
  // FKW8Y28 aparecia "ainda na fabrica ha 12 h" com o rastreador mudo desde 02:03).
  function semSinalAberta(x) {
    const v = donoVisita.get(x);
    if (x.saiu || !st.dados || !st.dados.hoje || !v || situacao(v).cls !== "sem") return null;
    return (v.dia && v.dia.ultima) || (v.atual && v.atual.posicao_em) || null;
  }

  function textosVisita(x) {
    const agora = Date.now();
    const chegou = x.chegou ? (x.chegada_vista ? hhmm(x.chegou) : `antes das ${hhmm(x.chegou)}`) : "—";
    const mudo = semSinalAberta(x);
    const saiu = x.saiu ? hhmm(x.saiu)
      : mudo ? `sem sinal desde ${hhmm(mudo)}`
      : x.chegou && st.dados && st.dados.hoje ? "ainda lá" : "—";
    let tempo = "—";
    if (x.min != null) tempo = duracao(x.min);
    else if (x.chegou && x.saiu) tempo = `≥ ${duracao((Date.parse(x.saiu) - Date.parse(x.chegou)) / 60000)}`;
    else if (x.chegou && mudo) {
      const min = (Date.parse(mudo) - Date.parse(x.chegou)) / 60000;
      tempo = min >= 1 ? `≥ ${duracao(min)}` : "—"; // 1 sinal so no dia: nao ha tempo a mostrar
    }
    else if (x.chegou && st.dados && st.dados.hoje) tempo = `${x.chegada_vista ? "" : "≥ "}${duracao((agora - Date.parse(x.chegou)) / 60000)}`;
    return { chegou, saiu, tempo };
  }

  function etiquetaPrevista(x) {
    if (!x.prevista) return x.na_viagem ? `<span class="frt-tag">na viagem</span>` : "";
    const a = atrasoMin(x);
    const extra = a == null ? "" : a > 5 ? ` · <b class="frt-atraso">+${duracao(a)}</b>` : " · no horário";
    return `<span class="frt-tag" title="Horário previsto da parada na viagem do TMS">previsto ${esc(x.prevista)}${extra}</span>`;
  }

  // Visitas do dia num lugar (para o tooltip da bolinha da loja).
  function visitasNoLugar(codigos) {
    const out = [];
    if (!st.dados) return out;
    for (const v of st.dados.veiculos) {
      for (const x of v.visitas || []) {
        if (x.sem_registro) continue;
        if (codigos.includes(x.codigo) || (x.ambigua || []).some((c) => codigos.includes(c))) out.push({ v, x });
      }
    }
    return out.sort((a, b) => Date.parse(a.x.chegou) - Date.parse(b.x.chegou));
  }

  // Linhas do registro do veiculo selecionado: visitas (lojas/fabrica/pontos)
  // + paradas fora de loja (do /frota/trajeto), em ordem, numeradas como no mapa.
  function linhasRegistro(v, t) {
    const ext = extras();
    const linhas = [];
    for (const x of v.visitas || []) {
      if (x.sem_registro) continue;
      linhas.push({ tipo: tipoVisita(x, ext), x, ini: x.chegou, lat: x.lat, lng: x.lng });
    }
    if (t && !t.erro) {
      for (const p of t.paradas || []) {
        if (p.lugar) continue; // parada em loja ja e uma visita
        linhas.push({ tipo: "fora", p, ini: p.inicio, lat: p.lat, lng: p.lng });
      }
    }
    linhas.sort((a, b) => Date.parse(a.ini) - Date.parse(b.ini));
    linhas.forEach((l, i) => { l.n = i + 1; });
    return linhas;
  }

  // ---------------------------------------------------------- dados
  async function getJson(url) {
    const r = await fetch(url, { headers: { Accept: "application/json" } });
    if (!r.ok) { const e = new Error(`HTTP ${r.status}`); e.status = r.status; throw e; }
    return r.json();
  }

  const normLugar = (l) => ({ ...l, lat: Number(l.lat), lng: Number(l.lng) });

  // Antes do restart nao existe /frota/painel: monta o mesmo formato com o
  // que ja existe (so o "agora", sem resumo do dia).
  async function carregarFallback() {
    const [pos, lugares] = await Promise.all([getJson(`${API()}/tms/rastreador/posicoes`), getJson(`${API()}/tms/rastreador/lojas`).catch(() => [])]);
    const veiculos = (pos.aparelhos || []).map((a) => {
      const nome = String(a.nome || "");
      return {
        placa: a.placa || nome, modelo: nome.split(" - ").slice(1).join(" - ") || null,
        tipo: /MOTO/i.test(nome) ? "moto" : /ONIX|BYD|SONG/i.test(nome) ? "carro" : /SCUDO|SPRINTER|DAILY|FIORINO/i.test(nome) ? "utilitario" : "caminhao",
        atual: a, fontes: [{ fonte: a.fonte || "srf", posicao_em: a.posicao_em, idade_min: a.idade_min }], dia: null, viagem: null,
      };
    });
    return {
      data: hojeISO(), hoje: true, vel_excesso: 90,
      plataformas: { srf: { configurado: pos.configurado, ultima_coleta: pos.ultima_coleta, erro: pos.erro, falhas_seguidas: pos.falhas_seguidas }, t4s: pos.t4s || {} },
      veiculos, lugares: lugares || [],
    };
  }

  async function carregar() {
    // Pedido no meio de outro (troca de data, rastro ligado, refresh): roda
    // de novo assim que o atual terminar — antes ele era descartado e a tela
    // ficava com os dados do dia anterior.
    if (st.carregando) { st.pendente = true; return; }
    st.carregando = true;
    st.pendente = false;
    st.ultimaCarga = Date.now();
    marcarCarregando(true);
    const pedido = st.data;
    const fimPedido = fimPeriodo();
    const comRastro = st.rastro !== "off";
    const atual = () => pedido === st.data && fimPedido === fimPeriodo() && comRastro === (st.rastro !== "off");
    try {
      let dados, modo;
      try {
        const dias = window.frtPeriodo.datas(pedido, fimPedido, hojeISO());
        const paineis = await window.frtPeriodo.consultar(dias, async (dia) => {
          const p = await getJson(`${API()}/frota/painel?data=${encodeURIComponent(dia)}${comRastro ? "&rastro=1" : ""}${st.lugaresV ? `&lugares_v=${encodeURIComponent(st.lugaresV)}` : ""}`);
          if(p.data !== dia)throw Error('O servidor retornou dados de outra data. Atualize a consulta.');
          return p;
        }, atual);
        if(!paineis){st.pendente=true;return;}
        dados = window.frtPeriodo.painel(paineis);
        modo = "completo";
      } catch (e) {
        if (e.status !== 404 || pedido !== hojeISO() || fimPedido !== pedido) throw e;
        dados = await carregarFallback();
        modo = "basico";
      }
      if (!atual()) { st.pendente = true; return; }
      dados = window.frtPosicoes?.mesclar(dados) || dados;
      if (Array.isArray(dados.lugares)) {
        st.lugares = dados.lugares.map(normLugar);
        st.lugaresV = dados.lugares_v || null;
        st.lugaresMudou = true;
      }
      // Frota da expedicao (cadastro de placas + quem tem viagem no TMS); onibus,
      // carros e motos das plataformas ficam escondidos atras do botao
      // "+ N outros veiculos" (rastreador.js: rastreadorEhExpedicao).
      const eh = (v) => !!v.viagem || typeof window.rastreadorEhExpedicao !== "function" || window.rastreadorEhExpedicao(v.placa);
      const todos = Array.isArray(dados.veiculos) ? dados.veiculos : [];
      st.outrosN = todos.filter((v) => !eh(v)).length;
      if (!st.verOutros) dados = { ...dados, veiculos: todos.filter(eh) };
      let prefs=st.prefs;
      if (modo === "completo") { try { prefs = await getJson(`${API()}/frota/fonte-preferida`); } catch (_) { prefs = prefs || {}; } }
      if(!atual()){st.pendente=true;return;}
      st.dados = dados;
      st.modo = modo;
      st.prefs = prefs;
      render();
      if (st.aposCarregar) { const f = st.aposCarregar; st.aposCarregar = null; setTimeout(f, 50); }
      if (st.sel) {
        const v = dados.veiculos.find((x) => x.placa === st.sel);
        // So busca o trajeto de novo se chegou ponto novo (antes: 1-2x/min o dia inteiro).
        if (v && assinatura(v) !== st.trajAssin && !st.replay) carregarTrajeto(st.sel, false);
        else if (v && !st.replay) renderDetalhe(v, st.trajeto);
      }
    } catch (e) {
      if(!atual()){st.pendente=true;return;}
      const raiz = document.getElementById("frtLista");
      if (raiz) raiz.innerHTML = `<p class="frt-vazio">Não consegui carregar a frota (${esc(e.message)}).</p>`;
      const aviso = document.getElementById("frtAviso");
      if(aviso)aviso.innerHTML=`<div class="frt-faixa" role="alert">Não foi possível carregar ${esc(periodoTexto())}: ${esc(e.message)}. ${st.dados ? "O mapa mantém a última consulta concluída." : "Tente novamente."}</div>`;
    } finally {
      st.carregando = false;
      marcarCarregando(false);
      if (st.pendente) { st.pendente = false; carregar(); }
    }
  }
  const assinatura = (v) => (v && v.dia ? `${v.dia.pontos}|${v.dia.ultima}${variosDias() ? '|'+st.data+'|'+fimPeriodo() : ''}` : "");

  function marcarCarregando(sim) {
    const b = document.getElementById("frtAtualizarBtn");
    if (b) { b.disabled = sim; b.textContent = sim ? "Atualizando…" : "↻ Atualizar"; }
    const consultar = document.getElementById("frtConsultarBtn");
    if(consultar){consultar.disabled=sim;consultar.textContent=sim?'Consultando período…':'Consultar período';}
  }

  function irParaDia(data) {
    return irParaPeriodo(data, data);
  }

  function irParaPeriodo(data, fim) {
    try{window.frtPeriodo.datas(data,fim,hojeISO());}catch(e){
      const aviso=document.getElementById("frtAviso");if(aviso)aviso.innerHTML=`<div class="frt-faixa" role="alert">${esc(e.message)}</div>`;
      return;
    }
    st.data = data;
    st.fim = fim;
    st.seguirHoje = data === hojeISO() && fim === data;
    if(!st.seguirHoje)st.filtro='todos';
    st.rastro = rastroSalvo();
    st.enquadrou = false;
    const el = document.getElementById("frtData");
    if (el) { el.value = data; el.max = hojeISO(); }
    const ate=document.getElementById("frtDataFim");if(ate){ate.value=fim;ate.max=hojeISO();}
    const selecionado=st.sel;
    fecharDetalhe();
    if(selecionado&&!st.aposCarregar)st.aposCarregar=()=>{if(st.dados?.veiculos.some(v=>v.placa===selecionado))selecionar(selecionado);};
    return carregar();
  }

  // ---------------------------------------------------------- esqueleto
  function montar() {
    const raiz = document.getElementById("frtRaiz");
    if (!raiz || raiz.dataset.montado) return;
    raiz.dataset.montado = "1";
    raiz.innerHTML = `
      <div class="frt-abas" role="tablist" aria-label="Partes da aba Frota">
        <button type="button" role="tab" data-parte="vivo" class="ativo" aria-selected="true">🗺 Ao vivo</button>
        <button type="button" role="tab" data-parte="historico" aria-selected="false">🕘 Histórico de rotas</button>
        <button type="button" role="tab" data-parte="operacao" aria-selected="false">🚚 Operação e custos</button>
        <button type="button" role="tab" data-parte="rota" aria-selected="false">🧭 Calcular rota</button>
        <button type="button" role="tab" data-parte="relatorios" aria-selected="false">📊 Relatórios</button>
        <button type="button" role="tab" data-parte="areas" aria-selected="false">⚠ Alertas e áreas</button>
        <button type="button" role="tab" data-parte="t4s" aria-selected="false">T4S · Rotas e alertas</button>
        <button type="button" role="tab" data-parte="manutencao" aria-selected="false">🔧 Manutenção</button>
      </div>
      <div id="frtParteHistorico" class="frt-parte" hidden></div>
      <div id="frtParteOperacao" class="frt-parte" hidden></div>
      <div id="frtParteRota" class="frt-parte" hidden></div>
      <div id="frtParteRelatorios" class="frt-parte" hidden></div>
      <div id="frtParteAreas" class="frt-parte" hidden></div>
      <div id="frtParteT4s" class="frt-parte" hidden></div>
      <div id="frtParteManutencao" class="frt-parte" hidden></div>
      <div id="frtVivo" class="frt-parte">
      <div id="frtMapaPainel">
      <div class="section-shell frt-topo">
        <div class="section-head">
          <div>
            <h2>🛰 Frota</h2>
            <p class="tms-subtitle">Onde está cada veículo, o que rodou no dia, quando chegou e saiu de cada loja e como estão os rastreadores (SRF + T4S).</p>
          </div>
          <div class="frt-acoes">
            <label class="frt-periodo-campo">De<input type="date" id="frtData" aria-label="Data inicial do período" /></label>
            <label class="frt-periodo-campo">Até<input type="date" id="frtDataFim" aria-label="Data final do período" /></label>
            <button type="button" class="btn-primary btn-sm" id="frtConsultarBtn" title="Ver o percurso e os totais deste período no mapa abaixo (até 31 dias)">Consultar período</button>
            <button type="button" class="btn-ghost btn-sm" id="frtHojeBtn">Hoje</button>
            <button type="button" class="btn-ghost btn-sm" id="frtAtualizarBtn">↻ Atualizar</button>
            <button type="button" class="btn-ghost btn-sm" id="frtTelaCheiaBtn" aria-controls="frtMapaPainel" aria-pressed="false">⛶ Tela cheia</button>
          </div>
        </div>
        <div id="frtAviso"></div>
        <div id="frtPlataformas" class="frt-plataformas"></div>
        <div id="frtKpis" class="frt-kpis"></div>
      </div>
      <div class="frt-grid">
        <div class="section-shell frt-mapa-box">
          <div class="frt-mapa-cabecalho">
            <div class="frt-mapa-titulo"><strong>Mapa da frota</strong><span id="frtMapaResumo">Carregando posições…</span></div>
            <button type="button" class="frt-enquadrar-btn" id="frtEnquadrarBtn" title="Enquadrar as posições dos veículos exibidos">⌖ Enquadrar veículos</button>
          </div>
          <div class="frt-mapa-area">
            <div id="frtMapa" class="frt-mapa" aria-label="Mapa da frota"></div>
            <button type="button" class="frt-tela-cheia-mapa" id="frtTelaCheiaMapaBtn" aria-controls="frtMapaPainel" aria-pressed="false" title="Ampliar o mapa com as informações dos veículos">⛶ Tela cheia</button>
          </div>
          <div class="frt-mapa-rodape">
            <div class="frt-mapa-controles">
              <span id="frtRastroCtl" class="frt-rastro-ctl"></span>
              <label class="frt-check"><input type="checkbox" id="frtLojasChk" /> Lojas e fábrica</label>
            </div>
            <div class="frt-legenda" aria-label="Legenda das situações dos veículos">
              <span><i style="background:#16a34a"></i>Rodando</span>
              <span><i style="background:#d97706"></i>Parado</span>
              <span><i style="background:#9333ea"></i>Em loja</span>
              <span><i style="background:#2563eb"></i>Fábrica</span>
              <span><i style="background:#94a3b8"></i>Sem sinal</span>
            </div>
            <div class="frt-mapa-notas">
              <span id="frtPosicoesInfo" class="frt-posicoes-info" role="status" aria-live="polite"></span>
              <span id="frtEnquadro" class="frt-mapa-aviso"></span>
              <span id="frtMapaAviso" class="frt-mapa-aviso"></span>
            </div>
          </div>
          <div id="frtLegendaRastro" class="frt-legenda-linha" hidden></div>
          <div id="frtLegendaSel" class="frt-legenda-linha" hidden></div>
        </div>
        <div id="frtLateral" class="frt-lateral" role="region" aria-label="Veículos e detalhes">
        <div class="section-shell frt-lista-box">
          <div id="frtVerBar" class="frt-verbar"></div>
          <div id="frtFiltros" class="frt-filtros" role="toolbar" aria-label="Filtrar veículos"></div>
          <input type="search" id="frtBusca" class="frt-busca" placeholder="Buscar placa, motorista, rota, modelo…" />
          <div id="frtLista" class="frt-lista"></div>
        </div>
        <div id="frtDetalhe" class="section-shell frt-detalhe hidden"></div>
        </div>
      </div>
      </div>
      <div class="section-shell" id="frtRegistroBox">
        <div class="section-head">
          <div>
            <h2 style="font-size:16px;">🏬 Chegadas e saídas nas lojas</h2>
            <p class="tms-subtitle">Pelo GPS: chegada e saída usam a área de cada loja, com leituras de confirmação. Ajuste os limites em Precisão do GPS. Mais recentes primeiro.</p>
          </div>
          <div class="frt-acoes">
            <input type="search" id="frtRegBusca" class="frt-busca" placeholder="Buscar placa, loja, motorista…" aria-label="Buscar no registro" />
            <label class="frt-check"><input type="checkbox" id="frtRegFab" /> Incluir fábrica</label>
            <button type="button" class="btn-ghost btn-sm" id="frtRegCsv">⬇ Exportar (Excel)</button>
          </div>
        </div>
        <div id="frtRegistro"></div>
      </div>
      <div class="section-shell" id="frtFabricaBox">
        <div class="section-head">
          <div>
            <h2 style="font-size:16px;">🏭 Entradas e saídas da fábrica</h2>
            <p class="tms-subtitle">Pelo GPS: chegada e saída usam a área da fábrica. Ajuste o contorno do pátio em Precisão do GPS para evitar eventos durante manobras. Mais recentes primeiro.</p>
          </div>
          <div class="frt-acoes">
            <input type="search" id="frtFabBusca" class="frt-busca" placeholder="Buscar placa, motorista…" aria-label="Buscar entradas na fábrica" />
            <button type="button" class="btn-ghost btn-sm" id="frtFabCsv">⬇ Exportar (Excel)</button>
          </div>
        </div>
        <div id="frtFabResumo" class="frt-plataformas"></div>
        <div id="frtFabrica"></div>
      </div>
      <div class="section-shell">
        <div class="section-head"><h2 style="font-size:16px;">🩺 Saúde dos rastreadores</h2></div>
        <div id="frtSaude"></div><div id="frtPrecisao"></div>
      </div>
      </div>`;

    // Partes da aba: Ao vivo (este arquivo) e Relatorios / Alertas e areas /
    // Manutencao (frota-relatorios.js, que usa window.frtApi).
    raiz.querySelectorAll(".frt-abas [data-parte]").forEach((b) => {
      b.onclick = () => mudarParte(b.dataset.parte);
    });

    window.frtPrecisao?.montar();
    window.frtTelaCheia?.montar(() => st.mapa?.invalidateSize({pan:false}), {parte:'frtVivo'});
    const data = raiz.querySelector("#frtData");
    data.value = st.data;
    data.max = hojeISO();
    const ate = raiz.querySelector("#frtDataFim");
    ate.value = fimPeriodo();ate.max = hojeISO();
    const consultarPeriodo = () => irParaPeriodo(data.value, ate.value);
    const alterouDatas = () => { const aviso = raiz.querySelector("#frtAviso");aviso.innerHTML='<div class="frt-faixa">Datas alteradas. Clique em Consultar período para atualizar este mapa (até 31 dias por consulta).</div>'; };
    data.onchange = ate.onchange = alterouDatas;
    raiz.querySelector("#frtHojeBtn").onclick = () => irParaDia(hojeISO());
    raiz.querySelector("#frtAtualizarBtn").onclick = consultarPeriodo;
    raiz.querySelector("#frtConsultarBtn").onclick = consultarPeriodo;
    raiz.querySelector("#frtEnquadrarBtn").onclick = enquadrarExibidos;
    raiz.querySelector("#frtBusca").oninput = (e) => { st.busca = e.target.value; renderLista(); };
    const chk = raiz.querySelector("#frtLojasChk");
    chk.checked = lsGet(LS_LOJAS, "1") === "1";
    chk.onchange = () => { lsSet(LS_LOJAS, chk.checked ? "1" : "0"); desenharLugares(); };
    raiz.querySelector("#frtRegBusca").oninput = (e) => { st.regBusca = e.target.value; renderRegistro(); };
    const fab = raiz.querySelector("#frtRegFab");
    fab.checked = st.regFabrica;
    fab.onchange = () => { st.regFabrica = fab.checked; lsSet(LS_REG_FAB, fab.checked ? "1" : "0"); renderRegistro(); };
    raiz.querySelector("#frtRegCsv").onclick = exportarRegistro;
    raiz.querySelector("#frtFabBusca").oninput = (e) => { st.fabBusca = e.target.value; renderFabrica(); };
    raiz.querySelector("#frtFabCsv").onclick = exportarFabrica;
  }

  function mudarParte(parte, opcoes = {}) {
    const raiz = document.getElementById("frtRaiz");
    if (!raiz) return;
    if (parte !== "vivo") pararReplay();
    if (parte !== "historico") window.frtHistorico?.ocultar();
    if (parte !== "t4s") window.frtT4s?.ocultar();
    raiz.querySelectorAll(".frt-abas [data-parte]").forEach((b) => {
      const ativo = b.dataset.parte === parte;
      b.classList.toggle("ativo", ativo);
      b.setAttribute("aria-selected", String(ativo));
    });
    document.getElementById("frtVivo").hidden = parte !== "vivo";
    ["historico", "operacao", "rota", "relatorios", "areas", "t4s", "manutencao"].forEach((p) => { document.getElementById(`frtParte${p[0].toUpperCase()}${p.slice(1)}`).hidden = p !== parte; });
    if (parte === "vivo") { if (st.mapa) setTimeout(() => st.mapa.invalidateSize(), 50); }
    else if (parte === "historico") return window.frtHistorico?.abrir(opcoes.placa || st.sel || undefined, opcoes);
    else if (parte === "operacao") return window.frtOperacao?.abrir();
    else if (parte === "t4s") return window.frtT4s?.abrir();
    else if (parte === "rota") { const placa = st.rotaPlaca; st.rotaPlaca = null; return window.frtRota?.abrir(placa || undefined); }
    else return window.frtRel?.abrir(parte);
  }

  // ---------------------------------------------------------- render
  function render() {
    if (!st.dados) return;
    donoVisita = new WeakMap();
    for (const v of st.dados.veiculos) for (const x of v.visitas || []) donoVisita.set(x, v);
    atribuirCores();
    prepararRastros();
    renderAviso();
    renderPosicoesInfo();
    renderPlataformas();
    renderRastroCtl();
    renderKpis();
    renderVerBar();
    renderFiltros();
    renderLista();
    renderRegistro();
    renderFabrica();
    renderSaude();
    desenharMapa();
  }

  function renderPosicoesInfo() {
    const el=document.getElementById("frtPosicoesInfo");if(!el)return;
    el.classList.remove("frt-posicoes-erro");
    if(!st.dados?.hoje){el.textContent="";return;}
    const em=st.dados.posicoes_atualizadas_em || st.dados.gerado_em;
    el.textContent="Atualização da tela: 5 s"+(st.dados.coleta_intervalo_s?" · coleta: "+st.dados.coleta_intervalo_s+" s":"")+(em?" · consulta às "+new Date(em).toLocaleTimeString("pt-BR",{timeZone:"America/Sao_Paulo",hour:"2-digit",minute:"2-digit",second:"2-digit"}):"")+" · horário do sinal GPS nos veículos";
  }
  function aplicarPosicoes(leitura) {
    if(!podeAtualizar() || !st.dados)return;
    const anterior=st.dados,novo=window.frtPosicoes.mesclar(anterior,leitura);
    if(novo===anterior)return;
    const mudou=JSON.stringify(anterior.veiculos.map(v=>[v.atual,v.fontes]))!==JSON.stringify(novo.veiculos.map(v=>[v.atual,v.fontes]));
    st.dados=novo;renderPosicoesInfo();renderPlataformas();
    if(!mudou)return;
    donoVisita=new WeakMap();for(const v of novo.veiculos)for(const x of v.visitas || [])donoVisita.set(x,v);
    renderKpis();renderFiltros();renderLista();renderSaude();
    if(st.mapa)desenharVeiculos();
    const selecionado=novo.veiculos.find(v=>v.placa===st.sel);
    if(selecionado && !st.replay)renderDetalhe(selecionado,st.trajeto);
  }
  function renderAviso() {
    const el = document.getElementById("frtAviso");
    if (!el) return;
    el.innerHTML = st.modo === "basico"
      ? `<div class="frt-faixa">Mostrando só a posição de agora. Os quilômetros, as paradas e o trajeto do dia aparecem depois que o servidor for reiniciado.</div>`
      : !st.dados.hoje ? `<div class="frt-faixa">${variosDias() ? 'Período' : 'Dia'} ${esc(periodoTexto())}: percurso e totais ${variosDias() ? 'do período' : 'do dia'}. Os marcadores mostram a última posição registrada. Marque os veículos para ver os rastros neste mapa.</div>` : "";
  }

  function renderPlataformas() {
    const el = document.getElementById("frtPlataformas");
    if (!el) return;
    const p = st.dados.plataformas || {};
    const chip = (nome, x) => {
      if (!x || x.configurado === false) return `<span class="frt-plat frt-plat-off">${nome}: não configurado</span>`;
      if (x.sessao_expirada) return `<span class="frt-plat frt-plat-erro" title="${esc(x.erro || "")}">⚠ ${nome}: refazer login</span>`;
      const idade = x.ultima_coleta ? Math.round((Date.now() - new Date(x.ultima_coleta).getTime()) / 60000) : null;
      if (x.erro && (idade == null || idade > 3)) return `<span class="frt-plat frt-plat-erro" title="${esc(x.erro)}">⚠ ${nome}: sem resposta${idade != null ? " há " + duracao(idade) : ""}</span>`;
      return `<span class="frt-plat frt-plat-ok">● ${nome}: ok${idade != null ? ` · coletado ${idade <= 1 ? "agora" : "há " + duracao(idade)}` : ""}</span>`;
    };
    el.innerHTML = chip("SRF", p.srf) + chip("T4S", p.t4s) + (p.sat && p.sat.configurado !== false ? chip("Sat", p.sat) : "");
  }

  function renderKpis() {
    const el = document.getElementById("frtKpis");
    if (!el) return;
    const vs = st.dados.veiculos;
    const cont = { rodando: 0, parado: 0, loja: 0, fabrica: 0, sem: 0 };
    vs.forEach((v) => { cont[situacao(v).cls]++; });
    const km = vs.reduce((s, v) => s + ((v.dia && v.dia.km) || 0), 0);
    const exc = vs.reduce((s, v) => s + ((v.dia && v.dia.excessos) || 0), 0);
    const comViagem = vs.filter((v) => v.viagem).length;
    const chegadas = vs.reduce((s, v) => s + lojasDoDia(v), 0);
    const kpi = (valor, rotulo, extra = "", filtro = "") => `<button type="button" class="frt-kpi ${extra}" ${filtro ? `data-filtro="${filtro}"` : "disabled"}><b>${valor}</b><span>${rotulo}</span></button>`;
    el.innerHTML = [
      kpi(vs.length, "Veículos", "", "todos"),
      st.dados.hoje ? kpi(cont.rodando, "Rodando", "frt-k-rodando", "rodando") : "",
      st.dados.hoje ? kpi(cont.parado, "Parados fora", "frt-k-parado", "parado") : "",
      st.dados.hoje ? kpi(cont.loja, "Em loja", "frt-k-loja", "loja") : "",
      st.dados.hoje ? kpi(cont.fabrica, "Na fábrica", "frt-k-fabrica", "fabrica") : "",
      st.dados.hoje ? kpi(cont.sem, "Sem sinal", cont.sem ? "frt-k-sem" : "", "sem") : "",
      st.modo === "completo" ? kpi(num(km, 0), variosDias() ? "km no período" : "km no dia") : "",
      temRegistro() ? kpi(chegadas, "Passagens em loja", "", "@registro") : "",
      st.modo === "completo" ? kpi(comViagem, "Com viagem no TMS") : "",
      st.modo === "completo" ? kpi(exc, `Leituras ≥ ${st.dados.vel_excesso} km/h`, exc ? "frt-k-exc" : "") : "",
    ].join("");
    el.querySelectorAll("[data-filtro]").forEach((b) => {
      b.onclick = () => {
        if (b.dataset.filtro === "@registro") { document.getElementById("frtRegistroBox").scrollIntoView({ behavior: "smooth", block: "start" }); return; }
        st.filtro = b.dataset.filtro; lsSet(LS_FILTRO, st.filtro); renderFiltros(); renderLista();
      };
    });
  }

  function renderFiltros() {
    const el = document.getElementById("frtFiltros");
    if (!el) return;
    const vs = st.dados.veiculos;
    const conta = (f) => (f === "todos" ? vs.length : vs.filter((v) => situacao(v).cls === f).length);
    const lista = st.dados.hoje ? FILTROS : FILTROS.slice(0, 1);
    if (!lista.some(([f]) => f === st.filtro)) st.filtro = "todos";
    el.innerHTML = lista.map(([f, r]) => `<button type="button" class="frt-filtro${st.filtro === f ? " ativo" : ""}" data-f="${f}" aria-pressed="${st.filtro === f}">${r} <small>${conta(f)}</small></button>`).join("")
      + (st.outrosN ? `<button type="button" class="frt-filtro${st.verOutros ? " ativo" : ""}" data-outros="1" aria-pressed="${st.verOutros}" title="Ônibus, carros e motos que estão nas plataformas mas não são da expedição">${st.verOutros ? "− ocultar" : "+"} ${st.outrosN} outros veículos</button>` : "");
    const bOutros = el.querySelector("[data-outros]");
    if (bOutros) bOutros.onclick = () => { st.verOutros = !st.verOutros; lsSet(LS_OUTROS, st.verOutros ? "1" : "0"); carregar(); };
    el.querySelectorAll("[data-f]").forEach((b) => { b.onclick = () => { st.filtro = b.dataset.f; lsSet(LS_FILTRO, st.filtro); renderFiltros(); renderLista(); }; });
  }

  const ORDEM = { rodando: 0, loja: 1, parado: 2, fabrica: 3, sem: 4 };
  function visiveis() {
    const q = st.busca.trim().toUpperCase();
    return st.dados.veiculos
      .filter((v) => st.filtro === "todos" || situacao(v).cls === st.filtro)
      .filter((v) => !q || [v.placa, v.modelo, v.viagem && v.viagem.motorista, v.viagem && v.viagem.rota].some((x) => String(x || "").toUpperCase().includes(q)))
      .sort((a, b) => (ORDEM[situacao(a).cls] - ORDEM[situacao(b).cls]) || String(a.placa).localeCompare(String(b.placa)));
  }

  function textoSinalGps(v) {
    const atual=st.dados?.hoje;
    const em=atual?v.atual?.posicao_em:v.dia?.ultima;
    const fonte=atual?v.atual?.fonte:v.dia?.fonte;
    if(!em || !Number.isFinite(Date.parse(em)))return 'GPS: sem leitura válida';
    const hora=new Date(em).toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'});
    return 'Sinal GPS'+(fonte?' '+String(fonte).toUpperCase():'')+': '+hora;
  }

  function chipsFontes(v) {
    return (v.fontes || []).map((f) => {
      const ruim = f.idade_min == null || f.idade_min > MUDO_MIN;
      const t = f.idade_min == null ? "nunca" : f.idade_min <= 1 ? "agora" : duracao(f.idade_min);
      return `<span class="frt-fonte${ruim ? " frt-fonte-ruim" : ""}" title="Último sinal ${esc(String(f.fonte).toUpperCase())}: ${f.posicao_em ? esc(new Date(f.posicao_em).toLocaleString("pt-BR")) : "nunca"}">${esc(String(f.fonte).toUpperCase())} ${t}</span>`;
    }).join("");
  }
  const swatch = (placa) => (st.rastros.has(placa)
    ? `<span class="frt-rc" style="background:${corDoVeiculo(placa)}" title="Cor do rastro no mapa"></span>` : "");

  // "6/12 lojas · ⚠ 3 sem registro · 📍 em ILHA · próxima: QUEIMADOS".
  // Visitadas contam o GPS (back/frota.js resumoViagem): loja por onde o
  // caminhao ja passou nao e mais a "proxima" so porque o registro nao veio.
  // Servidor antigo (sem paradas_visitadas) cai na contagem por registro.
  function progressoViagem(vi) {
    const feitas = vi.paradas_visitadas ?? vi.paradas_feitas;
    const semReg = vi.sem_registro || [];
    const pul = vi.puladas || [];
    return `${feitas}/${vi.paradas_total} lojas`
      + (semReg.length ? ` · <span style="color:#d97706;font-weight:700;" title="O GPS viu o caminhão passar, falta lançar o registro: ${esc(semReg.join(", "))}">⚠ ${semReg.length} sem registro</span>` : "")
      + (pul.length ? ` · <span style="color:var(--text-muted);" title="Ficaram para trás sem visita do GPS nem registro (pulou ou o GPS não viu): ${esc(pul.join(", "))}">${pul.length} pulada${pul.length === 1 ? "" : "s"}</span>` : "")
      + (vi.atual ? ` · 📍 em <b>${esc(vi.atual)}</b>` : "")
      + (vi.area_sinal ? ` · 📍 ${vi.area_sinal_antigo ? "último sinal na área de" : "na área de"} <b>${esc(vi.area_sinal)}</b> às ${hhmm(vi.area_sinal_em)} · ${vi.area_sinal_antigo ? "aguardando atualização" : "aguardando parada"}` : "")
      + (vi.proxima ? ` · próxima: <b>${esc(vi.proxima)}</b>` : "");
  }
  // saida_real e coluna TIME ("06:05:00"): new Date() dava "Invalid Date".
  const horaSaida = (vi) => (vi.saida_real ? ` · saiu ${String(vi.saida_real).slice(0, 5)}` : vi.saida_gps ? ` · saiu ${hhmm(vi.saida_gps)} (GPS)` : "");

  function renderLista() {
    const el = document.getElementById("frtLista");
    if (!el || !st.dados) return;
    const vs = visiveis();
    if (!vs.length) { el.innerHTML = `<p class="frt-vazio">Nenhum veículo neste filtro.</p>`; return; }
    el.innerHTML = vs.map((v) => {
      const s = situacao(v);
      const vi = v.viagem;
      const dia = v.dia;
      const lojas = lojasDoDia(v);
      const linhaViagem = vi
        ? `${esc(vi.rota || "Viagem")}${vi.motorista ? " · " + esc(vi.motorista) : ""} · ${progressoViagem(vi)}${vi.continua_pernoite ? " · 🏨 2º dia" : ""}`
        : st.modo === "completo" ? `<span class="frt-mudo">sem viagem no TMS</span>` : "";
      const linhaDia = dia && dia.pontos
        ? `${num(dia.km, 1)} km · ${duracao(dia.movendo_min)} rodando · ${dia.paradas_n} parada${dia.paradas_n === 1 ? "" : "s"}${dia.paradas_fora ? ` (${dia.paradas_fora} fora de loja)` : ""}${lojas ? ` · 🏬 ${lojas} loja${lojas === 1 ? "" : "s"}` : ""}${dia.vel_max ? ` · máx ${dia.vel_max} km/h` : ""}${dia.excessos ? ` <span class="frt-exc">⚠ ${dia.excessos}× ≥${st.dados.vel_excesso}</span>` : ""}`
        : dia ? `<span class="frt-mudo">sem pontos ${variosDias() ? 'no período' : 'no dia'}</span>` : "";
      const marcado = st.ver.has(v.placa);
      return `<div class="frt-item-linha${marcado ? " marcado" : ""}" style="${marcado ? `--rc:${corDoVeiculo(v.placa)}` : ""}">
        <label class="frt-ver" title="${marcado ? "Tirar do mapa" : "Ver no mapa (com rastro)"}">
          <input type="checkbox" data-ver="${esc(v.placa)}" ${marcado ? "checked" : ""} aria-label="Ver ${esc(v.placa)} no mapa" />
        </label>
        <button type="button" class="frt-item${st.sel === v.placa ? " sel" : ""}" data-placa="${esc(v.placa)}">
          <span class="frt-ponto" style="background:${s.cor}"></span>
          <span class="frt-item-corpo">
            <span class="frt-item-l1"><b class="frt-placa">${esc(v.placa)}</b>${swatch(v.placa)} <span class="frt-modelo">${ICONE_TIPO[v.tipo] || ""} ${esc(v.modelo || "")}</span><span class="frt-fontes">${chipsFontes(v)}</span></span>
            <span class="frt-item-l2" style="color:${s.cor}">${esc(s.rotulo)}${v.volta ? ` <span class="frt-volta" title="Tempo de carro da posição atual até a fábrica (${num(v.volta.km, 1)} km), sem contar paradas que ainda faltam">· 🏭 volta ~${hhmm(v.volta.eta)}</span>` : ""}</span>
            ${linhaViagem ? `<span class="frt-item-l3">${linhaViagem}</span>` : ""}
            ${linhaDia ? `<span class="frt-item-l3">${linhaDia}</span>` : ""}
            <span class="frt-item-l3">${esc(textoSinalGps(v))}</span>
          </span>
        </button></div>`;
    }).join("");
    el.querySelectorAll(".frt-item").forEach((b) => { b.onclick = () => selecionar(b.dataset.placa); });
    el.querySelectorAll("[data-ver]").forEach((c) => {
      c.onchange = () => { marcar(c.dataset.ver, c.checked); aposMudarVer(c.checked && st.ver.size === 1); };
    });
  }

  // Barra "No mapa": quantos marcados + atalhos.
  function renderVerBar() {
    const el = document.getElementById("frtVerBar");
    if (!el || !st.dados) return;
    const rodaram = st.dados.veiculos.filter((v) => Array.isArray(v.rastro) && v.rastro.length > 1).map((v) => v.placa);
    el.innerHTML = `<span><b>No mapa:</b> ${st.ver.size ? `${st.ver.size} carro${st.ver.size === 1 ? "" : "s"} marcado${st.ver.size === 1 ? "" : "s"}` : "todos (sem rastro)"}</span>
      ${rodaram.length ? `<button type="button" class="frt-link" data-acao="rodaram" title="Marca os ${rodaram.length} carros que saíram do pátio no dia">Marcar os que rodaram (${rodaram.length})</button>` : ""}
      ${st.ver.size ? `<button type="button" class="frt-link" data-acao="enquadrar">Enquadrar</button><button type="button" class="frt-link" data-acao="limpar">Limpar</button>` : ""}`;
    el.querySelectorAll("[data-acao]").forEach((b) => {
      b.onclick = () => {
        const a = b.dataset.acao;
        if (a === "rodaram") { rodaram.forEach((p) => marcar(p, true)); aposMudarVer(true); }
        else if (a === "limpar") { st.ver.clear(); salvarVer(); aposMudarVer(false); }
        else enquadrarMarcados();
      };
    });
  }

  // Enquadra o mapa nos carros marcados (posicao + rastro do dia).
  function enquadrarMarcados() {
    if (!st.mapa || !st.dados || !st.ver.size) return;
    const pts = [];
    for (const v of st.dados.veiculos) {
      if (!st.ver.has(v.placa)) continue;
      const pos = posicaoNoMapa(v);
      if (pos) pts.push(pos);
      for (const pd of st.rastros.get(v.placa) || []) for (const c of pd.coords) pts.push(c);
    }
    if (pts.length) st.mapa.fitBounds(window.L.latLngBounds(pts), { maxZoom: 15, padding: [30, 30] });
  }

  // Registro da frota toda: uma linha por passagem em loja (e na fabrica, se
  // marcado), mais recentes primeiro; no fim, as lojas da viagem sem passagem.
  function linhasRegistroFrota() {
    const ext = extras();
    const q = st.regBusca.trim().toUpperCase();
    const linhas = [];
    for (const v of st.dados.veiculos) {
      for (const x of v.visitas || []) {
        if (x.fabrica && !st.regFabrica) continue;
        const l = { v, x, tipo: x.sem_registro ? "sem" : tipoVisita(x, ext) };
        const vi = x.viagem || v.viagem;
        const texto = [v.placa, x.nome, x.data, vi && vi.motorista, vi && vi.rota].join(" ").toUpperCase();
        if (!q || texto.includes(q)) linhas.push(l);
      }
    }
    return linhas.sort((a, b) => {
      if (a.tipo === "sem" || b.tipo === "sem") return (a.tipo === "sem") - (b.tipo === "sem") || String(a.v.placa).localeCompare(String(b.v.placa));
      return Date.parse(b.x.chegou) - Date.parse(a.x.chegou);
    });
  }

  function renderRegistro() {
    const el = document.getElementById("frtRegistro");
    if (!el || !st.dados) return;
    if (st.modo !== "completo") { el.innerHTML = `<p class="frt-vazio">O registro de chegadas e saídas aparece depois que o servidor for reiniciado.</p>`; return; }
    if (!temRegistro()) { el.innerHTML = `<p class="frt-vazio">O registro de chegadas e saídas aparece depois que o servidor for reiniciado (o servidor no ar ainda é de antes desta função).</p>`; return; }
    const linhas = linhasRegistroFrota();
    if (!linhas.length) {
      el.innerHTML = `<p class="frt-vazio">${st.regBusca ? "Nada encontrado nesta busca." : "Nenhuma chegada em loja registrada pelo GPS " + (variosDias() ? "neste período." : "neste dia.")}</p>`;
      return;
    }
    el.innerHTML = `<div class="frt-tabela-wrap"><table class="frt-tabela frt-reg">
      <thead><tr><th>Placa</th><th>Onde</th><th>Chegou</th><th>Saiu</th><th>Tempo</th><th>Viagem</th></tr></thead>
      <tbody>${linhas.map((l, i) => {
        const { v, x } = l;
        const vi = x.viagem || v.viagem;
        if (l.tipo === "sem") {
          return `<tr class="frt-reg-sem" data-i="${i}"><td><b>${esc(v.placa)}</b>${swatch(v.placa)}</td><td>🏬 ${esc(x.nome)}</td>
            <td colspan="3"><span class="frt-mudo">${x.feita ? "entregue no TMS, sem passagem registrada pelo GPS" : "sem passagem registrada pelo GPS"}</span></td>
            <td>${etiquetaPrevista(x)}${vi && vi.motorista ? ` <span class="frt-mudo">${esc(vi.motorista)}</span>` : ""}</td></tr>`;
        }
        const tx = textosVisita(x);
        const amb = x.ambigua ? ` title="O GPS não separa estas lojas (mesmo ponto de parada)"` : "";
        return `<tr data-i="${i}" tabindex="0"><td><b>${esc(v.placa)}</b>${swatch(v.placa)}</td>
          <td${amb}>${ICONE_REG[l.tipo]} ${esc(l.tipo === "fabrica" ? "Fábrica" : x.nome)}</td>
          <td${x.chegada_vista ? "" : ' title="Já estava lá no 1º sinal do dia"'}>${esc(tx.chegou)}</td>
          <td>${tx.saiu === "ainda lá" ? `<span class="frt-ainda">ainda lá</span>` : esc(tx.saiu)}</td>
          <td>${esc(tx.tempo)}</td>
          <td>${etiquetaPrevista(x)}${vi ? ` <span class="frt-mudo">${esc([vi.rota, vi.motorista].filter(Boolean).join(" · "))}</span>` : ""}</td></tr>`;
      }).join("")}</tbody></table></div>`;
    el.querySelectorAll("tr[data-i]").forEach((tr) => {
      const l = linhas[Number(tr.dataset.i)];
      const ir = () => {
        if (st.sel !== l.v.placa) selecionar(l.v.placa, { semEnquadrar: true });
        if (st.mapa && Number.isFinite(l.x.lat)) st.mapa.setView([l.x.lat, l.x.lng], 16);
        document.getElementById("frtMapa").scrollIntoView({ behavior: "smooth", block: "center" });
      };
      tr.onclick = ir;
      tr.onkeydown = (e) => { if (e.key === "Enter") ir(); };
    });
  }

  // Excel abre CSV com ";" e BOM (acentos certos) no Brasil.
  function baixarCsv(linhas, nome) {
    const cel = (s) => `"${String(s == null ? "" : s).replace(/"/g, '""')}"`;
    const csv = "﻿" + linhas.map((r) => r.map(cel).join(";")).join("\r\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    a.download = nome;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  // ---------------------------------------------------------- fabrica
  // Cada passagem pela fabrica (chegou / saiu / tempo la), de todos os carros.
  function linhasFabrica() {
    const q = st.fabBusca.trim().toUpperCase();
    const linhas = [];
    for (const v of st.dados.veiculos) {
      for (const x of v.visitas || []) {
        if (!x.fabrica || x.sem_registro) continue;
        const vi = x.viagem || v.viagem;
        const texto = [v.placa, v.modelo, x.data, vi && vi.motorista, vi && vi.rota].join(" ").toUpperCase();
        if (!q || texto.includes(q)) linhas.push({ v, x });
      }
    }
    return linhas.sort((a, b) => Date.parse(b.x.chegou) - Date.parse(a.x.chegou));
  }

  function renderFabrica() {
    const el = document.getElementById("frtFabrica");
    const res = document.getElementById("frtFabResumo");
    if (!el || !st.dados) return;
    if (!temRegistro()) {
      if (res) res.innerHTML = "";
      el.innerHTML = `<p class="frt-vazio">As entradas e saídas da fábrica aparecem depois que o servidor for reiniciado.</p>`;
      return;
    }
    const linhas = linhasFabrica();
    const todas = st.dados.veiculos.flatMap((v) => (v.visitas || []).filter((x) => x.fabrica && !x.sem_registro));
    const chegadas = todas.filter((x) => x.chegada_vista).length;
    const saidas = todas.filter((x) => x.saiu).length;
    const agora = st.dados.hoje ? todas.filter((x) => !x.saiu && !semSinalAberta(x)).length : null;
    if (res) {
      res.innerHTML = `<span class="frt-plat">🏭 ${chegadas} chegada${chegadas === 1 ? "" : "s"}</span>
        <span class="frt-plat">➡️ ${saidas} saída${saidas === 1 ? "" : "s"}</span>
        ${agora != null ? `<span class="frt-plat frt-plat-ok">● ${agora} na fábrica agora</span>` : ""}`;
    }
    if (!linhas.length) {
      el.innerHTML = `<p class="frt-vazio">${st.fabBusca ? "Nada encontrado nesta busca." : "Nenhuma passagem pela fábrica registrada pelo GPS neste dia."}</p>`;
      return;
    }
    el.innerHTML = `<div class="frt-tabela-wrap"><table class="frt-tabela frt-reg">
      <thead><tr><th>Placa</th><th>Chegou na fábrica</th><th>Saiu da fábrica</th><th>Tempo na fábrica</th><th>Viagem</th></tr></thead>
      <tbody>${linhas.map(({ v, x }, i) => {
        const tx = textosVisita(x);
        const vi = x.viagem || v.viagem;
        const chegou = x.chegada_vista ? esc(tx.chegou)
          : `<span title="O carro já estava na fábrica no 1º sinal do dia (ex.: dormiu lá)">já estava às ${hhmm(x.chegou)}</span>`;
        return `<tr data-i="${i}" tabindex="0"><td><b>${esc(v.placa)}</b>${swatch(v.placa)} <span class="frt-modelo">${ICONE_TIPO[v.tipo] || ""}</span></td>
          <td>${chegou}</td>
          <td>${tx.saiu === "ainda lá" ? `<span class="frt-ainda">ainda na fábrica</span>` : esc(tx.saiu)}</td>
          <td>${esc(tx.tempo)}</td>
          <td>${vi ? `<span class="frt-mudo">${esc([vi.rota, vi.motorista].filter(Boolean).join(" · "))}</span>` : ""}</td></tr>`;
      }).join("")}</tbody></table></div>`;
    el.querySelectorAll("tr[data-i]").forEach((tr) => {
      const { v, x } = linhas[Number(tr.dataset.i)];
      const ir = () => {
        if (st.sel !== v.placa) selecionar(v.placa, { semEnquadrar: true });
        if (st.mapa && Number.isFinite(x.lat)) st.mapa.setView([x.lat, x.lng], 16);
        document.getElementById("frtMapa").scrollIntoView({ behavior: "smooth", block: "center" });
      };
      tr.onclick = ir;
      tr.onkeydown = (e) => { if (e.key === "Enter") ir(); };
    });
  }

  function exportarFabrica() {
    if (!temRegistro()) return;
    const linhas = [["Data", "Placa", "Modelo", "Motorista", "Rota", "Chegou na fábrica", "Saiu da fábrica", "Tempo na fábrica", "Observação"]];
    for (const { v, x } of linhasFabrica()) {
      const tx = textosVisita(x);
      const vi = x.viagem || v.viagem || {};
      linhas.push([x.data || st.data, v.placa, v.modelo, vi.motorista, vi.rota, x.chegada_vista ? tx.chegou : "", tx.saiu, tx.tempo,
        x.chegada_vista ? "" : `já estava na fábrica no 1º sinal do dia (${hhmm(x.chegou)})`]);
    }
    baixarCsv(linhas, `fabrica-entradas-saidas-${periodoArquivo()}.csv`);
  }

  function exportarRegistro() {
    if (!temRegistro()) return;
    const linhas = [["Data", "Placa", "Motorista", "Rota", "Onde", "Chegou", "Saiu", "Tempo", "Previsto", "Atraso (min)", "Observação"]];
    for (const l of linhasRegistroFrota()) {
      const { v, x } = l;
      const vi = x.viagem || v.viagem || {};
      if (l.tipo === "sem") {
        linhas.push([x.data || st.data, v.placa, vi.motorista, vi.rota, x.nome, "", "", "", x.prevista, "", x.feita ? "entregue no TMS, sem passagem pelo GPS" : "sem passagem registrada pelo GPS"]);
        continue;
      }
      const tx = textosVisita(x);
      const obs = [!x.chegada_vista && "já estava lá no 1º sinal do dia", x.ambigua && "GPS não separa lojas coladas"].filter(Boolean).join("; ");
      linhas.push([x.data || st.data, v.placa, vi.motorista, vi.rota, l.tipo === "fabrica" ? "Fábrica" : x.nome, tx.chegou, tx.saiu, tx.tempo, x.prevista, atrasoMin(x) ?? "", obs]);
    }
    baixarCsv(linhas, `chegadas-saidas-${periodoArquivo()}.csv`);
  }

  // Quem esta mudo e onde: so T4S vivo, so SRF vivo, mudo em tudo.
  function renderSaude() {
    const el = document.getElementById("frtSaude");
    if (!el) return;
    const linhas = st.dados.veiculos.map((v) => {
      const fs = v.fontes || [];
      const vivas = fs.filter((f) => f.idade_min != null && f.idade_min <= MUDO_MIN);
      const mortas = fs.filter((f) => !(f.idade_min != null && f.idade_min <= MUDO_MIN));
      const menor = fs.reduce((m, f) => (f.idade_min != null && (m == null || f.idade_min < m) ? f.idade_min : m), null);
      let nivel = 0, txt = fs.length > 1 ? `OK nas ${fs.length} plataformas` : `OK (só ${esc(String((fs[0] || {}).fonte || "").toUpperCase())})`;
      if (!vivas.length) {
        nivel = menor == null || menor > MUDO_DIA_MIN ? 2 : 1;
        txt = `Mudo em todas há ${duracao(menor)}${nivel === 2 ? " — verificar o aparelho/instalação" : ""}`;
      } else if (mortas.length) {
        nivel = 1;
        txt = mortas.map((f) => `${esc(String(f.fonte).toUpperCase())} parado há ${duracao(f.idade_min)}`).join(", ") + ` — usando ${vivas.map((f) => esc(String(f.fonte).toUpperCase())).join("/")}`;
      }
      if (!v.atual && fs.length) {nivel=Math.max(nivel,1);txt="Sem fonte GPS válida para esta placa. Confira bloqueios e vínculos em Precisão do GPS.";}
      // Rastreador que diz OUTRO lugar (ex.: SRF do FKC2E12 parado na fabrica
      // enquanto T4S/Sat mostram Buzios): aparelho trocado ou largado.
      if(v.atual && v.atual.confiavel_eventos === false) {nivel=Math.max(nivel,1);txt="Sinal antigo ou divergente: não confirma chegadas e saídas automaticamente.";}
      const disc = v.atual && v.atual.fontes_discordantes;
      if (disc && disc.length) {
        nivel = Math.max(nivel, 1);
        txt = `${disc.map((f) => esc(String(f).toUpperCase())).join("/")} diz outro lugar (aparelho trocado ou largado?) — usando ${esc(String(v.atual.fonte).toUpperCase())}` + (txt.startsWith("OK") ? "" : ` · ${txt}`);
      }
      return { v, nivel, txt };
    }).sort((a, b) => b.nivel - a.nivel || String(a.v.placa).localeCompare(String(b.v.placa)));
    const problemas = linhas.filter((l) => l.nivel > 0).length;
    el.innerHTML = `<p class="frt-saude-resumo">${problemas ? `<b>${problemas}</b> veículo(s) com rastreador falhando em pelo menos uma plataforma.` : "Todos os rastreadores respondendo."}</p>
      <div class="frt-tabela-wrap"><table class="frt-tabela">
        <thead><tr><th>Placa</th><th>Modelo</th><th>Sinais</th><th>Situação</th><th title="Qual rastreador vale para este carro">Usar</th></tr></thead>
        <tbody>${linhas.map(({ v, nivel, txt }) => `<tr class="frt-saude-${nivel}"><td><b>${esc(v.placa)}</b></td><td>${esc(v.modelo || "")}</td><td>${chipsFontes(v)}</td><td>${nivel === 2 ? "🔧 " : nivel === 1 ? "⚠ " : "✓ "}${txt}</td><td>${seletorFonte(v)}</td></tr>`).join("")}</tbody>
      </table></div>
      <p class="frt-mudo" style="font-size:11.5px;margin:6px 0 0;">Automático: compara sinais recentes com até 1 min de diferença; fontes bloqueadas e aparelhos não vinculados ficam de fora. Discordância sem consenso exige conferência. Escolha um rastreador fixo quando souber qual é o certo para aquele carro.</p>`;
    el.querySelectorAll("select[data-fonte-placa]").forEach((sel) => {
      sel.onchange = async () => {
        sel.disabled = true;
        try {
          const r = await fetch(`${API()}/frota/fonte-preferida`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ placa: sel.dataset.fontePlaca, fonte: sel.value }) });
          const j = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(r.status === 403 ? "Só administrador pode trocar o rastreador." : j.error || `HTTP ${r.status}`);
          st.prefs = j.preferencias || {};
          setTimeout(carregar, 300);
        } catch (e) {
          (typeof window.alertar === "function" ? window.alertar : alert)(e.message);
          sel.value = (st.prefs || {})[sel.dataset.fontePlaca] || "";
        } finally { sel.disabled = false; }
      };
    });
  }

  function seletorFonte(v) {
    if (st.modo !== "completo") return "";
    const pref = (st.prefs || {})[v.placa] || "";
    const fontes = [...new Set((v.fontes || []).map((f) => String(f.fonte)))];
    if (pref && !fontes.includes(pref)) fontes.push(pref);
    return `<select data-fonte-placa="${esc(v.placa)}" class="frt-sel-fonte" aria-label="Rastreador usado para ${esc(v.placa)}">
      <option value="">Automático${!pref && v.atual ? ` (${esc(String(v.atual.fonte).toUpperCase())})` : ""}</option>
      ${fontes.map((f) => `<option value="${esc(f)}" ${pref === f ? "selected" : ""}>Sempre ${esc(f.toUpperCase())}</option>`).join("")}
    </select>`;
  }

  // ---------------------------------------------------------- mapa
  function carregarLeaflet() {
    if (window.L && window.L.map) return Promise.resolve();
    if (carregarLeaflet.p) return carregarLeaflet.p;
    carregarLeaflet.p = new Promise((ok, erro) => {
      const css = document.createElement("link");
      css.rel = "stylesheet";
      css.href = LEAFLET + "leaflet.css";
      document.head.appendChild(css);
      const s = document.createElement("script");
      s.src = LEAFLET + "leaflet.js";
      s.onload = ok;
      s.onerror = () => { carregarLeaflet.p = null; erro(new Error("não carregou a biblioteca do mapa")); };
      document.head.appendChild(s);
    });
    return carregarLeaflet.p;
  }

  // Uma criacao so, mesmo com varias chamadas enquanto o Leaflet baixa (antes,
  // a 2a chamada fazia L.map de novo no mesmo div e dava erro).
  function garantirMapa() {
    if (st.mapa) return Promise.resolve(true);
    if (!st.mapaP) st.mapaP = criarMapa().finally(() => { st.mapaP = null; });
    return st.mapaP;
  }

  async function criarMapa() {
    const div = document.getElementById("frtMapa");
    if (!div) return false;
    try { await carregarLeaflet(); } catch (e) { div.innerHTML = `<p class="frt-vazio">${esc(e.message)}</p>`; return false; }
    if (st.mapa) return true;
    const L = window.L;
    st.mapa = L.map(div, { zoomControl: true, attributionControl: true }).setView([-22.9, -43.4], 9);
    const tiles = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19, attribution: "© OpenStreetMap", referrerPolicy: "strict-origin-when-cross-origin",
    }).addTo(st.mapa);
    // Antes do restart a CSP ainda bloqueia o fundo: avisa uma vez, o resto funciona.
    tiles.on("tileerror", () => {
      if (st.avisoTile) return;
      st.avisoTile = true;
      const a = document.getElementById("frtMapaAviso");
      if (a) a.textContent = "Fundo do mapa indisponível (aparece depois de reiniciar o servidor).";
    });
    L.control.scale({ imperial: false, position: "bottomleft", maxWidth: 100 }).addTo(st.mapa);
    st.camAreas = L.layerGroup().addTo(st.mapa);
    st.camLugares = L.layerGroup().addTo(st.mapa);
    // Rastros num painel proprio ABAIXO das lojas e do trajeto detalhado, em
    // canvas (dezenas de linhas por minuto ficariam pesadas em SVG).
    st.mapa.createPane("frtRastros").style.zIndex = 350;
    st.rendRastro = L.canvas({ pane: "frtRastros", padding: 0.3, tolerance: 6 });
    st.camRastros = L.layerGroup().addTo(st.mapa);
    st.camTrajeto = L.layerGroup().addTo(st.mapa);
    st.camReplay = L.layerGroup().addTo(st.mapa);
    st.camVeiculos = L.layerGroup().addTo(st.mapa);
    // Agrupamento dos carros depende do zoom (etiquetas que se encostariam).
    st.mapa.on("zoomend", () => { desenharLugares(); desenharVeiculos(); });
    st.lugaresMudou = true;
    return true;
  }

  function corLugar(l) {
    if (l.codigo === "FABRICA") return "#2563eb";
    if (l.origem === "manual") return "#0891b2";
    return "#9333ea";
  }

  function popupLugar(l) {
    const box=document.createElement('div');
    const coincidentes=st.lugares.filter(x=>x.codigo!==l.codigo && distM([l.lat,l.lng],[x.lat,x.lng])<=1);
    box.innerHTML=`<b>${esc(l.nome || l.codigo)}</b>${coincidentes.length
      ? `<p>Mesmo ponto cadastrado de ${esc(coincidentes.map(x=>x.nome || x.codigo).join(' / '))}. Confira o local de descarga de cada loja.</p>` : ''}
      <p><button type="button" class="btn-ghost btn-sm admin-only-action">Corrigir ponto desta loja</button></p>`;
    const botao=box.querySelector('button');
    botao.onclick=async()=>{
      const painel=document.getElementById('frtMapaPainel');
      if(painel?.classList.contains('frt-tela-cheia'))await document.getElementById('frtTelaCheiaBtn')?.onclick?.();
      st.mapa?.closePopup();
      await window.frtPrecisao?.abrirLoja(l.codigo);
    };
    return box;
  }

  // Cada lugar tem seu marcador. Quando as bolinhas se sobrepoem, afastamos
  // apenas o desenho em pixels e ligamos o marcador a coordenada original.
  function desenharLugares() {
    if (!st.mapa) return;
    const L = window.L;
    st.camLugares.clearLayers();
    st.lugaresMudou = false;
    const chk = document.getElementById("frtLojasChk");
    if (chk && !chk.checked) return;
    const zoom = st.mapa.getZoom();
    const ocupados = [];
    const lugares = st.lugares.filter((l) => Number.isFinite(l.lat) && Number.isFinite(l.lng))
      .slice().sort((a, b) => Number(b.codigo === "FABRICA") - Number(a.codigo === "FABRICA")
        || String(a.codigo || a.nome).localeCompare(String(b.codigo || b.nome)));
    for (const l of lugares) {
      const fab = l.codigo === "FABRICA";
      const raio = fab ? 8 : 5;
      const origem = [l.lat, l.lng];
      const px = st.mapa.project(origem, zoom);
      let pos = { x: px.x, y: px.y };
      const sobrepoe = () => ocupados.some((x) => Math.hypot(x.x - pos.x, x.y - pos.y) < x.raio + raio + 4);
      // Aneis em torno da coordenada real: ordem estavel nos refreshes.
      for (let anel = 1; sobrepoe(); anel++) {
        const passos = anel * 8;
        for (let i = 0; i < passos; i++) {
          const angulo = i * 2 * Math.PI / passos;
          pos = { x: px.x + Math.cos(angulo) * anel * LOJAS_SEPARACAO_PX,
            y: px.y + Math.sin(angulo) * anel * LOJAS_SEPARACAO_PX };
          if (!sobrepoe()) break;
        }
      }
      ocupados.push({ ...pos, raio });
      const deslocado = pos.x !== px.x || pos.y !== px.y;
      const coord = deslocado ? st.mapa.unproject([pos.x, pos.y], zoom) : origem;
      const cor = corLugar(l);
      if (deslocado) {
        L.polyline([origem, coord], { color: cor, weight: 1, opacity: 0.5, interactive: false })
          .addTo(st.camLugares);
      }
      L.circleMarker(coord, { radius: raio, color: cor, weight: 2, fillColor: cor, fillOpacity: fab ? 0.5 : 0.25 })
        .bindTooltip(() => {
          const html = `<b>${esc(l.nome || l.codigo)}</b>`;
          if (fab || !temRegistro()) return html;
          const vis = visitasNoLugar([l.codigo]);
          if (!vis.length) return html + `<br><small>nenhuma passagem ${st.dados.hoje ? "hoje" : "neste dia"}</small>`;
          const linhas = vis.slice(-8).map(({ v, x }) => { const tx = textosVisita(x); return `${esc(v.placa)} ${esc(tx.chegou)} → ${esc(tx.saiu)}`; });
          return html + `<br><small>${st.dados.hoje ? "Hoje" : "No dia"}:</small><br>${linhas.join("<br>")}${vis.length > 8 ? `<br><small>+${vis.length - 8} anteriores</small>` : ""}`;
        }, { direction: "top" })
        .bindPopup(() => popupLugar(l))
        .addTo(st.camLugares);
    }
  }

  function posicaoNoMapa(v) {
    if (st.dados.hoje && v.atual && Number.isFinite(v.atual.lat)) return [v.atual.lat, v.atual.lng];
    if (v.dia && v.dia.ultima_pos) return v.dia.ultima_pos;
    return null;
  }

  // Areas de risco/atencao/proibidas (desenhadas na parte "Alertas e areas").
  const COR_AREA = { risco: "#dc2626", proibida: "#7f1d1d", atencao: "#d97706" };
  async function carregarAreas() {
    // So as que avisam: corredor de rota/referencia (cercas do SRF) ficam na
    // parte "Alertas e areas" — 13 corredores no mapa ao vivo virariam ruido.
    try { st.areas = await getJson(`${API()}/frota/areas?tipos=risco,proibida,atencao`); } catch (_) { st.areas = []; }
    desenharAreas();
  }
  function desenharAreas() {
    if (!st.mapa || !st.camAreas) return;
    const L = window.L;
    st.camAreas.clearLayers();
    for (const a of st.areas || []) {
      if (!Array.isArray(a.pontos) || a.pontos.length < 3 || !COR_AREA[a.tipo]) continue;
      const cor = COR_AREA[a.tipo];
      L.polygon(a.pontos, { color: cor, weight: 2, dashArray: "6 5", fillColor: cor, fillOpacity: 0.08 })
        .bindTooltip(`<b>${esc(a.nome)}</b><br><small>${a.tipo === "proibida" ? "área proibida" : a.tipo === "atencao" ? "área de atenção" : "área de risco"}</small>`, { sticky: true })
        .addTo(st.camAreas);
    }
  }

  async function desenharMapa() {
    if (!(await garantirMapa()) || !st.dados) return;
    st.mapa.invalidateSize();
    if (!st.areas) carregarAreas(); // 1a vez
    if (st.lugaresMudou) desenharLugares();
    desenharRastros();
    desenharVeiculos();
    enquadrarInicio();
    renderLegendas();
  }

  function enquadrarExibidos() {
    if (!st.mapa || !st.dados) return;
    const pts = st.dados.veiculos.filter(v => st.marcadores.has(v.placa)).map(posicaoNoMapa).filter(Boolean);
    if (!pts.length) return;
    st.mapa.fitBounds(window.L.latLngBounds(pts), { maxZoom: 15, padding: [35, 35] });
    const aviso = document.getElementById("frtEnquadro");
    if (aviso) aviso.innerHTML = "";
  }

  function renderResumoMapa() {
    const el = document.getElementById("frtMapaResumo");
    if (!el || !st.dados) return;
    const n = st.marcadores.size;
    const dia = st.dados.hoje ? "Hoje" : periodoTexto();
    el.textContent = dia + " · " + n + " veículo" + (n === 1 ? " exibido" : "s exibidos") + (st.sel ? " · selecionado: " + st.sel : "");
    const btn = document.getElementById("frtEnquadrarBtn");
    if (btn) btn.disabled = !n;
  }

  function tooltipVeiculo(v, s) {
    const viagem = v.viagem;
    const em = st.dados.hoje ? v.atual?.posicao_em : v.dia?.ultima;
    const data = em ? new Date(em) : null;
    const sinal = data && Number.isFinite(data.getTime()) ? data.toLocaleString("pt-BR", {day:"2-digit",month:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit"}) : "Não informado";
    return `<div class="frt-tooltip-veiculo" style="--c:${s.cor}">
      <div class="frt-tooltip-topo"><b>${esc(v.placa)}</b><span>${esc(s.rotulo)}</span></div>
      ${viagem?.motorista ? `<div><small>Motorista</small><strong>${esc(viagem.motorista)}</strong></div>` : ""}
      ${viagem?.rota ? `<div><small>Rota</small><strong>${esc(viagem.rota)}</strong></div>` : ""}
      <div class="frt-tooltip-sinal"><small>${st.dados.hoje ? "Último sinal" : "Último ponto"}</small><span>${esc(sinal)}</span></div>
      <small class="frt-tooltip-dica">Clique para ver o trajeto e os detalhes</small>
    </div>`;
  }

  function desenharVeiculos() {
    if (!st.mapa || !st.dados) return;
    const L = window.L;
    // Popup de grupo aberto sobrevive ao refresh (antes sumia a cada minuto).
    const aberto = st.popupPlaca;
    st.camVeiculos.clearLayers();
    st.marcadores.clear();
    const zoom = st.mapa.getZoom();
    // Veiculos que dividiriam o lugar na tela viram UM marcador "PLACA +N"
    // (perto em metros OU etiquetas que se encostariam neste zoom). O
    // selecionado vira o "dono" do grupo em que esta.
    const grupos = [];
    for (const v of st.dados.veiculos) {
      // Com carros marcados, o mapa mostra so eles (e o selecionado).
      if (filtrandoMapa() && !st.ver.has(v.placa) && v.placa !== st.sel) continue;
      const pos = posicaoNoMapa(v);
      if (!pos) continue;
      const px = st.mapa.project(pos, zoom);
      const g = grupos.find((x) => distM(x.pos, pos) <= JUNTA_MAPA_M || (Math.abs(x.px.x - px.x) < JUNTA_PX.x && Math.abs(x.px.y - px.y) < JUNTA_PX.y));
      if (g) g.itens.push(v); else grupos.push({ pos, px, itens: [v] });
    }
    for (const g of grupos) {
      g.itens.sort((a, b) => (b.placa === st.sel) - (a.placa === st.sel) || ORDEM[situacao(a).cls] - ORDEM[situacao(b).cls] || String(a.placa).localeCompare(String(b.placa)));
      const v = g.itens[0];
      const s = situacao(v);
      const sel = v.placa === st.sel;
      const rumo = g.itens.length === 1 && st.dados.hoje && v.atual && s.cls === "rodando" && v.atual.rumo != null ? Number(v.atual.rumo) : null;
      const mais = g.itens.length > 1 ? `<em>+${g.itens.length - 1}</em>` : "";
      const attrsPlaca = st.rastros.has(v.placa) ? `class="frt-mk-placa com-rastro" style="--rc:${corDoVeiculo(v.placa)}"` : `class="frt-mk-placa"`;
      const icone = L.divIcon({
        className: "frt-marcador",
        html: `<span class="frt-mk${sel ? " sel" : ""}" style="--c:${s.cor}">${rumo != null ? `<i class="frt-seta" style="transform:rotate(${rumo}deg)">▲</i>` : `<i class="frt-bola"></i>`}<b ${attrsPlaca}>${esc(v.placa)}</b>${mais}</span>`,
        iconSize: null, iconAnchor: [9, 9],
      });
      const m = L.marker(g.pos, { icon: icone, title: v.placa + " · " + s.rotulo, alt: v.placa, zIndexOffset: sel ? 1000 : ORDEM[s.cls] === 0 ? 500 : 0 }).addTo(st.camVeiculos);
      if (g.itens.length === 1) {
        m.bindTooltip(tooltipVeiculo(v, s), { direction: "top", offset: [0, -8], className: "frt-tooltip-cartao" })
          .on("click", () => selecionar(v.placa));
      } else {
        const lugar = (g.itens.map((x) => situacao(x).lugar).find(Boolean) || {}).nome;
        const html = `<b>${g.itens.length} veículos${lugar ? " · " + esc(lugar) : ""}</b><div class="frt-grupo">${g.itens.map((x) => {
          const sx = situacao(x);
          return `<button type="button" data-placa="${esc(x.placa)}"><i style="background:${sx.cor}"></i><b>${esc(x.placa)}</b>${swatch(x.placa)} ${esc(sx.rotulo)}</button>`;
        }).join("")}</div>`;
        m.bindTooltip(`${g.itens.length} veículos aqui — clique para ver`, { direction: "top", offset: [0, -8] }).bindPopup(html);
        m.on("popupopen", (e) => {
          st.popupPlaca = v.placa;
          e.popup.getElement().querySelectorAll("[data-placa]").forEach((b) => { b.onclick = () => { st.mapa.closePopup(); selecionar(b.dataset.placa); }; });
        });
        m.on("popupclose", () => { if (st.popupPlaca === v.placa) st.popupPlaca = null; });
      }
      g.itens.forEach((x) => st.marcadores.set(x.placa, m));
    }
    renderResumoMapa();
    if (aberto) {
      const mk = st.marcadores.get(aberto);
      if (mk && mk.getPopup()) mk.openPopup();
    }
  }

  // 1o enquadramento: a frota "de verdade" (sem quem esta sem sinal e sem o
  // carro solto a 130 km — antes um Onix em Cabo Frio espremia todo mundo).
  function enquadrarInicio() {
    if (st.enquadrou || st.sel || !st.mapa) return;
    if (filtrandoMapa()) { st.enquadrou = true; enquadrarMarcados(); return; }
    const L = window.L;
    const todos = [], foco = [];
    for (const v of st.dados.veiculos) {
      const p = posicaoNoMapa(v);
      if (!p) continue;
      todos.push(p);
      if (!st.dados.hoje || situacao(v).cls !== "sem") foco.push(p);
    }
    if (!todos.length) return;
    const base = foco.length ? foco : todos;
    const meio = [mediana(base.map((p) => p[0])), mediana(base.map((p) => p[1]))];
    const perto = base.filter((p) => distM(p, meio) <= ENQUADRO_M);
    const usar = perto.length ? perto : base;
    st.mapa.fitBounds(L.latLngBounds(usar), { maxZoom: 13, padding: [30, 30] });
    st.enquadrou = true;
    const fora = todos.length - usar.length;
    const el = document.getElementById("frtEnquadro");
    if (el) {
      el.innerHTML = fora ? `<button type="button" class="frt-link" id="frtVerTodos">${fora} veículo(s) fora do mapa — ver todos</button>` : "";
      const b = el.querySelector("#frtVerTodos");
      if (b) b.onclick = () => { st.mapa.fitBounds(L.latLngBounds(todos), { padding: [30, 30] }); el.innerHTML = ""; };
    }
  }

  // ---------------------------------------------------------- detalhe / trajeto
  function selecionar(placa, opcoes = {}) {
    if (st.sel === placa) { if (!opcoes.semEnquadrar) fecharDetalhe(); return; }
    pararReplay();
    st.sel = placa;
    st.trajeto = null;
    st.trajAssin = null;
    st.trajDesenhado = null;
    st.camTrajeto?.clearLayers();
    prepararRastros();
    renderLista();
    const it = document.querySelector("#frtLista .frt-item.sel");
    if (it) it.scrollIntoView({ block: "nearest" });
    desenharMapa();
    carregarTrajeto(placa, !opcoes.semEnquadrar);
  }

  function fecharDetalhe() {
    pararReplay();
    st.sel = null;
    st.trajDesenhado = null;
    st.trajeto = null;
    st.trajAssin = null;
    st.seqTraj++;
    const d = document.getElementById("frtDetalhe");
    if (d) { d.classList.add("hidden"); d.innerHTML = ""; }
    document.getElementById("frtMapaPainel")?.classList.remove("frt-com-detalhe");
    if (st.camTrajeto) st.camTrajeto.clearLayers();
    if (st.dados) { prepararRastros(); renderLista(); desenharMapa(); }
  }

  async function carregarTrajeto(placa, enquadrar) {
    const d = document.getElementById("frtDetalhe");
    const v0 = st.dados && st.dados.veiculos.find((x) => x.placa === placa);
    if (!d || !v0) return;
    if(st.dados.data !== st.data || (st.dados.fim || st.dados.data) !== fimPeriodo())return;
    const seq = ++st.seqTraj, dataPedida = st.data, fimPedido = fimPeriodo(), assinPedida = assinatura(v0);
    const atual = () => st.sel === placa && st.data === dataPedida && fimPeriodo() === fimPedido && seq === st.seqTraj;
    d.classList.remove("hidden");
    document.getElementById("frtMapaPainel")?.classList.add("frt-com-detalhe");
    if (enquadrar) { const lateral = document.getElementById("frtLateral"); if (lateral) lateral.scrollTop = 0; }
    if (enquadrar) d.innerHTML = `<p class="frt-vazio">Carregando ${variosDias() ? 'o período' : 'o dia'} de ${esc(placa)}…</p>`;
    let t = null;
    try {
      const dias=window.frtPeriodo.datas(dataPedida,fimPedido,hojeISO());
      const trajetos=await window.frtPeriodo.consultar(dias, async dia=>{
        const t=await getJson(`${API()}/frota/trajeto?placa=${encodeURIComponent(placa)}&data=${encodeURIComponent(dia)}`);
        if(t.data !== dia || t.placa !== placa)throw Error('O servidor retornou um trajeto de outra data ou veículo.');
        return t;
      }, atual);
      if(!trajetos)return;
      t=window.frtPeriodo.trajeto(trajetos);
    } catch (e) {
      t = { erro: e.status === 404 ? "O trajeto do dia aparece depois que o servidor for reiniciado." : `Não consegui carregar o trajeto (${e.message}).` };
    }
    // Resposta velha (trocou de veiculo, de dia, ou chegou outra depois): descarta.
    if (!atual()) return;
    const v = st.dados.veiculos.find((x) => x.placa === placa) || v0;
    if (t.erro) {
      st.trajAssin = null;
      renderDetalhe(v, t);
      // Mantem a ultima linha confirmada deste carro/dia durante falhas de rede.
      desenharRastros();
      return;
    }
    st.trajeto = t;
    st.trajAssin = assinPedida;
    renderDetalhe(v, t);
    if (!(await garantirMapa()) || st.sel !== placa || seq !== st.seqTraj) return;
    desenharTrajeto(v, t, enquadrar);
  }

  function renderDetalhe(v, t) {
    const d = document.getElementById("frtDetalhe");
    if (!d) return;
    const s = situacao(v);
    const vi = v.viagem;
    const maisAnterior = d.dataset.placa === v.placa && d.querySelector(".frt-detalhe-mais");
    const expandido = maisAnterior ? maisAnterior.open : !document.getElementById("frtMapaPainel")?.classList.contains("frt-tela-cheia");
    const rolagem = d.scrollTop;
    const lateral = document.getElementById("frtLateral");
    const rolagemLateral = lateral?.scrollTop || 0;
    d.dataset.placa = v.placa;
    const stat = (rotulo, valor, cls = "") => `<div class="frt-stat ${cls}"><span>${rotulo}</span><b>${valor}</b></div>`;
    let corpo = "", extra = "";
    if (t && t.erro) corpo = `<p class="frt-vazio">${esc(t.erro)}</p>`;
    else if (t) {
      corpo = `<div class="frt-stats frt-stats-principais">
        ${stat(variosDias() ? "Km no período" : "Km no dia", num(t.km, 1))}
        ${stat("Rodando", duracao(t.movendo_min))}
        ${stat("Parado", duracao(t.parado_min))}
        ${stat("Vel. máxima", `${t.vel_max || 0} km/h`, t.vel_max >= t.vel_excesso ? "frt-stat-ruim" : "")}
      </div>`;
      extra = `<div class="frt-stats">
        ${stat(`Leituras ≥ ${t.vel_excesso}`, t.excessos || 0, t.excessos ? "frt-stat-ruim" : "")}
        ${stat("1º sinal", hhmm(t.primeira))}
        ${stat("Último sinal", hhmm(t.ultima))}
        ${stat("Trajeto pelo", t.fonte ? esc(String(t.fonte).toUpperCase()) : "—")}
      </div>`;
    }
    if (t && !t.erro && t.pontos && t.pontos.length > 1) extra += replayHtml(t);
    if(variosDias() && v.dias_sem_dados?.length)extra += `<p class="frt-vazio">Sem leituras válidas em: ${esc(v.dias_sem_dados.map(d=>d.split('-').reverse().join('/')).join(', '))}.</p>`;
    extra += registroDoVeiculo(v, t);
    d.innerHTML = `
      <div class="frt-detalhe-cabecalho">
        <div class="frt-detalhe-identidade">
          <h2>${ICONE_TIPO[v.tipo] || ""} ${esc(v.placa)}</h2>
          <span class="frt-modelo">${esc(v.modelo || "")}</span>
        </div>
        <div class="frt-acoes">
          <button type="button" class="btn-ghost btn-sm" id="frtCentrarBtn">Centralizar</button>
          ${st.dados && st.dados.hoje && v.atual && v.atual.estado !== "sem_sinal" && window.frtRota ? `<button type="button" class="btn-ghost btn-sm" id="frtRotaDaquiBtn" title="Km e tempo deste veículo até um ou mais destinos">🧭 Rota daqui</button>` : ""}
          <button type="button" class="btn-ghost btn-sm frt-fechar-detalhe" id="frtFecharBtn" aria-label="Fechar detalhes do veículo" title="Fechar detalhes">×</button>
        </div>
        <div class="frt-detalhe-status">
          <strong style="color:${s.cor}">${esc(s.rotulo)}</strong>
          <span class="frt-detalhe-retorno">${esc(textoSinalGps(v))}</span>
          ${v.volta ? `<span class="frt-detalhe-retorno">🏭 Volta prevista ~${hhmm(v.volta.eta)} · ${duracao(v.volta.min)} de carro · ${num(v.volta.km, 1)} km</span>` : ""}
          ${!s.lugar && v.atual?.perto_de && st.dados.hoje ? `<span class="frt-detalhe-retorno">${num(v.atual.perto_de.m / 1000, 1)} km de ${esc(v.atual.perto_de.nome)}</span>` : ""}
        </div>
      </div>
      ${vi ? `<div class="frt-viagem"><b class="frt-viagem-rota">🚛 ${esc(vi.rota || "Viagem")}</b>${vi.motorista ? `<span class="frt-viagem-motorista">${esc(vi.motorista)}</span>` : ""}<span class="frt-viagem-resumo">${esc(vi.status || "")} · ${progressoViagem(vi)}${horaSaida(vi)}${v.viagens_no_dia > 1 ? ` · ${v.viagens_no_dia} viagens no dia` : ""}</span></div>` : ""}
      ${corpo}
      ${extra ? `<details class="frt-detalhe-mais"${expandido ? " open" : ""}><summary>Mais informações, trajeto e chegadas</summary><div class="frt-detalhe-extra">${extra}</div></details>` : ""}`;
    d.scrollTop = rolagem;
    if (lateral) lateral.scrollTop = rolagemLateral;
    d.querySelector("#frtFecharBtn").onclick = fecharDetalhe;
    if (t && !t.erro && t.pontos && t.pontos.length > 1) ligarReplay(v, t);
    d.querySelector("#frtCentrarBtn").onclick = () => { if (st.trajeto) desenharTrajeto(v, st.trajeto, true); };
    const rotaDaqui = d.querySelector("#frtRotaDaquiBtn");
    if (rotaDaqui) rotaDaqui.onclick = () => { st.rotaPlaca = v.placa; document.querySelector('#frtRaiz .frt-abas [data-parte="rota"]').click(); };
    const linhas = linhasRegistro(v, t);
    d.querySelectorAll("tr[data-n]").forEach((tr) => {
      const l = linhas[Number(tr.dataset.n) - 1];
      const ir = () => { if (l && st.mapa && Number.isFinite(l.lat)) st.mapa.setView([l.lat, l.lng], 16); };
      tr.onclick = ir;
      tr.onkeydown = (e) => { if (e.key === "Enter") ir(); };
    });
  }
  // Tabela "Chegadas e saídas" do veiculo selecionado (numeros = mapa).
  function registroDoVeiculo(v, t) {
    if (!Array.isArray(v.visitas)) {
      return st.modo === "completo" ? `<p class="frt-vazio">O registro de chegadas e saídas aparece depois que o servidor for reiniciado.</p>` : "";
    }
    const linhas = linhasRegistro(v, t);
    const semRegistro = v.visitas.filter((x) => x.sem_registro);
    let html = `<h3 class="frt-h3">🏬 Chegadas e saídas</h3>`;
    if (!linhas.length) html += `<p class="frt-vazio">Nenhuma chegada em loja ou parada registrada pelo GPS ${variosDias() ? 'neste período' : 'neste dia'}.</p>`;
    else {
      html += `<div class="frt-tabela-wrap"><table class="frt-tabela frt-reg">
        <thead><tr><th>#</th><th>Onde</th><th>Chegou</th><th>Saiu</th><th>Tempo</th><th></th></tr></thead>
        <tbody>${linhas.map((l) => {
          if (l.tipo === "fora") {
            const p = l.p;
            return `<tr data-n="${l.n}" tabindex="0"><td><span class="frt-tl-n fora">${l.n}</span></td>
              <td>${ICONE_REG.fora} <span class="frt-fora">Parado fora de loja</span>${p.perto ? ` <span class="frt-mudo">· ${num(p.perto.m / 1000, 1)} km de ${esc(p.perto.nome)}</span>` : ""}</td>
              <td>${hhmm(p.inicio)}</td><td>${hhmm(p.fim)}</td><td>${duracao(p.min)}</td><td></td></tr>`;
          }
          const x = l.x;
          const tx = textosVisita(x);
          const cls = l.tipo === "fabrica" ? " fab" : l.tipo === "ponto" ? " ponto" : "";
          return `<tr data-n="${l.n}" tabindex="0"><td><span class="frt-tl-n${cls}">${l.n}</span></td>
            <td${x.ambigua ? ' title="O GPS não separa estas lojas (mesmo ponto de parada)"' : ""}>${ICONE_REG[l.tipo]} <b>${esc(l.tipo === "fabrica" ? "Fábrica" : x.nome)}</b></td>
            <td${x.chegada_vista ? "" : ' title="Já estava lá no 1º sinal do dia"'}>${esc(tx.chegou)}</td>
            <td>${tx.saiu === "ainda lá" ? `<span class="frt-ainda">ainda lá</span>` : esc(tx.saiu)}</td>
            <td>${esc(tx.tempo)}</td><td>${etiquetaPrevista(x)}</td></tr>`;
        }).join("")}</tbody></table></div>`;
    }
    if (semRegistro.length) {
      html += `<p class="frt-sem-registro">Lojas da viagem <b>sem passagem registrada pelo GPS</b>: ${semRegistro.map((x) => `${esc(x.nome)}${x.prevista ? ` (previsto ${esc(x.prevista)})` : ""}${x.feita ? " — entregue no TMS" : ""}`).join(", ")}</p>`;
    }
    return html;
  }

  // ---------------------------------------------------------- reproduzir o dia
  // Um caminhao anda pelo trajeto do dia (pontos do /frota/trajeto, com hora em
  // segundos desde 00:00), na velocidade escolhida; a barra pula para qualquer hora.
  const VELOC_REPLAY = [30, 60, 120, 300, 600];
  function replayHtml(t) {
    const P = t.pontos;
    return `<div class="frt-replay" id="frtReplay">
      <button type="button" class="btn-ghost btn-sm" id="frtReplayPlay" aria-label="Reproduzir">▶ Reproduzir ${variosDias() ? 'o período' : 'o dia'}</button>
      <input type="range" id="frtReplayBarra" min="${P[0][3]}" max="${P[P.length - 1][3]}" step="30" value="${P[0][3]}" aria-label="Hora do dia" />
      <span id="frtReplayHora" class="frt-replay-hora">—</span>
      <select id="frtReplayVel" aria-label="Velocidade da reprodução">${VELOC_REPLAY.map((x) => `<option value="${x}"${x === 120 ? " selected" : ""}>${x}×</option>`).join("")}</select>
    </div>`;
  }
  function posicaoReplay(P, s) {
    return window.frtRastroUtils.posicaoReplay(P, s);
  }
  function pararReplay() {
    if (st.replay && st.replay.timer) clearInterval(st.replay.timer);
    st.replay = null;
    if (st.camReplay) st.camReplay.clearLayers();
  }
  function ligarReplay(v, t) {
    const box = document.getElementById("frtReplay");
    if (!box) return;
    const P = t.pontos;
    const diaIni = t.dia_inicio ? Date.parse(t.dia_inicio) : null;
    const barra = box.querySelector("#frtReplayBarra"), hora = box.querySelector("#frtReplayHora");
    const play = box.querySelector("#frtReplayPlay"), velSel = box.querySelector("#frtReplayVel");
    const L = window.L;
    const mostrar = (s) => {
      if (!st.mapa) return;
      const p = posicaoReplay(P, s);
      if (!st.replay) st.replay = { timer: null, s };
      st.replay.s = s;
      if (!st.replay.marcador) {
        st.replay.marcador = L.marker([p.lat, p.lng], { icon: L.divIcon({ className: "frt-marcador", html: '<span class="frt-replay-mk">🚚</span>', iconSize: null, iconAnchor: [14, 14] }), zIndexOffset: 2000 }).addTo(st.camReplay);
      } else st.replay.marcador.setLatLng([p.lat, p.lng]);
      barra.value = String(s);
      st.replay.marcador.setOpacity(p.semSinal ? 0.45 : 1);
      hora.textContent = `${diaIni != null ? hhmm(diaIni + s * 1000) : "—"} · ${p.semSinal ? "sem sinal: última posição conhecida" : Math.round(p.vel || 0) + " km/h"}${p.aproximado ? " · estimado entre sinais" : ""}`;
    };
    const pausar = () => { if (st.replay && st.replay.timer) { clearInterval(st.replay.timer); st.replay.timer = null; } play.textContent = "▶ Continuar"; };
    play.onclick = () => {
      if (st.replay && st.replay.timer) { pausar(); return; }
      let s = st.replay ? st.replay.s : Number(barra.value);
      if (s >= P[P.length - 1][3]) s = P[0][3];
      mostrar(s);
      play.textContent = "⏸ Pausar";
      st.replay.timer = setInterval(() => {
        const fim = P[P.length - 1][3];
        const prox = Math.min(fim, st.replay.s + Number(velSel.value) * 0.1);
        mostrar(prox);
        if (st.mapa && !st.mapa.getBounds().pad(-0.1).contains(st.replay.marcador.getLatLng())) st.mapa.panTo(st.replay.marcador.getLatLng());
        if (prox >= fim) { pausar(); play.textContent = "↻ Reproduzir de novo"; }
      }, 100);
    };
    barra.oninput = () => mostrar(Number(barra.value));
  }

  function desenharTrajeto(v, t, enquadrar) {
    if (!st.mapa) return;
    const L = window.L;
    st.camTrajeto.clearLayers();
    st.trajDesenhado = null;
    renderLegendas();
    if (!t || t.erro || !t.pontos || !t.pontos.length) {
      const pos = posicaoNoMapa(v);
      if (enquadrar && pos) st.mapa.setView(pos, 14);
      desenharRastros();
      return;
    }
    const lim = t.vel_excesso || 90;
    const P = t.pontos;
    // Hora de um ponto: segundos desde 00:00 (servidor novo) ou ISO (antigo).
    const diaIni = t.dia_inicio ? Date.parse(t.dia_inicio) : null;
    const horaPonto = (p) => (typeof p[3] === "number" && diaIni != null ? hhmm(diaIni + p[3] * 1000) : hhmm(p[3]));
    // Mesmas regras do rastro: tracejado = sinal espacado; sem linha = buraco
    // grande ou salto impossivel (antes tudo virava linha reta cheia).
    let trecho = null;
    const fechar = () => {
      if (trecho && trecho.coords.length > 1) {
        L.polyline(trecho.coords, { color: trecho.exc ? "#dc2626" : "#2563eb", weight: trecho.exc ? 5 : 4, opacity: 0.85 }).addTo(st.camTrajeto);
        st.trajDesenhado = v.placa;
      }
      trecho = null;
    };
    for (let i = 1; i < P.length; i++) {
      const a = P[i - 1], b = P[i];
      const lig = typeof b[4] === "number" ? b[4] : 0;
      if (lig === 2) { fechar(); continue; }
      if (lig === 1) {
        fechar();
        L.polyline([[a[0], a[1]], [b[0], b[1]]], { color: "#2563eb", weight: 3, opacity: 0.6, dashArray: "5 7" })
          .bindTooltip("sinal espaçado: caminho aproximado", { sticky: true }).addTo(st.camTrajeto);
        st.trajDesenhado = v.placa;
        continue;
      }
      const exc = b[2] >= lim;
      if (!trecho || trecho.exc !== exc) { fechar(); trecho = { exc, coords: [[a[0], a[1]]] }; }
      trecho.coords.push([b[0], b[1]]);
    }
    fechar();
    desenharRastros();
    const ini = P[0];
    L.circleMarker([ini[0], ini[1]], { radius: 6, color: "#16a34a", fillColor: "#16a34a", fillOpacity: 1 }).bindTooltip(`1º sinal ${horaPonto(ini)}`).addTo(st.camTrajeto);
    // Lugares numerados como na tabela "Chegadas e saidas" (mesmas cores).
    for (const l of linhasRegistro(v, t)) {
      if (!Number.isFinite(l.lat)) continue;
      const cls = l.tipo === "fora" ? " fora" : l.tipo === "fabrica" ? " fab" : l.tipo === "ponto" ? " ponto" : "";
      const dica = l.tipo === "fora"
        ? `${hhmm(l.p.inicio)}–${hhmm(l.p.fim)} · ${duracao(l.p.min)}<br>parado fora de loja`
        : (() => { const tx = textosVisita(l.x); return `<b>${esc(l.tipo === "fabrica" ? "Fábrica" : l.x.nome)}</b><br>chegou ${esc(tx.chegou)} · saiu ${esc(tx.saiu)} · ${esc(tx.tempo)}`; })();
      L.marker([l.lat, l.lng], {
        icon: L.divIcon({ className: "frt-marcador", html: `<span class="frt-parada${cls}">${l.n}</span>`, iconSize: null, iconAnchor: [10, 10] }),
        zIndexOffset: 800,
      }).bindTooltip(dica, { direction: "top" }).addTo(st.camTrajeto);
    }
    if (enquadrar) st.mapa.fitBounds(L.latLngBounds(P.map((p) => [p[0], p[1]])).pad(0.1), { maxZoom: 16 });
  }

  // ---------------------------------------------------------- liga
  function abaVisivel() {
    const aba = document.getElementById("aba-frota");
    return !!aba && !aba.classList.contains("aba-hidden");
  }
  const podeAtualizar = () => abaVisivel() && !document.hidden && st.data === hojeISO() && !variosDias();

  function tique() {
    // Aba aberta virando a meia-noite: segue para o novo dia (antes congelava
    // em 23:59 e o seletor nem deixava escolher o dia novo).
    const h = hojeISO();
    const el = document.getElementById("frtData");
    if (el) el.max = h;
    const ate=document.getElementById("frtDataFim");if(ate)ate.max=h;
    if (st.seguirHoje && st.data !== h) { irParaDia(h); return; }
    if (podeAtualizar() && Date.now() - st.ultimaCarga >= RECARGA_MIN_MS) carregar();
  }

  window.frtInit = function () {
    montar();
    if (!st.iniciado) {
      st.iniciado = true;
      st.timer = setInterval(tique, 60000);
      window.frtPosicoes?.iniciar({permitido:()=>podeAtualizar() && !document.getElementById("frtVivo")?.hidden,lerData:()=>st.data,receber:aplicarPosicoes,erro:()=>{const el=document.getElementById("frtPosicoesInfo");if(el){el.textContent="Consulta de posições indisponível. Tentando novamente…";el.classList.add("frt-posicoes-erro");}}});
      // Aviso de chegou/saiu adianta o refresh — sem passar de 1x a cada 5 s,
      // so com a janela visivel, e com um atraso aleatorio para os PCs nao
      // baterem no servidor todos no mesmo segundo.
      let deb = null;
      if (window.Bus) window.Bus.on("gps:evento", () => {
        if (!podeAtualizar()) return;
        clearTimeout(deb);
        const falta = Math.max(0, 5000 - (Date.now() - st.ultimaCarga));
        deb = setTimeout(() => { if (podeAtualizar()) carregar(); }, falta + 500 + Math.random() * 1000);
      });
      document.addEventListener("visibilitychange", () => {
        if (podeAtualizar() && Date.now() - st.ultimaCarga >= RECARGA_MIN_MS) carregar();
      });
      // Troca de tema: contorno do rastro muda de cor na hora.
      window.addEventListener("tema-mudou", () => { if (st.mapa && st.dados) desenharRastros(); });
      window.addEventListener("frota-areas-mudou", () => carregarAreas());
    }
    carregar();
    window.frtPosicoes?.atualizar();
    // O mapa nasce com a aba escondida: recalcula o tamanho quando ela aparece.
    setTimeout(() => { if (st.mapa) st.mapa.invalidateSize(); }, 200);
  };
  window.frtAtualizar = () => carregar();
  // Para as partes Relatorios / Alertas e areas / Manutencao (frota-relatorios.js).
  window.frtApi = {
    carregarLeaflet, getJson, esc, hhmm, duracao, num, distM, ICONE_TIPO,
    dados: () => st.dados, lugares: () => st.lugares,
    voltarAoVivo: () => mudarParte("vivo"),
    // Abre "Ao vivo" ja com o veiculo (e o dia) do relatorio.
    verNoMapa(placa, data, lat, lng) {
      document.querySelector('#frtRaiz .frt-abas [data-parte="vivo"]').click();
      const ir = () => { if (placa && st.dados && st.dados.veiculos.some((v) => v.placa === placa)) selecionar(placa, { semEnquadrar: lat != null }); if (st.mapa && lat != null) st.mapa.setView([lat, lng], 16); };
      if (data && (data !== st.data || variosDias())) { st.aposCarregar = ir; irParaDia(data); } else ir();
    },
  };
})();
