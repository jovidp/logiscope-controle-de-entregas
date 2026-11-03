// ================================================================
// erros-loja.js — Importação de CSV "Registro de Ocorrências
// Operacionais" (erros de loja) para a tabela ocorrencias_operacionais.
//
// Fluxo:
//   1) Usuário escolhe um .CSV -> lê (detecta UTF-8/ANSI) e faz parse
//      (separador ";", respeita aspas e campos com várias linhas).
//   2) Mapeia o cabeçalho para campos canônicos e mostra uma prévia.
//   3) Botão "Importar" -> POST /ocorrencias-operacionais/importar (em lotes).
//   4) A lista abaixo carrega de /ocorrencias-operacionais com filtros locais.
//
// Reusa globais: API_URL, alertar, confirmar, escapar, $.
// ================================================================

// Cabeçalho do CSV (normalizado) -> campo canônico.
const ERROS_LOJA_MAP_CABECALHO = {
  "id": "id_externo",
  "data de registro tratada": "data_registro",
  "data de registro": "data_registro",
  "data da ocorrencia tratada": "data_ocorrencia",
  "data da ocorrencia": "data_ocorrencia",
  "mes ano": "mes_ano",
  "semana": "semana",
  "dias ate registro": "dias_ate_registro",
  "responsavel pelo registro": "responsavel",
  "responsavel": "responsavel",
  "area da ocorrencia": "area",
  "area": "area",
  "tipos de ocorrencias": "tipo",
  "tipos de ocorrencia": "tipo",
  "tipo de ocorrencia": "tipo",
  "macro falhas": "macro_falha",
  "macro falha": "macro_falha",
  "6m ishikawa": "ishikawa",
  "ishikawa": "ishikawa",
  "motorista": "motorista",
  "ajudantes": "ajudantes",
  "ajudantes 2": "ajudantes2",
  "colaborador": "colaborador",
  "rota": "rota",
  "loja": "loja",
  "fornecedor": "fornecedor",
  "tempo de atraso": "tempo_atraso",
  "impacto na operacao": "impacto",
  "impacto": "impacto",
  "divergencia": "divergencia",
  "retrabalho": "retrabalho",
  "observacao": "observacao",
  "classificacao do erro": "classificacao_erro",
  "classificacao": "classificacao_erro",
  "gravidade da ocorrencia": "gravidade",
  "gravidade": "gravidade",
  "atraso estimado min": "atraso_estimado_min",
  "origem do erro": "origem_erro",
  "origem": "origem_erro",
};

// Ordem e rótulo das colunas mostradas na tabela de registros.
const ERROS_LOJA_COLUNAS = [
  ["id_externo", "ID"],
  ["data_ocorrencia", "Data Ocorr."],
  ["mes_ano", "Mês/Ano"],
  ["area", "Área"],
  ["tipo", "Tipo"],
  ["macro_falha", "Macro Falha"],
  ["motorista", "Motorista"],
  ["loja", "Loja"],
  ["rota", "Rota"],
  ["gravidade", "Gravidade"],
  ["origem_erro", "Origem"],
  ["atraso_estimado_min", "Atraso (min)"],
  ["observacao", "Observação"],
];

let errosLojaDados = []; // registros vindos do banco
let errosLojaParaImportar = null; // itens prontos para POST (após escolher arquivo)

