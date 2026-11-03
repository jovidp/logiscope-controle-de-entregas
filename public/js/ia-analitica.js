// ================================================================
// IA Analitica - insights operacionais com dados agregados
// ================================================================
(function iniciarIaAnalitica() {
  let inicializado = false;
  let carregando = false;
  let ultimoPayload = null;

  const $ia = (id) => document.getElementById(id);

  function esc(valor) {
    return String(valor ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function num(valor) {
    const n = Number(valor);
    return Number.isFinite(n) ? n : 0;
  }

  async function api(path, options) {
    const resp = await fetch(path, {
      headers: { "Accept": "application/json", "Content-Type": "application/json", ...(options?.headers || {}) },
      ...(options || {}),
    });
    const texto = await resp.text().catch(() => "");
    let body = {};
    try {
      body = texto ? JSON.parse(texto) : {};
    } catch {
      body = {};
    }
    if (!resp.ok) {
      const detalhe = body.error || body.detalhe || texto.slice(0, 160).trim();
      throw new Error(detalhe || `Falha na IA analitica. HTTP ${resp.status}`);
    }
    return body;
  }

  function status(texto, tipo = "") {
    const el = $ia("iaStatus");
    if (!el) return;
    el.textContent = texto || "";
    el.className = `ia-status ${tipo}`.trim();
  }

  function renderKpis(ctx) {
    const r = ctx.resumo || {};
    const abertas = ctx.ocorrencias_abertas || {};
    const tms = ctx.tms_hoje || {};
    const kpis = [
      ["Entregas", r.total_entregas || 0, ctx.periodo_label],
      ["Atrasadas", r.entregas_atrasadas || 0, `${r.pct_no_prazo ?? "-"}% no prazo`],
      ["Ocorrencias abertas", abertas.total || 0, `${abertas.sem_responsavel || 0} sem responsavel`],
      ["Viagens hoje", tms.viagens || 0, `${tms.paradas_pendentes || 0} paradas pendentes`],
    ];
    const el = $ia("iaKpis");
    if (!el) return;
    el.innerHTML = kpis.map(([label, valor, sub]) => `
      <div class="ia-kpi">
        <span>${esc(label)}</span>
        <strong>${esc(valor)}</strong>
        <small>${esc(sub)}</small>
      </div>
    `).join("");
  }

  function markdownLeve(texto) {
    const linhas = String(texto || "").trim().split(/\r?\n/).filter(Boolean);
    if (!linhas.length) return "";
    return linhas.map((linha) => {
      const limpa = esc(linha.replace(/^\s*[-*]\s*/, ""));
      if (/^#{1,4}\s/.test(linha)) return `<h4>${esc(linha.replace(/^#{1,4}\s*/, ""))}</h4>`;
      if (/^\s*[-*]\s/.test(linha)) return `<p class="ia-bullet">${limpa}</p>`;
      return `<p>${limpa}</p>`;
    }).join("");
  }

  function rotuloProvedor(prov) {
    if (prov === "gemini") return "Gemini";
    if (prov === "openai") return "OpenAI";
    return "IA";
  }

  function renderInsights(payload) {
    const narrativa = $ia("iaNarrativa");
    const modo = $ia("iaModo");
    const insights = $ia("iaInsights");
    const acoes = $ia("iaAcoes");
    const ia = payload.analise_ia;

    if (modo) {
      modo.textContent = ia?.texto
        ? `${rotuloProvedor(payload.ia_provider)}: ${ia.modelo || "modelo configurado"}`
        : payload.ia_configurada
          ? "IA indisponivel, usando regras locais"
          : "Modo local";
    }
    if (narrativa) {
      if (ia?.texto) narrativa.innerHTML = markdownLeve(ia.texto);
      else if (payload.ia_erro) narrativa.innerHTML = `<p>${esc(payload.ia_erro)}</p>`;
      else narrativa.innerHTML = `<p>Configure OPENAI_API_KEY no .env para gerar uma narrativa com IA. Enquanto isso, os insights abaixo usam regras locais sobre os indicadores.</p>`;
    }
    if (insights) {
      insights.innerHTML = (payload.insights || []).map((i) => `
        <div class="ia-insight ${esc(i.nivel || "baixo")}">
          <strong>${esc(i.titulo)}</strong>
          <span>${esc(i.detalhe)}</span>
        </div>
      `).join("");
    }
    if (acoes) {
      acoes.innerHTML = (payload.acoes || []).map((a) => `<div class="ia-acao">${esc(a)}</div>`).join("");
    }
  }

  function tabelaRotas(lista) {
    return tabela(lista, ["rota", "entregas", "atrasadas", "ocorrencias"], {
      rota: "Rota",
      entregas: "Ent.",
      atrasadas: "Atr.",
      ocorrencias: "Oco.",
    });
  }

  function tabelaLojas(lista) {
    return tabela(lista, ["loja", "rota", "ocorrencias", "atrasadas"], {
      loja: "Loja",
      rota: "Rota",
      ocorrencias: "Oco.",
      atrasadas: "Atr.",
    });
  }

  function tabelaMotoristas(lista) {
    return tabela(lista, ["motorista", "ocorrencias", "atrasadas", "sem_checklist"], {
      motorista: "Motorista",
      ocorrencias: "Oco.",
      atrasadas: "Atr.",
      sem_checklist: "Sem check.",
    });
  }

  function tabela(lista, campos, titulos) {
    if (!Array.isArray(lista) || !lista.length) {
      return `<div class="ia-empty">Sem dados relevantes no periodo.</div>`;
    }
    return `
      <div class="ia-table-wrap">
        <table class="ia-table">
          <thead><tr>${campos.map((c) => `<th>${esc(titulos[c] || c)}</th>`).join("")}</tr></thead>
          <tbody>
            ${lista.map((row) => `
              <tr>
                ${campos.map((c) => `<td>${esc(row[c] ?? "-")}</td>`).join("")}
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
    `;
  }

  function renderRankings(ctx) {
    const rankings = ctx.rankings || {};
    const rotas = $ia("iaRankRotas");
    const lojas = $ia("iaRankLojas");
    const motoristas = $ia("iaRankMotoristas");
    if (rotas) rotas.innerHTML = tabelaRotas(rankings.rotas_criticas || []);
    if (lojas) lojas.innerHTML = tabelaLojas(rankings.lojas_criticas || []);
    if (motoristas) motoristas.innerHTML = tabelaMotoristas(rankings.motoristas_atencao || []);
  }

  function render(payload) {
    ultimoPayload = payload;
    const ctx = payload.contexto || {};
    renderKpis(ctx);
    renderInsights(payload);
    renderRankings(ctx);
    const erros = Array.isArray(ctx.erros) ? ctx.erros.length : 0;
    const total = num(ctx.resumo?.total_entregas);
    status(
      erros
        ? `Atualizado com ${erros} aviso(s) de consulta. Periodo: ${ctx.periodo_label || "-"}`
        : `Atualizado. Periodo: ${ctx.periodo_label || "-"}${total ? `, ${total} entrega(s).` : "."}`,
      erros ? "warn" : "ok",
    );
  }

  async function carregar() {
    if (carregando) return;
    carregando = true;
    status("Analisando indicadores...");
    try {
      const periodo = $ia("iaPeriodo")?.value || "semana";
      const payload = await api(`/ia/insights?periodo=${encodeURIComponent(periodo)}`);
      render(payload);
    } catch (err) {
      status(err.message, "erro");
    } finally {
      carregando = false;
    }
  }

  async function perguntar(event) {
    event.preventDefault();
    const input = $ia("iaPergunta");
    const resposta = $ia("iaResposta");
    const pergunta = input?.value.trim();
    if (!pergunta) return;
    if (resposta) resposta.innerHTML = `<div class="ia-empty">Consultando...</div>`;
    try {
      const periodo = $ia("iaPeriodo")?.value || ultimoPayload?.contexto?.periodo || "semana";
      const body = await api("/ia/perguntar", {
        method: "POST",
        body: JSON.stringify({ pergunta, periodo }),
      });
      if (resposta) {
        const origem = body.origem && body.origem !== "local"
          ? `${rotuloProvedor(body.origem)}${body.modelo ? `: ${body.modelo}` : ""}`
          : "Modo local";
        resposta.innerHTML = `<small>${esc(origem)}</small>${markdownLeve(body.resposta)}`;
      }
    } catch (err) {
      if (resposta) resposta.innerHTML = `<div class="ia-empty erro">${esc(err.message)}</div>`;
    }
  }

  function init() {
    if (inicializado) {
      if (!ultimoPayload) carregar();
      return;
    }
    inicializado = true;
    $ia("iaPeriodo")?.addEventListener("change", carregar);
    $ia("iaPerguntaForm")?.addEventListener("submit", perguntar);
    carregar();
  }

  window.iaAnaliticaInit = init;
  window.iaAnaliticaCarregar = carregar;
})();
