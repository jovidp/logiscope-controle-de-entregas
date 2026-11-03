// ================================================================
// TMS - planejamento de viagens e paradas
// Usa dados existentes: MOTORISTAS_LISTA, lojasRotas, placas e ajudantes
// ================================================================

const TMS_API = typeof API_URL !== "undefined" ? API_URL : window.location.origin;
const TMS_STATUS_VIAGEM = ["Planejada", "Carregando", "Liberada", "Em rota", "Retorno", "Finalizada", "Cancelada"];
const TMS_STATUS_PARADA = ["Pendente", "Em atendimento", "Entregue", "Entregue com ocorrencia", "Recusada", "Ocorrencia"];
// Status que representam entrega concluida (com ou sem ocorrencia).
const TMS_STATUS_ENTREGUE = ["Entregue", "Entregue com ocorrencia"];
// Status que indicam que houve ocorrencia.
const TMS_STATUS_COM_OCO = ["Ocorrencia", "Entregue com ocorrencia"];

const TMS_PLACAS = [
  "FKG6J16","FKP2S22","FKM0P20","FKN1R21","FKD3F13","FKJ8M18",
  "FKA0C10","FKF5H15","FKB1D11","FKC2E12","FKE4G14","FKO1007","FKK9N19","FKR3T23",
];
const TMS_AJUDANTES = [
  "JUNIOR","ARTUR","KLEBER","YAGO","NATAN","OSCAR","VICTOR D",
  "PEDRO A","LUCAS C","VICTOR HUGO","DAVI FREITAS","IAGO C","WILSON JR","ELIAS","PEDRO LUCAS",
  "VALTER","YURI (BALANÇO)",
  "CAIO L","ENZO L","LUCAS L","PEDRO L","MAYCON","LUIZ V",
];

const tmsState = { viagens: [], viagensRaw: [], editandoId: null, _chartStatus: null, _chartVolume: null };
let tmsViagensRequisicao = 0;

// Rotas disponiveis no TMS = rotas cadastradas em "Cadastros > Rotas" + rotas
// ja usadas no mapa loja->rota. So o mapa nao basta: uma rota recem-cadastrada
// ainda nao tem nenhuma loja apontando para ela e ficaria invisivel aqui.
function tmsGetRotas() {
  const rotas = new Set(Object.values(lojasRotas));
  if (typeof window.cadastrosLista === "function") {
    try {
      window.cadastrosLista("rota").forEach((r) => rotas.add(r));
    } catch (e) {
      /* cadastros ainda nao carregou: fica so com o mapa */
    }
  }
  return [...rotas].filter(Boolean).sort();
}

// Repopula APENAS os selects de rota (formulario de viagem + filtro),
// preservando a selecao atual. Chamado pelo modulo de cadastros sempre que a
// lista de rotas muda, sem resetar o resto do formulario.
function tmsAtualizarSelectsRota() {
  const rotas = tmsGetRotas();
  [
    ["tmsViagemRota", "Selecione"],
    ["tmsFiltroRota", "Todas as rotas"],
  ].forEach(([id, rotulo]) => {
    const el = document.getElementById(id);
    if (!el) return;
    const atual = el.value;
    el.innerHTML =
      `<option value="">${rotulo}</option>` +
      rotas.map((r) => tmsOption(r, r, r === atual)).join("");
  });
}

function tmsGetLojas(rotaFiltro = "") {
  const lojas = Object.entries(lojasRotas)
    .filter(([, rota]) => !rotaFiltro || rota === rotaFiltro)
    .map(([loja]) => loja.replace(/_/g, " "))
    .sort();
  return lojas;
}

async function tmsRequest(path, options = {}) {
  const headers = {
    ...(options.body ? { "Content-Type": "application/json" } : {}),
    ...(options.headers || {}),
  };
  const resposta = await fetch(`${TMS_API}${path}`, { ...options, headers });
  const dados = await resposta.json().catch(() => ({}));
  if (!resposta.ok) throw new Error(dados.error || "Erro ao processar solicitacao.");
  return dados;
}

function tmsOption(value, label, selecionado = false) {
  return `<option value="${value}" ${selecionado ? "selected" : ""}>${escapar(label)}</option>`;
}

// Monta as <option> do select de loja de uma parada.
// As lojas da rota selecionada vem agrupadas no topo ("Lojas da rota"),
// mas TODAS as outras lojas cadastradas tambem ficam disponiveis
// ("Outras lojas"), permitindo trocar ou adicionar lojas que nao sao da rota.
function tmsLojaOptionsHtml(rotaFiltro = "", lojaAtual = "") {
  const todas = tmsGetLojas("");
  const daRota = new Set(rotaFiltro ? tmsGetLojas(rotaFiltro) : []);

  let html = `<option value="">Selecione</option>`;
  if (rotaFiltro && daRota.size) {
    const rotaLojas = [...daRota].sort();
    const outras = todas.filter((l) => !daRota.has(l));
    html += `<optgroup label="Lojas da rota">${rotaLojas.map((l) => tmsOption(l, l, l === lojaAtual)).join("")}</optgroup>`;
    if (outras.length) {
      html += `<optgroup label="Outras lojas">${outras.map((l) => tmsOption(l, l, l === lojaAtual)).join("")}</optgroup>`;
    }
  } else {
    html += todas.map((l) => tmsOption(l, l, l === lojaAtual)).join("");
  }
  // Garante que a loja ja selecionada apareca mesmo se nao estiver em lojasRotas.
  if (lojaAtual && !todas.includes(lojaAtual)) {
    html += tmsOption(lojaAtual, lojaAtual, true);
  }
  return html;
}

function tmsPopularSelectLoja(el, rotaFiltro = "") {
  el.innerHTML = tmsLojaOptionsHtml(rotaFiltro, el.value);
}

function tmsPopularFormViagem() {
  const selMot = document.getElementById("tmsViagemMotorista");
  if (selMot) {
    selMot.innerHTML = `<option value="">Selecione</option>${MOTORISTAS_LISTA.map((m) => tmsOption(m, m)).join("")}`;
  }

  const selPlaca = document.getElementById("tmsViagemVeiculo");
  if (selPlaca) {
    selPlaca.innerHTML = `<option value="">Selecione</option>${TMS_PLACAS.map((p) => tmsOption(p, p)).join("")}`;
  }

  const selRota = document.getElementById("tmsViagemRota");
  if (selRota) {
    selRota.innerHTML = `<option value="">Selecione</option>${tmsGetRotas().map((r) => tmsOption(r, r)).join("")}`;
    selRota.onchange = () => {
      document.querySelectorAll(".tms-p-loja").forEach((sel) => {
        tmsPopularSelectLoja(sel, selRota.value);
      });
    };
  }

  const ajContainer = document.getElementById("tmsViagemAjudantesCheck");
  if (ajContainer) {
    ajContainer.innerHTML = TMS_AJUDANTES.map(
      (aj) => `<label class="multi-check-card"><input type="checkbox" class="tms-aj-check" value="${aj}" /> ${aj}</label>`
    ).join("");
  }
}

function tmsGetAjudantesSelecionados() {
  // Escopo restrito ao container do formulario de viagem. A classe .tms-aj-check
  // tambem e usada pelos cards do painel de importacao de checklist, entao um
  // seletor global misturava os ajudantes marcados la, gerando duplicatas
  // (ex.: "KLEBER, PEDRO A, KLEBER, PEDRO A, ...").
  const marcados = [
    ...document.querySelectorAll("#tmsViagemAjudantesCheck .tms-aj-check:checked"),
  ].map((el) => el.value);
  return [...new Set(marcados)].join(", ");
}

// ================= CALCULADORA DO CAMPO VOLUMES =================
// O volume de cada loja vem somado de varios sistemas, entao o campo aceita a
// conta digitada ("12+8+5", ou "12 8 5" usando espaco) em vez de obrigar a
// abrir a calculadora por fora. Enter ou sair do campo fecha a conta: fica so
// o total, e a conta original vira o title do campo para poder conferir depois.

// Avalia soma/subtracao de inteiros SEM eval — o valor vem de digitacao livre e
// eval aqui seria execucao de codigo arbitrario. Espaco entre numeros conta
// como "+", que e o jeito mais rapido de digitar e o unico que funciona no
// teclado numerico do celular (que nao tem "+").
// Retorna { vazio } | { erro } | { ok, total, parcelas, conta }.
function tmsAvaliarConta(texto) {
  const bruto = String(texto ?? "").trim();
  if (!bruto) return { vazio: true };
  const limpo = bruto.replace(/(\d)\s+(?=\d)/g, "$1+").replace(/\s+/g, "");
  if (!/^[+-]?\d+([+-]\d+)*$/.test(limpo)) return { erro: true };
  const partes = limpo.match(/[+-]?\d+/g) || [];
  if (!partes.length) return { erro: true };
  return {
    ok: true,
    total: partes.reduce((acc, p) => acc + Number(p), 0),
    parcelas: partes.length,
    conta: limpo,
  };
}

// Valor numerico do campo de volumes, avaliando a conta se ela ainda nao foi
// confirmada. Usado no recalculo e na hora de salvar: sem isso, salvar com o
// cursor ainda no campo mandaria "12+8+5" para uma coluna INTEGER.
function tmsLerVolumes(input) {
  if (!input) return 0;
  const r = tmsAvaliarConta(input.value);
  return r.ok ? r.total : 0;
}

function tmsVolumesDica(input) {
  return input.closest(".tms-p-volumes-wrap")?.querySelector(".tms-conta-dica") || null;
}

// Enquanto digita: so mostra o resultado, sem mexer no que foi digitado.
function tmsVolumesDigitando(input) {
  const dica = tmsVolumesDica(input);
  const r = tmsAvaliarConta(input.value);
  const negativo = r.ok && r.total < 0;

  input.classList.toggle("tms-conta-erro", Boolean(r.erro) || negativo);
  // Validacao nativa: o proprio navegador barra o submit e mostra o balao,
  // igual ao "required" da loja — nao precisa de checagem propria no salvar.
  if (r.erro) input.setCustomValidity("Conta invalida. Use algo como 12+8+5.");
  else if (negativo) input.setCustomValidity("O total de volumes nao pode ser negativo.");
  else input.setCustomValidity("");

  if (dica) {
    if (r.erro) dica.textContent = "conta invalida";
    else if (negativo) dica.textContent = `= ${r.total} — nao pode ser negativo`;
    else if (r.ok && r.parcelas > 1) dica.textContent = `= ${r.total}`;
    dica.hidden = !(r.erro || negativo || (r.ok && r.parcelas > 1));
  }
  tmsRecalcularTotais();
}

// Enter fecha a conta em vez de enviar o formulario inteiro.
function tmsVolumesTecla(evento, input) {
  if (evento.key !== "Enter") return;
  evento.preventDefault();
  tmsVolumesConfirmar(input);
}

// Troca a conta pelo total. Conta invalida ou negativa e mantida como esta,
// para o usuario corrigir em vez de perder o que digitou.
function tmsVolumesConfirmar(input) {
  const dica = tmsVolumesDica(input);
  const r = tmsAvaliarConta(input.value);

  if (r.vazio) {
    input.value = "";
    input.title = "";
    input.classList.remove("tms-conta-erro", "tms-conta-aplicada");
    input.setCustomValidity("");
    if (dica) dica.hidden = true;
    tmsRecalcularTotais();
    return;
  }
  if (!r.ok || r.total < 0) return; // segue marcado como invalido

  input.value = String(r.total);
  const veioDeConta = r.parcelas > 1;
  input.classList.toggle("tms-conta-aplicada", veioDeConta);
  input.title = veioDeConta ? `Conta: ${r.conta}` : "";
  if (dica) dica.hidden = true;
  tmsRecalcularTotais();
}

// ── Sacola: conversao caixa <-> sacola (fator P=250, M=200, G=150) ──────────
// Um seletor unico da viagem (#tmsSacolaModo) decide se o numero digitado por
// loja e CAIXA (multiplica) ou SACOLA (soma direta). O valor guardado e sempre
// em sacolas, entao painel/relatorios nao mudam.
function tmsFatorSacola() {
  return (typeof SACOLAS_POR_CAIXA !== "undefined")
    ? SACOLAS_POR_CAIXA
    : { P: 250, M: 200, G: 150 };
}
function tmsSacolaModo() {
  return document.getElementById("tmsSacolaModo")?.value || "sacola";
}
// Converte o valor digitado numa faixa (P/M/G) para SACOLAS canonicas.
function tmsParaSacolas(valor, size) {
  const n = Number(valor) || 0;
  return tmsSacolaModo() === "caixa" ? n * (tmsFatorSacola()[size] || 1) : n;
}
// Rotula os campos por loja conforme o modo (Cx P vs Sacola P).
function tmsAtualizarLabelsSacola() {
  const caixa = tmsSacolaModo() === "caixa";
  const F = tmsFatorSacola();
  document.querySelectorAll(".tms-parada-form").forEach((linha) => {
    [["P", ".tms-p-sacola-p-wrap"], ["M", ".tms-p-sacola-m-wrap"], ["G", ".tms-p-sacola-g-wrap"]]
      .forEach(([size, wrap]) => {
        const lab = linha.querySelector(wrap + " > label");
        if (lab) lab.textContent = (caixa ? "Cx " : "Sacola ") + size;
        const inp = linha.querySelector(wrap + " input");
        if (inp) inp.title = caixa ? `${size}: caixas × ${F[size]} = sacolas` : `${size}: sacolas`;
      });
  });
  tmsAtualizarDicaSacola();
}
// Texto de apoio abaixo do seletor, com o equivalente ao vivo.
function tmsAtualizarDicaSacola() {
  const dica = document.getElementById("tmsSacolaModoDica");
  if (!dica) return;
  const F = tmsFatorSacola();
  if (tmsSacolaModo() === "caixa") {
    dica.textContent = `Você digita CAIXAS por loja — o total sai em sacolas (P×${F.P}, M×${F.M}, G×${F.G}).`;
    return;
  }
  const val = (id) => Number(document.getElementById(id)?.value) || 0;
  const caixas = val("tmsViagemSacolaP") / F.P + val("tmsViagemSacolaM") / F.M + val("tmsViagemSacolaG") / F.G;
  const extra = caixas > 0
    ? ` — equivale a ~${caixas.toLocaleString("pt-BR", { maximumFractionDigits: 1 })} caixas (P÷${F.P}, M÷${F.M}, G÷${F.G}).`
    : ".";
  dica.textContent = `Você digita SACOLAS por loja — soma direta P+M+G${extra}`;
}
// Reage a troca do seletor.
function tmsSacolaModoMudou() {
  tmsAtualizarLabelsSacola();
  tmsRecalcularTotais();
}

// Soma as quantidades de cada loja (parada) e joga o total nos campos
// "previstos" do cabecalho da viagem (volume, campanha, retiradas e sacola).
function tmsRecalcularTotais() {
  const somar = (sel) =>
    [...document.querySelectorAll(sel)].reduce((acc, el) => acc + (Number(el.value) || 0), 0);
  const setTotal = (id, valor) => {
    const el = document.getElementById(id);
    if (el) el.value = valor;
  };
  // Volumes passa pelo avaliador: durante a digitacao o campo pode conter uma
  // conta ainda aberta, e Number("12+8") seria NaN.
  setTotal(
    "tmsViagemVolumes",
    [...document.querySelectorAll(".tms-p-volumes")].reduce((acc, el) => acc + tmsLerVolumes(el), 0)
  );
  setTotal("tmsViagemMaterialCampanha", somar(".tms-p-material"));
  setTotal("tmsViagemRetiradaCx", somar(".tms-p-retirada-cx"));
  setTotal("tmsViagemRetiradaRt", somar(".tms-p-retirada-rt"));
  // Sacola: em modo "caixa" o que a loja digita sao CAIXAS e o total sai em
  // sacolas (x250/200/150); em modo "sacola" e a soma direta. tmsParaSacolas
  // resolve e devolve sempre SACOLAS canonicas (o que o painel espera).
  const somarSacola = (sel, size) =>
    [...document.querySelectorAll(sel)].reduce((acc, el) => acc + tmsParaSacolas(el.value, size), 0);
  setTotal("tmsViagemSacolaP", somarSacola(".tms-p-sacola-p", "P"));
  setTotal("tmsViagemSacolaM", somarSacola(".tms-p-sacola-m", "M"));
  setTotal("tmsViagemSacolaG", somarSacola(".tms-p-sacola-g", "G"));

  // Total de sacolas de cada loja (ja convertido pra sacolas), automatico.
  document.querySelectorAll(".tms-parada-form").forEach((linha) => {
    const p = tmsParaSacolas(linha.querySelector(".tms-p-sacola-p")?.value, "P");
    const m = tmsParaSacolas(linha.querySelector(".tms-p-sacola-m")?.value, "M");
    const g = tmsParaSacolas(linha.querySelector(".tms-p-sacola-g")?.value, "G");
    const totalEl = linha.querySelector(".tms-p-sacola-total");
    if (totalEl) totalEl.value = p + m + g;
  });

  tmsAtualizarDicaSacola();
}