// ---------------- helpers ----------------
function errosLojaNormCab(h) {
  return String(h || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9/ ]/g, " ")
    .replace(/\//g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// "26/02/2026 10:33" -> "2026-02-26 10:33" ; "03/02/2026" -> "2026-02-03"
function errosLojaBrParaIso(s, comHora) {
  const t = String(s || "").trim();
  if (!t) return null;
  const m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:[ T](\d{1,2}):(\d{2}))?/);
  if (!m) return null;
  let [, d, mo, y, h, mi] = m;
  if (y.length === 2) y = "20" + y;
  const base = `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
  if (comHora && h !== undefined) return `${base} ${h.padStart(2, "0")}:${mi}`;
  return base;
}

// Lê o File detectando codificação (UTF-8 com fallback p/ ANSI/Windows-1252).
function errosLojaLerArquivo(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const buf = new Uint8Array(reader.result);
        let texto;
        // BOM UTF-8
        if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
          texto = new TextDecoder("utf-8").decode(buf.subarray(3));
        } else {
          texto = new TextDecoder("utf-8", { fatal: false }).decode(buf);
          if (texto.includes("�")) {
            // veio quebrado em UTF-8 -> tenta ANSI (Excel no Windows)
            texto = new TextDecoder("windows-1252").decode(buf);
          }
        }
        resolve(texto);
      } catch (e) {
        reject(e);
      }
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(file);
  });
}

// Parser de CSV (separador ";") com aspas e campos multilinha.
function errosLojaParseCsv(texto, sep) {
  sep = sep || ";";
  const linhas = [];
  let linha = [];
  let campo = "";
  let aspas = false;
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (aspas) {
      if (c === '"') {
        if (texto[i + 1] === '"') {
          campo += '"';
          i++;
        } else {
          aspas = false;
        }
      } else {
        campo += c;
      }
    } else if (c === '"') {
      aspas = true;
    } else if (c === sep) {
      linha.push(campo);
      campo = "";
    } else if (c === "\r") {
      // ignora
    } else if (c === "\n") {
      linha.push(campo);
      linhas.push(linha);
      linha = [];
      campo = "";
    } else {
      campo += c;
    }
  }
  if (campo !== "" || linha.length > 0) {
    linha.push(campo);
    linhas.push(linha);
  }
  return linhas;
}

// Transforma a matriz do CSV em itens canônicos prontos para o servidor.
function errosLojaMapear(matriz) {
  // descarta linhas totalmente vazias
  const linhas = matriz.filter(
    (l) => l && l.some((c) => String(c).trim() !== "")
  );
  if (linhas.length < 2) return { itens: [], reconhecidas: [], ignoradas: [] };

  const cabecalho = linhas[0];
  const reconhecidas = [];
  const ignoradas = [];
  const idxParaCampo = {}; // índice da coluna -> campo canônico

  cabecalho.forEach((bruto, idx) => {
    const norm = errosLojaNormCab(bruto);
    const campo = ERROS_LOJA_MAP_CABECALHO[norm];
    if (campo) {
      idxParaCampo[idx] = campo;
      reconhecidas.push(String(bruto).trim());
    } else if (String(bruto).trim() !== "") {
      ignoradas.push(String(bruto).trim());
    }
  });

  const itens = linhas.slice(1).map((cols) => {
    const bruto = {};
    Object.entries(idxParaCampo).forEach(([idx, campo]) => {
      bruto[campo] = (cols[idx] !== undefined ? String(cols[idx]) : "").replace(/\s+/g, " ").trim();
    });
    return {
      id_externo: bruto.id_externo || null,
      data_registro: errosLojaBrParaIso(bruto.data_registro, true),
      data_ocorrencia: errosLojaBrParaIso(bruto.data_ocorrencia, false),
      mes_ano: bruto.mes_ano || null,
      semana: bruto.semana || null,
      dias_ate_registro: bruto.dias_ate_registro || null,
      responsavel: bruto.responsavel || null,
      area: bruto.area || null,
      tipo: bruto.tipo || null,
      macro_falha: bruto.macro_falha || null,
      ishikawa: bruto.ishikawa || null,
      motorista: bruto.motorista || null,
      ajudantes: bruto.ajudantes || null,
      ajudantes2: bruto.ajudantes2 || null,
      colaborador: bruto.colaborador || null,
      rota: bruto.rota || null,
      loja: bruto.loja || null,
      fornecedor: bruto.fornecedor || null,
      tempo_atraso: bruto.tempo_atraso || null,
      impacto: bruto.impacto || null,
      divergencia: bruto.divergencia || null,
      retrabalho: bruto.retrabalho || null,
      observacao: bruto.observacao || null,
      classificacao_erro: bruto.classificacao_erro || null,
      gravidade: bruto.gravidade || null,
      atraso_estimado_min: bruto.atraso_estimado_min || null,
      origem_erro: bruto.origem_erro || null,
    };
  });

  // mantém apenas itens com algum conteúdo
  const itensValidos = itens.filter(
    (it) => it.id_externo || it.observacao || it.loja || it.tipo || it.data_ocorrencia || it.motorista
  );

  return { itens: itensValidos, reconhecidas, ignoradas };
}

// ---------------- escolha do arquivo + prévia ----------------
async function errosLojaArquivoSelecionado(file) {
  const alvo = $("errosLojaPreview");
  errosLojaParaImportar = null;
  if (!file) return;
  if (alvo) alvo.innerHTML = `<p style="color:var(--text-muted);">⏳ Lendo "${escapar(file.name)}"...</p>`;

  let texto;
  try {
    texto = await errosLojaLerArquivo(file);
  } catch (e) {
    if (alvo) alvo.innerHTML = `<p style="color:#f87171;">Não consegui ler o arquivo: ${escapar(e.message || e)}</p>`;
    return;
  }

  const matriz = errosLojaParseCsv(texto, ";");
  const { itens, reconhecidas, ignoradas } = errosLojaMapear(matriz);

  if (!itens.length) {
    if (alvo)
      alvo.innerHTML =
        `<p style="color:#f87171;">Nenhuma linha válida encontrada. ` +
        `Confira se o separador é ";" e se o cabeçalho está na primeira linha.</p>`;
    return;
  }

  errosLojaParaImportar = { nome: file.name, itens };

  // Prévia: primeiras 12 linhas
  const amostra = itens.slice(0, 12);
  const cab = ERROS_LOJA_COLUNAS.map(([, rot]) => `<th style="${errosLojaTh()}">${escapar(rot)}</th>`).join("");
  const corpo = amostra
    .map((it) => `<tr>${ERROS_LOJA_COLUNAS.map(([k]) => errosLojaCelula(it, k)).join("")}</tr>`)
    .join("");

  const avisoIgnoradas = ignoradas.length
    ? `<div style="margin-top:8px;font-size:12px;color:#fbbf24;">⚠️ Colunas não reconhecidas (serão ignoradas): ${escapar(ignoradas.join(", "))}</div>`
    : "";

  alvo.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:10px;">
      <div style="font-size:13px;color:var(--text-heading);">
        <b>${itens.length}</b> linha(s) prontas em <b>${escapar(file.name)}</b> ·
        <span style="color:var(--text-muted);">${reconhecidas.length} coluna(s) reconhecida(s)</span>
      </div>
      <button class="btn-blue" id="errosLojaBtnImportar" onclick="errosLojaImportar()" style="font-size:13px;padding:9px 18px;">⬆ Importar ${itens.length} registro(s)</button>
    </div>
    ${avisoIgnoradas}
    <div style="font-size:12px;color:var(--text-muted);margin:6px 0;">Prévia (12 primeiras linhas):</div>
    <div style="overflow-x:auto;border:1px solid var(--border);border-radius:10px;">
      <table data-ordenavel style="width:100%;border-collapse:collapse;font-size:12px;">
        <thead><tr>${cab}</tr></thead>
        <tbody>${corpo}</tbody>
      </table>
    </div>
  `;
}

