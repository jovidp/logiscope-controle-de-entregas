/* Consultas da API T4S na aba Frota. Autenticacao permanece no servidor. */
(function () {
  'use strict';
  const st = { parte: 'rotas', page: 1, configurado: false, consulta: 0, controle: null, statusCarregado: false };
  const el = id => document.getElementById(id);
  function hoje() {
    const p = new Intl.DateTimeFormat('en-CA', {timeZone:'America/Sao_Paulo', year:'numeric', month:'2-digit', day:'2-digit'}).formatToParts(new Date());
    const v = tipo => p.find(x => x.type === tipo).value;
    return `${v('year')}-${v('month')}-${v('day')}`;
  }
  async function ler(caminho, signal) {
    const r = await fetch(caminho, { signal, headers: { Accept: 'application/json' } });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || (r.status === 404 ? 'Reinicie o servidor para disponibilizar a integracao T4S.' : `Consulta indisponivel (HTTP ${r.status}).`));
    return d;
  }
  function mensagem(texto, falha = false) {
    const alvo = el('frtT4sMsg');
    alvo.textContent = texto;
    alvo.style.color = falha ? 'var(--vermelho,#dc2626)' : 'var(--text-muted)';
  }
  function montar() {
    const raiz = el('frtParteT4s');
    if (!raiz || raiz.dataset.montado) return;
    raiz.dataset.montado = '1';
    raiz.innerHTML = `
      <div class="section-shell">
        <div class="section-head">
          <div><h2>T4S · Rotas e alertas</h2><p class="tms-subtitle">Consulte as rotas cadastradas e os alertas dos veículos na T4S.</p></div>
          <button type="button" class="btn-ghost btn-sm" id="frtT4sAoVivo">Ver veículos ao vivo</button>
        </div>
        <p id="frtT4sConexao" role="status"></p>
        <p id="frtT4sAjuda" class="tms-subtitle" hidden>Solicite as credenciais da API à T4S para liberar estas consultas. O rastreamento pelo site continua disponível enquanto a sessão estiver válida.</p>
        <div class="frt-acoes" style="margin:16px 0;flex-wrap:wrap;">
          <label>Consulta <select id="frtT4sParte" aria-label="Consulta T4S"><option value="rotas">Rotas</option><option value="alertas">Alertas</option></select></label>
          <span id="frtT4sFiltros" style="display:flex;gap:10px;flex-wrap:wrap;" hidden>
            <label>Placa <input id="frtT4sPlaca" placeholder="Todas as placas" maxlength="8" style="width:145px;" /></label>
            <label>De <input type="date" id="frtT4sInicio" /></label>
            <label>Até <input type="date" id="frtT4sFim" /></label>
            <label>Status <select id="frtT4sStatus"><option value="">Todos</option></select></label>
          </span>
          <button type="button" class="btn-blue btn-sm" id="frtT4sBuscar">Consultar</button>
        </div>
        <p id="frtT4sMsg" role="status" aria-live="polite"></p>
        <div id="frtT4sDados" style="overflow-x:auto;"></div>
        <div class="frt-acoes" style="margin-top:14px;">
          <button type="button" class="btn-ghost btn-sm" id="frtT4sAnterior" disabled>Anterior</button>
          <span id="frtT4sPagina"></span>
          <button type="button" class="btn-ghost btn-sm" id="frtT4sProxima" disabled>Próxima</button>
        </div>
      </div>`;
    el('frtT4sInicio').value = el('frtT4sFim').value = hoje();
    el('frtT4sAoVivo').onclick = () => window.frtApi?.voltarAoVivo();
    el('frtT4sParte').onchange = () => {
      st.parte = el('frtT4sParte').value;
      el('frtT4sFiltros').hidden = st.parte !== 'alertas';
      consultar(1);
    };
    el('frtT4sBuscar').onclick = () => consultar(1);
    el('frtT4sAnterior').onclick = () => consultar(st.page - 1);
    el('frtT4sProxima').onclick = () => consultar(st.page + 1);
  }
  function dataHora(valor) {
    const d = new Date(valor);
    return valor && Number.isFinite(+d) ? d.toLocaleString('pt-BR', {timeZone:'America/Sao_Paulo'}) : '—';
  }
  function tabela(d) {
    const alvo = el('frtT4sDados'); alvo.replaceChildren();
    if (!d.itens.length) { mensagem(st.parte === 'rotas' ? 'Nenhuma rota cadastrada para este acesso.' : 'Nenhum alerta encontrado para os filtros.'); return; }
    const table = document.createElement('table'); table.style.cssText = 'width:100%;text-align:left;';
    const titulos = st.parte === 'rotas' ? ['ID', 'Rota', 'Tolerância', 'Processada'] : ['ID', 'Placa', 'Alerta', 'Status', 'Data e hora'];
    const head = table.createTHead().insertRow();
    for (const titulo of titulos) { const th = document.createElement('th'); th.textContent = titulo; th.scope = 'col'; head.appendChild(th); }
    const body = table.createTBody();
    for (const item of d.itens) {
      const row = body.insertRow();
      const valores = st.parte === 'rotas' ? [item.id, item.nome, item.tolerancia, item.processada ? 'Sim' : 'Não']
        : [item.id, item.placa, item.tipo, item.status, dataHora(item.em)];
      for (const valor of valores) { const td = row.insertCell(); td.style.padding = '10px 8px'; td.textContent = valor === null || valor === undefined || valor === '' ? '—' : String(valor); }
    }
    alvo.appendChild(table);
  }
  async function carregarStatus(signal) {
    if (st.statusCarregado) return;
    const itens = [];
    for (let page = 1, paginas = 1; page <= paginas; page++) {
      const d = await ler(`/frota/t4s/status-alertas?page=${page}`, signal);
      paginas = d.totalPages;
      if (paginas > 10) throw new Error('A T4S retornou muitos status. Consulte os alertas sem filtro de status.');
      itens.push(...d.itens);
    }
    const select = el('frtT4sStatus');
    for (const item of itens) {
      if (item.id === null || item.id === undefined) continue;
      const option = document.createElement('option'); option.value = String(item.id); option.textContent = item.nome || String(item.id); select.appendChild(option);
    }
    st.statusCarregado = true;
  }
  async function consultar(page) {
    st.controle?.abort();
    const seq = ++st.consulta, ctrl = new AbortController(); st.controle = ctrl;
    const timer = setTimeout(() => ctrl.abort(), 45000);
    el('frtT4sBuscar').disabled = el('frtT4sAnterior').disabled = el('frtT4sProxima').disabled = true;
    el('frtT4sDados').replaceChildren(); el('frtT4sPagina').textContent = '';
    mensagem('Consultando a T4S…');
    let statusAviso = '';
    try {
      const conexao = await ler('/frota/t4s/status', ctrl.signal);
      if (seq !== st.consulta) return;
      st.configurado = conexao.configurado;
      el('frtT4sConexao').textContent = conexao.configurado ? 'API configurada · localização e chegadas usam o painel Ao vivo.'
        : conexao.modo_posicoes === 'navegador' ? 'Localização pela sessão do site · API aguardando credenciais.' : 'T4S aguardando conexão.';
      el('frtT4sAjuda').hidden = conexao.configurado;
      if (!conexao.configurado) { mensagem(conexao.credenciais_incompletas ? 'Falta uma das credenciais da API no servidor.' : 'Rotas e alertas serão liberados após a configuração das credenciais.'); return; }
      const q = new URLSearchParams({ page: String(page) });
      if (st.parte === 'alertas') {
        q.set('placa', el('frtT4sPlaca').value.trim()); q.set('inicio', el('frtT4sInicio').value); q.set('fim', el('frtT4sFim').value); q.set('status', el('frtT4sStatus').value);
        try { await carregarStatus(ctrl.signal); }
        catch (e) { if (ctrl.signal.aborted) throw e; statusAviso = ' Lista de status indisponível; consulta de alertas mantida.'; }
      }
      const d = await ler(`/frota/t4s/${st.parte}?${q}`, ctrl.signal);
      if (seq !== st.consulta) return;
      st.page = d.page;
      mensagem(`${d.totalRecords} registro(s).${statusAviso}`);
      tabela(d);
      el('frtT4sPagina').textContent = `Página ${d.page} de ${d.totalPages}`;
      el('frtT4sAnterior').disabled = d.page <= 1; el('frtT4sProxima').disabled = d.page >= d.totalPages;
    } catch (e) {
      if (seq === st.consulta) mensagem(ctrl.signal.aborted ? 'A consulta demorou demais. Tente novamente.' : e.message, true);
    } finally {
      clearTimeout(timer);
      if (seq === st.consulta) el('frtT4sBuscar').disabled = false;
    }
  }
  window.frtT4s = { abrir() { montar(); if (el('frtT4sBuscar')) consultar(1); },
    ocultar() { st.consulta++; st.controle?.abort(); } };
})();
