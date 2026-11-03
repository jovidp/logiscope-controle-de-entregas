// ================================================================
// rastreador.js (front) — 🛰 posicao dos caminhoes no TMS
// ----------------------------------------------------------------
// GET /tms/rastreador/posicoes (back/rastreador.js, plataforma SRF):
//   - painel "🛰 Frota agora" no topo da aba TMS (todos os aparelhos);
//   - linha 🛰 no card de cada viagem (tmsRastreadorHtml), com a posicao que
//     o GET /tms/viagens ja anexa pela placa (viagem.rastreador).
// Atualiza a cada 60 s enquanto a aba TMS esta aberta. Sem rastreador
// configurado no servidor o painel fica escondido.
// ================================================================
(function iniciarRastreadorFront() {
  "use strict";

  const esc = (v) => (typeof window.escapar === "function"
    ? window.escapar(v == null ? "" : v)
    : String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])));
  const fmtMin = (m) => (m == null ? "?" : m >= 1440 ? `${Math.floor(m / 1440)}d` : m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}` : `${m} min`);
  const COR = { movendo: "#16a34a", parado: "#d97706", sem_sinal: "#94a3b8" };
  const mapa = (a) => `https://www.google.com/maps?q=${a.lat},${a.lng}`;

  // Frase curta: "Em movimento · 52 km/h · perto de BANGU I (300 m)"
  function frase(a) {
    // "em" so parado: andando a 30 km/h na porta da loja o caminhao esta indo embora.
    const naLoja = a.perto_de && a.perto_de.m <= 250 && a.estado !== "movendo";
    const perto = a.perto_de ? ` · ${naLoja ? "em" : "perto de"} ${esc(a.perto_de.nome || a.perto_de.codigo)}${!naLoja ? ` (${a.perto_de.m >= 1000 ? (a.perto_de.m / 1000).toFixed(1) + " km" : a.perto_de.m + " m"})` : ""}` : "";
    if (a.estado === "sem_sinal") return `Sem sinal há ${fmtMin(a.idade_min)}${perto ? ` · última posição${perto.replace(" · ", " ")}` : ""}`;
    if (a.estado === "parado") return `Parado${a.parado_min ? ` há ${fmtMin(a.parado_min)}` : ""}${perto}`;
    return `Em movimento · ${Math.round(a.velocidade)} km/h${perto}`;
  }

  // Linha no card da viagem (tms.js chama).
  window.tmsRastreadorHtml = function (viagem) {
    const a = viagem && viagem.rastreador;
    if (!a) return "";
    const cor = COR[a.estado] || COR.sem_sinal;
    const idade = a.estado !== "sem_sinal" && a.idade_min > 1 ? ` · há ${fmtMin(a.idade_min)}` : "";
    const outra = a.fonte && a.fonte !== "srf" ? String(a.fonte).toUpperCase() : "";
    const fonte = outra ? ` (${outra})` : "";
    return `<div class="tms-meta" style="color:${cor};font-weight:700;" title="Rastreador ${esc(a.nome)}${outra ? ` · posição do ${outra}, o sinal mais recente desta placa` : ""}">🛰${fonte} ${frase(a)}${idade}
      · <a href="${mapa(a)}" target="_blank" rel="noopener" style="color:inherit;text-decoration:underline;">mapa</a></div>`;
  };

  // Frota da EXPEDICAO = placas do cadastro (TMS_PLACAS, que o cadastros.js
  // mantem em dia) + quem tem viagem carregada no TMS. As plataformas trazem
  // tambem onibus de funcionarios, carros e motos (a Sat sozinha tem ~27):
  // eles vao para "Outros veiculos", recolhido, e nao entram na contagem.
  const LETRA_MERCOSUL = "ABCDEFGHIJ";
  const mercosul = (p) => {
    const x = String(p || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    return /^[A-Z]{3}\d{4}$/.test(x) ? x.slice(0, 4) + LETRA_MERCOSUL[Number(x[4])] + x.slice(5) : x;
  };
  window.rastreadorEhExpedicao = function (placa, viagens) {
    const base = (typeof TMS_PLACAS !== "undefined" && Array.isArray(TMS_PLACAS)) ? TMS_PLACAS : [];
    const set = new Set(base.map(mercosul));
    (viagens || []).forEach((v) => { if (v && v.placa) set.add(mercosul(v.placa)); });
    // Sem cadastro carregado (tela ainda abrindo): mostra tudo, nao esconde.
    return !set.size || set.has(mercosul(placa));
  };

  let ultimo = null;
  function render(d) {
    const sec = document.getElementById("tmsFrota");
    const corpo = document.getElementById("tmsFrotaCorpo");
    if (!sec || !corpo) return;
    if (!d || !d.configurado) { sec.style.display = "none"; return; }
    sec.style.display = "";
    const sub = document.getElementById("tmsFrotaSub");
    const todos = d.aparelhos || [];
    const viagensTms = (typeof tmsState !== "undefined" && tmsState && tmsState.viagens) || [];
    const lista = todos.filter((a) => window.rastreadorEhExpedicao(a.placa, viagensTms));
    const outros = todos.filter((a) => !lista.includes(a));
    const n = (e) => lista.filter((a) => a.estado === e).length;
    if (sub) {
      const quando = d.ultima_coleta ? new Date(d.ultima_coleta).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }) : "—";
      // A plataforma SRF engasga de vez em quando (uma consulta passa de 30 s
      // e e abortada) e o servidor guarda o erro ate a PROXIMA coleta boa.
      // Uma falha isolada nao muda nada na tela (as posicoes sao da coleta de
      // um minuto atras), entao so avisa quando a ultima coleta boa ficou
      // velha de verdade — e em portugues, dizendo desde quando.
      const idadeMin = d.ultima_coleta ? (Date.now() - new Date(d.ultima_coleta).getTime()) / 60000 : Infinity;
      const aviso = d.erro && idadeMin > 3
        ? ` · <span style="color:#d97706;" title="${esc(d.erro)}">⚠ rastreador sem resposta${Number.isFinite(idadeMin) ? ` há ${Math.round(idadeMin)} min — posições podem estar atrasadas` : ""}</span>`
        : "";
      // 2a fonte (T4S): login assistido — quando expira, so quem refaz o login
      // (com o captcha) resolve; o SRF segue sozinho enquanto isso.
      const t = d.t4s || {};
      const avisoT4s = t.configurado && t.sessao_expirada
        ? ` · <span style="color:#d97706;" title="${esc(t.erro || "")}">⚠ T4S: login vencido (posições do T4S paradas)</span> <button type="button" class="btn-ghost btn-sm admin-only-action" style="padding:2px 8px;" onclick="rastreadorReconectarT4s()">🔑 Reconectar T4S</button>`
        : t.configurado && t.erro
          ? ` · <span style="color:var(--text-muted);" title="${esc(t.erro)}">T4S sem resposta</span>`
          : "";
      // 3a fonte (Sat): mesmo esquema do T4S.
      const sa = d.sat || {};
      const avisoSat = sa.configurado && sa.sessao_expirada
        ? ` · <span style="color:#d97706;" title="${esc(sa.erro || "")}">⚠ Sat: login vencido (posições da Sat paradas)</span> <button type="button" class="btn-ghost btn-sm admin-only-action" style="padding:2px 8px;" onclick="rastreadorReconectar('sat')">🔑 Reconectar Sat</button>`
        : sa.configurado && sa.erro
          ? ` · <span style="color:var(--text-muted);" title="${esc(sa.erro)}">Sat sem resposta</span>`
          : "";
      const nT4s = lista.filter((a) => a.fonte === "t4s").length;
      const nSat = lista.filter((a) => a.fonte === "sat").length;
      const fontes = (nT4s ? ` · ${nT4s} pelo T4S` : "") + (nSat ? ` · ${nSat} pela Sat` : "");
      sub.innerHTML = `${n("movendo")} em movimento · ${n("parado")} parado(s) · ${n("sem_sinal")} sem sinal${fontes} · atualizado ${esc(quando)}${aviso}${avisoT4s}${avisoSat}`;
    }
    // Viagem de hoje por placa (do que o TMS ja carregou)
    const viagens = (typeof tmsState !== "undefined" && tmsState && tmsState.viagens) || [];
    const porPlaca = new Map();
    viagens.forEach((v) => { if (v.rastreador) porPlaca.set(v.rastreador.placa, v); });
    const ordem = { movendo: 0, parado: 1, sem_sinal: 2 };
    const ordenar = (l) => [...l].sort((a, b) => (ordem[a.estado] - ordem[b.estado]) || String(a.placa).localeCompare(String(b.placa)));
    const linha = (a) => {
      const v = porPlaca.get(a.placa);
      const cor = COR[a.estado] || COR.sem_sinal;
      return `<div style="display:flex;align-items:center;gap:10px;padding:7px 0;border-top:1px solid var(--border);font-size:12.5px;">
        <span style="width:9px;height:9px;border-radius:50%;background:${cor};flex:none;"></span>
        <b style="min-width:150px;">${esc(a.nome)}</b>
        <span style="flex:1;color:${a.estado === "sem_sinal" ? "var(--text-muted)" : "var(--text-heading)"};">${frase(a)}</span>
        ${a.fonte && a.fonte !== "srf" ? `<span title="Posição vinda do rastreador ${String(a.fonte).toUpperCase()} (o sinal mais recente desta placa)" style="font-size:10px;font-weight:700;color:var(--text-muted);border:1px solid var(--border);border-radius:999px;padding:1px 7px;white-space:nowrap;">${esc(String(a.fonte).toUpperCase())}</span>` : ""}
        ${v ? `<span style="color:var(--text-muted);white-space:nowrap;">${esc(v.rota_nome || "")} · ${esc(v.motorista_nome || "")}</span>` : ""}
        <a href="${mapa(a)}" target="_blank" rel="noopener" class="btn-ghost btn-sm" style="text-decoration:none;">mapa</a>
      </div>`;
    };
    const linhas = ordenar(lista).map(linha).join("");
    // O <details> lembra se estava aberto entre as atualizacoes de 60 s.
    const abertoAntes = !!(corpo.querySelector("#rastOutros") || {}).open;
    const blocoOutros = outros.length
      ? `<details id="rastOutros" style="margin-top:8px;"${abertoAntes ? " open" : ""}><summary style="cursor:pointer;font-size:12px;color:var(--text-muted);">Outros veículos nas plataformas (${outros.length}) — ônibus, carros e motos fora da expedição</summary>${ordenar(outros).map(linha).join("")}</details>`
      : "";
    corpo.innerHTML = todos.length ? linhas + blocoOutros : `<p style="color:var(--text-muted);">Nenhum aparelho ainda (primeira coleta em andamento).</p>`;
  }

  async function atualizar() {
    try {
      const r = await fetch(`${window.location.origin}/tms/rastreador/posicoes`, { headers: { Accept: "application/json" } });
      if (!r.ok) { render(null); return; } // servidor sem a rota (antes do restart) ou sem permissao
      ultimo = await r.json();
      render(ultimo);
    } catch (_) { /* rede: tenta no proximo ciclo */ }
  }
  window.rastreadorAtualizar = atualizar;

  // ⏪ ADM: completa chegada/saida/hotel/retorno das viagens antigas pelo
  // historico. 1) previa 2) confirma vendo o resumo 3) grava (so vazio).
  window.rastreadorCompletarDias = async function () {
    const btn = document.getElementById("rastreadorCompletarBtn");
    const avisar = (m) => (typeof window.alertar === "function" ? window.alertar(m) : alert(m));
    const confirmar = (m, o) => (typeof window.confirmarBonito === "function" ? window.confirmarBonito(m, o) : Promise.resolve(window.confirm(m)));
    const url = `${window.location.origin}/tms/rastreador/completar`;
    const rodar = async (gravar, rotulo) => {
      const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ dias: 45, gravar }) });
      if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || `HTTP ${r.status}`); }
      if (btn) { btn.disabled = true; btn.textContent = rotulo; }
      for (;;) {
        await new Promise((ok) => setTimeout(ok, 4000));
        const s = await (await fetch(url, { headers: { Accept: "application/json" } })).json();
        if (!s.rodando) { if (s.erro) throw new Error(s.erro); return s; }
      }
    };
    const fim = () => { if (btn) { btn.disabled = false; btn.textContent = "⏪ Completar dias"; } };
    try {
      const s = await rodar(false, "⏪ Lendo o histórico…");
      fim();
      const plano = s.plano || [];
      const com = plano.filter((p) => p.preencher && Object.keys(p.preencher).length);
      if (!com.length) { avisar(`Nada para preencher: ${plano.length} viagem(ns) sem horário, nenhuma com prova no rastreador.`); return; }
      const conta = (k) => com.filter((p) => p.preencher[k]).length;
      const motivos = {};
      plano.filter((p) => !(p.preencher && Object.keys(p.preencher).length)).forEach((p) => { motivos[p.motivo] = (motivos[p.motivo] || 0) + 1; });
      const linhas = com.slice(0, 12).map((p) => `• ${p.data.split("-").reverse().slice(0, 2).join("/")} ${p.rota || ""} (${p.placa}): ${Object.entries(p.preencher).map(([k, v]) => `${{ chegada: "chegou", saida: "saiu", hotel_chegada: "hotel", hotel_saida: "saiu do hotel", retorno: "voltou" }[k]} ${v}`).join(", ")}`);
      const msg = `🛰 O rastreador consegue preencher ${com.length} de ${plano.length} viagens sem horário:\n` +
        `chegada ${conta("chegada")} · saída ${conta("saida")} · hotel ${conta("hotel_saida")} · retorno ${conta("retorno")}\n\n` +
        linhas.join("\n") + (com.length > 12 ? `\n… e mais ${com.length - 12}` : "") +
        `\n\nFicam para você:\n${Object.entries(motivos).map(([m, n]) => `• ${n} × ${m}`).join("\n") || "—"}` +
        `\n\nSó preenche o que está vazio (nada que alguém lançou é trocado). Gravar agora?`;
      if (!(await confirmar(msg, { okLabel: "Gravar", cancelLabel: "Agora não" }))) return;
      const g = await rodar(true, "⏪ Gravando…");
      fim();
      const ap = g.aplicado || [];
      const comErro = ap.filter((x) => Object.keys(x.erros || {}).length);
      avisar(`⏪ ${ap.length - comErro.length} viagem(ns) completadas pelo rastreador.${comErro.length ? ` ${comErro.length} com erro: ${comErro.slice(0, 3).map((x) => `${x.rota} ${x.data} (${Object.values(x.erros)[0]})`).join("; ")}` : ""}`);
      if (typeof tmsCarregarViagens === "function") tmsCarregarViagens();
    } catch (err) {
      fim();
      avisar(`Completar dias falhou: ${err.message}`);
    }
  };

  // 🧭 ADM: aprende as coordenadas das lojas (POST, roda em segundo plano no
  // servidor) e acompanha ate terminar.
  window.rastreadorAprenderLojas = async function () {
    const btn = document.getElementById("rastreadorAprenderBtn");
    const avisar = (m) => (typeof window.alertar === "function" ? window.alertar(m) : alert(m));
    try {
      const r = await fetch(`${window.location.origin}/tms/rastreador/aprender-lojas`, {
        method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ dias: 90 }),
      });
      if (!r.ok && r.status !== 409) { const j = await r.json().catch(() => ({})); avisar(`Não consegui iniciar: ${j.error || r.status}`); return; }
    } catch (err) { avisar(`Não consegui iniciar: ${err.message}`); return; }
    if (btn) { btn.disabled = true; btn.textContent = "🧭 Aprendendo…"; }
    const acompanhar = async () => {
      try {
        const s = await (await fetch(`${window.location.origin}/tms/rastreador/aprender-lojas`, { headers: { Accept: "application/json" } })).json();
        if (s.rodando) {
          if (btn && s.log && s.log.length) btn.title = s.log[s.log.length - 1];
          setTimeout(acompanhar, 5000);
          return;
        }
        if (btn) { btn.disabled = false; btn.textContent = "🧭 Aprender lojas"; }
        if (s.erro) { avisar(`Aprender lojas falhou: ${s.erro}`); return; }
        const r = s.resultado || {};
        avisar(`🧭 ${r.lojas_com_coordenada} de ${r.lojas_cadastro} lojas localizadas pelo rastreador.${r.para_revisar && r.para_revisar.length ? ` Sem certeza (não gravadas): ${r.para_revisar.join(", ")}.` : ""}`);
        atualizar();
      } catch (_) { setTimeout(acompanhar, 10000); }
    };
    setTimeout(acompanhar, 3000);
  };
  window.rastreadorRedesenhar = () => render(ultimo);

  // 🔑 Reconectar T4S: o login do T4S tem captcha, entao so uma pessoa refaz.
  // Aqui ela cola os cookies do navegador e o servidor testa e adota na hora
  // (POST /tms/rastreador/t4s-reconectar) — sem terminal, sem restart.
  // z-index 990: o alertar() do app vive em 1000+ e tem de abrir POR CIMA.
  const PLATAFORMAS = {
    t4s: {
      nome: "T4S", url: "https://rastreamento.t4stecnologia.com.br", host: "rastreamento.t4stecnologia.com.br", lembrar: "Remember",
      cookies: "<b>.ASPXAUTH</b> e <b>u_token</b>", exemplo: ".ASPXAUTH=627E58...; u_token=aw0i5h...", rota: "t4s-reconectar", item: "caminhão(ões)",
    },
    sat: {
      nome: "Sat", url: "https://satfleet.satcompany.app", host: "satfleet.satcompany.app", lembrar: "lembrar de mim",
      cookies: "<b>remember_user_token</b> e <b>_session_id</b>", exemplo: "remember_user_token=BAhb...; _session_id=20c9b7...", rota: "sat-reconectar", item: "veículo(s)",
    },
  };
  window.rastreadorReconectarT4s = () => window.rastreadorReconectar("t4s");
  window.rastreadorReconectar = function (qual) {
    const P = PLATAFORMAS[qual] || PLATAFORMAS.t4s;
    document.getElementById("rastT4sModal")?.remove();
    const fundo = document.createElement("div");
    fundo.id = "rastT4sModal";
    fundo.style.cssText = "position:fixed;inset:0;z-index:990;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;padding:16px;";
    fundo.innerHTML = `
      <div style="background:var(--bg-card,#1f2937);color:var(--text-primary,inherit);border:1px solid var(--border);border-radius:12px;max-width:560px;width:100%;padding:18px 20px;max-height:90vh;overflow:auto;">
        <h3 style="margin:0 0 8px;">🔑 Reconectar ${P.nome}</h3>
        <ol style="margin:0 0 10px 18px;padding:0;font-size:13px;line-height:1.55;color:var(--text-secondary);">
          <li>Abra <a href="${P.url}" target="_blank" rel="noopener">${P.host}</a> e faça login <b>marcando “${P.lembrar}”</b> (o login dura mais).</li>
          <li>Aperte <b>F12</b> → <b>Application</b> (Aplicativo) → <b>Cookies</b> → ${P.host}.</li>
          <li>Selecione as linhas ${P.cookies}, copie e cole abaixo (pode colar a linha inteira, só os valores ou o “Copy as cURL”).</li>
        </ol>
        <textarea id="rastT4sTexto" rows="5" style="width:100%;font-family:monospace;font-size:12px;" placeholder="${P.exemplo}"></textarea>
        <div id="rastT4sMsg" style="font-size:12.5px;min-height:18px;margin:6px 0;"></div>
        <div style="display:flex;gap:8px;justify-content:flex-end;">
          <button type="button" class="btn-ghost btn-sm" id="rastT4sCancelar">Cancelar</button>
          <button type="button" class="btn-green btn-sm" id="rastT4sSalvar">Testar e conectar</button>
        </div>
      </div>`;
    document.body.appendChild(fundo);
    const fechar = () => fundo.remove();
    fundo.addEventListener("click", (e) => { if (e.target === fundo) fechar(); });
    fundo.querySelector("#rastT4sCancelar").onclick = fechar;
    const msg = fundo.querySelector("#rastT4sMsg");
    const btn = fundo.querySelector("#rastT4sSalvar");
    btn.onclick = async () => {
      const texto = fundo.querySelector("#rastT4sTexto").value.trim();
      if (!texto) { msg.style.color = "#d97706"; msg.textContent = "Cole os cookies primeiro."; return; }
      btn.disabled = true; msg.style.color = "var(--text-muted)"; msg.textContent = `Testando na ${P.nome}...`;
      try {
        const r = await fetch(`${window.location.origin}/tms/rastreador/${P.rota}`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cookie: texto }),
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) {
          throw new Error(d.error || (r.status === 404 ? "O servidor ainda não foi reiniciado com esta função." : `HTTP ${r.status}`));
        }
        fechar();
        const avisar = (m) => (typeof window.alertar === "function" ? window.alertar(m) : alert(m));
        avisar(`✅ ${P.nome} reconectado — ${d.aparelhos} ${P.item} com posição. Em até 1 minuto o aviso some.`);
        setTimeout(atualizar, 65000);
      } catch (err) {
        btn.disabled = false; msg.style.color = "#dc2626"; msg.textContent = err.message;
      }
    };
    setTimeout(() => fundo.querySelector("#rastT4sTexto").focus(), 50);
  };

  setInterval(() => {
    const aba = document.getElementById("aba-tms");
    if (aba && aba.offsetParent !== null) atualizar();
  }, 60000);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => setTimeout(atualizar, 1500));
  else setTimeout(atualizar, 1500);
})();