function errosLojaTh() {
  return "text-align:left;padding:8px 10px;background:var(--bg-base);color:var(--text-muted);font-size:11px;text-transform:uppercase;letter-spacing:.4px;white-space:nowrap;border-bottom:1px solid var(--border);position:sticky;top:0;";
}

function errosLojaCelula(it, campo) {
  let v = it[campo];
  if (campo === "data_ocorrencia") v = it.data_ocorrencia_fmt || it.data_ocorrencia || "";
  if (campo === "observacao") {
    const txt = String(v || "");
    const curto = txt.length > 60 ? txt.slice(0, 60) + "…" : txt;
    return `<td style="padding:7px 10px;border-bottom:1px solid var(--border);max-width:320px;" title="${escapar(txt)}">${escapar(curto)}</td>`;
  }
  let style = "padding:7px 10px;border-bottom:1px solid var(--border);white-space:nowrap;";
  if (campo === "gravidade") style += `font-weight:700;color:${errosLojaCorGravidade(v)};`;
  if (campo === "origem_erro") style += `color:${errosLojaCorOrigem(v)};`;
  return `<td style="${style}">${escapar(v == null ? "" : v)}</td>`;
}

function errosLojaCorGravidade(g) {
  const t = String(g || "").toLowerCase();
  if (t.includes("alta")) return "#f87171";
  if (t.includes("med") || t.includes("méd")) return "#fbbf24";
  if (t.includes("baix")) return "#4ade80";
  return "var(--text-heading)";
}
function errosLojaCorOrigem(o) {
  const t = String(o || "").toLowerCase();
  if (t.startsWith("interno")) return "#fb923c";
  if (t.startsWith("externo")) return "#38bdf8";
  return "var(--text-heading)";
}

