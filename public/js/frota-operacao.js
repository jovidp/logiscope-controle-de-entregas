// Acompanhamento das entregas, percurso de referência e custos cadastrados.
(function(){
  'use strict';
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const el=id=>document.getElementById(id);
  const num=n=>Number(n).toLocaleString('pt-BR',{maximumFractionDigits:1});
  const brl=n=>n==null?'—':Number(n).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
  const hoje=()=>{const p=Object.fromEntries(new Intl.DateTimeFormat('en',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date()).map(x=>[x.type,x.value]));return `${p.year}-${p.month}-${p.day}`;};
  const hora=d=>d?new Date(d).toLocaleTimeString('pt-BR',{timeZone:'America/Sao_Paulo',hour:'2-digit',minute:'2-digit'}):'—';
  let dados,carregando=false,timer=null,data=hoje();
  async function request(url,body){const r=await fetch(url,{headers:{Accept:'application/json',...(body?{'Content-Type':'application/json'}:{})},...(body?{method:'POST',body:JSON.stringify(body)}:{})});const j=await r.json().catch(()=>({}));if(!r.ok)throw Error(j.error || `HTTP ${r.status}`);return j;}
  function tabela(id,titulos,linhas){el(id).innerHTML=linhas.length?`<div class="frt-tabela-wrap"><table class="frt-tabela"><thead><tr>${titulos.map(t=>`<th>${esc(t)}</th>`).join('')}</tr></thead><tbody>${linhas.join('')}</tbody></table></div>`:'<p class="frt-vazio">Nenhum registro para esta data.</p>';}
  function tag(texto,atencao=false){return `<span class="frt-tag ${atencao?'frt-atraso':''}">${esc(texto)}</span>`;}
  function verBotao(x){return `<button type="button" class="btn-ghost btn-sm" data-local data-placa="${esc(x.placa)}" ${x.lat!=null?`data-lat="${esc(x.lat)}" data-lng="${esc(x.lng)}"`:''}>Ver no mapa</button>`;}
  function render(){
    const r=dados,c=r.config;
    const andamento=r.demoras.filter(x=>x.em_andamento),demoradas=andamento.filter(x=>x.excedeu),desvios=r.desvios.filter(x=>x.confirmado);
    const card=(v,t)=>`<div class="frt-kpi"><b>${esc(v)}</b><span>${esc(t)}</span></div>`;
    el('fopCards').innerHTML=[card(andamento.length,'veículos nas lojas'),card(demoradas.length,'permanências acima da referência'),card(desvios.length,'desvios para conferir'),card(r.custos_permitidos?(r.custos || []).filter(x=>x.custos_completos).length:'—','viagens com todos os custos preenchidos')].join('');
    el('fopAtualizado').textContent=`${r.ao_vivo?'Ao vivo':'Consulta do dia'} · atualizado às ${hora(r.gerado_em)}`;
    el('fopLojaAjuda').textContent=`Permanência pelo GPS: cinco visitas válidas permitem usar a mediana da loja, com margem de ${c.loja_margem_min} min ou ${num(c.loja_fator)}×. Sem histórico suficiente: ${c.loja_min} min. Áreas sobrepostas e chegadas não observadas ficam fora da comparação.`;
    tabela('fopLojas',['Placa / loja','Chegada / saída','Permanência','Referência','Situação','Local'],r.demoras.map(x=>`<tr><td><b>${esc(x.placa)}</b><br>${esc(x.loja)}</td><td>${hora(x.chegou)} → ${x.em_andamento?'no local':hora(x.saiu)}</td><td><b>${num(x.min)} min</b></td><td>${num(x.limite_min)} min<br><small>${x.referencia==='historico'?`Mediana ${num(x.mediana_min)} min · ${x.amostras} visitas`:`Limite padrão · ${x.amostras} visitas válidas`}</small></td><td>${tag(x.excedeu?'Acima da referência':'Dentro da referência',x.excedeu)}<br><small>${x.em_andamento?'Em andamento':'Concluída'}</small></td><td>${verBotao(x)}</td></tr>`));
    const status={na_loja:'Na loja ou fábrica',sem_sinal_confiavel:'Aguardando sinal confiável',sem_coordenadas:'Coordenadas incompletas',calculando:'Percurso indisponível ou em cálculo',no_percurso:'Dentro do percurso',parado_fora:'Parado fora do percurso',confirmando:'Confirmando afastamento',desvio:'Conferir desvio',viagens_sobrepostas:'Mais de uma viagem ativa'};
    el('fopDesvioAjuda').textContent=`Percurso de referência pelas ruas: fábrica → lojas na ordem da viagem → fábrica. O aviso exige afastamento maior que ${num(c.desvio_m/1000)} km por ${c.desvio_min} min e pelo menos três leituras distintas. Desvios autorizados devem ser conferidos. Ao reiniciar, a confirmação começa novamente.`;
    tabela('fopDesvios',['Placa / rota','Situação','Distância do percurso','Confirmação','Local'],r.desvios.map(x=>`<tr><td><b>${esc(x.placa)}</b><br>${esc(x.rota || '—')}</td><td>${tag(status[x.status] || x.status,x.confirmado)}${x.faltando?.length?`<br><small>Conferir: ${esc(x.faltando.join(', '))}</small>`:''}</td><td>${x.distancia_m==null?'—':`${num(x.distancia_m/1000)} km`}</td><td>${x.min==null?'—':`${x.min} min · ${x.leituras} leituras`}</td><td>${verBotao(x)}</td></tr>`));
    if(!r.ao_vivo)el('fopDesvios').innerHTML='<p class="frt-vazio">A confirmação de desvios acompanha viagens ativas de hoje. Para consultar o trajeto anterior, use a reprodução do dia em Ao vivo.</p>';
    el('fopCustosAjuda').textContent='Soma dos valores cadastrados no TMS: frete, combustível, pedágio e outros. Valores ausentes aparecem como pendentes; informe zero quando não houver despesa. A média usa entregas confirmadas, e o custo por km usa o km real da viagem. Valores permanecem provisórios até a finalização e o preenchimento dos custos.';
    if(!r.custos_permitidos)el('fopCustos').innerHTML='<p class="frt-vazio">Os valores financeiros estão disponíveis para administradores.</p>';
    else tabela('fopCustos',['Viagem / data','Placa / rota','Entregas','Custo cadastrado','Por entrega','Por km','Preenchimento'],(r.custos || []).map(x=>`<tr><td><b>${esc(x.codigo)}</b><br>${esc(x.data)}</td><td>${esc(x.placa || '—')}<br>${esc(x.rota || '—')}</td><td>${x.entregas_confirmadas} confirmadas<br><small>${x.paradas_previstas} paradas previstas</small></td><td><b>${brl(x.total_cadastrado)}</b>${x.frete_previsto!=null?`<br><small>Frete previsto: ${brl(x.frete_previsto)}</small>`:''}</td><td>${brl(x.custo_por_entrega)}</td><td>${brl(x.custo_por_km)}</td><td>${tag(x.provisorio?'Provisório':'Preenchido',x.custos_faltando.length>0)}<br><small>${x.custos_faltando.length?'Falta: '+esc(x.custos_faltando.join(', ')):esc(x.status)}</small></td></tr>`));
    el('fopCustosCsv').hidden=!r.custos_permitidos || !r.custos?.length;
    for(const k of Object.keys(c)){const campo=el('fop_'+k);if(campo && document.activeElement!==campo && !el('fopConfig').dataset.alterada)campo.value=c[k];}
    el('frtParteOperacao').querySelectorAll('[data-local]').forEach(b=>b.onclick=()=>window.frtApi.verNoMapa(b.dataset.placa,data,b.dataset.lat==null?undefined:Number(b.dataset.lat),b.dataset.lng==null?undefined:Number(b.dataset.lng)));
  }
  async function carregar(){
    if(carregando)return;carregando=true;el('fopStatus').textContent='Conferindo viagens e visitas…';
    const escolhida=data;
    try{const r=await request('/frota/operacao?data='+encodeURIComponent(escolhida));if(escolhida!==data)return;dados=r;render();el('fopStatus').textContent='';}
    catch(e){el('fopStatus').textContent='Não foi possível atualizar: '+e.message;}
    finally{carregando=false;if(escolhida!==data)carregar();}
  }
  function csv(){
    const linhas=[['Viagem','Data','Placa','Rota','Entregas confirmadas','Custo cadastrado','Custo por entrega','Custo por km','Custos faltando','Provisorio'],...(dados?.custos || []).map(x=>[x.codigo,x.data,x.placa,x.rota,x.entregas_confirmadas,x.total_cadastrado,x.custo_por_entrega,x.custo_por_km,x.custos_faltando.join(', '),x.provisorio?'Sim':'Nao'])];
    const cel=v=>{const s=String(v??'');return '"'+(/^[=+\-@\t\r]/.test(s)?"'":'')+s.replace(/"/g,'""')+'"';};
    const url=URL.createObjectURL(new Blob(['\ufeff'+linhas.map(l=>l.map(cel).join(';')).join('\r\n')],{type:'text/csv;charset=utf-8'}));
    const a=document.createElement('a');a.href=url;a.download='custos-viagens-'+data+'.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  function montar(){
    const host=el('frtParteOperacao');if(!host || host.dataset.montado)return;host.dataset.montado='1';
    host.innerHTML=`<div class="section-shell"><div class="section-head"><div><h2>Operação e custos</h2><p class="tms-subtitle">Acompanhe o atendimento nas lojas, confira desvios e compare o custo das entregas.</p></div><div class="gps-botoes"><label class="fop-data">Data<input type="date" id="fopData" value="${data}" max="${hoje()}"></label><button type="button" class="btn-ghost btn-sm" id="fopAtualizar">Atualizar</button></div></div><p id="fopAtualizado" class="tms-subtitle"></p><p id="fopStatus" role="status" aria-live="polite"></p><div id="fopCards" class="frt-kpis"></div></div>
    <div class="section-shell"><h2>Tempo nas lojas</h2><p id="fopLojaAjuda" class="tms-subtitle"></p><div id="fopLojas"></div></div>
    <div class="section-shell"><h2>Desvio de percurso</h2><p id="fopDesvioAjuda" class="tms-subtitle"></p><div id="fopDesvios"></div></div>
    <div class="section-shell"><div class="section-head"><h2>Custo por viagem e entrega</h2><button type="button" class="btn-ghost btn-sm" id="fopCustosCsv" hidden>Exportar CSV</button></div><p id="fopCustosAjuda" class="tms-subtitle"></p><div id="fopCustos"></div></div>
    <details class="section-shell admin-only-action"><summary>Ajustar referências e avisos</summary><form id="fopConfig" class="gps-area-form">
    <label>Sem histórico: tempo na loja (min)<input id="fop_loja_min" type="number" min="20" max="600" required></label>
    <label>Margem sobre a mediana (min)<input id="fop_loja_margem_min" type="number" min="10" max="180" required></label>
    <label>Multiplicador da mediana<input id="fop_loja_fator" type="number" min="1.1" max="3" step="0.1" required></label>
    <label>Afastamento do percurso (m)<input id="fop_desvio_m" type="number" min="300" max="10000" required></label>
    <label>Tempo fora do percurso (min)<input id="fop_desvio_min" type="number" min="3" max="60" required></label>
    <div class="gps-area-acoes gps-botoes"><button type="submit" class="btn-blue btn-sm">Salvar referências</button><span id="fopConfigStatus" role="status" aria-live="polite"></span></div></form></details>`;
    el('fopAtualizar').onclick=carregar;el('fopCustosCsv').onclick=csv;
    el('fopData').onchange=()=>{if(el('fopData').value){data=el('fopData').value;dados=null;el('fopCards').innerHTML='';el('fopAtualizado').textContent='';for(const id of ['fopLojas','fopDesvios','fopCustos'])el(id).innerHTML='<p class="frt-vazio">Carregando a data selecionada…</p>';el('fopCustosCsv').hidden=true;carregar();}};
    el('fopConfig').oninput=()=>el('fopConfig').dataset.alterada='1';
    el('fopConfig').onsubmit=async e=>{e.preventDefault();const b=Object.fromEntries(['loja_min','loja_margem_min','loja_fator','desvio_m','desvio_min'].map(k=>[k,el('fop_'+k).value]));const botao=e.target.querySelector('button');botao.disabled=true;try{await request('/frota/operacao/config',b);delete el('fopConfig').dataset.alterada;await carregar();el('fopConfigStatus').textContent='Referências salvas.';}catch(err){el('fopConfigStatus').textContent=err.message;}finally{botao.disabled=false;}};
  }
  function abrir(){montar();carregar();if(!timer)timer=setInterval(()=>{const h=el('frtParteOperacao'),aba=el('aba-frota');if(h && !h.hidden && aba && !aba.classList.contains('aba-hidden') && data===hoje())carregar();},60000);}
  window.frtOperacao={abrir};
})();