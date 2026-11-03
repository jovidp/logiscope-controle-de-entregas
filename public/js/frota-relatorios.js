// ================================================================
// frota-relatorios.js (front) — partes "📊 Relatórios", "⚠ Alertas e áreas"
// e "🔧 Manutenção" da aba 🛰 Frota. Usa window.frtApi (frota.js).
// ----------------------------------------------------------------
// Relatorios (GET /frota/relatorio?de=&ate=, resumos diarios por veiculo):
//   tempo de descarga por loja, tempo de patio na fabrica, pontualidade pelo
//   GPS, ranking de motoristas, excessos de velocidade (com local), jornada
//   sem pausa, motor ligado parado, uso fora do horario, disponibilidade dos
//   rastreadores, km (real x previsto), mapa de calor das paradas fora de
//   loja e a frota por hora.
// Alertas e areas: regras e limites dos avisos (sino 🚨 / Telegram), resumo do
//   dia e o desenho das areas de risco no mapa (POST/DELETE /frota/areas, ADM).
//   As areas conversam com as CERCAS do SRF (back/frota-cercas-srf.js):
//   ⬇ Trazer do SRF (previa + confirmacao) e ⬆ Enviar ao SRF (uma ou todas).
// Manutencao: itens por placa a cada X km, contados pelo GPS (/frota/manutencao).
// Prefixo frr.
// ================================================================
(function () {
  "use strict";

  const API = () => window.location.origin;
  const api = () => window.frtApi;
  const esc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const hhmm = (d) => (d ? new Date(d).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }) : "—");
  const dataBR = (d) => String(d || "").split("-").reverse().join("/");
  const num = (n, c = 0) => Number(n || 0).toLocaleString("pt-BR", { minimumFractionDigits: c, maximumFractionDigits: c });
  const dur = (min) => {
    if (min == null) return "—";
    min = Math.round(min);
    return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h${min % 60 ? " " + String(min % 60).padStart(2, "0") : ""}`;
  };
  const hojeISO = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
  const somaDias = (iso, n) => { const d = new Date(`${iso}T12:00:00`); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

  async function getJson(url) {
    const r = await fetch(url, { headers: { Accept: "application/json" } });
    if (!r.ok) { const e = new Error(r.status === 404 ? "disponível depois que o servidor for reiniciado" : `HTTP ${r.status}`); e.status = r.status; throw e; }
    return r.json();
  }
  async function enviar(metodo, url, corpo) {
    const r = await fetch(url, { method: metodo, headers: { "Content-Type": "application/json", Accept: "application/json" }, body: corpo ? JSON.stringify(corpo) : undefined });
    let j = {};
    try { j = await r.json(); } catch (_) {}
    if (!r.ok) throw new Error(r.status === 403 ? "Só administrador pode fazer isso." : r.status === 404 ? "Disponível depois que o servidor for reiniciado." : j.error || `HTTP ${r.status}`);
    return j;
  }

  // Excel abre CSV com ";" e BOM no Brasil.
  function baixarCsv(linhas, nome) {
    const cel = (s) => `"${String(s == null ? "" : s).replace(/"/g, '""')}"`;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob(["﻿" + linhas.map((r) => r.map(cel).join(";")).join("\r\n")], { type: "text/csv;charset=utf-8" }));
    a.download = nome;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  // Tabela simples com cabecalho clicavel para ordenar + CSV.
  // colunas: [{ t: titulo, v: (linha) => valor p/ ordenar/CSV, h: (linha) => html (opcional) }]
  function tabela(id, colunas, linhas, opcoes = {}) {
    const box = document.getElementById(id);
    if (!box) return;
    if (!linhas.length) { box.innerHTML = `<p class="frt-vazio">${esc(opcoes.vazio || "Nada no período.")}</p>`; return; }
    const estado = box.__ord || { c: opcoes.ordem != null ? opcoes.ordem : -1, d: opcoes.desc !== false };
    const ord = estado.c >= 0 ? [...linhas].sort((a, b) => {
      const x = colunas[estado.c].v(a), y = colunas[estado.c].v(b);
      const r = (typeof x === "number" && typeof y === "number") ? x - y : String(x ?? "").localeCompare(String(y ?? ""), "pt-BR", { numeric: true });
      return estado.d ? -r : r;
    }) : linhas;
    const max = opcoes.max || 200;
    box.innerHTML = `<div class="frt-tabela-wrap"><table class="frt-tabela frr-tab">
      <thead><tr>${colunas.map((c, i) => `<th data-c="${i}" class="${estado.c === i ? (estado.d ? "desc" : "asc") : ""}" title="Ordenar">${esc(c.t)}</th>`).join("")}</tr></thead>
      <tbody>${ord.slice(0, max).map((l, i) => `<tr data-i="${linhas.indexOf(l)}" ${opcoes.clique ? 'tabindex="0" class="frr-clicavel"' : ""}>${colunas.map((c) => `<td>${c.h ? c.h(l) : esc(c.v(l) ?? "—")}</td>`).join("")}</tr>`).join("")}</tbody>
    </table></div>
    <div class="frr-rodape">${ord.length > max ? `<span class="frt-mudo">Mostrando ${max} de ${ord.length}.</span>` : ""}
      <button type="button" class="frt-link" data-csv>⬇ Exportar (Excel)</button></div>`;
    box.querySelectorAll("th[data-c]").forEach((th) => {
      th.onclick = () => { const c = Number(th.dataset.c); box.__ord = { c, d: estado.c === c ? !estado.d : true }; tabela(id, colunas, linhas, opcoes); };
    });
    box.querySelector("[data-csv]").onclick = () => baixarCsv([colunas.map((c) => c.t), ...ord.map((l) => colunas.map((c) => c.v(l)))], `${opcoes.arquivo || id}.csv`);
    if (opcoes.clique) box.querySelectorAll("tr[data-i]").forEach((tr) => {
      const ir = () => opcoes.clique(linhas[Number(tr.dataset.i)]);
      tr.onclick = ir;
      tr.onkeydown = (e) => { if (e.key === "Enter") ir(); };
    });
  }

  const verNoMapa = (l) => api().verNoMapa(l.placa, l.data, l.lat, l.lng);
  const st = { de: hojeISO(), ate: hojeISO(), rel: null, carregando: false, mapaCalor: null, camCalor: null, mapaAreas: null, camAreas: null, novaArea: null, areas: [] };

  // ================================================================ RELATORIOS
  function montarRelatorios() {
    const raiz = document.getElementById("frtParteRelatorios");
    if (!raiz || raiz.dataset.montado) return;
    raiz.dataset.montado = "1";
    raiz.innerHTML = `
      <div class="section-shell">
        <div class="section-head">
          <div>
            <h2>📊 Relatórios da frota</h2>
            <p class="tms-subtitle">Tudo calculado pelos sinais do GPS (SRF + T4S). O 1º relatório de um período longo pode levar alguns segundos por dia; depois fica guardado.</p>
          </div>
          <div class="frt-acoes">
            <span class="frt-seg" role="group" aria-label="Período">
              <button type="button" data-p="hoje">Hoje</button><button type="button" data-p="ontem">Ontem</button>
              <button type="button" data-p="7">7 dias</button><button type="button" data-p="30">30 dias</button>
            </span>
            <input type="date" id="frrDe" aria-label="De" /> <input type="date" id="frrAte" aria-label="Até" />
            <button type="button" class="btn-ghost btn-sm" id="frrVer">Ver</button>
          </div>
        </div>
        <div id="frrStatus" class="frt-mudo"></div>
        <div id="frrCards" class="frt-kpis"></div>
      </div>
      ${secao("frrLojas", "🏬 Tempo de descarga por loja", "Quanto tempo o caminhão fica parado na loja (chegou → saiu pelo GPS). Só caminhões e utilitários. As lojas que mais seguram o caminhão aparecem primeiro.")}
      ${secao("frrFabrica", "🏭 Tempo de pátio na fábrica", "Quanto tempo cada veículo fica na fábrica entre chegar e sair de novo (carga, descarga, espera).")}
      ${secao("frrOtif", "⏱ Pontualidade pelo GPS", "Chegada na loja pelo GPS × horário previsto da parada na viagem do TMS (tolerância nas configurações).")}
      ${secao("frrMotoristas", "👤 Ranking de motoristas", "Motorista vem da viagem do TMS do dia; sem viagem lançada, o dia entra em \"(sem viagem no TMS)\".")}
      ${secao("frrExcessos", "⚠ Excessos de velocidade", "Cada episódio (leituras seguidas acima do limite) com o pico e o local. Clique para ver no mapa.")}
      ${secao("frrJornada", "😴 Jornada sem pausa", "Direção contínua acima do limite sem pausa de 30 min (Lei 13.103: 5h30).")}
      ${secao("frrNoite", "🌙 Uso fora do horário", "Movimento entre 22h e 5h. Viagens longas (pernoite) aparecem marcadas.")}
      ${secao("frrMotor", "🔑 Motor ligado parado", "Minutos parado com motor ligado (combustível à toa). Só o T4S informa a ignição.")}
      ${secao("frrDisp", "📶 Disponibilidade dos rastreadores", "% do dia com sinal recente (até 15 min) em cada plataforma. Abaixo de 50% = cobrar o fornecedor / revisar o aparelho.")}
      ${secao("frrKm", "📏 Km por veículo e km real × previsto", "Km pelo GPS no período; e, quando há viagem com km previsto no TMS, a diferença.")}
      <div class="section-shell">
        <div class="section-head"><div><h2 style="font-size:16px;">🔥 Onde os carros param fora das lojas</h2>
          <p class="tms-subtitle">Paradas de 5+ min fora de loja/fábrica agrupadas por quarteirão. Bolinha maior = mais tempo parado ali.</p></div></div>
        <div id="frrCalorMapa" class="frr-mapa"></div>
        <div id="frrCalor"></div>
      </div>
      <div class="section-shell">
        <div class="section-head"><div><h2 style="font-size:16px;">🕐 A frota hora a hora</h2>
          <p class="tms-subtitle">Média de veículos em cada situação em cada hora do dia, no período.</p></div></div>
        <div id="frrHoras"></div>
      </div>`;
    const de = raiz.querySelector("#frrDe"), ate = raiz.querySelector("#frrAte");
    de.value = st.de; ate.value = st.ate; de.max = ate.max = hojeISO();
    raiz.querySelectorAll("[data-p]").forEach((b) => {
      b.onclick = () => {
        const h = hojeISO();
        const p = b.dataset.p;
        st.ate = p === "ontem" ? somaDias(h, -1) : h;
        st.de = p === "hoje" ? h : p === "ontem" ? st.ate : somaDias(h, -(Number(p) - 1));
        de.value = st.de; ate.value = st.ate;
        carregarRelatorio();
      };
    });
    raiz.querySelector("#frrVer").onclick = () => { if (de.value && ate.value) { st.de = de.value <= ate.value ? de.value : ate.value; st.ate = de.value <= ate.value ? ate.value : de.value; carregarRelatorio(); } };
  }
  const secao = (id, titulo, ajuda) => `<div class="section-shell"><div class="section-head"><div><h2 style="font-size:16px;">${titulo}</h2><p class="tms-subtitle">${ajuda}</p></div></div><div id="${id}"></div></div>`;

  async function carregarRelatorio() {
    if (st.carregando) return;
    st.carregando = true;
    const status = document.getElementById("frrStatus");
    status.textContent = `Calculando ${st.de === st.ate ? dataBR(st.de) : `${dataBR(st.de)} a ${dataBR(st.ate)}`}…`;
    document.querySelectorAll("#frtParteRelatorios [data-p]").forEach((b) => b.setAttribute("aria-pressed", "false"));
    try {
      st.rel = await getJson(`${API()}/frota/relatorio?de=${st.de}&ate=${st.ate}`);
      status.textContent = `${st.rel.de === st.rel.ate ? dataBR(st.rel.de) : `${dataBR(st.rel.de)} a ${dataBR(st.rel.ate)}`} · ${st.rel.dias_com_dado} dia(s) com sinal`;
      renderRelatorio();
    } catch (e) {
      status.textContent = `Não consegui calcular: ${e.message}.`;
    } finally { st.carregando = false; }
  }

  function renderRelatorio() {
    const r = st.rel;
    const km = r.veiculos.reduce((s, v) => s + v.km, 0);
    const rodaram = r.veiculos.filter((v) => v.km > 1).length;
    const passagens = r.lojas.reduce((s, l) => s + l.visitas, 0);
    const mediaLoja = passagens ? r.lojas.reduce((s, l) => s + l.media_min * l.visitas, 0) / passagens : null;
    const motorMin = r.veiculos.reduce((s, v) => s + v.motor_parado_min, 0);
    const card = (v, t, cls = "") => `<div class="frt-kpi ${cls}" role="group"><b>${v}</b><span>${t}</span></div>`;
    document.getElementById("frrCards").innerHTML = [
      card(num(km), "km rodados"), card(rodaram, "veículos rodaram"), card(passagens, "passagens em loja"),
      card(mediaLoja != null ? dur(mediaLoja) : "—", "tempo médio na loja"),
      card(r.otif.total ? `${Math.round((r.otif.no_horario / r.otif.total) * 100)}%` : "—", "chegadas no horário"),
      card(r.excessos.length, `excessos ≥ ${r.vel_excesso} km/h`, r.excessos.length ? "frt-k-exc" : ""),
      card(r.jornadas.length, "jornadas sem pausa", r.jornadas.length ? "frt-k-sem" : ""),
      card(r.noites.filter((n) => !n.viagem_longa).length, "usos fora do horário", r.noites.some((n) => !n.viagem_longa) ? "frt-k-sem" : ""),
      card(dur(motorMin), "motor ligado parado"),
    ].join("");

    tabela("frrLojas", [
      { t: "Loja", v: (l) => l.loja },
      { t: "Passagens", v: (l) => l.visitas },
      { t: "Mediana", v: (l) => l.mediana_min, h: (l) => `<b>${dur(l.mediana_min)}</b>` },
      { t: "Média", v: (l) => l.media_min, h: (l) => dur(l.media_min) },
      { t: "Mais demorada", v: (l) => l.max_min, h: (l) => dur(l.max_min) },
      { t: "Veículos", v: (l) => l.veiculos },
      { t: "Última", v: (l) => l.ultima, h: (l) => esc(`${new Date(l.ultima).toLocaleDateString("pt-BR")} ${hhmm(l.ultima)}`) },
    ], r.lojas, { ordem: 2, vazio: "Nenhuma passagem completa (chegou e saiu) em loja no período.", arquivo: `descarga-lojas-${r.de}_${r.ate}` });

    tabela("frrFabrica", [
      { t: "Placa", v: (l) => l.placa },
      { t: "Chegadas", v: (l) => l.passagens },
      { t: "Com saída", v: (l) => l.com_saida },
      { t: "Mediana no pátio", v: (l) => l.mediana_min, h: (l) => `<b>${dur(l.mediana_min)}</b>` },
      { t: "Média", v: (l) => l.media_min, h: (l) => dur(l.media_min) },
    ], r.fabrica, { ordem: 3, arquivo: `patio-fabrica-${r.de}_${r.ate}` });

    const otifBox = document.getElementById("frrOtif");
    if (!r.otif.total) otifBox.innerHTML = `<p class="frt-vazio">Sem chegadas com horário previsto no período. A pontualidade aparece quando as viagens são lançadas no TMS com o horário de cada loja.</p>`;
    else {
      otifBox.innerHTML = `<p class="frr-destaque"><b>${Math.round((r.otif.no_horario / r.otif.total) * 100)}%</b> das ${r.otif.total} chegadas no horário (até ${r.tolerancia_atraso_min} min depois do previsto).</p><div id="frrOtifTab"></div>`;
      tabela("frrOtifTab", [
        { t: "Data", v: (l) => l.data, h: (l) => dataBR(l.data) },
        { t: "Placa", v: (l) => l.placa }, { t: "Motorista", v: (l) => l.motorista || "" }, { t: "Loja", v: (l) => l.loja },
        { t: "Previsto", v: (l) => l.prevista }, { t: "Chegou", v: (l) => l.chegou, h: (l) => hhmm(l.chegou) },
        { t: "Atraso", v: (l) => l.atraso_min, h: (l) => (l.atraso_min > r.tolerancia_atraso_min ? `<b class="frt-atraso">+${dur(l.atraso_min)}</b>` : l.atraso_min > 0 ? `+${dur(l.atraso_min)}` : "no horário") },
      ], r.otif.itens, { ordem: 6, arquivo: `pontualidade-${r.de}_${r.ate}` });
    }

    tabela("frrMotoristas", [
      { t: "Motorista", v: (l) => l.motorista },
      { t: "Dias", v: (l) => l.dias }, { t: "Km", v: (l) => l.km, h: (l) => num(l.km) }, { t: "Lojas", v: (l) => l.lojas },
      { t: "Tempo médio na loja", v: (l) => l.tempo_medio_loja_min ?? -1, h: (l) => dur(l.tempo_medio_loja_min) },
      { t: "No horário", v: (l) => l.pct_no_horario ?? -1, h: (l) => (l.pct_no_horario == null ? "—" : `${l.pct_no_horario}% <small class="frt-mudo">(${l.com_previsto})</small>`) },
      { t: "Excessos", v: (l) => l.excessos, h: (l) => (l.excessos ? `<b class="frt-atraso">${l.excessos}</b>` : "0") },
      { t: "Jornadas sem pausa", v: (l) => l.jornadas_acima },
      { t: "Motor ligado parado", v: (l) => l.motor_parado_min, h: (l) => dur(l.motor_parado_min) },
      { t: "Km de madrugada", v: (l) => l.noite_km },
    ], r.motoristas, { ordem: 2, arquivo: `motoristas-${r.de}_${r.ate}` });

    tabela("frrExcessos", [
      { t: "Data", v: (l) => l.data, h: (l) => dataBR(l.data) }, { t: "Hora", v: (l) => l.em, h: (l) => hhmm(l.em) },
      { t: "Placa", v: (l) => l.placa }, { t: "Motorista", v: (l) => l.motorista || "" },
      { t: "Pico", v: (l) => l.vel, h: (l) => `<b class="frt-atraso">${l.vel} km/h</b>` }, { t: "Leituras", v: (l) => l.leituras },
      { t: "Local", v: (l) => `${l.lat},${l.lng}`, h: () => `<span class="frt-link">ver no mapa</span>` },
    ], r.excessos, { ordem: 4, clique: verNoMapa, vazio: `Nenhuma leitura acima de ${r.vel_excesso} km/h no período.`, arquivo: `excessos-${r.de}_${r.ate}` });

    tabela("frrJornada", [
      { t: "Data", v: (l) => l.data, h: (l) => dataBR(l.data) }, { t: "Placa", v: (l) => l.placa }, { t: "Motorista", v: (l) => l.motorista || "" },
      { t: "Direção contínua", v: (l) => l.max_continua_min, h: (l) => `<b>${dur(l.max_continua_min)}</b>` },
      { t: "Das", v: (l) => l.inicio, h: (l) => hhmm(l.inicio) }, { t: "Às", v: (l) => l.fim, h: (l) => hhmm(l.fim) },
      { t: "Dirigindo no dia", v: (l) => l.dirigindo_min, h: (l) => dur(l.dirigindo_min) },
    ], r.jornadas, { ordem: 3, vazio: `Ninguém passou de ${dur(r.jornada_max_min)} de direção sem pausa de 30 min.`, arquivo: `jornada-${r.de}_${r.ate}` });

    tabela("frrNoite", [
      { t: "Data", v: (l) => l.data, h: (l) => dataBR(l.data) }, { t: "Placa", v: (l) => l.placa }, { t: "Motorista", v: (l) => l.motorista || "" },
      { t: "Das", v: (l) => l.inicio, h: (l) => hhmm(l.inicio) }, { t: "Às", v: (l) => l.fim, h: (l) => hhmm(l.fim) },
      { t: "Km", v: (l) => l.km, h: (l) => `<b>${num(l.km, 1)}</b>` },
      { t: "Viagem", v: (l) => (l.viagem_longa ? "viagem longa (pernoite)" : ""), h: (l) => (l.viagem_longa ? `<span class="frt-tag">viagem longa</span>` : `<span class="frt-atraso">sem viagem longa</span>`) },
    ], r.noites, { ordem: 5, clique: verNoMapa, vazio: "Nenhum movimento entre 22h e 5h no período.", arquivo: `fora-do-horario-${r.de}_${r.ate}` });

    tabela("frrMotor", [
      { t: "Placa", v: (l) => l.placa },
      { t: "Motor ligado parado", v: (l) => l.motor_parado_min, h: (l) => `<b>${dur(l.motor_parado_min)}</b>` },
      { t: "Km no período", v: (l) => l.km, h: (l) => num(l.km) },
    ], r.veiculos.filter((v) => v.motor_parado_min > 0), { ordem: 1, vazio: "Nenhum tempo parado com motor ligado (só os carros com T4S informam a ignição).", arquivo: `motor-ligado-${r.de}_${r.ate}` });

    const pct = (x) => (x == null ? "—" : `<b class="${x < 50 ? "frt-atraso" : x < 80 ? "frr-medio" : "frr-bom"}">${x}%</b>`);
    tabela("frrDisp", [
      { t: "Placa", v: (l) => l.placa },
      { t: "SRF", v: (l) => (l.disponibilidade.srf ?? -1), h: (l) => pct(l.disponibilidade.srf) },
      { t: "T4S", v: (l) => (l.disponibilidade.t4s ?? -1), h: (l) => pct(l.disponibilidade.t4s) },
      { t: "Sat", v: (l) => (l.disponibilidade.sat ?? -1), h: (l) => pct(l.disponibilidade.sat) },
      { t: "Melhor", v: (l) => Math.max(-1, ...Object.values(l.disponibilidade)), h: (l) => pct(Object.keys(l.disponibilidade).length ? Math.max(...Object.values(l.disponibilidade)) : null) },
    ], r.veiculos, { ordem: 3, desc: false, arquivo: `disponibilidade-${r.de}_${r.ate}` });

    const kmBox = document.getElementById("frrKm");
    kmBox.innerHTML = `<div id="frrKmVeic"></div><h3 class="frt-h3" style="margin-top:12px;">Km real × previsto (viagens do TMS)</h3><div id="frrKmPrev"></div>`;
    tabela("frrKmVeic", [
      { t: "Placa", v: (l) => l.placa }, { t: "Km", v: (l) => l.km, h: (l) => `<b>${num(l.km)}</b>` }, { t: "Dias rodando", v: (l) => l.dias_rodando },
    ], r.veiculos, { ordem: 1, arquivo: `km-veiculos-${r.de}_${r.ate}` });
    tabela("frrKmPrev", [
      { t: "Data", v: (l) => l.data, h: (l) => dataBR(l.data) }, { t: "Placa", v: (l) => l.placa }, { t: "Rota", v: (l) => l.rota || "" }, { t: "Motorista", v: (l) => l.motorista || "" },
      { t: "Previsto", v: (l) => l.km_previsto, h: (l) => num(l.km_previsto) }, { t: "Real (GPS)", v: (l) => l.km_real, h: (l) => num(l.km_real, 1) },
      { t: "Diferença", v: (l) => l.diferenca_pct ?? 0, h: (l) => (l.diferenca_pct == null ? "—" : `<b class="${Math.abs(l.diferenca_pct) > 20 ? "frt-atraso" : ""}">${l.diferenca_pct > 0 ? "+" : ""}${l.diferenca_pct}%</b>`) },
    ], r.km_previsto, { vazio: "Sem viagens com km previsto no período (aparece quando as viagens são lançadas no TMS).", arquivo: `km-previsto-${r.de}_${r.ate}` });

    renderCalor();
    renderHoras();
  }

  async function renderCalor() {
    const r = st.rel;
    tabela("frrCalor", [
      { t: "Perto de", v: (l) => l.perto || "" }, { t: "Paradas", v: (l) => l.paradas },
      { t: "Tempo parado", v: (l) => l.min, h: (l) => `<b>${dur(l.min)}</b>` },
      { t: "Veículos", v: (l) => l.veiculos.join(", ") },
      { t: "Local", v: (l) => `${l.lat},${l.lng}`, h: () => `<span class="frt-link">ver</span>` },
    ], r.calor, { ordem: 2, max: 30, clique: (l) => { if (st.mapaCalor) st.mapaCalor.setView([l.lat, l.lng], 16); }, vazio: "Nenhuma parada fora de loja no período.", arquivo: `paradas-fora-${r.de}_${r.ate}` });
    const div = document.getElementById("frrCalorMapa");
    if (!r.calor.length) { div.hidden = true; return; }
    div.hidden = false;
    try { await api().carregarLeaflet(); } catch (e) { div.innerHTML = `<p class="frt-vazio">${esc(e.message)}</p>`; return; }
    const L = window.L;
    if (!st.mapaCalor) {
      st.mapaCalor = L.map(div).setView([-22.9, -43.5], 10);
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap", referrerPolicy: "strict-origin-when-cross-origin" }).addTo(st.mapaCalor);
      st.camCalor = L.layerGroup().addTo(st.mapaCalor);
    }
    st.camCalor.clearLayers();
    const maxMin = Math.max(...r.calor.map((c) => c.min));
    for (const c of r.calor) {
      const f = Math.sqrt(c.min / maxMin);
      L.circleMarker([c.lat, c.lng], { radius: 5 + f * 22, color: "#dc2626", weight: 1, fillColor: "#f97316", fillOpacity: 0.25 + f * 0.45 })
        .bindTooltip(`<b>${c.paradas} parada(s) · ${dur(c.min)}</b>${c.perto ? `<br>perto de ${esc(c.perto)}` : ""}<br>${esc(c.veiculos.join(", "))}`, { direction: "top" })
        .addTo(st.camCalor);
    }
    setTimeout(() => { st.mapaCalor.invalidateSize(); st.mapaCalor.fitBounds(L.latLngBounds(r.calor.map((c) => [c.lat, c.lng])).pad(0.1), { maxZoom: 14 }); }, 60);
  }

  function renderHoras() {
    const h = st.rel.horas;
    const est = [["r", "Rodando", "#16a34a"], ["l", "Em loja", "#9333ea"], ["f", "Na fábrica", "#2563eb"], ["p", "Parado fora", "#d97706"], ["s", "Sem sinal", "#94a3b8"]];
    const total = Math.max(1, ...h.map((x) => est.reduce((s, [k]) => s + x[k], 0)));
    document.getElementById("frrHoras").innerHTML = `
      <div class="frr-legenda">${est.map(([, n, c]) => `<span><i style="background:${c}"></i>${n}</span>`).join("")}</div>
      <div class="frr-horas">${h.map((x, i) => `<div class="frr-hora"><span class="frr-hora-n">${String(i).padStart(2, "0")}h</span>
        <span class="frr-barra">${est.map(([k, n, c]) => (x[k] > 0 ? `<i style="width:${(x[k] / total) * 100}%;background:${c}" title="${n}: ${num(x[k], 1)} veículo(s)"></i>` : "")).join("")}</span>
        <span class="frr-hora-v">${num(x.r, 1)} rodando</span></div>`).join("")}</div>`;
  }

  // ================================================================ ALERTAS E AREAS
  function montarAreas() {
    const raiz = document.getElementById("frtParteAreas");
    if (!raiz || raiz.dataset.montado) return;
    raiz.dataset.montado = "1";
    raiz.innerHTML = `
      <div class="section-shell">
        <div class="section-head"><div><h2>⚠ Alertas da frota</h2>
          <p class="tms-subtitle">Avisos automáticos a cada 3 min no sino 🚨 do topo (e no Telegram, se configurado). Cada fato avisa uma vez só.</p></div></div>
        <div id="frrLimites"></div>
        <div class="frt-acoes" style="margin-top:10px;">
          <button type="button" class="btn-ghost btn-sm" id="frrResumoVer">Ver o resumo de hoje</button>
          <button type="button" class="btn-ghost btn-sm" id="frrResumoEnviar">Enviar o resumo agora no Telegram</button>
        </div>
        <pre id="frrResumoTexto" class="frr-resumo" hidden></pre>
      </div>
      <div class="section-shell">
        <div class="section-head"><div><h2 style="font-size:16px;">🗺 Áreas e cercas</h2>
          <p class="tms-subtitle">Desenhe no mapa as áreas onde o carro não deve entrar (ou que exigem atenção). Quando um veículo entra, chega um aviso. As áreas também aparecem no mapa ao vivo.
            As <b>cercas do SRF</b> podem vir para cá (⬇) e as daqui podem ir para lá (⬆). Corredor de rota e referência só aparecem no mapa, sem aviso.</p></div>
          <div class="frt-acoes">
            <button type="button" class="btn-ghost btn-sm" id="frrSrfTrazer" title="Mostra o que vai mudar antes de trazer">⬇ Trazer do SRF</button>
            <button type="button" class="btn-ghost btn-sm" id="frrSrfEnviar" title="Cria/atualiza no SRF as áreas daqui que ainda não estão lá">⬆ Enviar ao SRF</button>
            <button type="button" class="btn-blue btn-sm" id="frrNovaArea">➕ Nova área</button></div></div>
        <div id="frrSrfMsg" class="frt-mudo" style="margin:4px 0 8px;"></div>
        <div id="frrAreaForm" class="frr-area-form" hidden>
          <b>Clique no mapa para marcar os cantos da área</b> (pelo menos 3).
          <input type="text" id="frrAreaNome" placeholder="Nome (ex.: Comunidade X)" maxlength="80" />
          <select id="frrAreaTipo"><option value="risco">Área de risco</option><option value="proibida">Área proibida</option><option value="atencao">Área de atenção</option><option value="corredor">Corredor de rota (sem aviso)</option><option value="referencia">Só referência (sem aviso)</option></select>
          <button type="button" class="btn-ghost btn-sm" id="frrAreaDesfazer">Desfazer ponto</button>
          <button type="button" class="btn-ghost btn-sm" id="frrAreaCancelar">Cancelar</button>
          <button type="button" class="btn-green btn-sm" id="frrAreaSalvar">Salvar área</button>
          <span id="frrAreaMsg" class="frt-mudo"></span>
        </div>
        <div id="frrAreasMapa" class="frr-mapa"></div>
        <div id="frrAreasLista"></div>
      </div>`;
    raiz.querySelector("#frrResumoVer").onclick = async () => {
      const pre = document.getElementById("frrResumoTexto");
      pre.hidden = false; pre.textContent = "Montando…";
      try { pre.textContent = (await getJson(`${API()}/frota/resumo`)).texto; } catch (e) { pre.textContent = e.message; }
    };
    raiz.querySelector("#frrResumoEnviar").onclick = async () => {
      const pre = document.getElementById("frrResumoTexto");
      pre.hidden = false; pre.textContent = "Enviando…";
      try { const r = await enviar("POST", `${API()}/frota/resumo/enviar`); pre.textContent = r.ok ? "✓ Enviado no Telegram." : `${r.motivo}\n\n${r.texto || ""}`; }
      catch (e) { pre.textContent = e.message; }
    };
    raiz.querySelector("#frrNovaArea").onclick = () => iniciarNovaArea();
    raiz.querySelector("#frrAreaDesfazer").onclick = () => { if (st.novaArea) { st.novaArea.pontos.pop(); desenharNovaArea(); } };
    raiz.querySelector("#frrAreaCancelar").onclick = () => terminarNovaArea();
    raiz.querySelector("#frrAreaSalvar").onclick = salvarArea;
    raiz.querySelector("#frrSrfTrazer").onclick = trazerDoSrf;
    raiz.querySelector("#frrSrfEnviar").onclick = enviarTodasSrf;
  }

  async function carregarAreasParte() {
    const lim = document.getElementById("frrLimites");
    try {
      const l = await getJson(`${API()}/frota/limites`);
      lim.innerHTML = `<ul class="frr-regras">
        <li>⏸ <b>Parada longa</b> fora de loja/fábrica: a partir de ${dur(l.parada_min)}</li>
        <li>📵 <b>Rastreador mudo</b> em todas as plataformas: ${dur(l.mudo_min)} (6h–21h) — e <b>plataforma parada</b> (ex.: login do T4S expirado)</li>
        <li>🗺 <b>Entrou em área de risco</b> desenhada abaixo</li>
        <li>🌙 <b>Uso fora do horário</b>: movimento entre 22h e 5h sem viagem longa</li>
        <li>😴 <b>Jornada</b>: ${dur(l.jornada_min)} de direção sem pausa de 30 min</li>
        <li>🔑 <b>Motor ligado parado</b>: ${dur(l.motor_min)} (carros com T4S)</li>
        <li>⚠ <b>Velocidade</b> ≥ ${l.vel} km/h — só no sino${l.vel_telegram ? " e no Telegram" : " (sem Telegram, para não virar spam)"}</li>
        <li>📨 <b>Resumo do dia</b> no Telegram às ${esc(l.resumo_hora)}${l.resumo_ativo ? "" : " (desligado)"}</li>
      </ul>`;
    } catch (e) { lim.innerHTML = `<p class="frt-vazio">Os alertas da frota começam ${e.status === 404 ? "depois que o servidor for reiniciado" : `quando o servidor responder (${esc(e.message)})`}.</p>`; }
    try { st.areas = await getJson(`${API()}/frota/areas`); } catch (_) { st.areas = []; }
    await desenharMapaAreas();
    renderListaAreas();
  }

  const COR_AREA = { risco: "#dc2626", proibida: "#7f1d1d", atencao: "#d97706", corredor: "#2563eb", referencia: "#64748b" };
  const NOME_TIPO = { risco: "Área de risco", proibida: "Área proibida", atencao: "Área de atenção", corredor: "Corredor de rota", referencia: "Só referência" };
  const corDa = (a) => a.cor || COR_AREA[a.tipo] || COR_AREA.risco;
  async function desenharMapaAreas() {
    const div = document.getElementById("frrAreasMapa");
    try { await api().carregarLeaflet(); } catch (e) { div.innerHTML = `<p class="frt-vazio">${esc(e.message)}</p>`; return; }
    const L = window.L;
    if (!st.mapaAreas) {
      st.mapaAreas = L.map(div).setView([-22.9, -43.45], 10);
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap", referrerPolicy: "strict-origin-when-cross-origin" }).addTo(st.mapaAreas);
      st.camAreas = L.layerGroup().addTo(st.mapaAreas);
      st.camNova = L.layerGroup().addTo(st.mapaAreas);
      st.mapaAreas.on("click", (e) => { if (st.novaArea) { st.novaArea.pontos.push([Math.round(e.latlng.lat * 1e5) / 1e5, Math.round(e.latlng.lng * 1e5) / 1e5]); desenharNovaArea(); } });
      // Lojas e fabrica de referencia (cinza, discretas).
      for (const l of (api().lugares() || [])) {
        if (Number.isFinite(l.lat)) L.circleMarker([l.lat, l.lng], { radius: 3, color: "#64748b", weight: 1, fillOpacity: 0.4, interactive: false }).addTo(st.mapaAreas);
      }
    }
    setTimeout(() => st.mapaAreas.invalidateSize(), 60);
    st.camAreas.clearLayers();
    for (const a of st.areas) {
      L.polygon(a.pontos, { color: corDa(a), weight: 2, fillOpacity: 0.12 })
        .bindTooltip(`<b>${esc(a.nome)}</b><br><small>${NOME_TIPO[a.tipo] || ""}${a.srf_id ? " · cerca do SRF" : ""}</small>`, { sticky: true }).addTo(st.camAreas);
    }
  }

  function renderListaAreas() {
    const el = document.getElementById("frrAreasLista");
    if (!st.areas.length) { el.innerHTML = `<p class="frt-vazio">Nenhuma área desenhada ainda.</p>`; return; }
    const srf = (a) => !a.srf_id ? `<span class="frt-mudo">só aqui</span>`
      : `<span class="frt-tag" title="Cerca #${a.srf_id} no SRF">✓ SRF</span>${a.srf_ativo === false ? ` <span class="frt-mudo" title="Está desativada lá no SRF">· desativada lá</span>` : ""}${a.srf_pendente ? ` <span class="frt-atraso">· alterada aqui</span>` : ""}`;
    const opcoes = (a) => Object.keys(NOME_TIPO).map((t) => `<option value="${t}"${t === a.tipo ? " selected" : ""}>${NOME_TIPO[t]}</option>`).join("");
    el.innerHTML = `<div class="frt-tabela-wrap"><table class="frt-tabela"><thead><tr><th>Área</th><th>Tipo</th><th>Cantos</th><th>SRF</th><th></th></tr></thead><tbody>
      ${st.areas.map((a) => `<tr><td><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${esc(corDa(a))};margin-right:6px;"></span><b>${esc(a.nome)}</b></td>
        <td><select data-tipo="${a.id}" title="Risco/proibida/atenção avisam quando um carro entra; corredor e referência só aparecem no mapa">${opcoes(a)}</select></td><td>${a.pontos.length}</td><td>${srf(a)}</td>
        <td><button type="button" class="frt-link" data-ver="${a.id}">ver</button>${!a.srf_id || a.srf_pendente ? ` · <button type="button" class="frt-link" data-srf="${a.id}">${a.srf_id ? "⬆ atualizar no SRF" : "⬆ enviar ao SRF"}</button>` : ""} · <button type="button" class="frt-link" data-apagar="${a.id}">apagar</button></td></tr>`).join("")}
    </tbody></table></div>`;
    el.querySelectorAll("[data-tipo]").forEach((sel) => {
      sel.onchange = async () => {
        try { const r = await enviar("PUT", `${API()}/frota/areas/${sel.dataset.tipo}`, { tipo: sel.value }); srfMsg(r.srf_pendente ? "Tipo trocado. A cor mudou: use ⬆ atualizar no SRF para levar para lá." : "Tipo trocado."); window.dispatchEvent(new Event("frota-areas-mudou")); await carregarAreasParte(); }
        catch (e) { srfMsg(e.message, true); await carregarAreasParte(); }
      };
    });
    el.querySelectorAll("[data-srf]").forEach((b) => {
      b.onclick = async () => {
        b.disabled = true; b.textContent = "enviando…";
        try { const r = await enviar("POST", `${API()}/frota/areas/${b.dataset.srf}/srf`); srfMsg(`✓ "${r.nome}" ${r.criada ? "criada" : "atualizada"} no SRF (cerca #${r.srf_id}).`); await carregarAreasParte(); }
        catch (e) { srfMsg(e.message, true); b.disabled = false; b.textContent = "⬆ tentar de novo"; }
      };
    });
    el.querySelectorAll("[data-ver]").forEach((b) => { b.onclick = () => { const a = st.areas.find((x) => String(x.id) === b.dataset.ver); if (a && st.mapaAreas) st.mapaAreas.fitBounds(window.L.latLngBounds(a.pontos).pad(0.3)); }; });
    el.querySelectorAll("[data-apagar]").forEach((b) => {
      b.onclick = async () => {
        const a = st.areas.find((x) => String(x.id) === b.dataset.apagar);
        if (!a) return;
        const ok = await confirmar(`Apagar a área "${a.nome}"?`, "Apagar");
        if (!ok) return;
        // Ligada ao SRF: pergunta a parte (apagar la e irreversivel).
        const tambemSrf = a.srf_id ? await confirmar(`Apagar também a cerca "${a.nome}" lá no SRF?\n\nApagar lá não tem volta. "Só aqui" deixa a cerca no SRF e ela não volta para cá.`, "Apagar lá também", "Só aqui") : false;
        try { await enviar("DELETE", `${API()}/frota/areas/${a.id}${tambemSrf ? "?srf=1" : ""}`); srfMsg(tambemSrf ? `Área e cerca do SRF apagadas.` : "Área apagada."); window.dispatchEvent(new Event("frota-areas-mudou")); await carregarAreasParte(); }
        catch (e) { srfMsg(e.message, true); }
      };
    });
  }

  const confirmar = (texto, ok, cancelar = "Voltar") => (typeof window.confirmarBonito === "function"
    ? window.confirmarBonito(texto, { okLabel: ok, cancelLabel: cancelar }) : Promise.resolve(window.confirm(texto)));
  function srfMsg(texto, erro = false) {
    const el = document.getElementById("frrSrfMsg");
    if (!el) return;
    el.textContent = texto || "";
    el.style.color = erro ? "#dc2626" : "";
  }
  // ⬇ Trazer do SRF: mostra a previa e so grava depois do OK.
  async function trazerDoSrf() {
    const b = document.getElementById("frrSrfTrazer");
    b.disabled = true; srfMsg("Lendo as cercas do SRF…");
    try {
      const p = await enviar("GET", `${API()}/frota/areas/srf`);
      const r = p.resumo;
      const novas = p.itens.filter((i) => i.situacao === "nova");
      const partes = [];
      if (r.novas) partes.push(`${r.novas} nova(s): ${novas.slice(0, 12).map((i) => i.nome).join(", ")}${novas.length > 12 ? "…" : ""}`);
      if (r.mudaram) partes.push(`${r.mudaram} mudaram lá e serão atualizadas aqui`);
      if (p.sumiram.length) partes.push(`${p.sumiram.length} não existem mais lá (${p.sumiram.map((s) => s.nome).join(", ")})`);
      if (!partes.length) { srfMsg(`Nada para trazer: o SRF tem ${r.total} cerca(s) e ${r.iguais} já estão aqui iguais${r.apagadas_aqui ? `, ${r.apagadas_aqui} você apagou aqui` : ""}.`); return; }
      const inativas = novas.filter((i) => !i.ativa_srf).length;
      const texto = `O SRF tem ${r.total} cerca(s).\n\n• ${partes.join("\n• ")}${inativas ? `\n\n${inativas} das novas estão DESATIVADAS lá — vêm mesmo assim, marcadas.` : ""}\n\nCercas do grupo "Rota" entram como "Corredor de rota" (só no mapa, sem aviso). Dá para trocar o tipo na lista.`;
      if (!(await confirmar(texto, "Trazer"))) { srfMsg(""); return; }
      srfMsg("Trazendo…");
      const f = await enviar("POST", `${API()}/frota/areas/srf/importar`, {});
      srfMsg(`✓ Do SRF: ${f.novas} nova(s), ${f.atualizadas} atualizada(s)${f.removidas ? `, ${f.removidas} removida(s) (apagadas lá)` : ""}${f.desvinculadas ? `, ${f.desvinculadas} perderam o vínculo` : ""}.`);
      window.dispatchEvent(new Event("frota-areas-mudou"));
      await carregarAreasParte();
    } catch (e) { srfMsg(e.message, true); }
    finally { b.disabled = false; }
  }
  // ⬆ Enviar ao SRF: todas as daqui sem cerca la (ou alteradas aqui).
  async function enviarTodasSrf() {
    const pend = (st.areas || []).filter((a) => !a.srf_id || a.srf_pendente);
    if (!pend.length) { srfMsg("Todas as áreas daqui já estão no SRF."); return; }
    if (!(await confirmar(`Enviar ao SRF ${pend.length} área(s)?\n\n• ${pend.map((a) => `${a.nome}${a.srf_id ? " (atualizar)" : " (nova lá)"}`).join("\n• ")}`, "Enviar"))) return;
    const b = document.getElementById("frrSrfEnviar");
    b.disabled = true; srfMsg("Enviando ao SRF…");
    try {
      const r = await enviar("POST", `${API()}/frota/areas/srf/enviar`, {});
      srfMsg(`✓ ${r.enviadas} enviada(s) ao SRF (${r.criadas} nova(s) lá)${r.falhas.length ? ` · ${r.falhas.length} falha(s): ${r.falhas.map((f) => f.erro).join("; ")}` : ""}.`, r.falhas.length > 0);
      await carregarAreasParte();
    } catch (e) { srfMsg(e.message, true); }
    finally { b.disabled = false; }
  }

  function iniciarNovaArea() {
    st.novaArea = { pontos: [] };
    document.getElementById("frrAreaForm").hidden = false;
    document.getElementById("frrAreaMsg").textContent = "";
    document.getElementById("frrAreasMapa").classList.add("frr-desenhando");
    desenharNovaArea();
  }
  function terminarNovaArea() {
    st.novaArea = null;
    document.getElementById("frrAreaForm").hidden = true;
    document.getElementById("frrAreasMapa").classList.remove("frr-desenhando");
    if (st.camNova) st.camNova.clearLayers();
  }
  function desenharNovaArea() {
    if (!st.camNova) return;
    const L = window.L;
    st.camNova.clearLayers();
    const p = st.novaArea ? st.novaArea.pontos : [];
    p.forEach((x) => L.circleMarker(x, { radius: 5, color: "#2563eb", fillColor: "#fff", fillOpacity: 1, weight: 2 }).addTo(st.camNova));
    if (p.length >= 2) L.polyline(p.length >= 3 ? [...p, p[0]] : p, { color: "#2563eb", weight: 2, dashArray: "5 5" }).addTo(st.camNova);
    if (p.length >= 3) L.polygon(p, { stroke: false, fillColor: "#2563eb", fillOpacity: 0.12 }).addTo(st.camNova);
    document.getElementById("frrAreaMsg").textContent = `${p.length} canto(s)`;
  }
  async function salvarArea() {
    const msg = document.getElementById("frrAreaMsg");
    const nome = document.getElementById("frrAreaNome").value.trim();
    if (!st.novaArea || st.novaArea.pontos.length < 3) { msg.textContent = "Marque pelo menos 3 cantos no mapa."; return; }
    if (!nome) { msg.textContent = "Dê um nome para a área."; return; }
    try {
      await enviar("POST", `${API()}/frota/areas`, { nome, tipo: document.getElementById("frrAreaTipo").value, pontos: st.novaArea.pontos });
      document.getElementById("frrAreaNome").value = "";
      terminarNovaArea();
      window.dispatchEvent(new Event("frota-areas-mudou"));
      await carregarAreasParte();
    } catch (e) { msg.textContent = e.message; }
  }

  // ================================================================ MANUTENCAO
  const ITENS = ["Troca de óleo", "Revisão", "Filtros", "Pneus", "Freios", "Correia", "Outro"];
  function montarManutencao() {
    const raiz = document.getElementById("frtParteManutencao");
    if (!raiz || raiz.dataset.montado) return;
    raiz.dataset.montado = "1";
    raiz.innerHTML = `
      <div class="section-shell">
        <div class="section-head"><div><h2>🔧 Manutenção por quilometragem</h2>
          <p class="tms-subtitle">Cadastre a cada quantos km cada item vence e a data da última troca. O km rodado é contado pelo GPS (todos os dias desde a data informada) — vencidos e próximos também vão no resumo do dia.</p></div></div>
        <form id="frrManutForm" class="frr-manut-form">
          <label>Placa <input list="frrPlacas" id="frrMPlaca" required placeholder="ABC1D23" /></label>
          <datalist id="frrPlacas"></datalist>
          <label>Item <select id="frrMItem">${ITENS.map((i) => `<option>${i}</option>`).join("")}</select></label>
          <label id="frrMOutroBox" hidden>Qual? <input id="frrMOutro" maxlength="60" /></label>
          <label>A cada (km) <input type="number" id="frrMKm" min="100" step="100" required placeholder="10000" /></label>
          <label>Última troca em <input type="date" id="frrMDesde" required /></label>
          <label>Km já rodados desde a troca (antes do GPS) <input type="number" id="frrMKm0" min="0" step="1" value="0" /></label>
          <button type="submit" class="btn-green btn-sm">Adicionar</button>
          <span id="frrMMsg" class="frt-mudo"></span>
        </form>
        <div id="frrManut"></div>
      </div>`;
    const item = raiz.querySelector("#frrMItem");
    item.onchange = () => { raiz.querySelector("#frrMOutroBox").hidden = item.value !== "Outro"; };
    raiz.querySelector("#frrMDesde").value = hojeISO();
    raiz.querySelector("#frrMDesde").max = hojeISO();
    raiz.querySelector("#frrManutForm").onsubmit = async (e) => {
      e.preventDefault();
      const msg = raiz.querySelector("#frrMMsg");
      const it = item.value === "Outro" ? raiz.querySelector("#frrMOutro").value.trim() : item.value;
      try {
        await enviar("POST", `${API()}/frota/manutencao`, {
          placa: raiz.querySelector("#frrMPlaca").value, item: it, a_cada_km: Number(raiz.querySelector("#frrMKm").value),
          desde_data: raiz.querySelector("#frrMDesde").value, desde_km: Number(raiz.querySelector("#frrMKm0").value || 0),
        });
        msg.textContent = "✓ Adicionado.";
        raiz.querySelector("#frrMPlaca").value = ""; raiz.querySelector("#frrMKm").value = "";
        await carregarManutencao();
      } catch (err) { msg.textContent = err.message; }
    };
  }

  async function carregarManutencao() {
    const dados = api().dados();
    const dl = document.getElementById("frrPlacas");
    if (dl && dados) dl.innerHTML = dados.veiculos.map((v) => `<option value="${esc(v.placa)}">${esc(v.modelo || "")}</option>`).join("");
    const box = document.getElementById("frrManut");
    box.innerHTML = `<p class="frt-vazio">Calculando…</p>`;
    try {
      const h = hojeISO();
      const r = await getJson(`${API()}/frota/relatorio?de=${h}&ate=${h}`);
      const cor = { vencida: "frt-atraso", proxima: "frr-medio", ok: "frr-bom" };
      const rot = { vencida: "Vencida", proxima: "Próxima", ok: "Em dia" };
      tabela("frrManut", [
        { t: "Placa", v: (l) => l.placa }, { t: "Item", v: (l) => l.item },
        { t: "A cada", v: (l) => l.a_cada_km, h: (l) => `${num(l.a_cada_km)} km` },
        { t: "Última troca", v: (l) => l.desde_data, h: (l) => dataBR(l.desde_data) },
        { t: "Rodados desde", v: (l) => l.km_desde, h: (l) => `${num(l.km_desde)} km` },
        { t: "Faltam", v: (l) => l.falta_km, h: (l) => `<b class="${cor[l.situacao]}">${l.falta_km <= 0 ? `passou ${num(-l.falta_km)} km` : `${num(l.falta_km)} km`}</b>` },
        { t: "Situação", v: (l) => l.situacao, h: (l) => `<span class="frt-tag ${cor[l.situacao]}">${rot[l.situacao]}</span>` },
        { t: "", v: () => "", h: (l) => `<button type="button" class="frt-link" data-apagar-m="${l.id}">apagar</button>` },
      ], r.manutencao, { ordem: 5, desc: false, vazio: "Nenhum item cadastrado. Use o formulário acima.", arquivo: "manutencao" });
      box.querySelectorAll("[data-apagar-m]").forEach((b) => {
        b.onclick = async (e) => {
          e.stopPropagation();
          try { await enviar("DELETE", `${API()}/frota/manutencao/${b.dataset.apagarM}`); await carregarManutencao(); } catch (err) { alert(err.message); }
        };
      });
    } catch (e) { box.innerHTML = `<p class="frt-vazio">${esc(e.message)}</p>`; }
  }

  // ================================================================ liga
  window.frtRel = {
    abrir(parte) {
      if (!window.frtApi) return;
      if (parte === "relatorios") { montarRelatorios(); if (!st.rel) carregarRelatorio(); else setTimeout(() => st.mapaCalor && st.mapaCalor.invalidateSize(), 60); }
      if (parte === "areas") { montarAreas(); carregarAreasParte(); }
      if (parte === "manutencao") { montarManutencao(); carregarManutencao(); }
    },
  };
})();