// ---------------- importar ----------------
async function errosLojaImportar() {
  if (!errosLojaParaImportar || !errosLojaParaImportar.itens.length) {
    alertar("Escolha um arquivo CSV primeiro.");
    return;
  }
  const btn = $("errosLojaBtnImportar");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Importando...";
  }

  const itens = errosLojaParaImportar.itens;
  const LOTE = 500;
  let inseridos = 0;
  let atualizados = 0;
  let ignorados = 0;
  try {
    for (let i = 0; i < itens.length; i += LOTE) {
      const lote = itens.slice(i, i + LOTE);
      const resp = await fetch(`${API_URL}/ocorrencias-operacionais/importar`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itens: lote }),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data.error || data.detalhe || `Erro ${resp.status}`);
      inseridos += data.inseridos || 0;
      atualizados += data.atualizados || 0;
      ignorados += data.ignorados || 0;
      if (btn) btn.textContent = `Importando... ${Math.min(i + LOTE, itens.length)}/${itens.length}`;
    }
  } catch (e) {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "⬆ Tentar novamente";
    }
    alertar("Falha ao importar: " + (e.message || e));
    return;
  }

  errosLojaParaImportar = null;
  const arq = $("errosLojaArquivo");
  if (arq) arq.value = "";
  const prev = $("errosLojaPreview");
  if (prev)
    prev.innerHTML = `<p style="color:#4ade80;font-size:13px;">✅ Importação concluída — ${inseridos} novo(s), ${atualizados} atualizado(s)${ignorados ? `, ${ignorados} ignorado(s)` : ""}.</p>`;
  await errosLojaInit();
}

// ---------------- listar / filtros ----------------
async function errosLojaInit() {
  const tabela = $("errosLojaTabela");
  if (tabela) tabela.innerHTML = `<p style="color:var(--text-muted);text-align:center;padding:24px;">Carregando...</p>`;
  try {
    const resp = await fetch(`${API_URL}/ocorrencias-operacionais?limite=10000`);
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || `Erro ${resp.status}`);
    errosLojaDados = Array.isArray(data.registros) ? data.registros : [];
    errosLojaPopularFiltros();
    errosLojaAplicarFiltro();
  } catch (e) {
    if (tabela) tabela.innerHTML = `<p style="color:#f87171;text-align:center;padding:24px;">Erro ao carregar: ${escapar(e.message || e)}</p>`;
  }
}