// Formata um numero como moeda BRL (ex.: 1234.5 -> "R$ 1.234,50").
function tmsBRL(v) {
  const n = Number(v) || 0;
  return n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

// Ids dos campos de custo do formulario de viagem (para limpar/coletar).
const TMS_CAMPOS_CUSTO = [
  "tmsViagemKmPrevisto", "tmsViagemKmReal", "tmsViagemCustoFrete",
  "tmsViagemCustoCombustivel", "tmsViagemPedagio", "tmsViagemOutrosCustos",
];

// Recalcula o "Custo total" do cabecalho (frete + combustivel + pedagio + outros).
function tmsRecalcularCusto() {
  const val = (id) => Number(document.getElementById(id)?.value) || 0;
  const total =
    val("tmsViagemCustoFrete") + val("tmsViagemCustoCombustivel") +
    val("tmsViagemPedagio") + val("tmsViagemOutrosCustos");
  const el = document.getElementById("tmsViagemCustoTotal");
  if (el) el.value = total > 0 ? tmsBRL(total) : "";
}

function tmsAbrirViagem() {
  const form = document.getElementById("tmsFormViagem");
  if (!form) return;
  tmsState.editandoId = null;
  form.classList.remove("hidden");
  document.getElementById("tmsFormViagemTitulo").textContent = "Nova viagem / romaneio";
  document.getElementById("tmsSalvarViagemBtn").textContent = "Salvar viagem";
  ["tmsViagemVolumes", "tmsViagemMaterialCampanha", "tmsViagemRetiradaCx", "tmsViagemRetiradaRt", "tmsViagemSacolaP", "tmsViagemSacolaM", "tmsViagemSacolaG", "tmsViagemObs", "tmsViagemResponsavel", "tmsViagemCustoTotal", ...TMS_CAMPOS_CUSTO].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.value = "";
  });
  document.getElementById("tmsViagemData").value = hojeISO();
  document.getElementById("tmsViagemHoraSaida").value = "06:00";
  document.getElementById("tmsParadasForm").innerHTML = "";
  const modoSacolaNova = document.getElementById("tmsSacolaModo");
  if (modoSacolaNova) modoSacolaNova.value = "sacola";
  tmsPopularFormViagem();
  tmsAdicionarParada();
  form.scrollIntoView({ behavior: "smooth", block: "start" });
}

function tmsFecharViagem() {
  tmsState.editandoId = null;
  document.getElementById("tmsFormViagem")?.classList.add("hidden");
}

function tmsAdicionarParada(parada = {}) {
  const container = document.getElementById("tmsParadasForm");
  if (!container) return;
  const ordem = container.querySelectorAll(".tms-parada-form").length + 1;
  const rota = document.getElementById("tmsViagemRota")?.value || "";
  const lojaAtual = parada.loja_nome || parada.loja || "";
  const linha = document.createElement("div");
  linha.className = "tms-parada-form";
  linha.dataset.paradaId = parada.id || "";
  linha.innerHTML = `
    <div class="tms-parada-pos">
      <button type="button" class="tms-pos-btn tms-pos-sobe admin-only-action" title="Subir esta loja uma posição" onclick="tmsMoverParadaForm(this, -1)">▲</button>
      <div class="tms-parada-num" draggable="true" title="Arraste para mudar a posição da loja">${ordem}</div>
      <button type="button" class="tms-pos-btn tms-pos-desce admin-only-action" title="Descer esta loja uma posição" onclick="tmsMoverParadaForm(this, 1)">▼</button>
    </div>
    <div class="tms-p-col-loja"><label>Loja</label><select class="tms-p-loja" required>
      ${tmsLojaOptionsHtml(rota, lojaAtual)}
    </select></div>
    <div class="tms-p-hora-wrap"><label>Previsao</label><input type="time" class="tms-p-hora" value="${escapar(String(parada.hora_prevista || "").slice(0, 5))}" /></div>
    <div class="tms-p-volumes-wrap"><label>Volumes</label><input type="text" inputmode="numeric" autocomplete="off" class="tms-p-volumes" value="${escapar(parada.volumes_previstos ?? "")}" placeholder="0" title="Aceita conta: 12+8+5 (ou 12 8 5). Enter fecha." oninput="tmsVolumesDigitando(this)" onkeydown="tmsVolumesTecla(event, this)" onblur="tmsVolumesConfirmar(this)" /><div class="tms-conta-dica" hidden></div></div>
    <div class="tms-p-material-wrap"><label>Mat. campanha</label><input type="number" min="0" class="tms-p-material" value="${escapar(parada.material_campanha ?? "")}" oninput="tmsRecalcularTotais()" /></div>
    <div class="tms-p-retirada-cx-wrap"><label>Retirada CX</label><input type="number" min="0" class="tms-p-retirada-cx" value="${escapar(parada.retirada_cx ?? "")}" oninput="tmsRecalcularTotais()" /></div>
    <div class="tms-p-retirada-rt-wrap"><label>Retirada RT</label><input type="number" min="0" class="tms-p-retirada-rt" value="${escapar(parada.retirada_rt ?? "")}" oninput="tmsRecalcularTotais()" /></div>
    <div class="tms-p-sacola-p-wrap"><label>Sacola P</label><input type="number" min="0" class="tms-p-sacola-p" value="${escapar(parada.sacola_p ?? "")}" oninput="tmsRecalcularTotais()" /></div>
    <div class="tms-p-sacola-m-wrap"><label>Sacola M</label><input type="number" min="0" class="tms-p-sacola-m" value="${escapar(parada.sacola_m ?? "")}" oninput="tmsRecalcularTotais()" /></div>
    <div class="tms-p-sacola-g-wrap"><label>Sacola G</label><input type="number" min="0" class="tms-p-sacola-g" value="${escapar(parada.sacola_g ?? "")}" oninput="tmsRecalcularTotais()" /></div>
    <div class="tms-p-sacola-total-wrap"><label>Total sacolas</label><input type="number" class="tms-p-sacola-total" readonly title="Soma de P + M + G desta loja" /></div>
    <div class="tms-p-prioridade-wrap"><label>Prioridade</label><select class="tms-p-prioridade" title="Usada pela otimização da rota">
      <option value="1" ${Number(parada.prioridade || 2) === 1 ? "selected" : ""}>Baixa</option>
      <option value="2" ${Number(parada.prioridade || 2) === 2 ? "selected" : ""}>Normal</option>
      <option value="3" ${Number(parada.prioridade || 2) === 3 ? "selected" : ""}>Alta</option>
      <option value="4" ${Number(parada.prioridade || 2) === 4 ? "selected" : ""}>Urgente</option>
    </select></div>
    <button type="button" class="btn-red btn-sm tms-p-remove admin-only-action" onclick="tmsRemoverParada(this)">Remover</button>`;
  container.appendChild(linha);
  tmsRenumerarParadasForm();
  tmsAtualizarLabelsSacola();
  tmsRecalcularTotais();
}

function tmsRemoverParada(botao) {
  botao.closest(".tms-parada-form")?.remove();
  tmsRenumerarParadasForm();
  tmsRecalcularTotais();
}

async function tmsSalvarViagem(event) {
  event.preventDefault();
  const paradas = [...document.querySelectorAll(".tms-parada-form")].map((linha) => {
    // Converte pra sacolas conforme o modo do seletor (caixa multiplica).
    const sacolaP = tmsParaSacolas(linha.querySelector(".tms-p-sacola-p").value, "P");
    const sacolaM = tmsParaSacolas(linha.querySelector(".tms-p-sacola-m").value, "M");
    const sacolaG = tmsParaSacolas(linha.querySelector(".tms-p-sacola-g").value, "G");
    return {
      id: linha.dataset.paradaId ? Number(linha.dataset.paradaId) : null,
      loja: linha.querySelector(".tms-p-loja").value,
      hora_prevista: linha.querySelector(".tms-p-hora").value,
      // Passa pelo avaliador: salvar com o cursor ainda no campo mandaria a
      // conta crua ("12+8+5") para uma coluna INTEGER.
      volumes_previstos: tmsLerVolumes(linha.querySelector(".tms-p-volumes")),
      material_campanha: linha.querySelector(".tms-p-material").value,
      retirada_cx: Number(linha.querySelector(".tms-p-retirada-cx")?.value) || 0,
      retirada_rt: Number(linha.querySelector(".tms-p-retirada-rt")?.value) || 0,
      sacola_p: sacolaP,
      sacola_m: sacolaM,
      sacola_g: sacolaG,
      sacola: sacolaP + sacolaM + sacolaG,
      prioridade: Number(linha.querySelector(".tms-p-prioridade")?.value) || 2,
    };
  });
  const totalSacolaP = paradas.reduce((acc, p) => acc + (Number(p.sacola_p) || 0), 0);
  const totalSacolaM = paradas.reduce((acc, p) => acc + (Number(p.sacola_m) || 0), 0);
  const totalSacolaG = paradas.reduce((acc, p) => acc + (Number(p.sacola_g) || 0), 0);
  const body = {
    data_viagem: document.getElementById("tmsViagemData").value,
    hora_saida_fabrica: document.getElementById("tmsViagemHoraSaida").value,
    rota: document.getElementById("tmsViagemRota").value,
    motorista: document.getElementById("tmsViagemMotorista").value,
    placa: document.getElementById("tmsViagemVeiculo").value,
    ajudantes: tmsGetAjudantesSelecionados(),
    volumes_previstos: document.getElementById("tmsViagemVolumes").value,
    material_campanha: document.getElementById("tmsViagemMaterialCampanha").value,
    retirada_cx: paradas.reduce((acc, p) => acc + (Number(p.retirada_cx) || 0), 0),
    retirada_rt: paradas.reduce((acc, p) => acc + (Number(p.retirada_rt) || 0), 0),
    sacola_p: totalSacolaP,
    sacola_m: totalSacolaM,
    sacola_g: totalSacolaG,
    sacola: totalSacolaP + totalSacolaM + totalSacolaG,
    observacao: document.getElementById("tmsViagemObs").value,
    responsavel_monitoramento: document.getElementById("tmsViagemResponsavel")?.value || "",
    km_previsto: document.getElementById("tmsViagemKmPrevisto")?.value || "",
    km_real: document.getElementById("tmsViagemKmReal")?.value || "",
    custo_frete: document.getElementById("tmsViagemCustoFrete")?.value || "",
    custo_combustivel: document.getElementById("tmsViagemCustoCombustivel")?.value || "",
    pedagio: document.getElementById("tmsViagemPedagio")?.value || "",
    outros_custos: document.getElementById("tmsViagemOutrosCustos")?.value || "",
    paradas,
  };
  try {
    const editando = tmsState.editandoId;
    if (editando) {
      // A ordem enviada pelo formulario prevalece sobre movimentos antigos
      // ainda na fila do card. Aguarda apenas o PUT que ja estiver em curso.
      clearTimeout(tmsOrdemTimers.get(editando));
      tmsOrdemTimers.delete(editando);
      tmsOrdensPendentes.delete(editando);
      await tmsOrdemFila;
    }
    const path = editando ? `/tms/viagens/${editando}` : "/tms/viagens";
    await tmsRequest(path, { method: editando ? "PUT" : "POST", body: JSON.stringify(body) });
    tmsViagensRequisicao += 1;
    tmsFecharViagem();
    await tmsCarregarViagens();
    if (typeof window.dispararMudou === "function") window.dispararMudou("tms");
    alertar(editando ? "Viagem atualizada com sucesso." : "Viagem planejada com sucesso.");
  } catch (err) {
    alertar(`Nao foi possivel salvar a viagem: ${err.message}`);
  }
}

function tmsEditarViagem(id) {
  const viagem = tmsState.viagens.find((item) => item.id === id);
  const form = document.getElementById("tmsFormViagem");
  if (!viagem || !form) return;

  tmsState.editandoId = id;
  form.classList.remove("hidden");
  tmsPopularFormViagem();
  document.getElementById("tmsFormViagemTitulo").textContent = `Editar viagem ${tmsCodigoExibicao(viagem)}`;
  document.getElementById("tmsSalvarViagemBtn").textContent = "Atualizar viagem";
  document.getElementById("tmsViagemData").value = String(viagem.data_viagem || "").split("T")[0];
  document.getElementById("tmsViagemHoraSaida").value = String(viagem.hora_saida_fabrica || "06:00").slice(0, 5);
  document.getElementById("tmsViagemRota").value = viagem.rota_nome || "";
  document.getElementById("tmsViagemMotorista").value = viagem.motorista_nome || "";
  document.getElementById("tmsViagemVeiculo").value = viagem.placa || "";
  document.getElementById("tmsViagemVolumes").value = viagem.volumes_previstos ?? "";
  document.getElementById("tmsViagemMaterialCampanha").value = viagem.material_campanha ?? "";
  document.getElementById("tmsViagemRetiradaCx").value = (viagem.paradas || []).reduce((s, p) => s + (Number(p.retirada_cx) || 0), 0);
  document.getElementById("tmsViagemRetiradaRt").value = (viagem.paradas || []).reduce((s, p) => s + (Number(p.retirada_rt) || 0), 0);
  document.getElementById("tmsViagemSacolaP").value = viagem.sacola_p ?? "";
  document.getElementById("tmsViagemSacolaM").value = viagem.sacola_m ?? "";
  document.getElementById("tmsViagemSacolaG").value = viagem.sacola_g ?? "";
  document.getElementById("tmsViagemObs").value = viagem.observacao || "";
  const selResp = document.getElementById("tmsViagemResponsavel");
  if (selResp) selResp.value = viagem.responsavel_monitoramento || "";
  const setCusto = (id, v) => { const el = document.getElementById(id); if (el) el.value = v ?? ""; };
  setCusto("tmsViagemKmPrevisto", viagem.km_previsto);
  setCusto("tmsViagemKmReal", viagem.km_real);
  setCusto("tmsViagemCustoFrete", viagem.custo_frete);
  setCusto("tmsViagemCustoCombustivel", viagem.custo_combustivel);
  setCusto("tmsViagemPedagio", viagem.pedagio);
  setCusto("tmsViagemOutrosCustos", viagem.outros_custos);
  tmsRecalcularCusto();
  const ajudantes = String(viagem.ajudantes || "").split(",").map((item) => item.trim());
  document.querySelectorAll(".tms-aj-check").forEach((campo) => {
    campo.checked = ajudantes.includes(campo.value);
  });
  const container = document.getElementById("tmsParadasForm");
  container.innerHTML = "";
  const modoSacolaEdit = document.getElementById("tmsSacolaModo");
  if (modoSacolaEdit) modoSacolaEdit.value = "sacola";
  (viagem.paradas || []).forEach((parada) => tmsAdicionarParada(parada));
  if (!(viagem.paradas || []).length) tmsAdicionarParada();
  form.scrollIntoView({ behavior: "smooth", block: "start" });
}

function tmsStatusOptions(status, opcoes) {
  return opcoes.map((item) => tmsOption(item, item, item === status)).join("");
}

function tmsClasseParada(parada) {
  if (parada.ocorrencia_teve_problema || TMS_STATUS_COM_OCO.includes(parada.status)) return " ocorrencia";
  if (parada.status === "Entregue") return " entregue";
  if (parada.status === "Em atendimento") return " atendimento";
  if (parada.status === "Recusada") return " recusada";
  return " pendente";
}

function tmsClasseViagem(viagem) {
  const paradas = viagem.paradas || [];
  if (paradas.some((p) => p.ocorrencia_teve_problema || TMS_STATUS_COM_OCO.includes(p.status))) return " com-ocorrencia";
  if (viagem.status === "Finalizada") return " finalizada";
  if (viagem.status === "Em rota" || viagem.status === "Retorno") return " andamento";
  return "";
}

const TMS_STATUS_CORES = {
  "Planejada":  "#6366f1",
  "Carregando": "#f59e0b",
  "Liberada":   "#06b6d4",
  "Em rota":    "#f97316",
  "Retorno":    "#a78bfa",
  "Finalizada": "#22c55e",
  "Cancelada":  "#ef4444",
};

