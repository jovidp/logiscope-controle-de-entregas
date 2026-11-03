// ================================================================
// AUTOFILL de relacionamentos
// Ao escolher o MOTORISTA nos formularios de "Atraso de Saida" e "Tempo de
// Rota", sugere automaticamente a PLACA e a ROTA mais usadas por ele,
// derivadas do historico ja carregado em cache (atrasos_saida + rotas_
// registradas). Preenche apenas campos VAZIOS (e uma sugestao, nao imposicao:
// o usuario pode trocar). Reusa os helpers globais do sistema.
// (Loja -> Rota ja e tratado no form de ocorrencia por preencherEscalaAutomatica.)
// ================================================================
(function iniciarAutofill() {
  // Agrega o historico por motorista (canonico). Recalcula a cada uso: os
  // caches sao pequenos e assim sempre reflete lancamentos recentes.
  function agregarPorMotorista() {
    const mapa = {};
    const add = (motorista, placa, rota) => {
      const nome = String(motorista || "").trim();
      if (!nome) return;
      const chave = typeof chaveMotoristaCanonica === "function"
        ? chaveMotoristaCanonica(nome)
        : nome.toUpperCase();
      if (!chave) return;
      const m = (mapa[chave] ||= { placas: {}, rotas: {} });
      const p = String(placa || "").trim();
      const r = String(rota || "").trim();
      if (p) m.placas[p] = (m.placas[p] || 0) + 1;
      if (r) m.rotas[r] = (m.rotas[r] || 0) + 1;
    };
    const ler = (chave) => (typeof lerStorage === "function" ? lerStorage(chave) : []) || [];
    // LS.atrasos = "atrasosSaidaFabrica" | LS.rotas = "rotasRegistradas"
    const atrasos = typeof LS !== "undefined" ? ler(LS.atrasos) : [];
    const rotas = typeof LS !== "undefined" ? ler(LS.rotas) : [];
    atrasos.forEach((a) => add(a.motorista, a.placa, a.rota));
    rotas.forEach((r) => add(r.motorista, r.placa, r.rotaFeita));
    return mapa;
  }

  function maisFrequente(contagem) {
    let melhor = "";
    let max = 0;
    for (const [k, v] of Object.entries(contagem || {})) {
      if (v > max) { max = v; melhor = k; }
    }
    return melhor;
  }

  function sugestoes(motorista) {
    const chave = typeof chaveMotoristaCanonica === "function"
      ? chaveMotoristaCanonica(motorista)
      : String(motorista || "").toUpperCase();
    const info = agregarPorMotorista()[chave];
    if (!info) return null;
    return { placa: maisFrequente(info.placas), rota: maisFrequente(info.rotas) };
  }

  // Flash discreto pra mostrar que o campo foi preenchido automaticamente.
  function flash(el) {
    const alvo = el.closest(".select-search-wrap") || el;
    const orig = alvo.style.backgroundColor;
    alvo.style.transition = "background-color .2s";
    alvo.style.backgroundColor = "rgba(56,189,248,.20)";
    setTimeout(() => { alvo.style.backgroundColor = orig; }, 900);
  }

  function jaTemValor(id) {
    return typeof getVal === "function" && String(getVal(id) || "").trim() !== "";
  }

  function preencherSelect(id, valor, somenteSeExistir) {
    if (!valor || jaTemValor(id)) return;
    const el = document.getElementById(id);

    // somenteSeExistir: sugestao que nao esta na lista NAO entra.
    // A sugestao sai do historico, e o historico deste sistema tem grafia
    // propria ("N. FLUMINENSE" onde o cadastro diz "NORTE FLUMINENSE"). Inserir
    // a sugestao como opcao nova faria o campo continuar gerando grafia solta —
    // exatamente o que a troca para select veio resolver. Sem correspondencia,
    // o campo fica vazio e quem preenche escolhe da lista.
    if (somenteSeExistir) {
      const combina = el && [...el.options].some((o) => o.value === valor);
      if (!combina) return;
    } else if (typeof garantirOpcaoSelect === "function") {
      garantirOpcaoSelect(id, valor);
    }

    if (typeof setVal === "function") setVal(id, valor);
    if (el) { el.dispatchEvent(new Event("change", { bubbles: true })); flash(el); }
  }

  function preencherInput(id, valor) {
    if (!valor || jaTemValor(id)) return;
    if (typeof setVal === "function") setVal(id, valor);
    const el = document.getElementById(id);
    if (el) { el.dispatchEvent(new Event("input", { bubbles: true })); flash(el); }
  }

  // Liga o autofill a um select de motorista, apontando os campos a preencher.
  function ligar(motoristaId, alvos) {
    const sel = document.getElementById(motoristaId);
    if (!sel || sel.dataset.autofill === "1") return;
    sel.dataset.autofill = "1";
    sel.addEventListener("change", () => {
      const motorista = typeof getVal === "function" ? getVal(motoristaId) : "";
      if (!motorista) return;
      const s = sugestoes(motorista);
      if (!s) return;
      if (alvos.placaId) preencherSelect(alvos.placaId, s.placa);
      // Rota: so aceita sugestao que exista na lista (ver preencherSelect).
      if (alvos.rotaSelectId) preencherSelect(alvos.rotaSelectId, s.rota, true);
      if (alvos.rotaInputId) preencherInput(alvos.rotaInputId, s.rota);
    });
  }

  function iniciar() {
    // Atraso de Saida da Fabrica (placa e rota sao selects)
    ligar("motoristaAtrasoSaida", { placaId: "placaAtrasoSaida", rotaSelectId: "rotaAtrasoSaida" });
    // Tempo/Retorno de Rota. rotaFeita virou SELECT (era texto livre): usa
    // rotaSelectId, que passa por garantirOpcaoSelect e nao perde valor fora
    // da lista.
    ligar("motoristaRota", { placaId: "placaRota", rotaSelectId: "rotaFeita" });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", iniciar);
  } else {
    iniciar();
  }
})();