function errosLojaPopularFiltros() {
  const def = [
    ["errosLojaFiltroMes", "mes_ano", "Mês/Ano"],
    ["errosLojaFiltroArea", "area", "Área"],
    ["errosLojaFiltroGravidade", "gravidade", "Gravidade"],
    ["errosLojaFiltroOrigem", "origem_erro", "Origem"],
  ];
  def.forEach(([id, campo, rotulo]) => {
    const sel = $(id);
    if (!sel) return;
    const atual = sel.value;
    const valores = [...new Set(errosLojaDados.map((r) => r[campo]).filter((v) => v != null && v !== ""))].sort();
    sel.innerHTML =
      `<option value="">${rotulo}</option>` +
      valores.map((v) => `<option value="${escapar(v)}">${escapar(v)}</option>`).join("");
    if (valores.includes(atual)) sel.value = atual;
  });
}

function errosLojaAplicarFiltro() {
  const q = ($("errosLojaBusca")?.value || "").toLowerCase().trim();
  const fMes = $("errosLojaFiltroMes")?.value || "";
  const fArea = $("errosLojaFiltroArea")?.value || "";
  const fGrav = $("errosLojaFiltroGravidade")?.value || "";
  const fOrig = $("errosLojaFiltroOrigem")?.value || "";

  const filtrados = errosLojaDados.filter((r) => {
    if (fMes && r.mes_ano !== fMes) return false;
    if (fArea && r.area !== fArea) return false;
    if (fGrav && r.gravidade !== fGrav) return false;
    if (fOrig && r.origem_erro !== fOrig) return false;
    if (q) {
      const blob = [r.observacao, r.loja, r.motorista, r.rota, r.tipo, r.macro_falha]
        .map((x) => String(x || "").toLowerCase())
        .join(" ");
      if (!blob.includes(q)) return false;
    }
    return true;
  });

  errosLojaRenderCards(filtrados);
  errosLojaRenderTabela(filtrados);
}

function errosLojaRenderCards(lista) {
  const alvo = $("errosLojaCards");
  if (!alvo) return;
  const cont = (pred) => lista.filter(pred).length;
  const alta = cont((r) => String(r.gravidade || "").toLowerCase().includes("alta"));
  const interno = cont((r) => String(r.origem_erro || "").toLowerCase().startsWith("interno"));
  const externo = cont((r) => String(r.origem_erro || "").toLowerCase().startsWith("externo"));
  const cards = [
    ["Registros", lista.length, "var(--text-heading)"],
    ["Gravidade Alta", alta, "#f87171"],
    ["Origem Interna", interno, "#fb923c"],
    ["Origem Externa", externo, "#38bdf8"],
  ];
  alvo.innerHTML = cards
    .map(
      ([rot, val, cor]) => `
      <div style="flex:1;min-width:120px;background:var(--bg-base);border:1px solid var(--border);border-radius:12px;padding:10px 14px;">
        <div style="font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.5px;">${rot}</div>
        <div style="font-size:22px;font-weight:800;color:${cor};">${val}</div>
      </div>`
    )
    .join("");
}

function errosLojaRenderTabela(lista) {
  const alvo = $("errosLojaTabela");
  if (!alvo) return;
  const resumo = $("errosLojaResumo");
  if (resumo)
    resumo.textContent = `${lista.length} de ${errosLojaDados.length} registro(s).`;

  if (!lista.length) {
    alvo.innerHTML = `<p style="color:var(--text-muted);text-align:center;padding:24px;">Nenhum registro. Importe um CSV acima.</p>`;
    return;
  }

  const cab =
    ERROS_LOJA_COLUNAS.map(([, rot]) => `<th style="${errosLojaTh()}">${escapar(rot)}</th>`).join("") +
    `<th style="${errosLojaTh()}"></th>`;

  const corpo = lista
    .map((it) => {
      const celulas = ERROS_LOJA_COLUNAS.map(([k]) => errosLojaCelula(it, k)).join("");
      const acao = `<td style="padding:7px 10px;border-bottom:1px solid var(--border);white-space:nowrap;"><button class="btn-ghost btn-sm" title="Excluir" onclick="errosLojaExcluir(${it.id})" style="color:#f87171;padding:2px 8px;">🗑</button></td>`;
      return `<tr>${celulas}${acao}</tr>`;
    })
    .join("");

  alvo.innerHTML = `
    <table data-ordenavel style="width:100%;border-collapse:collapse;font-size:12px;">
      <thead><tr>${cab}</tr></thead>
      <tbody>${corpo}</tbody>
    </table>`;
}

