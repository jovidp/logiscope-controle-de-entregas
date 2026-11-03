// Importacao de pedidos por planilha: converte CSV/XLSX em linhas canonicas
// e envia ao endpoint que agrupa os pedidos em viagens/paradas.
(function () {
  "use strict";

  let itens = [];
  const MAX_ITENS = 5000;
  const ALIASES = {
    pedido_numero: ["pedido", "numero pedido", "numero do pedido", "pedido numero", "order"],
    data_viagem: ["data", "data entrega", "data viagem", "data_viagem", "entrega", "delivery date"],
    loja_nome: ["loja", "nome loja", "loja nome", "destino", "cliente", "store"],
    rota_nome: ["rota", "rota nome", "route"],
    motorista_nome: ["motorista", "entregador", "driver"],
    placa: ["placa", "veiculo", "veículo", "vehicle"],
    volumes: ["volumes", "volume", "quantidade", "qtd volumes", "qty"],
    nota_fiscal: ["nf", "nota", "nota fiscal", "nota_fiscal", "invoice"],
    hora_prevista: ["hora", "horario", "horário", "hora prevista", "hora_prevista", "delivery time"],
    observacao: ["observacao", "observação", "obs", "comentario", "comentário", "notes"],
  };

  function esc(v) {
    if (typeof window.escapar === "function") return window.escapar(v);
    return String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function chave(v) {
    return String(v == null ? "" : v).normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  }

  function csvMatriz(texto) {
    const linhas = [];
    let linha = [], campo = "", aspas = false;
    const separador = ((texto.split(/\r?\n/)[0] || "").match(/;/g) || []).length >
      ((texto.split(/\r?\n/)[0] || "").match(/,/g) || []).length ? ";" : ",";
    for (let i = 0; i < texto.length; i += 1) {
      const c = texto[i];
      if (c === '"') {
        if (aspas && texto[i + 1] === '"') { campo += '"'; i += 1; }
        else aspas = !aspas;
      } else if (c === separador && !aspas) {
        linha.push(campo); campo = "";
      } else if ((c === "\n" || c === "\r") && !aspas) {
        if (c === "\r" && texto[i + 1] === "\n") i += 1;
        linha.push(campo); campo = "";
        if (linha.some((v) => String(v).trim() !== "")) linhas.push(linha);
        linha = [];
      } else campo += c;
    }
    if (campo || linha.length) { linha.push(campo); if (linha.some((v) => String(v).trim() !== "")) linhas.push(linha); }
    return linhas;
  }

  function acharColunas(cabecalho) {
    const mapa = {};
    const chaves = cabecalho.map(chave);
    Object.entries(ALIASES).forEach(([campo, aliases]) => {
      const aceitas = aliases.map(chave);
      mapa[campo] = chaves.findIndex((h) => aceitas.includes(h));
    });
    return mapa;
  }

  function valor(row, mapa, campo) {
    const i = mapa[campo];
    return i == null || i < 0 ? "" : String(row[i] == null ? "" : row[i]).trim();
  }

  function matrizItens(matriz) {
    if (!matriz || matriz.length < 2) throw new Error("A planilha precisa ter cabeçalho e pelo menos uma linha.");
    const mapa = acharColunas(matriz[0]);
    if (mapa.data_viagem < 0 || mapa.loja_nome < 0) {
      throw new Error("A planilha precisa conter as colunas Data e Loja.");
    }
    return matriz.slice(1).map((row) => ({
      pedido_numero: valor(row, mapa, "pedido_numero"),
      data_viagem: valor(row, mapa, "data_viagem"),
      loja_nome: valor(row, mapa, "loja_nome"),
      rota_nome: valor(row, mapa, "rota_nome"),
      motorista_nome: valor(row, mapa, "motorista_nome"),
      placa: valor(row, mapa, "placa"),
      volumes: valor(row, mapa, "volumes"),
      nota_fiscal: valor(row, mapa, "nota_fiscal"),
      hora_prevista: valor(row, mapa, "hora_prevista"),
      observacao: valor(row, mapa, "observacao"),
    })).filter((item) => Object.values(item).some(Boolean));
  }

  async function arquivoMatriz(file) {
    const buffer = await file.arrayBuffer();
    const nome = String(file.name || "").toLowerCase();
    if (/\.xlsx?$/.test(nome)) {
      if (!window.XLSX) throw new Error("Leitor XLSX indisponível. Use CSV ou recarregue a página.");
      const wb = window.XLSX.read(buffer, { type: "array", cellDates: false, raw: false });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      return window.XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "", raw: false });
    }
    let texto = new TextDecoder("utf-8").decode(buffer).replace(/^\uFEFF/, "");
    if (texto.includes("�")) texto = new TextDecoder("windows-1252").decode(buffer);
    return csvMatriz(texto.replace(/^\uFEFF/, ""));
  }

  function mostrarPreview() {
    const el = document.getElementById("tmsPedidosPreview");
    const btn = document.getElementById("tmsBtnImportarPedidos");
    if (!el || !btn) return;
    btn.disabled = !itens.length;
    if (!itens.length) { el.innerHTML = ""; return; }
    const validos = itens.filter((i) => i.data_viagem && i.loja_nome).length;
    el.innerHTML = `<div style="padding:10px 12px;border:1px solid var(--border);border-radius:10px;background:var(--bg-base);font-size:12px;color:var(--text-secondary);">
      <strong>${itens.length}</strong> linha(s) carregada(s) · <strong>${validos}</strong> com data e loja · limite ${MAX_ITENS}
      <div style="overflow:auto;margin-top:10px;max-height:190px;"><table data-ordenavel style="width:100%;border-collapse:collapse;font-size:11px;">
        <thead><tr>${["Pedido", "Data", "Loja", "Rota", "Motorista", "Volumes"].map((h) => `<th style="text-align:left;padding:5px;border-bottom:1px solid var(--border);">${h}</th>`).join("")}</tr></thead>
        <tbody>${itens.slice(0, 8).map((i) => `<tr>${[i.pedido_numero, i.data_viagem, i.loja_nome, i.rota_nome, i.motorista_nome, i.volumes].map((v) => `<td style="padding:5px;border-bottom:1px solid var(--border);">${esc(v)}</td>`).join("")}</tr>`).join("")}</tbody>
      </table></div></div>`;
  }

  window.tmsAbrirImportarPedidos = function () {
    const modal = document.getElementById("tmsModalImportarPedidos");
    if (modal) { modal.classList.remove("hidden"); modal.style.display = "flex"; }
    itens = [];
    const input = document.getElementById("tmsPedidosArquivo");
    if (input) input.value = "";
    mostrarPreview();
  };

  window.tmsFecharImportarPedidos = function () {
    const modal = document.getElementById("tmsModalImportarPedidos");
    if (modal) { modal.classList.add("hidden"); modal.style.display = "none"; }
  };

  window.tmsPedidosArquivoSelecionado = async function (file) {
    if (!file) return;
    const el = document.getElementById("tmsPedidosPreview");
    try {
      const matriz = await arquivoMatriz(file);
      itens = matrizItens(matriz);
      if (itens.length > MAX_ITENS) throw new Error(`A planilha possui ${itens.length} linhas; limite: ${MAX_ITENS}.`);
      mostrarPreview();
    } catch (err) {
      itens = [];
      mostrarPreview();
      if (el) el.innerHTML = `<div style="color:#f87171;font-size:12px;padding:10px;">${esc(err.message || err)}</div>`;
    }
  };

  window.tmsConfirmarImportarPedidos = async function () {
    if (!itens.length) return;
    const btn = document.getElementById("tmsBtnImportarPedidos");
    if (btn) { btn.disabled = true; btn.textContent = "Importando..."; }
    try {
      const resp = await fetch(`${window.location.origin}/tms/pedidos/importar`, {
        method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ itens }),
      });
      const dados = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(dados.error || dados.detalhe || `Erro ${resp.status}`);
      const qtd = (dados.importadas || []).reduce((s, x) => s + (x.pedidos || 0), 0);
      const erros = (dados.erros || []).length;
      window.tmsFecharImportarPedidos();
      if (typeof window.tmsCarregarViagens === "function") window.tmsCarregarViagens();
      if (typeof window.dispararMudou === "function") window.dispararMudou("tms");
      if (typeof window.alertar === "function") window.alertar(`Importação concluída: ${qtd} pedido(s) em ${(dados.importadas || []).length} viagem(ns).${erros ? ` ${erros} linha(s) com erro.` : ""}`);
    } catch (err) {
      if (btn) { btn.disabled = false; btn.textContent = "Importar pedidos"; }
      if (typeof window.alertar === "function") window.alertar("Falha ao importar: " + (err.message || err));
    }
  };
})();
