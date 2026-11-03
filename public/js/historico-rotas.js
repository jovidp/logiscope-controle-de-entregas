// ================================================================
// Histórico de Rotas por Motorista
// ================================================================

let _historicoRotasInicializado = false;

function _hrEsc(v) {
  return typeof escapar === "function"
    ? escapar(v)
    : String(v == null ? "" : v).replace(/[&<>"']/g, (c) =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
      );
}

function _hrNorm(v) {
  return String(v || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .trim();
}

function _hrMinHora(hora) {
  const m = String(hora || "").match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(min) || min > 59) return null;
  return h * 60 + min;
}

function _hrDiff(saida, retorno) {
  const a = _hrMinHora(saida);
  const b = _hrMinHora(retorno);
  if (a == null || b == null) return null;
  let diff = b - a;
  if (diff < 0) diff += 1440;
  return diff;
}

function _hrTotalMin(r) {
  const direto = Number(r?.totalMin ?? r?.total_min);
  if (Number.isFinite(direto) && direto > 0) return Math.round(direto);

  const horas = Number(r?.horas);
  const minutos = Number(r?.minutos);
  if (Number.isFinite(horas) || Number.isFinite(minutos)) {
    const total =
      (Number.isFinite(horas) ? horas * 60 : 0) +
      (Number.isFinite(minutos) ? minutos : 0);
    if (total > 0) return Math.round(total);
  }

  return _hrDiff(r?.saida, r?.retorno);
}

function _hrTempo(min) {
  const n = Number(min);
  if (!Number.isFinite(n)) return "-";
  return typeof formatarTempo === "function" ? formatarTempo(n) : `${Math.round(n)}min`;
}

function _hrDataFormatada(data) {
  return typeof formatarDataBR === "function" ? formatarDataBR(data) : data || "-";
}

function _hrData(r) {
  return String(r?.data || r?.data_rota || "").split("T")[0];
}

function _hrRota(r) {
  const rota = r?.rotaFeita || r?.rota_feita || r?.rota || r?.rota_nome || "";
  return String(rota || "Sem rota informada").trim();
}

function _hrRegistros() {
  const lista =
    typeof lerStorage === "function" && typeof LS !== "undefined" ? lerStorage(LS.rotas) : [];
  return (Array.isArray(lista) ? lista : [])
    .map((r) => ({ ...r, _totalMin: _hrTotalMin(r), _rotaLabel: _hrRota(r), _dataISO: _hrData(r) }))
    .filter((r) => r.motorista || r._rotaLabel || Number.isFinite(r._totalMin));
}

function _hrMedia(lista) {
  const tempos = lista.map((r) => r._totalMin).filter((v) => Number.isFinite(v));
  if (!tempos.length) return null;
  return Math.round(tempos.reduce((s, v) => s + v, 0) / tempos.length);
}

function _hrInjectCss() {
  if (document.getElementById("historicoRotasCss")) return;
  const css = `
    .hr-filtros{display:grid;grid-template-columns:repeat(5,minmax(150px,1fr));gap:10px;margin-bottom:14px;align-items:end}
    .hr-filtros label{display:block;font-size:11px;color:var(--text-muted);font-weight:800;margin-bottom:5px;text-transform:uppercase;letter-spacing:.3px}
    .hr-filtros input,.hr-filtros select{width:100%;min-height:38px;border:1px solid var(--border);border-radius:8px;background:var(--bg-base);color:var(--text-heading);padding:8px 10px;font:inherit;font-size:13px}
    .hr-kpis{display:grid;grid-template-columns:repeat(4,minmax(150px,1fr));gap:10px;margin:12px 0 14px}
    .hr-kpi{border:1px solid var(--border);border-radius:8px;background:var(--bg-elevated);padding:12px}
    .hr-kpi span{display:block;color:var(--text-muted);font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.35px}
    .hr-kpi strong{display:block;color:var(--text-heading);font-size:22px;line-height:1.2;margin-top:4px;font-variant-numeric:tabular-nums}
    .hr-grid{display:grid;grid-template-columns:minmax(280px,.9fr) minmax(420px,1.4fr);gap:14px;align-items:start}
    .hr-painel{border:1px solid var(--border);border-radius:8px;background:var(--bg-elevated);overflow:hidden}
    .hr-painel h3{margin:0;padding:12px 14px;border-bottom:1px solid var(--border);font-size:13px;color:var(--text-heading)}
    .hr-lista{display:flex;flex-direction:column}
    .hr-grupo{border:0;border-bottom:1px solid var(--border);background:transparent;color:inherit;text-align:left;padding:11px 14px;cursor:pointer;font:inherit}
    .hr-grupo:hover{background:rgba(56,189,248,.07)}
    .hr-grupo strong{display:block;color:var(--text-heading);font-size:13px}
    .hr-grupo small{display:block;color:var(--text-muted);font-size:11px;margin-top:3px}
    .hr-table-wrap{overflow:auto}
    .hr-table{width:100%;min-width:880px;border-collapse:collapse;font-size:12px}
    .hr-table th{position:sticky;top:0;background:var(--bg-base);color:var(--text-muted);text-transform:uppercase;font-size:10px;letter-spacing:.35px;text-align:left;padding:9px;border-bottom:1px solid var(--border)}
    .hr-table td{padding:9px;border-bottom:1px solid var(--border);color:var(--text-secondary);vertical-align:top}
    .hr-table td strong{color:var(--text-heading)}
    .hr-tempo{font-weight:800;color:var(--text-heading);font-variant-numeric:tabular-nums;white-space:nowrap}
    .hr-empty{padding:18px;text-align:center;color:var(--text-muted);font-size:13px;border:1px dashed var(--border);border-radius:8px;background:rgba(255,255,255,.02)}
    @media (max-width: 980px){.hr-filtros{grid-template-columns:repeat(2,minmax(0,1fr))}.hr-kpis{grid-template-columns:repeat(2,minmax(0,1fr))}.hr-grid{grid-template-columns:1fr}}
    @media (max-width: 620px){.hr-filtros,.hr-kpis{grid-template-columns:1fr}}
  `;
  const style = document.createElement("style");
  style.id = "historicoRotasCss";
  style.textContent = css;
  document.head.appendChild(style);
}

function historicoRotasInit() {
  _hrInjectCss();
  const app = document.getElementById("historicoRotasApp");
  if (!app) return;

  if (!_historicoRotasInicializado) {
    app.innerHTML = `
      <div class="hr-filtros">
        <div><label>De</label><input type="date" id="hrDataDe" onchange="historicoRotasRender()"></div>
        <div><label>Até</label><input type="date" id="hrDataAte" onchange="historicoRotasRender()"></div>
        <div><label>Motorista</label><select id="hrMotorista" onchange="historicoRotasRender()"><option value="">Todos</option></select></div>
        <div><label>Rota</label><select id="hrRota" onchange="historicoRotasRender()"><option value="">Todas</option></select></div>
        <div><label>Busca</label><input type="search" id="hrBusca" placeholder="Placa, rota ou observação" oninput="historicoRotasRender()"></div>
      </div>
      <div id="hrKpis" class="hr-kpis"></div>
      <div id="hrConteudo"></div>
    `;
    _historicoRotasInicializado = true;
  }

  historicoRotasPopularFiltros();
  historicoRotasRender();
}

function historicoRotasPopularFiltros() {
  const regs = _hrRegistros();
  const fill = (id, label, valores) => {
    const el = document.getElementById(id);
    if (!el) return;
    const atual = el.value;
    const opts = [...new Set(valores.filter(Boolean))].sort((a, b) =>
      a.localeCompare(b, "pt-BR"),
    );
    el.innerHTML =
      `<option value="">${label}</option>` +
      opts.map((v) => `<option value="${_hrEsc(v)}">${_hrEsc(v)}</option>`).join("");
    if (atual && opts.includes(atual)) el.value = atual;
  };
  fill("hrMotorista", "Todos", regs.map((r) => r.motorista));
  fill("hrRota", "Todas", regs.map((r) => r._rotaLabel));
}

function _hrFiltrar(regs) {
  const de = document.getElementById("hrDataDe")?.value || "";
  const ate = document.getElementById("hrDataAte")?.value || "";
  const motorista = document.getElementById("hrMotorista")?.value || "";
  const rota = document.getElementById("hrRota")?.value || "";
  const busca = _hrNorm(document.getElementById("hrBusca")?.value || "");

  return regs.filter((r) => {
    if (de && r._dataISO && r._dataISO < de) return false;
    if (ate && r._dataISO && r._dataISO > ate) return false;
    if (motorista && r.motorista !== motorista) return false;
    if (rota && r._rotaLabel !== rota) return false;
    if (busca) {
      const texto = _hrNorm([r.motorista, r.placa, r._rotaLabel, r.saida, r.retorno, r.obs].join(" "));
      if (!texto.includes(busca)) return false;
    }
    return true;
  });
}

function _hrGrupos(regs) {
  const mapa = new Map();
  regs.forEach((r) => {
    const motorista = r.motorista || "Sem motorista";
    const rota = r._rotaLabel || "Sem rota informada";
    const chave = `${motorista}|||${rota}`;
    if (!mapa.has(chave)) mapa.set(chave, { motorista, rota, registros: [] });
    mapa.get(chave).registros.push(r);
  });
  return [...mapa.values()]
    .map((g) => {
      const tempos = g.registros.map((r) => r._totalMin).filter((v) => Number.isFinite(v));
      return {
        ...g,
        media: _hrMedia(g.registros),
        melhor: tempos.length ? Math.min(...tempos) : null,
        pior: tempos.length ? Math.max(...tempos) : null,
        ultimaData: g.registros.map((r) => r._dataISO).filter(Boolean).sort().pop() || "",
      };
    })
    .sort(
      (a, b) =>
        b.registros.length - a.registros.length ||
        String(a.motorista).localeCompare(String(b.motorista), "pt-BR"),
    );
}

function historicoRotasRender() {
  const regs = _hrFiltrar(_hrRegistros());
  const kpis = document.getElementById("hrKpis");
  const conteudo = document.getElementById("hrConteudo");
  if (!kpis || !conteudo) return;

  const tempos = regs.map((r) => r._totalMin).filter((v) => Number.isFinite(v));
  const media = _hrMedia(regs);
  const melhor = tempos.length ? Math.min(...tempos) : null;
  const pior = tempos.length ? Math.max(...tempos) : null;
  const motoristas = new Set(regs.map((r) => r.motorista).filter(Boolean)).size;

  kpis.innerHTML = [
    ["Registros", regs.length || "0"],
    ["Motoristas", motoristas || "0"],
    ["Média", media == null ? "-" : _hrTempo(media)],
    ["Melhor / pior", melhor == null ? "-" : `${_hrTempo(melhor)} / ${_hrTempo(pior)}`],
  ]
    .map(([rotulo, valor]) => `<div class="hr-kpi"><span>${_hrEsc(rotulo)}</span><strong>${_hrEsc(valor)}</strong></div>`)
    .join("");

  if (!regs.length) {
    conteudo.innerHTML = `<div class="hr-empty">Nenhum histórico de rota encontrado para os filtros atuais.</div>`;
    return;
  }

  const grupos = _hrGrupos(regs);
  conteudo.innerHTML = `
    <div class="hr-grid">
      <div class="hr-painel">
        <h3>Motorista x rota</h3>
        <div class="hr-lista">
          ${grupos
            .map((g) => {
              const mot = encodeURIComponent(g.motorista).replace(/'/g, "%27");
              const rota = encodeURIComponent(g.rota).replace(/'/g, "%27");
              return `
                <button type="button" class="hr-grupo" onclick="historicoRotasSelecionar(decodeURIComponent('${mot}'),decodeURIComponent('${rota}'))">
                  <strong>${_hrEsc(g.motorista)} - ${_hrEsc(g.rota)}</strong>
                  <small>${g.registros.length} registro(s) | média ${_hrEsc(_hrTempo(g.media))} | último ${_hrEsc(_hrDataFormatada(g.ultimaData))}</small>
                </button>
              `;
            })
            .join("")}
        </div>
      </div>
      <div class="hr-painel">
        <h3>Histórico detalhado</h3>
        <div class="hr-table-wrap">
          <table data-ordenavel class="hr-table">
            <thead>
              <tr>
                <th>Data</th>
                <th>Motorista</th>
                <th>Rota</th>
                <th>Placa</th>
                <th>Saída</th>
                <th>Retorno</th>
                <th>Tempo</th>
                <th>Excedente</th>
                <th>Obs.</th>
              </tr>
            </thead>
            <tbody>
              ${regs
                .slice()
                .sort(
                  (a, b) =>
                    String(b._dataISO).localeCompare(String(a._dataISO)) ||
                    String(a.motorista || "").localeCompare(String(b.motorista || ""), "pt-BR"),
                )
                .map((r) => {
                  const excedente = Number(r.minutosExcedentes || r.minutos_excedentes || 0);
                  return `
                    <tr>
                      <td>${_hrEsc(_hrDataFormatada(r._dataISO))}</td>
                      <td><strong>${_hrEsc(r.motorista || "-")}</strong></td>
                      <td>${_hrEsc(r._rotaLabel || "-")}</td>
                      <td>${_hrEsc(r.placa || "-")}</td>
                      <td>${_hrEsc(r.saida || "-")}</td>
                      <td>${_hrEsc(r.retorno || "-")}</td>
                      <td class="hr-tempo">${_hrEsc(_hrTempo(r._totalMin))}</td>
                      <td>${excedente > 0 ? _hrEsc(_hrTempo(excedente)) : "-"}</td>
                      <td>${_hrEsc(r.obs || "-")}</td>
                    </tr>
                  `;
                })
                .join("")}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `;
}

function historicoRotasSelecionar(motorista, rota) {
  const mot = document.getElementById("hrMotorista");
  const rot = document.getElementById("hrRota");
  if (mot) mot.value = motorista;
  if (rot) rot.value = rota;
  historicoRotasRender();
}

function historicoRotasRegistrar() {
  if (typeof irParaAba === "function") irParaAba("veiculos");
  setTimeout(() => {
    if (typeof abrirFormRota === "function") abrirFormRota();
  }, 80);
}