// ---------------- excluir ----------------
function errosLojaExcluir(id) {
  confirmar("Excluir este registro de erro de loja?", async () => {
    try {
      const resp = await fetch(`${API_URL}/ocorrencias-operacionais/${id}`, { method: "DELETE" });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data.error || `Erro ${resp.status}`);
      errosLojaDados = errosLojaDados.filter((r) => r.id !== id);
      errosLojaPopularFiltros();
      errosLojaAplicarFiltro();
    } catch (e) {
      alertar("Falha ao excluir: " + (e.message || e));
    }
  });
}

function errosLojaLimparTudo() {
  if (!errosLojaDados.length) {
    alertar("Não há registros para limpar.");
    return;
  }
  confirmar(
    `Apagar TODOS os ${errosLojaDados.length} registros de erros de loja? Esta ação não pode ser desfeita.`,
    async () => {
      try {
        const resp = await fetch(`${API_URL}/ocorrencias-operacionais`, { method: "DELETE" });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error(data.error || `Erro ${resp.status}`);
        await errosLojaInit();
      } catch (e) {
        alertar("Falha ao limpar: " + (e.message || e));
      }
    }
  );
}

// ---------------- exportar ----------------
function errosLojaExportarCsv() {
  const q = ($("errosLojaBusca")?.value || "").toLowerCase().trim();
  const fMes = $("errosLojaFiltroMes")?.value || "";
  const fArea = $("errosLojaFiltroArea")?.value || "";
  const fGrav = $("errosLojaFiltroGravidade")?.value || "";
  const fOrig = $("errosLojaFiltroOrigem")?.value || "";
  const lista = errosLojaDados.filter((r) => {
    if (fMes && r.mes_ano !== fMes) return false;
    if (fArea && r.area !== fArea) return false;
    if (fGrav && r.gravidade !== fGrav) return false;
    if (fOrig && r.origem_erro !== fOrig) return false;
    if (q) {
      const blob = [r.observacao, r.loja, r.motorista, r.rota, r.tipo, r.macro_falha]
        .map((x) => String(x || "").toLowerCase())
        .join(" ");
      if (!blob.includes(q)) return false;
    }
    return true;
  });
  if (!lista.length) {
    alertar("Nada para exportar com os filtros atuais.");
    return;
  }

  const campos = [
    "id_externo", "data_registro_fmt", "data_ocorrencia_fmt", "mes_ano", "semana",
    "dias_ate_registro", "responsavel", "area", "tipo", "macro_falha", "ishikawa",
    "motorista", "ajudantes", "ajudantes2", "colaborador", "rota", "loja", "fornecedor",
    "tempo_atraso", "impacto", "divergencia", "retrabalho", "observacao",
    "classificacao_erro", "gravidade", "atraso_estimado_min", "origem_erro",
  ];
  const titulos = [
    "ID", "Data de Registro", "Data da Ocorrência", "Mês/Ano", "Semana",
    "Dias até Registro", "Responsável", "Área", "Tipo", "Macro Falha", "6M Ishikawa",
    "Motorista", "Ajudantes", "Ajudantes 2", "Colaborador", "Rota", "Loja", "Fornecedor",
    "Tempo de Atraso", "Impacto", "Divergência", "Retrabalho", "Observação",
    "Classificação do Erro", "Gravidade", "Atraso estimado (min)", "Origem do Erro",
  ];
  const esc = (v) => {
    const s = v == null ? "" : String(v);
    return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const linhas = [titulos.join(";")];
  lista.forEach((r) => linhas.push(campos.map((c) => esc(r[c])).join(";")));
  const conteudo = "﻿" + linhas.join("\r\n"); // BOM p/ Excel abrir acentos

  const blob = new Blob([conteudo], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `erros-loja-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