function tmsRenderGraficos() {
  if (typeof Chart === "undefined") return;
  const viagens = tmsState.viagens;

  // -- Pizza: status das viagens --
  const contagemStatus = {};
  TMS_STATUS_VIAGEM.forEach((s) => (contagemStatus[s] = 0));
  viagens.forEach((v) => { if (contagemStatus[v.status] !== undefined) contagemStatus[v.status]++; });
  const statusLabels = Object.keys(contagemStatus).filter((s) => contagemStatus[s] > 0);
  const statusData   = statusLabels.map((s) => contagemStatus[s]);
  const statusCores  = statusLabels.map((s) => TMS_STATUS_CORES[s] || "#94a3b8");

  const canvasStatus = document.getElementById("tmsChartStatus");
  if (canvasStatus) {
    if (tmsState._chartStatus) tmsState._chartStatus.destroy();
    tmsState._chartStatus = new Chart(canvasStatus, {
      type: "doughnut",
      data: { labels: statusLabels, datasets: [{ data: statusData, backgroundColor: statusCores, borderWidth: 2, borderColor: "transparent", hoverOffset: 6 }] },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: "62%",
        plugins: {
          legend: { position: "right", labels: { color: getComputedStyle(document.documentElement).getPropertyValue("--text-primary").trim() || "#ccc", font: { size: 11 }, boxWidth: 12, padding: 10 } },
          tooltip: { callbacks: { label: (ctx) => ` ${ctx.label}: ${ctx.raw}` } },
        },
      },
    });
  }

  // -- Gauge: volume entregue vs planejado --
  const totalPlanejado = viagens.reduce((acc, v) => acc + (Number(v.volumes_previstos) || 0), 0);
  const totalEntregue  = viagens.flatMap((v) => v.paradas || [])
    .filter((p) => TMS_STATUS_ENTREGUE.includes(p.status))
    .reduce((acc, p) => acc + tmsVolEntregueParada(p), 0);
  const restante  = Math.max(0, totalPlanejado - totalEntregue);
  const pct       = totalPlanejado > 0 ? Math.round((totalEntregue / totalPlanejado) * 100) : 0;
  const corFill   = pct >= 80 ? "#22c55e" : pct >= 50 ? "#f59e0b" : "#ef4444";

  const canvasVol = document.getElementById("tmsChartVolume");
  const gaugeLabel = document.getElementById("tmsGaugeLabel");
  if (canvasVol) {
    if (tmsState._chartVolume) tmsState._chartVolume.destroy();
    tmsState._chartVolume = new Chart(canvasVol, {
      type: "doughnut",
      data: {
        datasets: [{
          data: [totalEntregue || 0, restante || (totalPlanejado === 0 ? 1 : 0)],
          backgroundColor: [corFill, "rgba(148,163,184,0.15)"],
          borderWidth: 0,
          hoverOffset: 0,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        rotation: -90,
        circumference: 180,
        cutout: "70%",
        plugins: { legend: { display: false }, tooltip: { enabled: false } },
        animation: { duration: 600 },
      },
    });
    if (gaugeLabel) {
      gaugeLabel.innerHTML = `<span style="font-size:22px;font-weight:900;color:${corFill}">${pct}%</span><br><span style="font-size:11px;font-weight:500;color:var(--text-muted)">${totalEntregue} / ${totalPlanejado} vol</span>`;
    }
  }
}

// Volume efetivamente entregue numa parada: se ja houve registro lancado, usa o
// volume lancado (fisico, ou gerencial na falta dele); senao, o previsto do TMS.
// Usado no card da parada e nos totais de "volumes entregues" (medidor + KPI), para
// que o volume lancado apareca mesmo quando a parada veio zerada do TMS.
function tmsVolEntregueParada(p) {
  const lancado = p.ocorrencia_id != null
    ? (p.ocorrencia_volume_fisico ?? p.ocorrencia_volume_gerencial)
    : null;
  if (lancado !== null && lancado !== undefined && lancado !== "") return Number(lancado) || 0;
  return Number(p.volumes_previstos) || 0;
}

// Sacolas da parada: espelha o volume. Se a parada tem registro/ocorrencia, usa a
// sacola LANCADA nele (sacola_qtd; se faltar, soma P+M+G do registro); senao cai
// no previsto do TMS (parada.sacola). Assim o painel computa as sacolas que o
// operador lancou no registro, mesmo com a parada zerada no cadastro do TMS.
function tmsSacolaParada(p) {
  if (p.ocorrencia_id != null) {
    const qtd = p.ocorrencia_sacola_qtd;
    if (qtd !== null && qtd !== undefined && qtd !== "") return Number(qtd) || 0;
    const somaPMG = (Number(p.ocorrencia_sacola_p) || 0)
      + (Number(p.ocorrencia_sacola_m) || 0)
      + (Number(p.ocorrencia_sacola_g) || 0);
    if (somaPMG > 0) return somaPMG;
  }
  return Number(p.sacola) || 0;
}

// Total de sacolas da viagem = soma do efetivo por parada (registro > previsto).
// Sem paradas, cai no cabecalho previsto da viagem.
function tmsSacolaViagem(viagem) {
  const paradas = viagem.paradas || [];
  if (paradas.length) return paradas.reduce((acc, p) => acc + tmsSacolaParada(p), 0);
  return Number(viagem.sacola) || 0;
}

function tmsRenderKpis() {
  const viagens = tmsState.viagens;
  const paradas = viagens.flatMap((v) => v.paradas || []);

  // -- Viagens por situacao --
  const finalizadas = viagens.filter((v) => v.status === "Finalizada").length;
  const emRota = viagens.filter((v) => v.status === "Em rota" || v.status === "Retorno").length;
  const planejadas = viagens.filter((v) => v.status === "Planejada").length;

  // -- Paradas por situacao --
  const entregues = paradas.filter((p) => TMS_STATUS_ENTREGUE.includes(p.status)).length;
  const pendentes = paradas.filter((p) => p.status === "Pendente" || p.status === "Em atendimento").length;
  const comOco = paradas.filter((p) => p.ocorrencia_teve_problema || TMS_STATUS_COM_OCO.includes(p.status)).length;

  // -- Percentuais --
  const pct = (parte, total) => (total > 0 ? Math.round((parte / total) * 100) : 0);
  const taxaEntrega = pct(entregues, paradas.length);
  const taxaOco = pct(comOco, paradas.length);

  // -- Volumes / sacolas / lojas --
  const volPlanejado = viagens.reduce((acc, v) => acc + tmsTotalViagem(v, "volumes_previstos"), 0);
  const volEntregue = paradas
    .filter((p) => TMS_STATUS_ENTREGUE.includes(p.status))
    .reduce((acc, p) => acc + tmsVolEntregueParada(p), 0);
  const sacolas = viagens.reduce((acc, v) => acc + tmsSacolaViagem(v), 0);
  const retiradaCx = paradas.reduce((acc, p) => acc + (Number(p.retirada_cx) || 0), 0);
  const retiradaRt = paradas.reduce((acc, p) => acc + (Number(p.retirada_rt) || 0), 0);
  const lojas = new Set(paradas.map((p) => p.loja_nome).filter(Boolean)).size;

  const el = document.getElementById("tmsKpis");
  if (!el) return;

  // [label, valor, cor de destaque, sub-texto opcional]
  const cards = [
    ["Viagens", viagens.length, "#6366f1"],
    ["Em rota", emRota, "#f97316"],
    ["Planejadas", planejadas, "#06b6d4"],
    ["Finalizadas", finalizadas, "#22c55e"],
    ["Paradas", paradas.length, "#94a3b8"],
    ["Entregues", entregues, "#22c55e", `${taxaEntrega}% das paradas`],
    ["Pendentes", pendentes, "#f59e0b"],
    ["Com ocorrencia", comOco, "#ef4444", `${taxaOco}% das paradas`],
    ["Taxa de entrega", `${taxaEntrega}%`, taxaEntrega >= 80 ? "#22c55e" : taxaEntrega >= 50 ? "#f59e0b" : "#ef4444"],
    ["Volumes planejados", volPlanejado, "#6366f1"],
    ["Volumes entregues", volEntregue, "#22c55e", `${pct(volEntregue, volPlanejado)}% do planejado`],
    ["Sacolas", sacolas, "#a78bfa"],
    ["Retiradas CX", retiradaCx, "#f97316"],
    ["Retiradas RT", retiradaRt, "#06b6d4"],
    ["Lojas atendidas", lojas, "#06b6d4"],
  ];

  // -- Custos (so entram nos KPIs quando ha algum custo lancado nas viagens) --
  // Frete digitado na viagem vence; sem ele, entra o calculado pelo cadastro de
  // lojas (km x CCD + taxa do caminhao). Idem km: real vence o previsto.
  const custoTotal = viagens.reduce(
    (acc, v) => acc + (Number(v.custo_frete) || Number(v.frete_calc_total) || 0) + (Number(v.custo_combustivel) || 0) +
      (Number(v.pedagio) || 0) + (Number(v.outros_custos) || 0), 0);
  if (custoTotal > 0) {
    const kmReal = viagens.reduce((acc, v) => acc + (Number(v.km_real) || 0), 0);
    const kmPrev = viagens.reduce((acc, v) => acc + (Number(v.km_real) || Number(v.km_previsto_calc) || 0), 0);
    const kmBase = kmReal > 0 ? kmReal : kmPrev;
    const custoKm = kmBase > 0 ? custoTotal / kmBase : 0;
    const custoEntrega = entregues > 0 ? custoTotal / entregues : 0;
    cards.push(["Custo total", tmsBRL(custoTotal), "#f43f5e"]);
    cards.push(["Custo / km", kmBase > 0 ? tmsBRL(custoKm) : "—", "#fb923c",
      kmReal > 0 ? `${kmReal} km rodados` : kmPrev > 0 ? `${Math.round(kmPrev)} km previstos` : "informe o km real"]);
    cards.push(["Custo / entrega", entregues > 0 ? tmsBRL(custoEntrega) : "—", "#eab308", `${entregues} entregas`]);
  }

  el.innerHTML = cards
    .map(
      ([label, valor, cor, sub]) =>
        `<div class="tms-kpi" style="border-left:3px solid ${cor};">
          <strong style="color:${cor};">${valor}</strong>
          <span>${label}</span>
          ${sub ? `<small class="tms-kpi-sub">${sub}</small>` : ""}
        </div>`
    )
    .join("");
}

function tmsRenderCardOcorrencias() {
  const el = document.getElementById("tmsCardOcorrencias");
  if (!el) return;

  const paradas = tmsState.viagens.flatMap((v) => v.paradas || []);
  const itens = [];
  tmsState.viagens.forEach((v) => {
    (v.paradas || []).forEach((p) => {
      if (p.ocorrencia_teve_problema || TMS_STATUS_COM_OCO.includes(p.status)) itens.push({ v, p });
    });
  });

  const total = itens.length;
  const pct = paradas.length
    ? Math.round((total / paradas.length) * 100)
    : 0;

  if (total === 0) {
    el.innerHTML = `
      <div class="tms-chart-card">
        <p class="tms-chart-title">⚠️ Entregas com ocorrência</p>
        <div style="display:flex;align-items:baseline;gap:10px;">
          <strong style="font-size:25px;color:var(--text-heading);">0</strong>
          <span style="font-size:11px;color:var(--text-muted);font-weight:700;text-transform:uppercase;">nenhuma no filtro</span>
        </div>
      </div>`;
    return;
  }

  const corStatus = (s) =>
    s === "Entregue com ocorrencia" ? "#fb923c" : "#f87171";

  const linhas = itens
    .map(({ v, p }) => {
      const meta = [
        v.motorista_nome,
        v.placa,
        v.rota_nome,
        formatarDataBR(v.data_viagem),
      ]
        .filter(Boolean)
        .map((x) => escapar(x))
        .join(" · ");
      const cor = corStatus(p.status);
      return `
      <div style="display:flex;align-items:center;gap:12px;padding:10px 0;border-top:1px solid var(--border);">
        <div style="flex:1;min-width:0;">
          <div style="font-weight:700;color:var(--text-heading);font-size:13px;">${escapar(p.loja_nome || "Loja")}</div>
          <div style="font-size:11px;color:var(--text-muted);">${meta}</div>
        </div>
        <span style="flex-shrink:0;font-size:11px;font-weight:800;color:${cor};background:${cor}22;border:1px solid ${cor}55;border-radius:7px;padding:3px 9px;white-space:nowrap;">${escapar(p.status)}</span>
        ${p.ocorrencia_id
          ? `<button type="button" class="btn-blue btn-sm" onclick="tmsVerOcorrencia(${p.ocorrencia_id})">Ver</button>`
          : `<button type="button" class="btn-blue btn-sm" onclick="tmsAbrirOcorrencia(${v.id}, ${p.id})">Lancar</button>`}
      </div>`;
    })
    .join("");

  el.innerHTML = `
    <div class="tms-chart-card">
      <p class="tms-chart-title">⚠️ Entregas com ocorrência</p>
      <div style="display:flex;align-items:baseline;gap:10px;margin-bottom:6px;">
        <strong style="font-size:25px;color:var(--text-heading);">${total}</strong>
        <span style="font-size:11px;color:var(--text-muted);font-weight:700;text-transform:uppercase;">de ${paradas.length} paradas · ${pct}%</span>
      </div>
      ${linhas}
    </div>`;
}

// Total exibido no card: usa o valor do cabecalho da viagem se preenchido;
// senao, soma o que foi informado nas paradas (campo por loja).
function tmsTotalViagem(viagem, campo) {
  const cabecalho = Number(viagem[campo]);
  if (Number.isFinite(cabecalho) && cabecalho > 0) return cabecalho;
  return (viagem.paradas || []).reduce((acc, p) => acc + (Number(p[campo]) || 0), 0);
}

function tmsCodigoExibicao(viagem) {
  const codigo = viagem.codigo || `Viagem ${viagem.id}`;
  const dataFormatada = formatarDataBR(viagem.data_viagem);
  return codigo.replace(/^V-\d{8}/, `V-${dataFormatada}`);
}

// Km previsto (soma dos trechos fabrica -> lojas na ordem -> fabrica) e frete
// calculado pelo cadastro de lojas (PES). Vem pronto do GET /tms/viagens.
function tmsKmFreteViagem(viagem) {
  const blocos = [];
  if (viagem.km_previsto_calc) {
    const falta = viagem.km_trechos_faltando ? `<small>${escapar(viagem.km_trechos_faltando)} trecho(s) sem km</small>` : "";
    blocos.push(`<div class="tms-resumo-bloco"><span class="tms-resumo-label">Distância prevista</span><strong>~${Math.round(viagem.km_previsto_calc)} km</strong>${falta}</div>`);
  }
  if (viagem.frete_calc_total) {
    const detalhes = [viagem.tipo_frete_rotulo || viagem.tipo_frete, viagem.tipo_frete_assumido ? "tipo do caminhão estimado" : "", viagem.frete_lojas_sem_preco ? `${viagem.frete_lojas_sem_preco} loja(s) sem preço` : ""].filter(Boolean);
    blocos.push(`<div class="tms-resumo-bloco" title="Frete por loja = km da fábrica × CCD + taxa fixa do caminhão. Retorno = mesmo valor do envio.">
      <span class="tms-resumo-label">Frete total</span><strong>${escapar(tmsBRL(viagem.frete_calc_total))}</strong>
      <small>Ida ${escapar(tmsBRL(viagem.frete_calc_ida))} · Retorno ${escapar(tmsBRL(viagem.frete_calc_retorno))}</small>
      ${detalhes.length ? `<small>${escapar(detalhes.join(" · "))}</small>` : ""}</div>`);
  }
  if (viagem.retorno_previsto) {
    const trab = Number(viagem.jornada_prevista_trabalho_min) || 0;
    const cor = trab > 720 ? "#dc2626" : trab > 480 ? "#f97316" : "var(--text-heading)";
    blocos.push(`<div class="tms-resumo-bloco" title="Previsão pela saída real + tempo típico de cada trecho e descarga (1h de almoço descontada da jornada)">
      <span class="tms-resumo-label">Retorno previsto</span><strong>${escapar(viagem.retorno_previsto)}${viagem.retorno_previsto_dia_seguinte && !viagem.continua_pernoite ? " (dia seguinte)" : ""}</strong>
      <small style="color:${cor};">Jornada prevista ${Math.floor(trab / 60)}h${String(trab % 60).padStart(2, "0")} de trabalho</small></div>`);
  }
  return blocos.length ? `<div class="tms-resumo-custos">${blocos.join("")}</div>` : "";
}

// Rota de viagem (pernoite, back/pernoite.js): viagem de ontem que segue hoje,
// ou viagem de hoje cuja previsao ja joga loja para amanha.
function tmsPernoiteSeloHtml(viagem) {
  const estilo = "display:inline-block;margin:0 6px 6px 0;padding:3px 9px;border-radius:6px;font-size:11px;font-weight:800;background:rgba(56,189,248,.12);border:1px solid rgba(56,189,248,.4);color:#0284c7;";
  if (viagem.continua_pernoite) {
    // Loja que o GPS ja viu nao esta mais "a fazer", so sem registro.
    const pend = (viagem.paradas || []).filter((p) => !p.ocorrencia_id && !["Entregue", "Entregue com ocorrencia", "Recusada", "Ocorrencia"].includes(p.status) && !p.gps_chegou_em && !p.gps_saiu_em).length;
    return `<span style="${estilo}" title="A equipe dormiu na região e termina a rota hoje. O registro destas lojas fica na viagem de ${formatarDataBR(viagem.data_viagem)}, marcado como dia seguinte.">🏨 Pernoite — viagem de ${formatarDataBR(viagem.data_viagem)} continua hoje${pend ? ` · ${pend} loja(s)` : ""}</span>`;
  }
  if (viagem.pernoite_previsto) {
    return `<span style="${estilo}" title="Pela previsão, parte das lojas fica para amanhã (a equipe dorme na região)">🏨 Pernoite previsto</span>`;
  }
  return "";
}

// Progresso do roteiro considera visitas GPS; entrega registrada continua separada.
function tmsRoteiroHtml(viagem) {
  const paradas = [...(viagem.paradas || [])].sort((a, b) => (a.ordem || 0) - (b.ordem || 0) || a.id - b.id);
  if (!paradas.length) return "";
  const registrada = (p) => !!p.ocorrencia_id || ["Entregue", "Entregue com ocorrencia", "Recusada", "Ocorrencia"].includes(p.status);
  const visitada = (p) => registrada(p) || !!(p.gps_chegou_em || p.gps_saiu_em);
  let ultima = -1;
  paradas.forEach((p, i) => { if (visitada(p)) ultima = i; });
  const atual = paradas.find((p) => p.gps_no_local || p.no_local);
  const proxima = paradas.find((p, i) => i > ultima && !visitada(p) && p !== atual && !p.gps_na_area_em);
  const area = paradas.find(p => p.gps_na_area_em);
  const faltamRegistro = paradas.filter((p) => !registrada(p) && visitada(p) && !p.gps_no_local).length;
  const puladas = paradas.filter((p, i) => i < ultima && !visitada(p)).length;
  const partes = [`🛰 ${paradas.filter(visitada).length}/${paradas.length} lojas visitadas`,
    `${paradas.filter(registrada).length} com registro`];
  const aberta = !viagem.retorno_real && !["Finalizada", "Cancelada"].includes(viagem.status);
  if (aberta && atual) partes.push(`no local: ${atual.loja_nome || "Loja"}`);
  if (aberta && area) partes.push(`${area.gps_na_area_antigo ? 'último sinal na área' : 'na área'}: ${area.loja_nome || 'Loja'} · aguardando confirmação`);
  if (aberta && proxima) partes.push(`próxima: ${proxima.loja_nome || "Loja"}`);
  if (faltamRegistro) partes.push(`📝 ${faltamRegistro} sem registro`);
  if (puladas) partes.push(`⚠️ ${puladas} sem passagem confirmada`);
  return `<div class="tms-roteiro-resumo">${partes.map((p) => `<span class="tms-roteiro-item${p.startsWith("📝") || p.startsWith("⚠️") ? " tms-roteiro-alerta" : ""}">${escapar(p)}</span>`).join("")}</div>`;
}

// Horários salvos e evidências do GPS têm origens distintas.
function tmsHorariosParadaHtml(parada) {
  const hora = h => /^\d{2}:\d{2}(?::\d{2})?$/.test(String(h || '')) ? String(h).slice(0, 5) : '';
  const registro = [];
  if (parada.ocorrencia_id) {
    const ch = hora(parada.ocorrencia_hora_chegada), ini = hora(parada.ocorrencia_inicio_descarga);
    const fim = hora(parada.ocorrencia_termino_descarga), sa = hora(parada.ocorrencia_saida_loja);
    if (ch) registro.push('chegada ' + ch);
    if (ini || fim) registro.push('descarga ' + (ini && fim ? ini + '–' + fim : ini ? 'início ' + ini : 'fim ' + fim));
    if (sa) registro.push('saída ' + sa);
  }
  const partes = registro.length ? ['Registro: ' + registro.join(' · ')] : [];
  const chGps = tmsHoraGps(parada.gps_chegou_em), saGps = tmsHoraGps(parada.gps_saiu_em);
  if (chGps || saGps) {
    const espacada = /sinais espaçados/.test(parada.gps_chegada_detalhe || '');
    partes.push('GPS: ' + [chGps ? 'primeiro sinal na loja ' + chGps : '', saGps ? 'saída ' + saGps : '', espacada ? 'confirmação com sinais espaçados' : ''].filter(Boolean).join(' · '));
  }
  return partes.length ? '<div class="tms-meta tms-horarios-parada">' + partes.map(escapar).join('<br>') + '</div>' : '';
}

function tmsHorariosViagemHtml(viagem) {
  if (viagem.saida_real) return '';
  const saidas = [...new Set((viagem.paradas || []).filter(p => p.ocorrencia_id)
    .map(p => p.ocorrencia_saida_fabrica).filter(h => /^\d{2}:\d{2}$/.test(String(h || ''))))];
  if (!saidas.length) return '';
  const texto = saidas.length === 1 ? 'Saída fábrica informada nos registros: ' + saidas[0]
    : 'Saída fábrica: registros divergentes (' + saidas.join(', ') + ')';
  return '<div class="tms-meta">' + escapar(texto) + '</div>';
}

// Previsao de chegada da parada pendente (GET /tms/viagens, back/previsao-tms.js).
// Hora local (HH:MM) de um instante ISO vindo do GPS.
function tmsHoraGps(iso) {
  return iso ? new Date(iso).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" }) : "";
}

function tmsEtaParadaHtml(parada, viagem) {
  const visitadaGps = !!(parada.gps_chegou_em || parada.gps_saiu_em);
  if (parada.sem_registro || (visitadaGps && !parada.no_local && !parada.ocorrencia_id)) {
    // Com a prova do GPS (back/rastreador-ao-vivo.js anexarVisitas): o
    // caminhao passou aqui — esta loja nao e mais a "proxima".
    if (parada.sem_registro_fonte === "gps" || visitadaGps) {
      const ch = tmsHoraGps(parada.gps_chegou_em), sa = tmsHoraGps(parada.gps_saiu_em);
      const quando = ch && sa ? `${ch}–${sa}` : ch ? `chegou ${ch}` : `saiu ${sa}`;
      const dia = new Date(parada.gps_chegou_em || parada.gps_saiu_em).toLocaleDateString('pt-BR', {timeZone:'America/Sao_Paulo'});
      return ` | <span style="color:#f97316;font-weight:700;" title="O rastreador viu o caminhão nesta loja em ${dia} (${quando}). Falta lançar o registro.">🛰 visitada em ${dia} · ${quando} · 📝 falta lançar o registro</span>`;
    }
    return ` | <span style="color:#f97316;font-weight:700;" title="Uma loja mais adiante na rota já tem registro: esta provavelmente já foi atendida">📝 falta lançar o registro</span>`;
  }
  // Rastreador: o caminhao esta parado nesta loja agora.
  if (parada.no_local) {
    const desde = parada.gps_chegou_em ? ` desde ${tmsHoraGps(parada.gps_chegou_em)}` : "";
    return ` | <span style="color:#16a34a;font-weight:700;" title="O rastreador mostra o caminhão nesta loja agora">📍 no local agora${desde}</span>`;
  }
  if (parada.gps_na_area_em) {
    const hora = tmsHoraGps(parada.gps_na_area_em);
    const texto = parada.gps_na_area_antigo
      ? `último sinal na área da loja às ${hora} · aguardando atualização`
      : `na área da loja às ${hora} · aguardando confirmação de parada`;
    return ` | <span style="color:#d97706;font-weight:700;" title="O GPS já está dentro da área cadastrada. A chegada ainda não foi confirmada por sinais de parada.">📍 ${escapar(texto)}</span>`;
  }
  if (!parada.eta) return "";
  if (parada.eta_passou) {
    const data = parada.eta_em ? ` de ${new Date(parada.eta_em).toLocaleDateString('pt-BR', {timeZone:'America/Sao_Paulo'})}` : '';
    return ` | <span style="color:#d97706;font-weight:700;" title="Esse horário era uma previsão. A passagem pela loja ainda não foi confirmada.">previsão ${escapar(parada.eta)}${escapar(data)} vencida · aguardando confirmação</span>`;
  }
  const at = Number(parada.eta_atraso_min);
  const cor = !Number.isFinite(at) ? "inherit" : at >= 15 ? "#dc2626" : at > 0 ? "#f97316" : "#16a34a";
  const txt = !Number.isFinite(at) ? "" : at > 0 ? ` (+${at} min)` : " (no horário)";
  const dica = parada.eta_fonte === "gps" ? `pela posição real do rastreador (${parada.distancia_km} km até a loja)`
    : parada.eta_fonte === "historico" ? "pelo tempo típico deste trecho" : "pelos km do trecho e velocidade média";
  // Rota de viagem: loja que cai no dia seguinte (pernoite) — em viagem que
  // ja "continua de ontem" o dia seguinte e hoje, nao precisa dizer.
  const hoje = new Intl.DateTimeFormat('en-CA', {timeZone:'America/Sao_Paulo'}).format(new Date());
  const diaEta = parada.eta_em && new Intl.DateTimeFormat('en-CA', {timeZone:'America/Sao_Paulo'}).format(new Date(parada.eta_em));
  const amanha = diaEta ? (diaEta === hoje ? '' : ` em ${new Date(parada.eta_em).toLocaleDateString('pt-BR', {timeZone:'America/Sao_Paulo'})}${parada.eta_pernoite ? ' 🏨' : ''}`)
    : parada.eta_dia_seguinte && !(viagem && viagem.continua_pernoite) ? ` amanhã${parada.eta_pernoite ? " 🏨" : ""}` : "";
  const dicaPernoite = parada.eta_pernoite ? " — a equipe dorme na região e faz esta loja no dia seguinte" : "";
  return ` | <span style="color:${cor};font-weight:700;" title="Previsão ${dica}${dicaPernoite}">${parada.eta_fonte === "gps" ? "🛰" : "🔮"} chega ~${escapar(parada.eta)}${amanha}${txt}</span>`;
}

// Dados da planilha de PROGRAMACAO DE ROTAS (botao "Importar programação"),
// quando a viagem/parada foi criada ou completada por ela. Sao so leitura: o
// que a planilha traz e o TMS tem campo proprio (horario, retirada CX/RT,
// saida) ja foi gravado nos campos normais.
function tmsProgramacaoResumoViagem(viagem) {
  const p = viagem.programacao;
  if (!p || typeof p !== "object") return "";
  const partes = [
    viagem.hora_saida_fabrica ? `Saída prevista ${String(viagem.hora_saida_fabrica).slice(0, 5)}` : "",
    p.edicao_manual ? "Planejamento salvo manualmente" :
      (viagem.checklist_origem_id || p.checklist_id) ? `volumes e materiais do Checklist #${viagem.checklist_origem_id || p.checklist_id}` : "sem checklist de expedição",
  ].filter(Boolean);
  const origem = `Planilha ${p.arquivo || ""}${p.importado_em ? ` · importada em ${formatarDataBR(String(p.importado_em).slice(0, 10))}` : ""}${p.importado_por ? ` por ${p.importado_por}` : ""}`;
  return `<div class="tms-meta tms-programacao-resumo" title="${escapar(origem)}"><span class="tms-resumo-label">Programação</span>${partes.map((p) => `<span>${escapar(p)}</span>`).join("")}</div>`;
}

function tmsProgramacaoTextosParada(parada) {
  const p = parada.programacao;
  if (!p || typeof p !== "object") return [];
  return [p.pes ? `PES ${p.pes}` : ""].filter(Boolean);
}

function tmsProgramacaoResumoParada(parada) {
  const partes = tmsProgramacaoTextosParada(parada);
  return partes.length ? `<div class="tms-meta">🏷️ ${escapar(partes.join(" | "))}</div>` : "";
}

// Monta as tabelas das secoes de remessa (Materiais, Plastico Bolha, Caixa Azul,
// Material de Campanha e Sacola) que vieram do Checklist Expedicao para a parada.
function tmsBadgeCarregado(carregado) {
  return carregado
    ? `<span class="tms-carregado sim">✅ Sim</span>`
    : `<span class="tms-carregado nao">❌ Não</span>`;
}

function tmsTabelaRemessa(titulo, cabecalhos, linhas) {
  if (!linhas.length) return "";
  const ths = cabecalhos.map((h) => `<th>${escapar(h)}</th>`).join("");
  const trs = linhas.map((cols) => `<tr>${cols.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("");
  return `
    <div class="tms-remessa-secao">
      <div class="tms-remessa-titulo">${escapar(titulo)}</div>
      <table data-ordenavel class="tms-remessa-tabela">
        <thead><tr>${ths}</tr></thead>
        <tbody>${trs}</tbody>
      </table>
    </div>`;
}

function tmsRenderRemessas(parada) {
  const r = parada.remessas;
  if (!r || typeof r !== "object") return "";

  const num = (v) => Number(v) || 0;
  const secoes = [];

  secoes.push(tmsTabelaRemessa("📦 Materiais", ["Setor", "Descrição", "Qtd.", "Carregado"],
    (r.materiais || []).map((m) => [escapar(m.setor || "-"), escapar(m.descricao || "-"), num(m.quantidade), tmsBadgeCarregado(m.carregado)])));

  secoes.push(tmsTabelaRemessa("🫧 Plástico Bolha", ["Material", "Carregado"],
    (r.plastico_bolha || []).map((b) => [escapar(b.material || "-"), tmsBadgeCarregado(b.carregado)])));

  secoes.push(tmsTabelaRemessa("🟦 Caixa Azul Vazia", ["Quantidade", "Carregado"],
    (r.caixa_azul || []).map((c) => [num(c.quantidade), tmsBadgeCarregado(c.carregado)])));

  secoes.push(tmsTabelaRemessa("📋 Material de Campanha", ["Campanha", "Adesivo", "Banner", "Folder", "Total", "Carregado"],
    (r.campanha || []).map((c) => [escapar(c.campanha || "-"), num(c.adesivo), num(c.banner), num(c.folder), num(c.total), tmsBadgeCarregado(c.carregado)])));

  secoes.push(tmsTabelaRemessa("🛍️ Sacola", ["Tamanho", "P", "M", "G", "Total", "Carregado"],
    (r.sacolas || []).map((s) => [escapar(s.tamanho || "-"), num(s.p), num(s.m), num(s.g), num(s.total), tmsBadgeCarregado(s.carregado)])));

  const conteudo = secoes.filter(Boolean).join("");
  if (!conteudo) return "";

  const totalItens =
    (r.materiais || []).length + (r.plastico_bolha || []).length + (r.caixa_azul || []).length +
    (r.campanha || []).length + (r.sacolas || []).length;

  return `
    <details class="tms-remessas">
      <summary>📑 Conferência de expedição (${totalItens} ${totalItens === 1 ? "item" : "itens"})</summary>
      <div class="tms-remessas-corpo">${conteudo}</div>
    </details>`;
}

function tmsResumoViagemHtml(viagem) {
  const campo = (nome, valor) => `<div class="tms-resumo-campo"><span class="tms-resumo-label">${nome}</span><strong>${escapar(valor)}</strong></div>`;
  return `<div class="tms-resumo-equipe">
    ${campo("Data", formatarDataBR(viagem.data_viagem))}
    ${campo("Motorista", viagem.motorista_nome || "—")}
    ${campo("Placa", viagem.placa || "—")}
    ${viagem.ajudantes ? campo("Ajudantes", viagem.ajudantes) : ""}
  </div><div class="tms-resumo-carga" aria-label="Totais da carga">
    <span><strong>${tmsTotalViagem(viagem, "volumes_previstos")}</strong> volumes</span>
    <span><strong>${tmsTotalViagem(viagem, "material_campanha")}</strong> mat. campanha</span>
    <span><strong>${tmsSacolaViagem(viagem)}</strong> sacolas</span>
  </div>`;
}

function tmsRenderViagens() {
  const container = document.getElementById("tmsViagensLista");
  if (!container) return;
  tmsRenderKpis();
  tmsRenderGraficos();
  tmsRenderCardOcorrencias();
  if (!tmsState.viagens.length) {
    container.innerHTML = '<p style="color:var(--text-muted);padding:18px 0;">Nenhuma viagem cadastrada para o filtro.</p>';
    return;
  }
  const podeMover = tmsPodeMoverParadas();
  container.innerHTML = tmsState.viagens
    .map(
      (viagem) => `<article class="tms-viagem${tmsClasseViagem(viagem)}" data-viagem-id="${viagem.id}">
        <div class="tms-viagem-head">
          <div class="tms-viagem-info">
            ${viagem.responsavel_monitoramento ? `<span class="tms-resp-badge">📡 Monitoramento: ${escapar(viagem.responsavel_monitoramento)}</span>` : ""}
            ${tmsPernoiteSeloHtml(viagem)}
            <div class="tms-viagem-title">${escapar(tmsCodigoExibicao(viagem))} - ${escapar(viagem.rota_nome || "-")}</div>
            ${tmsResumoViagemHtml(viagem)}

            ${typeof tmsRastreadorHtml === "function" ? tmsRastreadorHtml(viagem) : ""}
            ${tmsRoteiroHtml(viagem)}
            ${tmsHorariosViagemHtml(viagem)}
            ${tmsKmFreteViagem(viagem)}
            ${tmsProgramacaoResumoViagem(viagem)}
          </div>
          <div class="tms-viagem-acoes">
            ${typeof tmsSaidaHtml === "function" ? tmsSaidaHtml(viagem) : ""}
            <select class="tms-status" onchange="tmsAlterarStatusViagem(${viagem.id}, this.value)">
              ${tmsStatusOptions(viagem.status, TMS_STATUS_VIAGEM)}
            </select>
            ${typeof tmsCapaFrente === "function" ? `<button type="button" class="btn-ghost btn-sm" title="Imprimir a capa da frente (só pede o nº do lacre)" onclick="tmsCapaFrente(${viagem.id})">🖨️ Capa</button>` : ""}
            <button type="button" class="btn-blue btn-sm admin-only-action" onclick="tmsEditarViagem(${viagem.id})">Editar</button>
            <button type="button" class="btn-ghost btn-sm admin-only-action" title="Separar as paradas desta viagem em duas ou mais" onclick="tmsAbrirDividir(${viagem.id})">Dividir</button>
            <button type="button" class="btn-red btn-sm admin-only-action" onclick="tmsExcluirViagem(${viagem.id})">Excluir</button>
          </div>
        </div>
        ${(viagem.paradas || [])
          .map(
            (parada, idx, lista) => {
              const comOcorrencia = parada.ocorrencia_teve_problema || TMS_STATUS_COM_OCO.includes(parada.status);
              const entregue = parada.status === "Entregue";
              const iconeParada = comOcorrencia ? "⚠️ " : entregue ? "✅ " : "";
              const ocorrenciaResumo = parada.ocorrencia_id
                ? `<div class="tms-ocorrencia-resumo${comOcorrencia ? "" : " registro-ok"}">${comOcorrencia ? "Ocorrencia" : "Registro"} #${parada.ocorrencia_id}${parada.ocorrencia_tipo ? ` - ${escapar(parada.ocorrencia_tipo)}` : ""}${parada.ocorrencia_dia_seguinte ? " · 🏨 dia seguinte" : ""}</div>`
                : "";
              // Volume no card: volume lancado no registro (se houver) ou o previsto do
              // TMS. Assim, mesmo com a parada zerada no TMS, o volume lancado aparece.
              const volumesCard = tmsVolEntregueParada(parada);
              const prioridadeTexto = ({ 4: "Urgente", 3: "Alta", 1: "Baixa" }[Number(parada.prioridade)] || "Normal");
              return `<div class="tms-parada${tmsClasseParada(parada)}" data-parada-id="${parada.id}">
              <div class="tms-parada-pos">
                <button type="button" class="tms-pos-btn tms-pos-sobe admin-only-action" title="Subir esta loja uma posição" onclick="tmsMoverParadaCard(${viagem.id}, ${parada.id}, -1)" ${idx === 0 ? "disabled" : ""}>▲</button>
                <strong class="tms-parada-num"${podeMover && lista.length > 1 ? ' draggable="true" title="Arraste para mudar a posição da loja"' : ""}>${parada.ordem}</strong>
                <button type="button" class="tms-pos-btn tms-pos-desce admin-only-action" title="Descer esta loja uma posição" onclick="tmsMoverParadaCard(${viagem.id}, ${parada.id}, 1)" ${idx === lista.length - 1 ? "disabled" : ""}>▼</button>
              </div>
              <div>
                <div class="tms-viagem-title">${iconeParada}${escapar(parada.loja_nome || "Loja")}</div>
                <div class="tms-meta">${parada.pes ? `PES ${escapar(parada.pes)} | ` : ""}Prevista: ${escapar(parada.hora_prevista || "--:--")}${parada.hora_prevista_origem === "cadastro" ? " (horário da loja)" : ""}${tmsEtaParadaHtml(parada, viagem)} | Prioridade: ${prioridadeTexto} | Volumes: ${volumesCard} | Mat. campanha: ${parada.material_campanha || 0} | Ret. CX: ${parada.retirada_cx || 0} | Ret. RT: ${parada.retirada_rt || 0} | Sacola: ${tmsSacolaParada(parada)}</div>
                ${tmsProgramacaoResumoParada(parada)}
                ${tmsHorariosParadaHtml(parada)}
                ${ocorrenciaResumo}
                ${typeof tmsMaterialParadaHtml === "function" ? tmsMaterialParadaHtml(viagem, parada) : ""}
                ${tmsRenderRemessas(parada)}
                ${typeof tmsEntregaRapidaHtml === "function" ? tmsEntregaRapidaHtml(viagem, parada) : ""}
              </div>
              <select class="tms-status" onchange="tmsAlterarStatusParada(${parada.id}, this.value)">
                ${tmsStatusOptions(parada.status, TMS_STATUS_PARADA)}
              </select>
              <div class="tms-parada-acoes">
                ${parada.ocorrencia_id
                  ? `<button type="button" class="btn-blue btn-sm" onclick="tmsVerOcorrencia(${parada.ocorrencia_id})">Ver registro</button>`
                  : `<button type="button" class="btn-blue btn-sm" onclick="tmsAbrirOcorrencia(${viagem.id}, ${parada.id})">Lancar registro</button>`}
              </div>
            </div>`;
            },
          )
          .join("")}
      </article>`
    )
    .join("");
}

// ================= MOVER LOJAS (posicao das paradas) =================
// Setas ▲▼ e arrastar pelo numero mudam a sequencia das lojas em dois lugares:
// - formulario (Nova/Editar viagem): a ordem das linhas JA e a ordem que o
//   "Salvar viagem" grava, entao aqui so mexemos no DOM;
// - card da viagem: cada movimento grava sozinho (PUT /tms/viagens/:id/ordem),
//   sem abrir o formulario. ETA/km/retorno previstos vem do servidor e se
//   recalculam no recarregamento que a gravacao dispara.
// Mesma regra do Editar: ADM (setas sao .admin-only-action e o servidor barra
// o OPERADOR pela whitelist).

function tmsPodeMoverParadas() {
  const b = document.body.classList;
  return !b.contains("perfil-operador") && !b.contains("perfil-restrito");
}

// Linhas de parada tem ~100px: sem isto, ao subir uma loja a OUTRA loja cai
// embaixo do mouse e o segundo clique em ▲ move a loja errada. Rola a tela
// para a linha movida ficar onde estava.
function tmsRolavelDe(el) {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const s = getComputedStyle(p);
    if (/(auto|scroll)/.test(s.overflowY) && p.scrollHeight > p.clientHeight) return p;
  }
  return document.scrollingElement || document.documentElement;
}

function tmsManterNaTela(el, topoAntes) {
  if (!el || topoAntes == null) return;
  const delta = el.getBoundingClientRect().top - topoAntes;
  if (delta) tmsRolavelDe(el).scrollTop += delta;
}

function tmsRenumerarParadasForm() {
  const linhas = [...document.querySelectorAll("#tmsParadasForm .tms-parada-form")];
  linhas.forEach((linha, i) => {
    const num = linha.querySelector(".tms-parada-num");
    if (num) num.textContent = String(i + 1);
    const sobe = linha.querySelector(".tms-pos-sobe");
    const desce = linha.querySelector(".tms-pos-desce");
    if (sobe) sobe.disabled = i === 0;
    if (desce) desce.disabled = i === linhas.length - 1;
  });
}

function tmsMoverParadaForm(botao, direcao) {
  const linha = botao.closest(".tms-parada-form");
  const vizinha = direcao < 0 ? linha?.previousElementSibling : linha?.nextElementSibling;
  if (!linha || !vizinha?.classList.contains("tms-parada-form")) return;
  const topo = linha.getBoundingClientRect().top;
  if (direcao < 0) vizinha.before(linha);
  else vizinha.after(linha);
  tmsRenumerarParadasForm();
  tmsRecalcularTotais();
  tmsManterNaTela(linha, topo);
  if (!botao.disabled) botao.focus({ preventScroll: true });
}

function tmsViagemPorId(id) {
  return (tmsState.viagensRaw || []).find((v) => v.id === id) || (tmsState.viagens || []).find((v) => v.id === id);
}

function tmsLinhaParadaCard(viagemId, paradaId) {
  return document.querySelector(`.tms-viagem[data-viagem-id="${viagemId}"] .tms-parada[data-parada-id="${paradaId}"]`);
}

// Aplica a ordem nova no estado (viagensRaw e viagens apontam para os mesmos
// objetos), redesenha na hora e agenda a gravacao.
function tmsReordenarParadasCard(viagemId, idsNaOrdem, movidaId, direcao = 0) {
  const viagem = tmsViagemPorId(viagemId);
  if (!viagem) return;
  const atuais = viagem.paradas || [];
  const porId = new Map(atuais.map((p) => [p.id, p]));
  const nova = idsNaOrdem.map((pid) => porId.get(pid)).filter(Boolean);
  if (nova.length !== atuais.length || nova.every((p, i) => p === atuais[i])) return;
  // So nas setas: no arrastar a loja tem de aparecer onde foi solta.
  const topo = direcao ? tmsLinhaParadaCard(viagemId, movidaId)?.getBoundingClientRect().top : null;
  nova.forEach((p, i) => { p.ordem = i + 1; });
  viagem.paradas = nova;
  tmsRenderViagens();
  const linha = tmsLinhaParadaCard(viagemId, movidaId);
  if (linha) {
    tmsManterNaTela(linha, topo);
    linha.classList.add("tms-pos-movida");
    const botao = direcao ? linha.querySelector(direcao < 0 ? ".tms-pos-sobe" : ".tms-pos-desce") : null;
    if (botao && !botao.disabled) botao.focus({ preventScroll: true });
  }
  tmsAgendarSalvarOrdem(viagemId);
}

function tmsMoverParadaCard(viagemId, paradaId, direcao) {
  const ids = (tmsViagemPorId(viagemId)?.paradas || []).map((p) => p.id);
  const i = ids.indexOf(paradaId);
  const j = i + direcao;
  if (i < 0 || j < 0 || j >= ids.length) return;
  [ids[i], ids[j]] = [ids[j], ids[i]];
  tmsReordenarParadasCard(viagemId, ids, paradaId, direcao);
}

// Varios cliques seguidos viram UMA gravacao (espera 700ms parado). A lista de
// ids e capturada na hora de editar: um recarregamento no meio do caminho nao
// troca a ordem que o usuario escolheu pela antiga do servidor.
const tmsOrdemTimers = new Map();
const tmsOrdensPendentes = new Map();
let tmsOrdemFila = Promise.resolve();
let tmsOrdemEmVoo = 0;

function tmsAgendarSalvarOrdem(viagemId) {
  const ids = (tmsViagemPorId(viagemId)?.paradas || []).map((p) => p.id);
  tmsOrdensPendentes.set(viagemId, ids);
  clearTimeout(tmsOrdemTimers.get(viagemId));
  tmsOrdemTimers.set(viagemId, setTimeout(() => {
    tmsOrdemTimers.delete(viagemId);
    tmsOrdemEmVoo += 1;
    tmsOrdemFila = tmsOrdemFila.then(() => tmsSalvarOrdem(viagemId, ids));
  }, 700));
}

async function tmsSalvarOrdem(viagemId, ids) {
  if (tmsOrdensPendentes.get(viagemId) !== ids) {
    tmsOrdemEmVoo -= 1;
    return;
  }
  let falhou = false;
  try {
    const resposta = await fetch(`${TMS_API}/tms/viagens/${viagemId}/ordem`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paradas: ids }),
    });
    const dados = await resposta.json().catch(() => ({}));
    if (!resposta.ok) {
      // 404 sem JSON = rota inexistente: o servidor ainda roda a versao antiga.
      throw new Error(dados.error || (resposta.status === 404
        ? "o servidor ainda não foi reiniciado com esta função. Por enquanto use Editar → setas ▲▼ → Salvar viagem."
        : "erro ao gravar."));
    }
    // Respostas de GET iniciadas antes da gravacao podem conter a ordem antiga.
    tmsViagensRequisicao += 1;
  } catch (err) {
    falhou = true;
    alertar(`A nova ordem das lojas não foi salva: ${err.message}`);
  } finally {
    tmsOrdemEmVoo -= 1;
    // Uma resposta de um movimento antigo nao descarta um movimento mais novo.
    if (tmsOrdensPendentes.get(viagemId) === ids) tmsOrdensPendentes.delete(viagemId);
  }
  // Falhou: recarrega para a tela voltar a mostrar o que esta gravado.
  // Deu certo: so avisa quando nao ha mais nada pendente (recarrega o TMS com
  // ETA/km da ordem nova sem atropelar um movimento ainda nao gravado).
  if (falhou) await tmsCarregarViagens();
  else if (!tmsOrdemEmVoo && !tmsOrdemTimers.size) {
    await tmsCarregarViagens();
    if (typeof window.dispararMudou === "function") window.dispararMudou("tms");
  }
}

// Arrastar pelo numero (desktop). Vale para o card e para o formulario: so
// troca de lugar entre linhas irmas (mesma viagem / mesmo formulario).
let tmsArrasto = null;

function tmsAlvoArrasto(e) {
  if (!tmsArrasto) return null;
  const alvo = e.target.closest?.(".tms-parada, .tms-parada-form");
  if (!alvo || alvo === tmsArrasto.linha || alvo.parentElement !== tmsArrasto.linha.parentElement) return null;
  const r = alvo.getBoundingClientRect();
  return { alvo, depois: e.clientY > r.top + r.height / 2 };
}

function tmsLimparMarcasArrasto() {
  document.querySelectorAll(".tms-pos-antes, .tms-pos-depois").forEach((el) => el.classList.remove("tms-pos-antes", "tms-pos-depois"));
}

document.addEventListener("dragstart", (e) => {
  const num = e.target.closest?.(".tms-parada-num[draggable]");
  if (!num) return;
  const linha = num.closest(".tms-parada, .tms-parada-form");
  if (!linha || !tmsPodeMoverParadas()) {
    e.preventDefault();
    return;
  }
  tmsArrasto = { linha };
  linha.classList.add("tms-pos-arrastando");
  e.dataTransfer.effectAllowed = "move";
  e.dataTransfer.setData("text/plain", "");
  try { e.dataTransfer.setDragImage(linha, 20, 20); } catch (_) {}
});

document.addEventListener("dragover", (e) => {
  const achado = tmsAlvoArrasto(e);
  if (!achado) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = "move";
  const classe = achado.depois ? "tms-pos-depois" : "tms-pos-antes";
  if (!achado.alvo.classList.contains(classe)) {
    tmsLimparMarcasArrasto();
    achado.alvo.classList.add(classe);
  }
});

document.addEventListener("drop", (e) => {
  const achado = tmsAlvoArrasto(e);
  if (!achado) return;
  e.preventDefault();
  const { linha } = tmsArrasto;
  tmsLimparMarcasArrasto();
  if (linha.classList.contains("tms-parada-form")) {
    if (achado.depois) achado.alvo.after(linha);
    else achado.alvo.before(linha);
    tmsRenumerarParadasForm();
    tmsRecalcularTotais();
    return;
  }
  const card = linha.closest(".tms-viagem");
  const ids = [...card.querySelectorAll(":scope > .tms-parada")]
    .filter((el) => el !== linha)
    .map((el) => Number(el.dataset.paradaId));
  const posAlvo = ids.indexOf(Number(achado.alvo.dataset.paradaId));
  ids.splice(posAlvo + (achado.depois ? 1 : 0), 0, Number(linha.dataset.paradaId));
  tmsReordenarParadasCard(Number(card.dataset.viagemId), ids, Number(linha.dataset.paradaId));
});

document.addEventListener("dragend", () => {
  tmsArrasto?.linha.classList.remove("tms-pos-arrastando");
  tmsArrasto = null;
  tmsLimparMarcasArrasto();
});

// Data de hoje no fuso do navegador (hojeISO() e UTC: depois das 21h ja seria amanha).
function tmsHojeLocalISO() {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

async function tmsCarregarViagens() {
  const requisicao = ++tmsViagensRequisicao;
  const filtro = document.getElementById("tmsFiltroData")?.value || "";
  // Filtro em HOJE: traz tambem a viagem de rota longa de ontem que ainda tem
  // loja pendente (a equipe dormiu fora e termina hoje — back/pernoite.js).
  const pernoite = filtro && filtro === tmsHojeLocalISO() ? "&pernoite=1" : "";
  try {
    const viagens = await tmsRequest(`/tms/viagens${filtro ? `?data=${encodeURIComponent(filtro)}${pernoite}` : ""}`);
    if (requisicao !== tmsViagensRequisicao) return;
    for (const viagem of viagens) {
      const ids = tmsOrdensPendentes.get(viagem.id);
      if (!ids) continue;
      const porId = new Map((viagem.paradas || []).map((p) => [p.id, p]));
      const ordem = ids.map((id) => porId.get(id)).filter(Boolean);
      const conhecidos = new Set(ids);
      // Novas lojas vindas do servidor continuam visiveis; o PUT valida a lista.
      ordem.push(...(viagem.paradas || []).filter((p) => !conhecidos.has(p.id)));
      ordem.forEach((p, i) => { p.ordem = i + 1; });
      viagem.paradas = ordem;
    }
    tmsState.viagensRaw = viagens;
    tmsPopularFiltros();
    tmsAplicarFiltros();
  } catch (err) {
    if (requisicao !== tmsViagensRequisicao) return;
    alertar(`Nao foi possivel carregar viagens: ${err.message}`);
  }
}

// Preenche os selects de filtro (rota / motorista / status) preservando a selecao atual.
function tmsPopularFiltros() {
  const fill = (id, rotulo, montar) => {
    const el = document.getElementById(id);
    if (!el) return;
    const atual = el.value;
    el.innerHTML = `<option value="">${rotulo}</option>${montar(atual)}`;
  };
  fill("tmsFiltroRota", "Todas as rotas", (a) => tmsGetRotas().map((r) => tmsOption(r, r, r === a)).join(""));
  fill("tmsFiltroMotorista", "Todos os motoristas", (a) => MOTORISTAS_LISTA.map((m) => tmsOption(m, m, m === a)).join(""));
  fill("tmsFiltroStatus", "Todos os status", (a) =>
    TMS_STATUS_VIAGEM.map((s) => tmsOption(s, s, s === a)).join("") +
    `<option value="__oco" ${a === "__oco" ? "selected" : ""}>Com ocorrencia</option>`
  );
}

// Um responsavel pode ser combinado, ex.: "RAFAEL MENDES E PRISCILA". Ao filtrar por
// uma pessoa, as viagens monitoradas por ambos tambem devem aparecer. Por isso
// comparamos por pessoa (separadas por " E "), e nao por igualdade exata do texto.
function tmsResponsavelCorresponde(responsavelViagem, selecionado) {
  if (!selecionado) return true;
  const pessoasViagem = String(responsavelViagem || "")
    .split(" E ")
    .map((p) => p.trim())
    .filter(Boolean);
  const pessoasSelecionadas = String(selecionado)
    .split(" E ")
    .map((p) => p.trim())
    .filter(Boolean);
  return pessoasSelecionadas.every((p) => pessoasViagem.includes(p));
}

// Aplica os filtros do cliente (rota/motorista/status/busca) sobre o conjunto ja carregado.
function tmsAplicarFiltros() {
  const rota = document.getElementById("tmsFiltroRota")?.value || "";
  const motorista = document.getElementById("tmsFiltroMotorista")?.value || "";
  const responsavel = document.getElementById("tmsFiltroResponsavel")?.value || "";
  const status = document.getElementById("tmsFiltroStatus")?.value || "";
  const busca = (document.getElementById("tmsFiltroBusca")?.value || "").trim().toLowerCase();

  tmsState.viagens = (tmsState.viagensRaw || []).filter((v) => {
    if (rota && v.rota_nome !== rota) return false;
    if (motorista && v.motorista_nome !== motorista) return false;
    if (!tmsResponsavelCorresponde(v.responsavel_monitoramento, responsavel)) return false;
    if (status === "__oco") {
      const temOco = (v.paradas || []).some((p) => p.ocorrencia_teve_problema || TMS_STATUS_COM_OCO.includes(p.status));
      if (!temOco) return false;
    } else if (status && v.status !== status) {
      return false;
    }
    if (busca) {
      const alvo = [
        tmsCodigoExibicao(v),
        v.rota_nome,
        v.motorista_nome,
        v.placa,
        ...(v.paradas || []).map((p) => p.loja_nome),
        // PES da planilha de programacao tambem acha a viagem.
        ...(v.paradas || []).flatMap((p) => tmsProgramacaoTextosParada(p)),
      ].filter(Boolean).join(" ").toLowerCase();
      if (!alvo.includes(busca)) return false;
    }
    return true;
  });
  tmsRenderViagens();
}

async function tmsAlterarStatusViagem(id, status) {
  try {
    await tmsRequest(`/tms/viagens/${id}/status`, { method: "PUT", body: JSON.stringify({ status }) });
    await tmsCarregarViagens();
    if (typeof window.dispararMudou === "function") window.dispararMudou("tms");
  } catch (err) {
    alertar(err.message);
  }
}

function tmsExcluirViagem(id) {
  const viagem = tmsState.viagens.find((item) => item.id === id);
  const codigo = viagem ? tmsCodigoExibicao(viagem) : `Viagem ${id}`;
  confirmarSimples(`Deseja excluir ${codigo} e todas as suas paradas?`, async () => {
    try {
      await tmsRequest(`/tms/viagens/${id}`, { method: "DELETE" });
      await tmsCarregarViagens();
      if (typeof window.dispararMudou === "function") window.dispararMudou("tms");
      alertar("Viagem excluida com sucesso.");
    } catch (err) {
      alertar(`Nao foi possivel excluir a viagem: ${err.message}`);
    }
  });
}

async function tmsAlterarStatusParada(id, status) {
  try {
    await tmsRequest(`/tms/paradas/${id}/status`, { method: "PUT", body: JSON.stringify({ status }) });
    await tmsCarregarViagens();
    if (typeof window.dispararMudou === "function") window.dispararMudou("tms");
  } catch (err) {
    alertar(err.message);
  }
}

async function tmsVerOcorrencia(ocorrenciaId) {
  irParaAba("entregas");
  if (typeof carregarHistorico === "function") await carregarHistorico(true);
  if (typeof editarOcorrencia === "function") editarOcorrencia(ocorrenciaId);
}

// Converte o nome da loja vindo do TMS (ex.: "SAO P ALDEIA", com espacos)
// de volta para a CHAVE ja cadastrada em lojasRotas (ex.: "SAO_P_ALDEIA").
// Assim o formulario seleciona a loja existente em vez de criar uma duplicata.
function tmsResolverLojaKey(nome) {
  if (!nome) return "";
  const norm = (s) =>
    String(s)
      .trim()
      .toUpperCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "");
  const alvo = norm(nome);
  const alvoUnderscore = alvo.replace(/\s+/g, "_");
  const chaves = typeof lojasRotas === "object" ? Object.keys(lojasRotas) : [];
  // 1) bate com a chave (com underscore) ou com o proprio nome
  let chave = chaves.find((k) => norm(k) === alvoUnderscore || norm(k) === alvo);
  // 2) bate com o nome formatado (com espacos)
  if (!chave && typeof formatarNomeLoja === "function") {
    chave = chaves.find((k) => norm(formatarNomeLoja(k)) === alvo);
  }
  return chave || nome;
}

// ==================================================================
// RASCUNHO da ocorrencia aberta pelo TMS.
// Se o registro e aberto pela parada do TMS e o usuario fecha sem salvar
// (ex.: ligou pro CLLR e deu ocupado), o que ja foi digitado fica salvo no
// navegador e volta ao reabrir a MESMA parada — sem precisar refazer. E limpo
// ao salvar com sucesso ou ao clicar em "Descartar". So vale para ocorrencias
// abertas pelo TMS (quando ha window.tmsOcorrenciaContexto.parada_id).
// ==================================================================
const TMS_RASCUNHO_MULTI_GRUPOS = ["ajudantes", "tipoOcorrencia", "ocorrenciaResponsavel"];
const TMS_RASCUNHO_PREFIXO = "tms_oc_rascunho_v1_";
const TMS_RASCUNHO_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 dias

function tmsRascunhoKey(paradaId) {
  return TMS_RASCUNHO_PREFIXO + paradaId;
}

// Serializa o estado atual do formulario de ocorrencia (campos + grupos multi).
// Ignora fotos/canhoto/assinatura (base64 grande, estouraria o localStorage).
function tmsColetarRascunho() {
  const f = document.getElementById("form");
  if (!f) return null;
  const campos = {};
  f.querySelectorAll("input, textarea, select").forEach((el) => {
    if (!el.id || TMS_RASCUNHO_MULTI_GRUPOS.includes(el.id)) return;
    if (["file", "button", "submit", "reset"].includes(el.type)) return;
    if (/foto|canhoto|assinatura/i.test(el.id)) return;
    if (el.type === "checkbox" || el.type === "radio") campos[el.id] = el.checked;
    else if (el.multiple) campos[el.id] = Array.from(el.selectedOptions).map((o) => o.value);
    else campos[el.id] = el.value;
  });
  const multi = {};
  TMS_RASCUNHO_MULTI_GRUPOS.forEach((g) => {
    multi[g] = typeof selecionadosGrupo === "function" ? selecionadosGrupo(g) : [];
  });
  return { campos, multi, ts: Date.now() };
}

function tmsSalvarRascunho(paradaId) {
  if (paradaId == null) return;
  try {
    const r = tmsColetarRascunho();
    if (r) localStorage.setItem(tmsRascunhoKey(paradaId), JSON.stringify(r));
  } catch (_) { /* quota/localStorage indisponivel: ignora */ }
}

function tmsLimparRascunho(paradaId) {
  if (paradaId != null) { try { localStorage.removeItem(tmsRascunhoKey(paradaId)); } catch (_) {} }
  document.getElementById("tmsRascunhoBanner")?.remove();
}

// Remove rascunhos vencidos (> TTL) para nao acumular no navegador.
function tmsPrunarRascunhos() {
  try {
    const agora = Date.now();
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(TMS_RASCUNHO_PREFIXO)) continue;
      let ts = 0;
      try { ts = (JSON.parse(localStorage.getItem(k)) || {}).ts || 0; } catch (_) {}
      if (!ts || agora - ts > TMS_RASCUNHO_TTL_MS) localStorage.removeItem(k);
    }
  } catch (_) {}
}

// Restaura o rascunho no formulario. Retorna true se havia algo salvo.
function tmsRestaurarRascunho(paradaId) {
  let raw = null;
  try { raw = localStorage.getItem(tmsRascunhoKey(paradaId)); } catch (_) { return false; }
  if (!raw) return false;
  let d;
  try { d = JSON.parse(raw); } catch (_) { return false; }
  if (!d || !d.campos) return false;
  if (d.ts && Date.now() - d.ts > TMS_RASCUNHO_TTL_MS) { tmsLimparRascunho(paradaId); return false; }

  // 1) valores (sem disparar eventos ainda)
  Object.entries(d.campos).forEach(([id, val]) => {
    const el = document.getElementById(id);
    if (!el) return;
    if (el.type === "checkbox" || el.type === "radio") el.checked = !!val;
    else if (el.multiple && Array.isArray(val)) Array.from(el.options).forEach((o) => (o.selected = val.includes(o.value)));
    // Rascunho vazio nao apaga pre-preenchimento do TMS. tmsColetarRascunho salva
    // TODO campo, inclusive em branco, entao um rascunho antigo (feito antes de o
    // campo passar a ser pre-preenchido) sobrescrevia o valor com "". Com conteudo
    // real o rascunho continua prevalecendo, que e o comportamento esperado.
    else if (val !== "" || !el.value) el.value = val;
  });
  // 2) grupos multi: marca os checkboxes + sincroniza contadores/campo hidden
  if (d.multi && typeof marcarGrupoMulti === "function") {
    Object.entries(d.multi).forEach(([g, arr]) => marcarGrupoMulti(g, (arr || []).join(",")));
  }
  // 3) dispara os toggles/calculos: change nos selects (revela os paineis) e input
  //    nos volumes (recalcula divergencia). NAO dispara em dataOcorrencia para nao
  //    re-rodar a escala automatica por cima do rascunho.
  const f = document.getElementById("form");
  if (f) {
    f.querySelectorAll("select").forEach((s) => s.dispatchEvent(new Event("change", { bubbles: true })));
    ["volumeGerencial", "volumeFisico"].forEach((id) =>
      document.getElementById(id)?.dispatchEvent(new Event("input", { bubbles: true })));
  }
  tmsMostrarBannerRascunho(paradaId);
  return true;
}

function tmsMostrarBannerRascunho(paradaId) {
  const form = document.getElementById("form");
  if (!form) return;
  document.getElementById("tmsRascunhoBanner")?.remove();
  const banner = document.createElement("div");
  banner.id = "tmsRascunhoBanner";
  banner.style.cssText =
    "margin:8px 0;padding:8px 12px;border-radius:8px;background:rgba(59,130,246,.12);" +
    "border:1px solid rgba(59,130,246,.45);font-size:13px;display:flex;justify-content:space-between;" +
    "align-items:center;gap:12px;flex-wrap:wrap;";
  const texto = document.createElement("span");
  texto.textContent = "📝 Rascunho recuperado do último preenchimento desta parada.";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "btn-red btn-sm";
  btn.textContent = "Descartar e recomeçar";
  btn.onclick = () => {
    tmsLimparRascunho(paradaId);
    const ctx = window.tmsOcorrenciaContexto;
    if (ctx && ctx.parada_id != null) tmsAbrirOcorrencia(ctx.viagem_id, ctx.parada_id);
  };
  banner.appendChild(texto);
  banner.appendChild(btn);
  form.prepend(banner);
}

// Autosave: salva o rascunho a cada edicao REAL do usuario (isTrusted, ignora
// os pre-preenchimentos programaticos) enquanto o form estiver no contexto de
// uma parada do TMS. Anexado uma unica vez.
function tmsInitRascunhoAutosave() {
  if (window._tmsRascunhoAutosaveAtivo) return;
  window._tmsRascunhoAutosaveAtivo = true;
  let timer = null;
  const handler = (e) => {
    if (!e || !e.isTrusted) return;
    const ctx = window.tmsOcorrenciaContexto;
    if (!ctx || ctx.parada_id == null) return;
    const form = document.getElementById("form");
    if (!form || !form.contains(e.target)) return;
    clearTimeout(timer);
    timer = setTimeout(() => tmsSalvarRascunho(ctx.parada_id), 400);
  };
  document.addEventListener("input", handler, true);
  document.addEventListener("change", handler, true);
}

function tmsAbrirOcorrencia(viagemId, paradaId) {
  const viagem = tmsState.viagens.find((v) => v.id === viagemId);
  const parada = viagem?.paradas.find((p) => p.id === paradaId);
  if (!viagem || !parada) return;
  tmsInitRascunhoAutosave();
  tmsPrunarRascunhos();
  irParaAba("entregas");
  setTimeout(() => {
    abrirForm();
    document.getElementById("tmsRascunhoBanner")?.remove();
    window.tmsOcorrenciaContexto = { viagem_id: viagem.id, parada_id: parada.id, rota: viagem.rota_nome || "" };
    const loja = tmsResolverLojaKey(parada.loja_nome);
    garantirOpcaoSelect("loja", loja);
    garantirOpcaoSelect("motorista", viagem.motorista_nome);
    garantirOpcaoSelect("placa", viagem.placa);
    preencherCampo("loja", loja);
    preencherCampo("motorista", viagem.motorista_nome);
    preencherCampo("placa", viagem.placa);
    preencherCampo("dataOcorrencia", String(viagem.data_viagem || "").split("T")[0]);
    preencherCampo("horaAgendadaLoja", String(parada.hora_prevista || "").slice(0, 5));
    // Puxa o volume planejado da parada do TMS para o Volume Gerencial.
    const volTms = parada.volumes_previstos ?? viagem.volumes_previstos ?? "";
    if (volTms !== "" && volTms !== null) {
      preencherCampo("volumeGerencial", volTms);
    }
    // Puxa material de campanha (numerico) e sacolas por tamanho do TMS para a ocorrencia.
    const matTms = parada.material_campanha ?? viagem.material_campanha ?? "";
    if (matTms !== "" && matTms !== null) {
      preencherCampo("materialCampanhaQtd", matTms);
    }
    [
      ["sacolaP", parada.sacola_p ?? viagem.sacola_p],
      ["sacolaM", parada.sacola_m ?? viagem.sacola_m],
      ["sacolaG", parada.sacola_g ?? viagem.sacola_g],
    ].forEach(([campo, valor]) => {
      if (valor !== "" && valor !== null && valor !== undefined) {
        preencherCampo(campo, valor);
      }
    });
    // Puxa as retiradas planejadas da parada para os campos "Previsto".
    // A guarda aqui e > 0, e nao o teste dos irmaos acima, porque retirada_cx/rt
    // sao INTEGER NOT NULL DEFAULT 0: com aquele teste, toda parada sem retirada
    // carimbaria "0" no formulario, trocando "nao preenchido" por "conferido e deu zero".
    [
      ["retiradaCxPrevista", parada.retirada_cx],
      ["retiradaRtPrevista", parada.retirada_rt],
    ].forEach(([campo, valor]) => {
      if (Number(valor) > 0) preencherCampo(campo, valor);
    });
    marcarGrupoMulti("ajudantes", viagem.ajudantes || "");
    // Puxa as secoes de remessa do checklist (Materiais, Plastico Bolha, Caixa Azul,
    // Material de Campanha e Sacola) desta parada para o painel da ocorrencia.
    tmsPreencherExpedicaoOcorrencia(parada.remessas);
    // Rota de viagem: mostra "🏨 Entregue no dia seguinte" e ja marca quando a
    // previsao pos esta loja no 2o dia (pernoite-form.js). A data continua a da viagem.
    if (typeof pernoiteFormDoTms === "function") pernoiteFormDoTms({
      // Visita do GPS manda (data real da chegada); sem ela, a previsao.
      sugerirDiaSeguinte: parada.gps_chegou_em
        ? new Date(parada.gps_chegou_em).toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" }) > String(viagem.data_viagem || "").slice(0, 10)
        : !!parada.eta_dia_seguinte && String(viagem.data_viagem || "").slice(0, 10) < tmsHojeLocalISO(),
    });
    // Recupera o que ja foi preenchido antes (caso tenha fechado sem salvar). Roda
    // apos o atualizarDadosOcorrenciaPeloDia (timer interno do abrirForm, ~200ms)
    // para o rascunho prevalecer sobre os pre-preenchimentos.
    setTimeout(() => tmsRestaurarRascunho(parada.id), 350);
  }, 100);
}

// Preenche o painel "Conferencia de Expedicao" do formulario de ocorrencia
// com as secoes de remessa da parada (somente leitura). Reaproveita os mesmos
// montadores de tabela usados na lista do TMS.
function tmsPreencherExpedicaoOcorrencia(remessas) {
  const panel = document.getElementById("ocExpedicaoPanel");
  const corpo = document.getElementById("ocExpedicaoRemessas");
  if (!panel || !corpo) return;
  if (!remessas || typeof remessas !== "object") {
    panel.classList.add("hidden");
    corpo.innerHTML = "";
    return;
  }
  const num = (v) => Number(v) || 0;
  const secoes = [
    tmsTabelaRemessa("📦 Materiais", ["Setor", "Descrição", "Qtd.", "Carregado"],
      (remessas.materiais || []).map((m) => [escapar(m.setor || "-"), escapar(m.descricao || "-"), num(m.quantidade), tmsBadgeCarregado(m.carregado)])),
    tmsTabelaRemessa("🫧 Plástico Bolha", ["Material", "Carregado"],
      (remessas.plastico_bolha || []).map((b) => [escapar(b.material || "-"), tmsBadgeCarregado(b.carregado)])),
    tmsTabelaRemessa("🟦 Caixa Azul Vazia", ["Quantidade", "Carregado"],
      (remessas.caixa_azul || []).map((c) => [num(c.quantidade), tmsBadgeCarregado(c.carregado)])),
    tmsTabelaRemessa("📋 Material de Campanha", ["Campanha", "Adesivo", "Banner", "Folder", "Total", "Carregado"],
      (remessas.campanha || []).map((c) => [escapar(c.campanha || "-"), num(c.adesivo), num(c.banner), num(c.folder), num(c.total), tmsBadgeCarregado(c.carregado)])),
    tmsTabelaRemessa("🛍️ Sacola", ["Tamanho", "P", "M", "G", "Total", "Carregado"],
      (remessas.sacolas || []).map((s) => [escapar(s.tamanho || "-"), num(s.p), num(s.m), num(s.g), num(s.total), tmsBadgeCarregado(s.carregado)])),
  ].filter(Boolean);
  if (!secoes.length) {
    panel.classList.add("hidden");
    corpo.innerHTML = "";
    return;
  }
  corpo.innerHTML = `<div class="tms-remessas-corpo" style="padding:0;">${secoes.join("")}</div>`;
  panel.classList.remove("hidden");
}

function tmsLimparFiltro() {
  ["tmsFiltroData", "tmsFiltroRota", "tmsFiltroMotorista", "tmsFiltroResponsavel", "tmsFiltroStatus", "tmsFiltroBusca"].forEach((id) => {
    const campo = document.getElementById(id);
    if (campo) campo.value = "";
  });
  tmsCarregarViagens();
}

async function tmsAtualizar() {
  try {
    // Ao abrir o TMS, ja deixa o filtro de data no dia atual (mostra so as
    // viagens de hoje em vez de todas). O usuario pode limpar para ver tudo.
    const filtroData = document.getElementById("tmsFiltroData");
    if (filtroData && !filtroData.value) filtroData.value = tmsHojeLocalISO();
    await tmsCarregarViagens();
  } catch (err) {
    alertar(`Falha ao abrir modulo TMS: ${err.message}`);
  }
}

// ================= IMPORTACAO DO CHECKLIST EXPEDICAO =================
const tmsImportState = { lista: [], escolhas: new Map() };

function tmsImportEl(id) { return document.getElementById(id); }

function tmsAbrirImportarChecklist() {
  const modal = tmsImportEl("tmsModalImportar");
  if (!modal) return;
  modal.classList.remove("hidden");
  const hoje = new Date().toISOString().slice(0, 10);
  const inputData = tmsImportEl("tmsImportData");
  if (inputData && !inputData.value) inputData.value = hoje;
  tmsImportState.lista = [];
  tmsImportState.escolhas = new Map();
  tmsImportEl("tmsImportLista").innerHTML = `<p style="padding:24px;text-align:center;color:var(--text-muted);">Clique em <b>Buscar</b> para listar os checklists do dia.</p>`;
  tmsImportEl("tmsImportInfo").textContent = "";
  tmsAtualizarBtnImportar();
}

function tmsFecharImportarChecklist() {
  const modal = tmsImportEl("tmsModalImportar");
  if (modal) modal.classList.add("hidden");
}

async function tmsCarregarChecklistsDisponiveis() {
  const data = tmsImportEl("tmsImportData").value;
  if (!data) { alertar("Informe a data."); return; }
  const lista = tmsImportEl("tmsImportLista");
  lista.innerHTML = `<p style="padding:24px;text-align:center;color:var(--text-muted);">Buscando checklists...</p>`;
  try {
    const itens = await tmsRequest(`/tms/checklist-expedicao/disponiveis?data=${encodeURIComponent(data)}`);
    tmsImportState.lista = itens;
    tmsImportState.escolhas = new Map();
    tmsRenderListaChecklists();
  } catch (err) {
    lista.innerHTML = `<p style="padding:24px;text-align:center;color:var(--vermelho);">Erro: ${err.message}</p>`;
  }
}

// Cada escolha guarda { motorista, placa, ajudantes[] } por checklist.
function tmsImportEscolha(id) {
  id = Number(id);
  let e = tmsImportState.escolhas.get(id);
  if (!e) { e = { motorista: "", placa: "", ajudantes: [] }; tmsImportState.escolhas.set(id, e); }
  return e;
}

function tmsRenderListaChecklists() {
  const itens = tmsImportState.lista;
  const lista = tmsImportEl("tmsImportLista");
  const info = tmsImportEl("tmsImportInfo");
  if (!itens.length) {
    lista.innerHTML = `<p style="padding:24px;text-align:center;color:var(--text-muted);">Nenhum checklist encontrado para a data informada.</p>`;
    info.textContent = "";
    tmsAtualizarBtnImportar();
    return;
  }
  const motoristas = Array.isArray(MOTORISTAS_LISTA) ? MOTORISTAS_LISTA : [];

  const cards = itens.map((c) => {
    const dataEntrega = String(c.delivery_date || "").slice(0, 10);
    const importada = c.ja_importado;
    const placaChecklist = String(c.vehicle_plate || "").trim();
    const statusBadge = c.status === "FINALIZADO"
      ? `<span style="background:#dcfce7;color:#166534;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:700;">FINALIZADO</span>`
      : `<span style="background:#fef3c7;color:#92400e;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:700;">EM ANDAMENTO</span>`;

    const meta = `<span style="color:var(--text-muted);">📅 ${dataEntrega || "-"}</span>
      <span style="color:var(--text-muted);">🗺️ ${c.route_name || "-"}</span>
      <span style="color:var(--text-muted);">🏬 ${c.store_count || 0} loja(s)</span>`;

    if (importada) {
      return `<div style="border:1px solid var(--border);border-radius:10px;padding:12px 14px;margin-bottom:10px;background:var(--bg-base);opacity:.7;">
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
          <b style="font-size:13px;">Checklist #${c.id}</b>
          ${statusBadge}
          <span style="background:#dbeafe;color:#1e40af;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:700;">${c.viagem_codigo || "JÁ IMPORTADO"}</span>
          <span style="font-size:11px;color:var(--text-muted);">Placa ${placaChecklist || "-"}</span>
        </div>
        <div style="display:flex;gap:14px;flex-wrap:wrap;font-size:11px;margin-top:6px;">${meta}</div>
      </div>`;
    }

    // pré-preenche a placa com a do checklist (auto)
    const esc = tmsImportEscolha(c.id);
    if (!esc.placa && placaChecklist) esc.placa = placaChecklist;

    const optsMot = `<option value="">Selecione...</option>` +
      motoristas.map((m) => `<option value="${m}" ${esc.motorista === m ? "selected" : ""}>${m}</option>`).join("");
    // garante que a placa do checklist apareça mesmo se não estiver na lista padrão
    const placas = [...new Set([...(placaChecklist ? [placaChecklist] : []), ...TMS_PLACAS])];
    const optsPlaca = `<option value="">Selecione...</option>` +
      placas.map((p) => `<option value="${p}" ${esc.placa === p ? "selected" : ""}>${p}</option>`).join("");
    const ajChecks = TMS_AJUDANTES.map((a) =>
      `<label style="display:flex;align-items:center;gap:6px;font-size:12px;padding:4px 6px;cursor:pointer;white-space:nowrap;">
        <input type="checkbox" class="tms-aj-check" data-id="${c.id}" value="${a}" ${esc.ajudantes.includes(a) ? "checked" : ""} onchange="tmsImportToggleAjudante(this)" /> ${a}
      </label>`).join("");
    const resumoAj = esc.ajudantes.length ? `${esc.ajudantes.length} ajudante(s)` : "Ajudantes...";

    return `<div style="border:1px solid var(--border);border-radius:10px;padding:12px 14px;margin-bottom:10px;background:var(--bg-overlay);">
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-weight:700;font-size:13px;">
          <input type="checkbox" class="tms-import-check" data-id="${c.id}" onchange="tmsAtualizarBtnImportar()" style="width:16px;height:16px;" />
          Checklist #${c.id}
        </label>
        ${statusBadge}
        ${placaChecklist ? `<span style="background:#ecfeff;color:#0e7490;border:1px solid #a5f3fc;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:700;" title="Placa puxada do checklist">🚚 ${placaChecklist}</span>` : `<span style="background:#fee2e2;color:#b91c1c;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:700;">sem placa no checklist</span>`}
      </div>
      <div style="display:flex;gap:14px;flex-wrap:wrap;font-size:11px;margin:8px 0 10px;">${meta}</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
        <div>
          <label style="display:block;font-size:10px;font-weight:700;color:var(--text-secondary);text-transform:uppercase;letter-spacing:.5px;margin-bottom:3px;">Motorista *</label>
          <select class="tms-import-input" data-id="${c.id}" onchange="tmsImportSetCampo(this,'motorista')" style="width:100%;padding:7px 9px;border:1px solid var(--border-md);border-radius:8px;font-size:13px;">${optsMot}</select>
        </div>
        <div>
          <label style="display:block;font-size:10px;font-weight:700;color:var(--text-secondary);text-transform:uppercase;letter-spacing:.5px;margin-bottom:3px;">Placa *</label>
          <select class="tms-import-input" data-id="${c.id}" onchange="tmsImportSetCampo(this,'placa')" style="width:100%;padding:7px 9px;border:1px solid var(--border-md);border-radius:8px;font-size:13px;">${optsPlaca}</select>
        </div>
        <div style="grid-column:1/-1;">
          <label style="display:block;font-size:10px;font-weight:700;color:var(--text-secondary);text-transform:uppercase;letter-spacing:.5px;margin-bottom:3px;">Ajudantes</label>
          <details style="border:1px solid var(--border-md);border-radius:8px;background:var(--bg-base);">
            <summary style="padding:7px 9px;font-size:13px;cursor:pointer;list-style:none;color:var(--text-secondary);" id="tmsAjResumo-${c.id}">${resumoAj}</summary>
            <div style="display:flex;flex-wrap:wrap;gap:2px 12px;padding:6px 10px;border-top:1px solid var(--border);max-height:160px;overflow:auto;">${ajChecks}</div>
          </details>
        </div>
      </div>
    </div>`;
  }).join("");

  lista.innerHTML = cards;
  const disponiveis = itens.filter((c) => !c.ja_importado).length;
  info.textContent = `${itens.length} checklist(s) | ${disponiveis} disponível(is) | ${itens.length - disponiveis} já importado(s)`;
  tmsAtualizarBtnImportar();
}

function tmsImportSetCampo(el, campo) {
  const esc = tmsImportEscolha(el.dataset.id);
  esc[campo] = el.value;
  tmsAtualizarBtnImportar();
}

function tmsImportToggleAjudante(el) {
  const esc = tmsImportEscolha(el.dataset.id);
  const nome = el.value;
  const i = esc.ajudantes.indexOf(nome);
  if (el.checked && i < 0) esc.ajudantes.push(nome);
  else if (!el.checked && i >= 0) esc.ajudantes.splice(i, 1);
  const resumo = document.getElementById(`tmsAjResumo-${el.dataset.id}`);
  if (resumo) resumo.textContent = esc.ajudantes.length ? `${esc.ajudantes.length} ajudante(s)` : "Ajudantes...";
}

function tmsAtualizarBtnImportar() {
  const btn = tmsImportEl("tmsBtnImportar");
  if (!btn) return;
  const checks = [...document.querySelectorAll(".tms-import-check:checked")];
  const pendentes = checks.filter((c) => {
    const e = tmsImportState.escolhas.get(Number(c.dataset.id)) || {};
    return !e.motorista || !e.placa;
  }).length;
  btn.disabled = checks.length === 0 || pendentes > 0;
  btn.textContent = checks.length === 0
    ? "Importar selecionados"
    : pendentes > 0
      ? `Defina motorista e placa (${pendentes} pendente${pendentes > 1 ? "s" : ""})`
      : `Importar ${checks.length} viagem(ens)`;
}

async function tmsConfirmarImportarChecklists() {
  console.log("[IMPORT] clique em Importar selecionados");
  const checks = [...document.querySelectorAll(".tms-import-check:checked")];
  console.log("[IMPORT] checkboxes marcados:", checks.length, "escolhas:", [...tmsImportState.escolhas.entries()]);
  const itens = checks.map((c) => {
    const id = Number(c.dataset.id);
    const e = tmsImportState.escolhas.get(id) || {};
    return {
      checklist_id: id,
      motorista: e.motorista,
      placa: e.placa,
      ajudantes: (e.ajudantes || []).join(", "),
    };
  }).filter((x) => x.motorista && x.placa);
  console.log("[IMPORT] itens a enviar:", itens);
  if (itens.length === 0) {
    alertar("Selecione checklists e defina motorista e placa (nenhum item valido para enviar).");
    return;
  }
  const btn = tmsImportEl("tmsBtnImportar");
  btn.disabled = true;
  btn.textContent = "Importando...";
  try {
    console.log("[IMPORT] enviando POST /tms/checklist-expedicao/importar", { itens });
    const resp = await tmsRequest("/tms/checklist-expedicao/importar", {
      method: "POST",
      body: JSON.stringify({ itens })
    });
    console.log("[IMPORT] resposta do servidor:", resp);
    const importadas = Array.isArray(resp?.importadas) ? resp.importadas : [];
    const erros = Array.isArray(resp?.erros) ? resp.erros : [];
    const okMsg = importadas.length
      ? `${importadas.length} viagem(ens) importada(s): ${importadas.map((i) => i.codigo).join(", ")}`
      : "";
    const errMsg = erros.length
      ? `\n${erros.length} com erro:\n${erros.map((e) => `- #${e.checklist_id}: ${e.error}`).join("\n")}`
      : "";
    alertar((okMsg || "Nada importado.") + errMsg);
    tmsFecharImportarChecklist();
    await tmsCarregarViagens();
  } catch (err) {
    console.error("[IMPORT] falha na importacao:", err);
    alertar(`Falha na importacao: ${err.message}`);
  } finally {
    tmsAtualizarBtnImportar();
  }
}

// ================= DIVIDIR VIAGEM =================
// Reparte as paradas de UMA viagem ja cadastrada em duas ou mais. Nasceu do
// caso real: a carga sai como uma rota so e no meio do dia vira duas (segundo
// veiculo, motorista que assume metade das lojas). Ate agora o jeito era
// apagar a viagem e recadastrar tudo — perdendo ocorrencia, remessa e historico
// das paradas ja atendidas.
//
// A viagem 1 e SEMPRE a original: fica com o id, o codigo, os custos e o km
// (ratear custo aqui seria chute). As demais nascem com motorista/placa
// proprios e custo/km em branco, para o usuario preencher no "Editar" de
// sempre. Quem move as paradas de fato e o servidor
// (POST /tms/viagens/:id/dividir): la a parada so troca de viagem_id, entao
// ocorrencia, remessas, pedidos, CTE e status seguem junto com ela.
const TMS_DIVIDIR_MAX = 6; // espelha o limite do servidor
const TMS_RESPONSAVEIS = ["RAFAEL MENDES", "PRISCILA", "LARISSA", "RAFAEL MENDES E PRISCILA"];

// atrib: parada_id -> indice do grupo (0 = fica na original).
// config: um objeto por grupo; o do indice 0 nunca e usado (a viagem 1 nao
// muda de motorista aqui — para isso existe o "Editar").
const tmsDividirState = { viagemId: null, atrib: new Map(), config: [] };

function tmsDividirViagem() {
  return (tmsState.viagens || []).find((v) => v.id === tmsDividirState.viagemId);
}

function tmsDividirConfigVazia() {
  return { motorista: "", placa: "", rota: "", hora: "", responsavel: "", observacao: "", ajudantes: [] };
}

function tmsAbrirDividir(id) {
  const viagem = (tmsState.viagens || []).find((item) => item.id === id);
  const modal = document.getElementById("tmsModalDividir");
  if (!viagem || !modal) return;
  const paradas = viagem.paradas || [];
  if (paradas.length < 2) {
    alertar("Esta viagem tem menos de duas paradas — nao ha o que dividir.");
    return;
  }
  tmsDividirState.viagemId = id;
  tmsDividirState.atrib = new Map(paradas.map((p) => [p.id, 0]));
  tmsDividirState.config = [tmsDividirConfigVazia(), tmsDividirConfigVazia()];
  const codigo = document.getElementById("tmsDividirCodigo");
  if (codigo) codigo.textContent = tmsCodigoExibicao(viagem);
  modal.classList.remove("hidden");
  tmsDividirRender();
}

function tmsFecharDividir() {
  document.getElementById("tmsModalDividir")?.classList.add("hidden");
  tmsDividirState.viagemId = null;
}

// Passa o que esta escolhido nos cartoes para o state. Tem que rodar ANTES de
// qualquer re-render (adicionar/remover grupo), senao o motorista que o usuario
// ja tinha escolhido na viagem 2 some quando ele cria a viagem 3.
function tmsDividirLerConfig() {
  document.querySelectorAll("#tmsDividirCorpo [data-grupo-cfg]").forEach((card) => {
    const cfg = tmsDividirState.config[Number(card.dataset.grupoCfg)];
    if (!cfg) return;
    const v = (sel) => card.querySelector(sel)?.value ?? "";
    cfg.motorista = v(".tms-div-motorista");
    cfg.placa = v(".tms-div-placa");
    cfg.rota = v(".tms-div-rota");
    cfg.hora = v(".tms-div-hora");
    cfg.responsavel = v(".tms-div-responsavel");
    cfg.observacao = v(".tms-div-obs");
    cfg.ajudantes = [...card.querySelectorAll(".tms-div-aj:checked")].map((el) => el.value);
  });
}

function tmsDividirAdicionarGrupo() {
  if (tmsDividirState.config.length >= TMS_DIVIDIR_MAX) {
    alertar(`Da para dividir em no maximo ${TMS_DIVIDIR_MAX} viagens de uma vez.`);
    return;
  }
  tmsDividirLerConfig();
  tmsDividirState.config.push(tmsDividirConfigVazia());
  tmsDividirRender();
}

function tmsDividirRemoverGrupo() {
  if (tmsDividirState.config.length <= 2) {
    alertar("A divisao precisa de pelo menos duas viagens.");
    return;
  }
  tmsDividirLerConfig();
  const removido = tmsDividirState.config.length - 1;
  tmsDividirState.config.pop();
  // As paradas que estavam no grupo removido voltam para a viagem original.
  // Sem isto elas apontariam para um grupo que nao existe mais e o servidor
  // recusaria a divisao inteira ("parada que nao pertence a esta viagem").
  tmsDividirState.atrib.forEach((g, pid) => {
    if (g >= removido) tmsDividirState.atrib.set(pid, 0);
  });
  tmsDividirRender();
}

// Paradas de um grupo, na ordem em que aparecem hoje na viagem — essa ordem
// vira a ordem das paradas na viagem resultante.
function tmsDividirParadasDo(grupo) {
  const viagem = tmsDividirViagem();
  return (viagem?.paradas || []).filter((p) => (tmsDividirState.atrib.get(p.id) ?? 0) === grupo);
}

function tmsDividirSetParada(select) {
  tmsDividirState.atrib.set(Number(select.dataset.parada), Number(select.value));
  tmsDividirAtualizarContagem();
}

// So os numeros: nao re-renderiza, para nao derrubar o foco de quem esta
// escolhendo motorista/placa nos cartoes.
function tmsDividirAtualizarContagem() {
  const total = tmsDividirState.config.length;
  let vazios = 0;
  for (let i = 0; i < total; i += 1) {
    const paradas = tmsDividirParadasDo(i);
    const volumes = paradas.reduce((s, p) => s + (Number(p.volumes_previstos) || 0), 0);
    if (!paradas.length) vazios += 1;
    const alvo = document.querySelector(`[data-grupo-conta="${i}"]`);
    if (alvo) {
      alvo.textContent = paradas.length
        ? `${paradas.length} ${paradas.length === 1 ? "parada" : "paradas"} · ${volumes} volumes`
        : "nenhuma parada";
      alvo.style.color = paradas.length ? "var(--text-muted)" : "var(--vermelho)";
    }
  }
  const resumo = document.getElementById("tmsDividirResumo");
  if (resumo) {
    resumo.textContent = vazios
      ? `${vazios} ${vazios === 1 ? "viagem ficou" : "viagens ficaram"} sem parada`
      : `${total} viagens · toda parada distribuida`;
    resumo.style.color = vazios ? "var(--vermelho)" : "var(--text-muted)";
  }
  const btn = document.getElementById("tmsBtnDividir");
  if (btn) btn.disabled = vazios > 0;
}

function tmsDividirRender() {
  const corpo = document.getElementById("tmsDividirCorpo");
  const viagem = tmsDividirViagem();
  if (!corpo || !viagem) return;
  const total = tmsDividirState.config.length;
  const motoristas = Array.isArray(MOTORISTAS_LISTA) ? MOTORISTAS_LISTA : [];
  const rotas = tmsGetRotas();
  const opts = (lista, atual) => lista.map((v) => tmsOption(v, v, v === atual)).join("");

  const cartao = (i) => {
    const cfg = tmsDividirState.config[i];
    const conta = `<span data-grupo-conta="${i}" style="font-size:11px;color:var(--text-muted);font-weight:600;"></span>`;
    if (i === 0) {
      return `<div style="border:1px solid var(--border);border-left:3px solid var(--azul);border-radius:10px;padding:10px 14px;background:var(--bg-base);">
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
          <strong style="font-size:13px;color:var(--text-heading);">Viagem 1 — ${escapar(tmsCodigoExibicao(viagem))}</strong>
          <span style="font-size:9px;font-weight:800;letter-spacing:.5px;color:var(--azul);background:rgba(56,189,248,.12);padding:2px 6px;border-radius:5px;">CONTINUA A ORIGINAL</span>
          ${conta}
        </div>
        <div style="font-size:11px;color:var(--text-muted);margin-top:4px;">
          ${escapar(viagem.motorista_nome || "-")} · ${escapar(viagem.placa || "-")} · ${escapar(viagem.rota_nome || "-")} — custos e km ficam aqui. Para trocar o motorista dela, use o "Editar".
        </div>
      </div>`;
    }
    return `<div data-grupo-cfg="${i}" style="border:1px solid var(--border);border-left:3px solid var(--verde);border-radius:10px;padding:10px 14px;background:var(--bg-base);">
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:8px;">
        <strong style="font-size:13px;color:var(--text-heading);">Viagem ${i + 1}</strong>
        <span style="font-size:9px;font-weight:800;letter-spacing:.5px;color:var(--verde);background:rgba(34,197,94,.12);padding:2px 6px;border-radius:5px;">NOVA</span>
        ${conta}
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px;">
        <div><label style="font-size:10px;font-weight:700;color:var(--text-secondary);">Motorista *</label>
          <select class="tms-div-motorista"><option value="">Selecione</option>${opts(motoristas, cfg.motorista)}</select></div>
        <div><label style="font-size:10px;font-weight:700;color:var(--text-secondary);">Veiculo *</label>
          <select class="tms-div-placa"><option value="">Selecione</option>${opts(TMS_PLACAS, cfg.placa)}</select></div>
        <div><label style="font-size:10px;font-weight:700;color:var(--text-secondary);">Rota</label>
          <select class="tms-div-rota"><option value="">Mesma da original</option>${opts(rotas, cfg.rota)}</select></div>
        <div><label style="font-size:10px;font-weight:700;color:var(--text-secondary);">Saida da fabrica</label>
          <input type="time" class="tms-div-hora" value="${escapar(cfg.hora)}" title="Em branco herda o horario da viagem original" /></div>
        <div><label style="font-size:10px;font-weight:700;color:var(--text-secondary);">Monitoramento</label>
          <select class="tms-div-responsavel"><option value="">Mesmo da original</option>${opts(TMS_RESPONSAVEIS, cfg.responsavel)}</select></div>
        <div><label style="font-size:10px;font-weight:700;color:var(--text-secondary);">Observacao</label>
          <input type="text" class="tms-div-obs" value="${escapar(cfg.observacao)}" placeholder="opcional" /></div>
      </div>
      <details style="margin-top:8px;">
        <summary style="font-size:11px;font-weight:700;color:var(--text-secondary);cursor:pointer;">Ajudantes${cfg.ajudantes.length ? ` (${cfg.ajudantes.length})` : ""}</summary>
        <div class="multi-check-grid" style="margin-top:6px;">
          ${TMS_AJUDANTES.map((aj) => `<label class="multi-check-card"><input type="checkbox" class="tms-div-aj" value="${escapar(aj)}" ${cfg.ajudantes.includes(aj) ? "checked" : ""} /> ${escapar(aj)}</label>`).join("")}
        </div>
      </details>
    </div>`;
  };

  const opcoesGrupo = (atual) =>
    Array.from({ length: total }, (_, i) =>
      `<option value="${i}" ${i === atual ? "selected" : ""}>Viagem ${i + 1}${i === 0 ? " (fica)" : ""}</option>`
    ).join("");

  const linhaParada = (p) => {
    const g = tmsDividirState.atrib.get(p.id) ?? 0;
    // Parada com registro lancado muda de viagem junto com a ocorrencia (o
    // servidor reaponta o viagem_id dela). Avisa em vez de bloquear: dividir
    // no meio do dia, com metade ja entregue, e justamente o caso de uso.
    const marca = p.ocorrencia_id
      ? `<span title="Ja tem registro lancado — ele vai junto com a parada" style="font-size:9px;font-weight:800;color:var(--amarelo,#f59e0b);background:rgba(245,158,11,.12);padding:2px 6px;border-radius:5px;">REGISTRO #${p.ocorrencia_id}</span>`
      : "";
    return `<div style="display:flex;align-items:center;gap:10px;padding:8px 12px;border:1px solid var(--border);border-radius:10px;margin-bottom:6px;background:var(--bg-base);">
      <strong style="min-width:22px;text-align:center;font-size:12px;color:var(--text-muted);">${p.ordem}</strong>
      <div style="flex:1;min-width:0;">
        <div style="font-size:13px;font-weight:600;color:var(--text-heading);">${escapar(p.loja_nome || "Loja")} ${marca}</div>
        <div style="font-size:11px;color:var(--text-muted);">${escapar(String(p.hora_prevista || "--:--").slice(0, 5))} · ${Number(p.volumes_previstos) || 0} volumes · ${escapar(p.status || "-")}</div>
      </div>
      <select class="tms-status" data-parada="${p.id}" onchange="tmsDividirSetParada(this)" style="flex-shrink:0;">${opcoesGrupo(g)}</select>
    </div>`;
  };

  corpo.innerHTML =
    `<div style="display:grid;gap:10px;margin-bottom:14px;">${Array.from({ length: total }, (_, i) => cartao(i)).join("")}</div>` +
    `<div style="font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.6px;font-weight:700;margin:2px 0 8px;">Paradas — escolha o destino de cada uma</div>` +
    (viagem.paradas || []).map(linhaParada).join("");

  const addBtn = document.getElementById("tmsDividirAddBtn");
  if (addBtn) addBtn.disabled = total >= TMS_DIVIDIR_MAX;
  const delBtn = document.getElementById("tmsDividirDelBtn");
  if (delBtn) delBtn.disabled = total <= 2;
  tmsDividirAtualizarContagem();
}

async function tmsConfirmarDividir() {
  tmsDividirLerConfig();
  const viagem = tmsDividirViagem();
  if (!viagem) return;
  const total = tmsDividirState.config.length;

  const grupos = [];
  for (let i = 0; i < total; i += 1) {
    const paradas = tmsDividirParadasDo(i).map((p) => p.id);
    if (!paradas.length) {
      alertar(`A viagem ${i + 1} ficou sem nenhuma parada.`);
      return;
    }
    if (i === 0) {
      grupos.push({ paradas });
      continue;
    }
    const cfg = tmsDividirState.config[i];
    if (!cfg.motorista || !cfg.placa) {
      alertar(`Informe motorista e veiculo da viagem ${i + 1}.`);
      return;
    }
    grupos.push({
      paradas,
      motorista: cfg.motorista,
      placa: cfg.placa,
      ajudantes: cfg.ajudantes.join(", "),
      rota: cfg.rota,
      hora_saida_fabrica: cfg.hora,
      responsavel_monitoramento: cfg.responsavel,
      observacao: cfg.observacao,
    });
  }

  const resumo = grupos
    .map((g, i) => `Viagem ${i + 1}${i === 0 ? " (a original)" : ` - ${g.motorista} / ${g.placa}`}: ${g.paradas.length} parada(s)`)
    .join("\n");
  const ok = await confirmarBonito(
    `Dividir ${tmsCodigoExibicao(viagem)} em ${total} viagens?\n\n${resumo}\n\nOs custos e o km continuam na viagem original.`,
    { okLabel: "Dividir", cancelLabel: "Cancelar" }
  );
  if (!ok) return;

  const btn = document.getElementById("tmsBtnDividir");
  if (btn) btn.disabled = true;
  try {
    const r = await tmsRequest(`/tms/viagens/${viagem.id}/dividir`, {
      method: "POST",
      body: JSON.stringify({ grupos }),
    });
    tmsFecharDividir();
    await tmsCarregarViagens();
    if (typeof window.dispararMudou === "function") window.dispararMudou("tms");
    const codigos = (r.criadas || []).map((c) => c.codigo).join(", ");
    alertar(`Viagem dividida. Nova(s) viagem(ns): ${codigos || "-"}. Lance o km e os custos delas pelo "Editar".`);
  } catch (err) {
    alertar(`Nao foi possivel dividir a viagem: ${err.message}`);
  } finally {
    if (btn) btn.disabled = false;
  }
}

window.tmsAbrirViagem = tmsAbrirViagem;
window.tmsFecharViagem = tmsFecharViagem;
window.tmsAdicionarParada = tmsAdicionarParada;
window.tmsRemoverParada = tmsRemoverParada;
window.tmsMoverParadaForm = tmsMoverParadaForm;
window.tmsMoverParadaCard = tmsMoverParadaCard;
window.tmsRecalcularTotais = tmsRecalcularTotais;
window.tmsSalvarViagem = tmsSalvarViagem;
window.tmsEditarViagem = tmsEditarViagem;
window.tmsCarregarViagens = tmsCarregarViagens;
window.tmsAlterarStatusViagem = tmsAlterarStatusViagem;
window.tmsExcluirViagem = tmsExcluirViagem;
window.tmsAbrirDividir = tmsAbrirDividir;
window.tmsFecharDividir = tmsFecharDividir;
window.tmsDividirAdicionarGrupo = tmsDividirAdicionarGrupo;
window.tmsDividirRemoverGrupo = tmsDividirRemoverGrupo;
window.tmsDividirSetParada = tmsDividirSetParada;
window.tmsConfirmarDividir = tmsConfirmarDividir;
window.tmsAlterarStatusParada = tmsAlterarStatusParada;
window.tmsAbrirOcorrencia = tmsAbrirOcorrencia;
window.tmsVerOcorrencia = tmsVerOcorrencia;
window.tmsLimparFiltro = tmsLimparFiltro;
window.tmsAplicarFiltros = tmsAplicarFiltros;
window.tmsAtualizar = tmsAtualizar;
window.tmsAbrirImportarChecklist = tmsAbrirImportarChecklist;
window.tmsFecharImportarChecklist = tmsFecharImportarChecklist;
window.tmsCarregarChecklistsDisponiveis = tmsCarregarChecklistsDisponiveis;
window.tmsImportSetCampo = tmsImportSetCampo;
window.tmsImportToggleAjudante = tmsImportToggleAjudante;
window.tmsAtualizarBtnImportar = tmsAtualizarBtnImportar;
window.tmsConfirmarImportarChecklists = tmsConfirmarImportarChecklists;
