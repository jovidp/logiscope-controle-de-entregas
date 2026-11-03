// ================================================================
// responsavel-sugerido.js — o formulario de ocorrencia ja vem com o
// RESPONSAVEL marcado, pelo tipo de problema
// ----------------------------------------------------------------
// GET /ocorrencias/responsavel-sugerido aprende do historico quem costuma ser
// responsavel por cada tipo (ex.: "Mercadoria a mais" -> EXPEDICAO em 25 de
// 25). Ao marcar o tipo, se ninguem escolheu responsavel ainda, as caixinhas
// do responsavel sao pre-marcadas e aparece de onde veio a sugestao. Sempre
// editavel: depois que a pessoa mexe no responsavel, a sugestao vira so dica.
//
// As caixinhas multi (script-4) param a propagacao do "change" na captura,
// entao aqui embrulhamos sincronizarGrupoMulti / marcarGrupoMulti /
// limparGrupoMulti para saber quando o tipo ou o responsavel mudaram e se
// a mudanca veio da pessoa ou do sistema (carregar/limpar formulario).
// ================================================================
(function () {
  "use strict";

  const GRUPO_TIPO = "tipoOcorrencia";
  const GRUPO_RESP = "ocorrenciaResponsavel";

  let sugestoes = null;      // { tipo: { casos, responsaveis:[{responsavel,n,pct}] } }
  let tocouResp = false;     // a pessoa mexeu no responsavel -> nao sobrescrever
  let aplicando = false;     // a mudanca do responsavel e nossa
  let programatico = 0;      // dentro de marcar/limpar chamados pelo sistema
  let ultimaSugestao = "";

  const esc = (v) => (typeof window.escapar === "function"
    ? window.escapar(v == null ? "" : v)
    : String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])));
  const valores = (id) => String(document.getElementById(id)?.value || "")
    .split(/,|;|\|/).map((v) => v.trim()).filter(Boolean);
  // Mesmo conjunto, independente da ordem (as caixinhas seguem a ordem da tela).
  const chave = (lista) => [...lista].sort().join("|");

  async function carregar() {
    try {
      const r = await fetch(`${window.location.origin}/ocorrencias/responsavel-sugerido`, { headers: { Accept: "application/json" } });
      if (!r.ok) return;
      sugestoes = (await r.json()).sugestoes || {};
      aplicarSugestao();
    } catch (_) { /* sem sugestao: o formulario segue como antes */ }
  }

  // Responsaveis sugeridos para os tipos marcados + explicacao.
  function calcular() {
    const tipos = valores(GRUPO_TIPO);
    const resp = [], motivos = [];
    for (const t of tipos) {
      const s = sugestoes && sugestoes[t];
      if (!s) continue;
      const top = s.responsaveis[0];
      for (const x of s.responsaveis) if (!resp.includes(x.responsavel)) resp.push(x.responsavel);
      motivos.push(`${t} → ${top.responsavel} em ${top.n} de ${s.casos} casos`);
    }
    return { resp, motivos };
  }

  function dica(html) {
    const contador = document.querySelector(`[data-multi-count="${GRUPO_RESP}"]`);
    if (!contador) return;
    let el = document.getElementById("respSugeridoDica");
    if (!el) {
      el = document.createElement("div");
      el.id = "respSugeridoDica";
      el.style.cssText = "font-size:0.72rem;margin-top:4px;color:var(--text-muted);";
      contador.insertAdjacentElement("afterend", el);
    }
    el.innerHTML = html;
  }

  function aplicarSugestao() {
    if (!sugestoes || typeof window.marcarGrupoMulti !== "function") return;
    const { resp, motivos } = calcular();
    const atual = chave(valores(GRUPO_RESP));
    const sugestao = resp.join(", ");
    if (!tocouResp && (atual === "" || atual === ultimaSugestao) && chave(resp) !== atual) {
      aplicando = true;
      try { window.marcarGrupoMulti(GRUPO_RESP, sugestao); } finally { aplicando = false; }
      ultimaSugestao = chave(resp);
    }
    if (!resp.length) { dica(""); return; }
    const usada = chave(valores(GRUPO_RESP)) === chave(resp);
    dica(usada
      ? `💡 <b>Sugerido pelo histórico:</b> ${esc(motivos.join(" · "))}. Confira — pode desmarcar ou trocar.`
      : `💡 Sugestão do histórico: <b>${esc(sugestao)}</b> (${esc(motivos.join(" · "))}).`);
  }

  function embrulhar() {
    const sinc = window.sincronizarGrupoMulti, marcar = window.marcarGrupoMulti, limpar = window.limparGrupoMulti;
    if (typeof sinc !== "function" || typeof marcar !== "function" || typeof limpar !== "function") return false;

    window.marcarGrupoMulti = function (grupo, valor) {
      programatico += 1;
      try { return marcar.apply(this, arguments); } finally { programatico -= 1; }
    };
    window.limparGrupoMulti = function (grupo) {
      programatico += 1;
      try { return limpar.apply(this, arguments); } finally { programatico -= 1; }
    };
    window.sincronizarGrupoMulti = function (grupo) {
      const ret = sinc.apply(this, arguments);
      try {
        if (grupo === GRUPO_RESP && !aplicando) {
          const vazio = !valores(GRUPO_RESP).length;
          if (programatico > 0) {
            // Formulario carregado/limpo pelo sistema: so conta como "da pessoa"
            // se ja veio com responsavel (ocorrencia antiga editada).
            tocouResp = !vazio;
            ultimaSugestao = "";
            if (vazio) setTimeout(aplicarSugestao, 0);
          } else {
            tocouResp = true; // clique da pessoa — respeita, ate se desmarcou tudo
            aplicarSugestao(); // so atualiza o texto da dica
          }
        } else if (grupo === GRUPO_TIPO) {
          if (programatico > 0 && !valores(GRUPO_TIPO).length) { tocouResp = false; ultimaSugestao = ""; }
          aplicarSugestao();
        }
      } catch (_) { /* nunca quebrar o formulario */ }
      return ret;
    };
    return true;
  }

  function iniciar() {
    if (!embrulhar()) { setTimeout(iniciar, 500); return; }
    carregar();
    setInterval(carregar, 30 * 60 * 1000);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", iniciar);
  else iniciar();
})();
