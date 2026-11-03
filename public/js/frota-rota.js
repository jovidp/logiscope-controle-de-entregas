// ================================================================
// frota-rota.js — aba Frota -> 🧭 Calcular rota
// ----------------------------------------------------------------
// "A partir de um veiculo, os km e o tempo ate o destino que eu coloquei" (como
// na Sat), com VARIOS destinos, melhor ordem e volta para a fabrica.
//   Origem: veiculo (posicao atual do rastreador), fabrica ou loja.
//   Destino: loja/fabrica do cadastro, endereco (busca no OSM), link do Google
//   Maps / "lat,lng" colado, ou clique no mapa.
// Calculo no servidor (GET /frota/rota, back/frota-calcular-rota.js): rota
// pela rua (OSRM) e tempo pelo historico real da frota. So leitura.
// Atalho: botao "🧭 Rota daqui" no detalhe do veiculo (Ao vivo).
// ================================================================
(function () {
  "use strict";

  const API = () => window.location.origin;
  const esc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const num = (n, c = 0) => Number(n || 0).toLocaleString("pt-BR", { minimumFractionDigits: c, maximumFractionDigits: c });
  const dur = (min) => { min = Math.round(min || 0); return min < 60 ? `${min} min` : `${Math.floor(min / 60)}h${String(min % 60).padStart(2, "0")}`; };
  const norm = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const el = (id) => document.getElementById(id);
  const MAX = 25;
  const FONTE = {
    historico: ["histórico", "Mediana real das nossas entregas neste trecho"],
    frota: ["frota", "Km da rota ÷ velocidade real da nossa frota para essa distância"],
    osrm: ["carro", "Tempo de carro sem trânsito (OSRM): a frota costuma ser mais lenta"],
  };
  const PARADA = { historico: "mediana da loja", media: "média geral", informada: "informada", nenhuma: "" };

  const st = { montado: false, veiculos: [], lugares: [], origem: "", destinos: [], resultado: null, mapa: null, cam: null, clicando: false, sug: [], carregandoBase: null };

  async function getJson(url) {
    const r = await fetch(url, { headers: { Accept: "application/json" } });
    let j = null;
    try { j = await r.json(); } catch (_) {}
    if (!r.ok) throw new Error(r.status === 404 && !(j && j.error) ? "Disponível depois que o servidor for reiniciado." : (j && j.error) || `HTTP ${r.status}`);
    return j;
  }
  function msg(texto, erro = false) { const m = el("frcMsg"); if (m) { m.textContent = texto || ""; m.style.color = erro ? "#dc2626" : ""; } }

  // ------------------------------------------------------------ base
  async function carregarBase() {
    if (st.carregandoBase) return st.carregandoBase;
    st.carregandoBase = (async () => {
      try {
        const b = await getJson(`${API()}/frota/rota/veiculos`);
        st.veiculos = b.veiculos || []; st.lugares = b.lugares || [];
      } catch (e) { msg(e.message, true); }
      finally { st.carregandoBase = null; }
      renderOrigem();
    })();
    return st.carregandoBase;
  }
  function renderOrigem() {
    const sel = el("frcOrigem");
    if (!sel) return;
    const atual = st.origem || sel.value;
    const vivo = st.veiculos.filter((v) => v.idade_min <= 60), velhos = st.veiculos.filter((v) => v.idade_min > 60);
    const opV = (v) => `<option value="placa:${esc(v.placa)}">${esc(v.placa)}${v.perto ? ` · em ${esc(v.perto.nome)}` : v.velocidade >= 3 ? ` · rodando ${Math.round(v.velocidade)} km/h` : ""}${v.idade_min > 15 ? ` · sinal de ${dur(v.idade_min)} atrás` : ""}</option>`;
    sel.innerHTML = `<option value="">Escolha…</option>
      ${vivo.length ? `<optgroup label="🚚 Veículos (posição de agora)">${vivo.map(opV).join("")}</optgroup>` : ""}
      <optgroup label="🏭 Lugares">${st.lugares.map((l) => `<option value="lugar:${esc(l.codigo)}">${esc(l.nome)}</option>`).join("")}</optgroup>
      ${velhos.length ? `<optgroup label="Sinal antigo (mais de 1 h)">${velhos.map(opV).join("")}</optgroup>` : ""}`;
    if (atual && [...sel.options].some((o) => o.value === atual)) sel.value = atual;
    st.origem = sel.value;
    infoOrigem();
  }
  function infoOrigem() {
    const box = el("frcOrigemInfo"), saida = el("frcSaidaBox");
    if (!box) return;
    const [tipo, id] = String(st.origem || "").split(/:(.*)/);
    const v = tipo === "placa" ? st.veiculos.find((x) => x.placa === id) : null;
    box.textContent = v ? `Parte da posição de ${v.idade_min <= 1 ? "agora" : `${dur(v.idade_min)} atrás`} (${String(v.fonte || "").toUpperCase()}), saindo agora.` : "";
    saida.hidden = tipo === "placa";
    desenharBase();
  }

  // ------------------------------------------------------------ destinos
  function pontoDoTexto(txt) {
    const t = String(txt || "").trim();
    // Google Maps: ".../@-22.9,-43.2,15z", "?q=-22.9,-43.2", "!3d-22.9!4d-43.2"; ou "lat, lng".
    let m = t.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/) || t.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/) || t.match(/[?&](?:q|query|ll|destination)=(-?\d+\.\d+)(?:,|%2C)\s*(-?\d+\.\d+)/i)
      || t.match(/^\s*(-?\d{1,2}\.\d{3,})\s*[,;\s]\s*(-?\d{1,3}\.\d{3,})\s*$/);
    if (!m) return null;
    const lat = Number(m[1]), lng = Number(m[2]);
    return Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : null;
  }
  function adicionar(d) {
    if (st.destinos.length >= MAX) { msg(`No máximo ${MAX} destinos.`, true); return; }
    st.destinos.push({ ...d, parada_min: null });
    st.resultado = null;
    el("frcBusca").value = "";
    fecharSug();
    renderDestinos();
    msg("");
  }
  function renderDestinos() {
    const ol = el("frcDestinos");
    el("frcQtd").textContent = st.destinos.length ? `${st.destinos.length}/${MAX}` : "";
    if (!st.destinos.length) { ol.innerHTML = `<li class="frc-vazio">Nenhum destino ainda — busque uma loja ou endereço abaixo, cole um link do Google Maps ou marque no mapa.</li>`; desenharBase(); return; }
    ol.innerHTML = st.destinos.map((d, i) => `<li>
        <span class="frc-n">${i + 1}</span>
        <span class="frc-nome" title="${esc(d.rotulo)}">${esc(d.rotulo)}</span>
        <input type="number" min="0" max="600" step="5" value="${d.parada_min ?? ""}" placeholder="auto" data-par="${i}" title="Tempo parado neste destino (min). Vazio = mediana de descarga da loja; 0 = só passar." aria-label="Parada em minutos" />
        <span class="frc-min">min</span>
        <button type="button" class="frt-link" data-sobe="${i}" ${i === 0 ? "disabled" : ""} aria-label="Subir">▲</button>
        <button type="button" class="frt-link" data-desce="${i}" ${i === st.destinos.length - 1 ? "disabled" : ""} aria-label="Descer">▼</button>
        <button type="button" class="frt-link" data-tira="${i}" aria-label="Tirar">✕</button>
      </li>`).join("");
    const troca = (i, j) => { [st.destinos[i], st.destinos[j]] = [st.destinos[j], st.destinos[i]]; renderDestinos(); };
    ol.querySelectorAll("[data-sobe]").forEach((b) => { b.onclick = () => troca(+b.dataset.sobe, +b.dataset.sobe - 1); });
    ol.querySelectorAll("[data-desce]").forEach((b) => { b.onclick = () => troca(+b.dataset.desce, +b.dataset.desce + 1); });
    ol.querySelectorAll("[data-tira]").forEach((b) => { b.onclick = () => { st.destinos.splice(+b.dataset.tira, 1); renderDestinos(); }; });
    ol.querySelectorAll("[data-par]").forEach((inp) => {
      inp.oninput = () => { const v = inp.value.trim(); st.destinos[+inp.dataset.par].parada_min = v === "" ? null : Math.max(0, Math.min(600, Number(v) || 0)); };
    });
    desenharBase();
  }

  // ------------------------------------------------------------ busca
  function fecharSug() { const s = el("frcSugestoes"); if (s) { s.hidden = true; s.innerHTML = ""; } st.sug = []; }
  function mostrarSug(lista, rodape = "") {
    const s = el("frcSugestoes");
    st.sug = lista;
    if (!lista.length && !rodape) { fecharSug(); return; }
    s.innerHTML = lista.map((x, i) => `<button type="button" role="option" data-i="${i}"><span>${x.icone || "📍"}</span> ${esc(x.rotulo)}${x.extra ? ` <small>${esc(x.extra)}</small>` : ""}</button>`).join("")
      + (rodape ? `<div class="frc-sug-rodape">${rodape}</div>` : "");
    s.hidden = false;
    s.querySelectorAll("[data-i]").forEach((b) => { b.onmousedown = (ev) => { ev.preventDefault(); adicionar(st.sug[+b.dataset.i].ponto); }; });
  }
  function sugerirLocal() {
    const t = el("frcBusca").value;
    if (!t.trim()) { fecharSug(); return; }
    const p = pontoDoTexto(t);
    if (p) { mostrarSug([{ icone: "🎯", rotulo: `Ponto ${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`, ponto: { tipo: "ll", ...p, rotulo: `Ponto ${p.lat.toFixed(4)}, ${p.lng.toFixed(4)}` } }]); return; }
    if (/goo\.gl|maps\.app/i.test(t)) { mostrarSug([], "Link curto do Google Maps não traz a coordenada: abra o link e copie o endereço da barra (com @lat,lng) ou clique com o botão direito no lugar e copie os números."); return; }
    const q = norm(t);
    const achados = st.lugares.filter((l) => norm(l.nome).includes(q) || norm(l.codigo) === q).slice(0, 8)
      .map((l) => ({ icone: l.codigo === "FABRICA" ? "🏭" : "🏬", rotulo: l.nome, extra: l.codigo === "FABRICA" ? "" : `loja ${l.codigo}`, ponto: { tipo: "lugar", codigo: l.codigo, rotulo: l.nome, lat: l.lat, lng: l.lng } }));
    mostrarSug(achados, `<button type="button" class="frt-link" id="frcSugEnd">🔎 Procurar "${esc(t.trim().slice(0, 40))}" como endereço</button>`);
    const b = el("frcSugEnd");
    if (b) b.onmousedown = (ev) => { ev.preventDefault(); buscarEndereco(); };
  }
  async function buscarEndereco() {
    const t = el("frcBusca").value.trim();
    if (t.length < 4) { msg("Digite pelo menos 4 letras do endereço.", true); return; }
    mostrarSug([], "Procurando o endereço…");
    try {
      const lista = await getJson(`${API()}/frota/rota/endereco?q=${encodeURIComponent(t)}`);
      if (!lista.length) { mostrarSug([], "Não achei esse endereço. Tente com bairro e cidade (ex.: Rua X 100, Campo Grande, Rio de Janeiro)."); return; }
      mostrarSug(lista.map((x) => ({ icone: "📍", rotulo: x.rotulo, ponto: { tipo: "ll", lat: x.lat, lng: x.lng, rotulo: x.rotulo.split(",").slice(0, 3).join(",") } })));
    } catch (e) { mostrarSug([], esc(e.message)); }
  }

  // ------------------------------------------------------------ mapa
  async function garantirMapa() {
    if (st.mapa) return true;
    const div = el("frcMapa");
    try { await window.frtApi.carregarLeaflet(); } catch (e) { div.innerHTML = `<p class="frt-vazio">${esc(e.message)}</p>`; return false; }
    const L = window.L;
    st.mapa = L.map(div).setView([-22.9, -43.45], 10);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap", referrerPolicy: "strict-origin-when-cross-origin" }).addTo(st.mapa);
    st.cam = L.layerGroup().addTo(st.mapa);
    st.mapa.on("click", (e) => {
      if (!st.clicando) return;
      const lat = Math.round(e.latlng.lat * 1e5) / 1e5, lng = Math.round(e.latlng.lng * 1e5) / 1e5;
      adicionar({ tipo: "ll", lat, lng, rotulo: `Ponto ${lat.toFixed(4)}, ${lng.toFixed(4)}` });
      alternarClique(false);
    });
    return true;
  }
  function alternarClique(liga) {
    st.clicando = liga;
    el("frcClicar").classList.toggle("ativo", liga);
    el("frcClicar").textContent = liga ? "Clique no mapa… (cancelar)" : "📍 Marcar no mapa";
    el("frcMapa").classList.toggle("frr-desenhando", liga);
  }
  const numIcone = (n, cor) => window.L.divIcon({ className: "frc-pino", html: `<span style="background:${cor}">${n}</span>`, iconSize: [26, 26], iconAnchor: [13, 13] });
  function origemPonto() {
    const [tipo, id] = String(st.origem || "").split(/:(.*)/);
    if (tipo === "placa") { const v = st.veiculos.find((x) => x.placa === id); return v ? { lat: v.lat, lng: v.lng, rotulo: v.placa, icone: "🚚" } : null; }
    if (tipo === "lugar") { const l = st.lugares.find((x) => x.codigo === id); return l ? { lat: l.lat, lng: l.lng, rotulo: l.nome, icone: id === "FABRICA" ? "🏭" : "🏬" } : null; }
    return null;
  }
  // Antes de calcular: origem + destinos (sem a rota).
  async function desenharBase() {
    if (!(await garantirMapa())) return;
    if (st.resultado) return; // o resultado desenha tudo
    const L = window.L;
    st.cam.clearLayers();
    const o = origemPonto(), pts = [];
    if (o) { L.marker([o.lat, o.lng], { icon: numIcone(o.icone, "#0f172a") }).bindTooltip(`Saída: ${esc(o.rotulo)}`).addTo(st.cam); pts.push([o.lat, o.lng]); }
    st.destinos.forEach((d, i) => {
      const lat = d.lat, lng = d.lng;
      if (!Number.isFinite(lat)) return;
      L.marker([lat, lng], { icon: numIcone(i + 1, "#2563eb") }).bindTooltip(esc(d.rotulo)).addTo(st.cam);
      pts.push([lat, lng]);
    });
    if (pts.length > 1) st.mapa.fitBounds(L.latLngBounds(pts).pad(0.2)); else if (pts.length) st.mapa.setView(pts[0], 13);
  }
  function desenharResultado(r) {
    const L = window.L;
    st.cam.clearLayers();
    if (r.geometria && r.geometria.length > 1) {
      L.polyline(r.geometria, { color: "#ffffff", weight: 8, opacity: 0.9 }).addTo(st.cam);
      L.polyline(r.geometria, { color: "#2563eb", weight: 5, opacity: 0.9 }).addTo(st.cam);
    }
    const o = r.origem;
    L.marker([o.lat, o.lng], { icon: numIcone(o.placa ? "🚚" : o.codigo === "FABRICA" ? "🏭" : "●", "#0f172a"), zIndexOffset: 500 })
      .bindTooltip(`<b>Saída ${esc(r.total.saida)}</b><br>${esc(o.rotulo)}`).addTo(st.cam);
    for (const p of r.pontos) {
      L.marker([p.lat, p.lng], { icon: numIcone(p.fim ? "🏭" : p.ordem, p.fim ? "#0f172a" : "#16a34a") })
        .bindTooltip(`<b>${p.ordem}. ${esc(p.rotulo)}</b><br>chega ${esc(p.chegada)}${p.chegada_dia ? " (+1 dia)" : ""} · ${num(p.trecho_km, 1)} km${p.parada_min ? `<br>parado ${dur(p.parada_min)}, sai ${esc(p.saida)}` : ""}`).addTo(st.cam);
    }
    const b = r.geometria && r.geometria.length > 1 ? r.geometria : [[o.lat, o.lng], ...r.pontos.map((p) => [p.lat, p.lng])];
    st.mapa.fitBounds(L.latLngBounds(b).pad(0.12));
  }

  // ------------------------------------------------------------ calcular
  async function calcular() {
    if (!st.origem) { msg("Escolha de onde sai.", true); return; }
    if (!st.destinos.length) { msg("Coloque pelo menos um destino.", true); return; }
    const [tipo, id] = String(st.origem).split(/:(.*)/);
    const pedido = {
      origem: tipo === "placa" ? { tipo, placa: id } : { tipo: "lugar", codigo: id },
      destinos: st.destinos.map((d) => ({ ...(d.tipo === "lugar" ? { tipo: "lugar", codigo: d.codigo } : { tipo: "ll", lat: d.lat, lng: d.lng, rotulo: d.rotulo }), parada_min: d.parada_min })),
      otimizar: el("frcOtimizar").checked, voltar: el("frcVoltar").checked,
      saida: tipo === "placa" ? undefined : el("frcSaida").value || undefined,
    };
    const b = el("frcCalcular");
    b.disabled = true; b.textContent = "Calculando…"; msg("");
    try {
      const r = await getJson(`${API()}/frota/rota?q=${encodeURIComponent(JSON.stringify(pedido))}`);
      // Melhor ordem: a lista passa a seguir a ordem calculada.
      if (r.otimizado && Array.isArray(r.ordem_entrada) && r.ordem_entrada.length === st.destinos.length) {
        st.destinos = r.ordem_entrada.map((i) => st.destinos[i]);
        renderDestinos();
      }
      st.resultado = r;
      renderResultado(r);
      if (await garantirMapa()) desenharResultado(r);
    } catch (e) { msg(e.message, true); }
    finally { b.disabled = false; b.textContent = "Calcular rota"; }
  }
  function textoResumo(r) {
    const linhas = [`🧭 Rota saindo de ${r.origem.rotulo} às ${r.total.saida}`];
    for (const p of r.pontos) linhas.push(`${p.fim ? "🏭" : `${p.ordem}.`} ${p.rotulo} — ${num(p.trecho_km, 1)} km · ${dur(p.trecho_min)} · chega ${p.chegada}${p.chegada_dia ? " (+1 dia)" : ""}${p.parada_min ? ` · sai ${p.saida}` : ""}`);
    linhas.push(`Total: ${num(r.total.km, 1)} km · ${dur(r.total.dirigindo_min)} dirigindo${r.total.paradas_min ? ` + ${dur(r.total.paradas_min)} parado` : ""} · termina ${r.total.fim}${r.total.fim_dia ? " (+1 dia)" : ""}`);
    return linhas.join("\n");
  }
  function renderResultado(r) {
    const box = el("frcResultado");
    const stat = (rot, val, dica = "") => `<div class="frt-stat" title="${esc(dica)}"><span>${rot}</span><b>${val}</b></div>`;
    const tag = (f) => `<span class="frt-tag frc-f-${f}" title="${esc(FONTE[f][1])}">${FONTE[f][0]}</span>`;
    const vel = r.velocidades_frota && r.velocidades_frota.cidade ? ` A frota anda em média ${r.velocidades_frota.cidade} km/h na cidade (trechos curtos) e ${r.velocidades_frota.estrada || "—"} km/h na estrada.` : "";
    box.innerHTML = `
      ${r.avisos && r.avisos.length ? `<div class="frc-aviso">⚠ ${r.avisos.map(esc).join("<br>")}</div>` : ""}
      ${r.otimizado ? `<div class="frc-ok">✓ Ordem ajustada para o menor tempo (a lista ao lado já está nessa ordem).</div>` : ""}
      <div class="frt-stats frt-stats-principais">
        ${stat("Distância", `${num(r.total.km, 1)} km`)}
        ${stat("Dirigindo", dur(r.total.dirigindo_min))}
        ${stat("Parado nos destinos", dur(r.total.paradas_min))}
        ${stat("Saída → fim", `${esc(r.total.saida)} → ${esc(r.total.fim)}${r.total.fim_dia ? " +1d" : ""}`, `Tempo total ${dur(r.total.total_min)}`)}
      </div>
      <div class="frt-tabela-wrap"><table class="frt-tabela"><thead><tr><th>#</th><th>Destino</th><th>Trecho</th><th>Tempo</th><th>Chega</th><th>Parado</th><th>Sai</th></tr></thead><tbody>
        ${r.pontos.map((p) => `<tr>
          <td>${p.fim ? "🏭" : p.ordem}</td><td><b>${esc(p.rotulo)}</b></td>
          <td>${num(p.trecho_km, 1)} km</td>
          <td class="frc-tempo">${dur(p.trecho_min)} ${tag(p.trecho_fonte)}${p.trecho_fonte !== "osrm" ? ` <small class="frt-mudo" title="Tempo de carro sem trânsito">· carro ${dur(p.trecho_min_carro)}</small>` : ""}</td>
          <td><b>${esc(p.chegada)}</b>${p.chegada_dia ? " <small>+1d</small>" : ""}</td>
          <td class="frc-tempo">${p.parada_min ? `${dur(p.parada_min)} <small class="frt-mudo">${esc(PARADA[p.parada_fonte] || "")}</small>` : "—"}</td>
          <td>${p.parada_min ? esc(p.saida) : "—"}</td></tr>`).join("")}
      </tbody></table></div>
      <div class="frt-acoes" style="margin-top:8px;"><button type="button" class="btn-ghost btn-sm" id="frcCopiar">📋 Copiar resumo</button></div>
      <p class="frt-mudo frc-nota">Rota pela rua: OpenStreetMap (OSRM, de carro). Tempo de cada trecho: <b>histórico</b> real das nossas entregas quando o trecho já foi feito 3+ vezes;
        senão a velocidade real da <b>frota</b> para aquela distância; nunca menos que o tempo de <b>carro</b> sem trânsito.${vel}
        Parada: a que você digitou; senão a mediana de descarga da loja.</p>`;
    el("frcCopiar").onclick = async () => {
      const t = textoResumo(r);
      try { await navigator.clipboard.writeText(t); el("frcCopiar").textContent = "✓ Copiado"; }
      catch (_) { window.prompt("Copie o resumo:", t); }
      setTimeout(() => { const b = el("frcCopiar"); if (b) b.textContent = "📋 Copiar resumo"; }, 2000);
    };
  }

  // ------------------------------------------------------------ montagem
  function montar() {
    const raiz = el("frtParteRota");
    if (!raiz || st.montado) return;
    st.montado = true;
    raiz.innerHTML = `
      <div class="section-shell">
        <div class="section-head"><div><h2 style="font-size:16px;">🧭 Calcular rota</h2>
          <p class="tms-subtitle">Km, tempo e horário de chegada de um veículo (ou da fábrica) até um ou vários destinos. Com "melhor ordem" o sistema escolhe a sequência mais rápida.</p></div></div>
        <div class="frc-grade">
          <div class="frc-form">
            <label class="frc-campo">Saindo de
              <span class="frc-linha"><select id="frcOrigem"></select><button type="button" class="btn-ghost btn-sm" id="frcRecarregar" title="Atualizar as posições">↻</button></span></label>
            <div id="frcOrigemInfo" class="frt-mudo"></div>
            <label class="frc-campo" id="frcSaidaBox">Horário de saída <input type="time" id="frcSaida" /> <small class="frt-mudo">vazio = agora</small></label>
            <div class="frc-destinos-cab"><b>Destinos</b> <span id="frcQtd" class="frt-mudo"></span></div>
            <ol id="frcDestinos" class="frc-lista"></ol>
            <div class="frc-busca">
              <input type="text" id="frcBusca" placeholder="Loja, endereço, link do Google Maps ou lat,lng" autocomplete="off" aria-label="Adicionar destino" />
              <div id="frcSugestoes" class="frc-sugestoes" role="listbox" hidden></div>
            </div>
            <div class="frt-acoes"><button type="button" class="btn-ghost btn-sm" id="frcBuscarEnd">🔎 Endereço</button><button type="button" class="btn-ghost btn-sm" id="frcClicar">📍 Marcar no mapa</button></div>
            <label class="frc-op"><input type="checkbox" id="frcOtimizar" checked /> Melhor ordem (menor tempo)</label>
            <label class="frc-op"><input type="checkbox" id="frcVoltar" /> Voltar para a fábrica no fim</label>
            <div class="frt-acoes"><button type="button" class="btn-green" id="frcCalcular">Calcular rota</button><button type="button" class="btn-ghost btn-sm" id="frcLimpar">Limpar</button></div>
            <div id="frcMsg" class="frt-mudo" role="status"></div>
          </div>
          <div id="frcMapa" class="frr-mapa frc-mapa"></div>
        </div>
        <div id="frcResultado"></div>
      </div>`;
    el("frcOrigem").onchange = (e) => { st.origem = e.target.value; st.resultado = null; infoOrigem(); };
    el("frcRecarregar").onclick = () => carregarBase();
    const busca = el("frcBusca");
    let deb = null;
    busca.oninput = () => { clearTimeout(deb); deb = setTimeout(sugerirLocal, 120); };
    busca.onkeydown = (e) => {
      if (e.key === "Escape") fecharSug();
      if (e.key !== "Enter") return;
      e.preventDefault();
      if (st.sug.length) adicionar(st.sug[0].ponto); else buscarEndereco();
    };
    busca.onblur = () => setTimeout(fecharSug, 150);
    el("frcBuscarEnd").onclick = buscarEndereco;
    el("frcClicar").onclick = () => alternarClique(!st.clicando);
    el("frcCalcular").onclick = calcular;
    el("frcLimpar").onclick = () => { st.destinos = []; st.resultado = null; el("frcResultado").innerHTML = ""; renderDestinos(); msg(""); };
    // Mudou destino/origem depois de calcular: volta ao desenho simples.
    el("frcDestinos").addEventListener("click", () => { if (st.resultado) { st.resultado = null; desenharBase(); } });
    renderDestinos();
  }

  window.frtRota = {
    // placa (opcional): ja abre com o veiculo como origem (botao "Rota daqui").
    async abrir(placa) {
      montar();
      if (placa) st.origem = `placa:${placa}`;
      await carregarBase();
      if (placa) { el("frcOrigem").value = `placa:${placa}`; st.origem = el("frcOrigem").value; st.resultado = null; infoOrigem(); }
      if (await garantirMapa()) setTimeout(() => st.mapa.invalidateSize(), 60);
    },
  };
})();
