// Frota: conferir aparelhos e calibrar a área real de descarga.
(function () {
  'use strict';
  let dados, mapa, camada, marcador, pontos=null, desenhando=false, carregando, salvando=false, criando=false, lojaAnterior;
  const esc = v => String(v ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const el = id => document.getElementById(id);
  async function request(url,body) {
    const opcoes=body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)};
    if(typeof AbortSignal!=='undefined' && AbortSignal.timeout)opcoes.signal=AbortSignal.timeout(20000);
    const r=await fetch(url,opcoes);
    const j=await r.json().catch(()=>({}));
    if(!r.ok)throw Error(r.status===403?'Somente administrador pode ajustar o GPS.':r.status===404 && url==='/frota/precisao/pontos'?'Reinicie o servidor para ativar a criação de pontos.':j.error || 'Não foi possível carregar os ajustes.');
    return j;
  }
  function mensagem(texto,erro=false) {const e=el('gpsAjusteStatus');if(e){e.textContent=texto;e.style.color=erro?'var(--vermelho)':'var(--text-secondary)';}}
  function mensagemArea(texto,erro=false) {
    const e=el('gpsAreaStatus');if(e){e.textContent=texto;e.style.color=erro?'var(--vermelho)':'var(--text-secondary)';}
  }
  function listarLugares(selecionada=el('gpsLoja').value) {
    el('gpsLoja').innerHTML=(criando?'<option value="__NOVO__">Novo ponto</option>':'')+(dados?.lugares || []).map(l=>`<option value="${esc(l.codigo)}">${esc(l.nome || l.codigo)}</option>`).join('');
    if([...el('gpsLoja').options].some(o=>o.value===selecionada))el('gpsLoja').value=selecionada;
  }
  function modoFormulario() {
    el('gpsNomeCampo').hidden=!criando;el('gpsNome').required=criando;
    el('gpsCancelarNovo').hidden=!criando;el('gpsRestaurar').disabled=criando;
    el('gpsSalvar').textContent=criando?'Criar ponto':'Salvar área';
  }
  function usarRaio() {pontos=null;desenhando=false;el('gpsDesenhar').textContent='Desenhar área';}
  const tempo = s => s==null?'sem dados':s<60?`${s} s`:`${Math.round(s/60)} min`;
  async function atualizar() {
    if(carregando)return carregando;
    carregando=carregarDiagnostico();
    try{return await carregando;}finally{carregando=null;}
  }
  async function carregarDiagnostico() {
    mensagem('Conferindo sinais e intervalos…');
    try {
      dados=await request('/frota/precisao');
      const a=dados.aparelhos || [];
      el('gpsAparelhos').innerHTML=`<div class="frt-tabela-wrap"><table class="frt-tabela"><thead><tr><th>Placa / plataforma</th><th>Aparelho</th><th>Idade do sinal</th><th>Intervalo entre posições</th><th>Uso</th><th>Ajustar</th></tr></thead><tbody>${a.map((x,i)=>`<tr>
        <td><b>${esc(x.placa)}</b><br>${esc(x.fonte.toUpperCase())}</td><td>${esc(x.nome || '—')}<br><small>ID na plataforma: ${esc(x.device_id)}</small></td>
        <td>${tempo(x.idade_s)}${x.validacao?`<br><small>${esc(x.validacao)}</small>`:''}</td>
        <td>Mediana ${tempo(x.intervalo_mediano_s)}<br><small>95% até ${tempo(x.intervalo_p95_s)} · ${x.amostras || 0} intervalos / 24 h</small></td>
        <td>${x.bloqueada?'Bloqueada':x.vinculo==null?'Automático':String(x.vinculo)===String(x.device_id)?'Vinculado':'Outro aparelho vinculado'}</td>
        <td><div class="gps-botoes admin-only-action"><button type="button" class="btn-ghost btn-sm" data-vincular="${i}" ${String(x.vinculo)===String(x.device_id)?'disabled':''}>Vincular este</button>
        ${x.vinculo!=null?`<button type="button" class="btn-ghost btn-sm" data-soltar="${i}">Automático</button>`:''}
        <button type="button" class="btn-ghost btn-sm" data-bloquear="${i}">${x.bloqueada?'Liberar plataforma':'Bloquear plataforma'}</button></div></td></tr>`).join('')}</tbody></table></div>`;
      for(const tipo of ['vincular','soltar','bloquear']) el('gpsAparelhos').querySelectorAll(`[data-${tipo}]`).forEach(b=>b.onclick=async()=>{
        const x=a[Number(b.dataset[tipo])];b.disabled=true;
        try {
          await request(tipo==='bloquear'?'/frota/precisao/bloqueio':'/frota/precisao/aparelho',tipo==='bloquear'?{placa:x.placa,fonte:x.fonte,bloqueada:!x.bloqueada}:{placa:x.placa,fonte:x.fonte,device_id:tipo==='soltar'?null:x.device_id});
          await atualizar();window.frtAtualizar?.();mensagem('Ajuste salvo.');
        }catch(e){mensagem(e.message,true);b.disabled=false;}
      });
      listarLugares();
      if(!mapa) preencherLoja();
      const rejeitadas=(dados.rejeicoes || []).reduce((s,x)=>s+x.rejeitadas,0);
      el('gpsRejeicoes').textContent=`${rejeitadas} leituras suspeitas descartadas desde a última inicialização. Eventos exigem sinal de até ${dados.idade_max_eventos_s/60} min; fontes são comparadas com até ${dados.comparacao_max_s} s de diferença.`;
      mensagem('Diagnóstico atualizado. Confira o ID com a plataforma antes de vincular o aparelho à placa.');
      return true;
    } catch(e){mensagem(e.message,true);return false;}
  }
  function loja() {return (dados?.lugares || []).find(l=>l.codigo===el('gpsLoja').value);}
  function preencherLoja() {
    if(criando)return;
    const l=loja();if(!l)return;
    el('gpsPerfil').value=l.perfil || 'padrao';
    el('gpsLat').value=l.lat;el('gpsLng').value=l.lng;
    el('gpsEntrada').value=l.raio_entrada_m || 250;el('gpsSaida').value=l.raio_saida_m || 400;
    pontos=l.poligono?l.poligono.map(p=>[...p]):null;desenhando=false;
    const proximidade=l.ajuste_proximidade;
    const aviso=el('gpsProximidade');
    const coincidentes=(dados.lugares || []).filter(x=>x.codigo!==l.codigo && window.frtApi.distM([l.lat,l.lng],[x.lat,x.lng])<=1);
    if(aviso) aviso.textContent=coincidentes.length
      ? 'Mesmo ponto cadastrado de '+coincidentes.map(x=>x.nome || x.codigo).join(' / ')+'. Se as descargas ficam em locais diferentes, posicione esta loja no ponto correto e salve a área.'
      : proximidade
      ? 'Loja vizinha: '+proximidade.vizinha_nome+' a '+proximidade.distancia_m+' m. Por proximidade, os raios ficam limitados a '+proximidade.limite_entrada_m+' m na entrada e '+proximidade.limite_saida_m+' m na saída. Diâmetros atuais: '+(l.raio_entrada_m*2)+' m e '+(l.raio_saida_m*2)+' m.'+(proximidade.sobreposicao_inevitavel?' As áreas ainda podem se sobrepor: confirme a loja atendida.':'')
      : 'A área usa os limites do cadastro ou do ajuste manual.';
    el('gpsDesenhar').textContent='Desenhar área';
    desenhar(true);
  }
  function desenhar(enquadrar=false) {
    if(!mapa)return;
    const L=window.L,lat=Number(el('gpsLat').value),lng=Number(el('gpsLng').value);
    camada.clearLayers();
    if(marcador){mapa.removeLayer(marcador);marcador=null;}
    if(String(el('gpsLat').value).trim()==='' || String(el('gpsLng').value).trim()==='' || !Number.isFinite(lat)||!Number.isFinite(lng))return;
    for(const outra of dados?.lugares || []) {
      if(outra.codigo===el('gpsLoja').value || window.frtApi.distM([lat,lng],[outra.lat,outra.lng])>500)continue;
      L.circleMarker([outra.lat,outra.lng],{radius:5,color:'#9333ea',fillOpacity:.3})
        .bindTooltip(esc(outra.nome || outra.codigo),{permanent:true,direction:'top'}).addTo(camada);
    }
    marcador=L.marker([lat,lng],{draggable:true}).bindTooltip('Ponto de descarga').addTo(mapa);
    marcador.on('dragend',()=>{const p=marcador.getLatLng();el('gpsLat').value=p.lat.toFixed(7);el('gpsLng').value=p.lng.toFixed(7);mensagemArea('Alteração ainda não salva.');desenhar();});
    if(pontos?.length) {
      const forma=pontos.length>=3?L.polygon(pontos,{color:'#0891b2',fillOpacity:.12}):L.polyline(pontos,{color:'#0891b2'});
      forma.addTo(camada);
      pontos.forEach(p=>L.circleMarker(p,{radius:4,color:'#0891b2',fillOpacity:1}).addTo(camada));
    } else {
      L.circle([lat,lng],{radius:Number(el('gpsSaida').value)||400,color:'#d97706',dashArray:'5 5',fillOpacity:0}).bindTooltip('Limite para confirmar saída').addTo(camada);
      L.circle([lat,lng],{radius:Number(el('gpsEntrada').value)||250,color:'#0891b2',fillOpacity:.1}).bindTooltip('Área de chegada').addTo(camada);
    }
    if(enquadrar)mapa.setView([lat,lng],16);
  }
  async function garantirMapa() {
    if(mapa){mapa.invalidateSize();return;}
    await window.frtApi.carregarLeaflet();
    if(mapa)return;
    const L=window.L;mapa=L.map('gpsAreaMapa').setView([-22.9,-43.4],14);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'© OpenStreetMap',referrerPolicy:'strict-origin-when-cross-origin'}).addTo(mapa);
    camada=L.layerGroup().addTo(mapa);
    mapa.on('click',e=>{
      if(salvando)return;
      if(desenhando)pontos.push([e.latlng.lat,e.latlng.lng]);
      else if(criando){el('gpsLat').value=e.latlng.lat.toFixed(7);el('gpsLng').value=e.latlng.lng.toFixed(7);}
      else return;
      mensagemArea('Alteração ainda não salva.');desenhar();
    });
    preencherLoja();
  }
  function montar() {
    const host=el('frtPrecisao');if(!host || host.dataset.montado)return;host.dataset.montado='1';
    host.innerHTML=`<details class="gps-ajustes"><summary>Precisão do GPS · aparelhos e áreas de lojas</summary><div class="gps-ajustes-corpo">
      <div class="gps-botoes"><button type="button" class="btn-ghost btn-sm" id="gpsDiagnostico">Atualizar diagnóstico</button><span id="gpsAjusteStatus" role="status" aria-live="polite"></span></div>
      <p class="tms-subtitle" id="gpsRejeicoes"></p><div id="gpsAparelhos"></div>
      <h3>Área de chegada e saída</h3><p class="tms-subtitle">Shopping pode precisar de uma área maior; rua, de uma área menor. Lojas a menos de 500 m de outra loja têm os raios reduzidos automaticamente conforme a distância entre elas. Posicione o marcador na descarga e confira o desenho. Áreas desenhadas mantêm o contorno definido.</p>
      <p class="tms-subtitle" id="gpsProximidade"></p>
      <div class="gps-botoes admin-only-action"><button type="button" class="btn-ghost btn-sm" id="gpsNovoPonto">+ Criar ponto</button><button type="button" class="btn-ghost btn-sm" id="gpsCancelarNovo" hidden>Cancelar novo ponto</button></div>
      <form id="gpsAreaForm" class="gps-area-form">
      <label>Loja ou ponto<select id="gpsLoja"></select></label><label id="gpsNomeCampo" hidden>Nome do ponto<input id="gpsNome" type="text" maxlength="120" placeholder="Ex.: Pátio de apoio" /></label><label>Perfil<select id="gpsPerfil"><option value="padrao">Padrão atual</option><option value="shopping">Shopping · 200 / 300 m</option><option value="rua">Rua · 80 / 150 m</option></select></label>
      <label>Latitude<input id="gpsLat" type="number" step="any" min="-90" max="90" required></label><label>Longitude<input id="gpsLng" type="number" step="any" min="-180" max="180" required></label>
      <label>Raio de entrada (m)<input id="gpsEntrada" type="number" min="20" max="1000" required></label><label>Raio de saída (m)<input id="gpsSaida" type="number" min="21" max="2000" required></label>
      <div class="gps-botoes gps-area-acoes admin-only-action"><button type="button" class="btn-ghost btn-sm" id="gpsDesenhar">Desenhar área</button><button type="button" class="btn-ghost btn-sm" id="gpsRaio">Usar raio</button><button type="button" class="btn-ghost btn-sm" id="gpsDesfazer">Desfazer ponto</button><button type="submit" class="btn-blue btn-sm" id="gpsSalvar">Salvar área</button><button type="button" class="btn-ghost btn-sm" id="gpsRestaurar">Restaurar cadastro</button><span id="gpsAreaStatus" role="status" aria-live="polite"></span></div>
      </form><p class="tms-subtitle">Arraste o marcador até a descarga. Para desenhar o pátio, clique em “Desenhar área”, marque as bordas no mapa e conclua. No polígono, a saída usa uma margem de 40 m.</p><div id="gpsAreaMapa" class="gps-area-mapa"></div>
      </div></details>`;
    host.querySelector('details').ontoggle=async e=>{if(!e.target.open)return;if(!dados)await atualizar();try{await garantirMapa();}catch(err){mensagem(err.message,true);}};
    el('gpsDiagnostico').onclick=async()=>{if(await atualizar())preencherLoja();};
    el('gpsLoja').onchange=()=>{if(el('gpsLoja').value==='__NOVO__')return;criando=false;modoFormulario();mensagemArea('');preencherLoja();};
    el('gpsNovoPonto').onclick=async()=>{
      if(salvando)return;
      if(!dados && !await atualizar())return;
      if(!criando)lojaAnterior=el('gpsLoja').value;
      criando=true;usarRaio();listarLugares('__NOVO__');modoFormulario();
      el('gpsNome').value='';el('gpsLat').value='';el('gpsLng').value='';
      el('gpsPerfil').value='rua';el('gpsEntrada').value=80;el('gpsSaida').value=150;
      el('gpsProximidade').textContent='Dê um nome ao ponto e clique no mapa para posicioná-lo. Ajuste os raios ou desenhe a área.';
      mensagemArea('Clique no mapa para marcar o novo ponto.');
      try{await garantirMapa();desenhar();el('gpsNome').focus?.();}catch(e){mensagemArea(e.message,true);}
    };
    el('gpsCancelarNovo').onclick=()=>{if(salvando)return;criando=false;listarLugares(lojaAnterior);modoFormulario();mensagemArea('');preencherLoja();};
    el('gpsPerfil').onchange=()=>{const r={shopping:[200,300],rua:[80,150],padrao:[250,400]}[el('gpsPerfil').value];el('gpsEntrada').value=r[0];el('gpsSaida').value=r[1];pontos=null;desenhando=false;el('gpsDesenhar').textContent='Desenhar área';desenhar();};
    const nomes={gpsLat:'Latitude',gpsLng:'Longitude',gpsEntrada:'Raio de entrada',gpsSaida:'Raio de saída'};
    for(const [id,nome] of Object.entries(nomes)) {
      el(id).oninput=()=>{if(id==='gpsEntrada' || id==='gpsSaida')usarRaio();mensagemArea('Alteração ainda não salva.');desenhar();};
      el(id).oninvalid=()=>mensagemArea(nome+': '+el(id).validationMessage,true);
    }
    el('gpsDesenhar').onclick=()=>{desenhando=!desenhando;if(desenhando)pontos=[];el('gpsDesenhar').textContent=desenhando?'Concluir desenho':'Desenhar área';desenhar();};
    el('gpsRaio').onclick=()=>{usarRaio();mensagemArea('Área circular selecionada. Ajuste os raios e salve.');desenhar();};
    el('gpsDesfazer').onclick=()=>{pontos?.pop();desenhar();};
    async function salvar(restaurar=false) {
      let codigo=el('gpsLoja').value;if(!codigo || salvando)return;
      const novo=criando && !restaurar;
      const botao=el('gpsSalvar');
      const controles=['gpsSalvar','gpsRestaurar','gpsLoja','gpsPerfil','gpsLat','gpsLng','gpsEntrada','gpsSaida','gpsDesenhar','gpsRaio','gpsDesfazer','gpsDiagnostico','gpsNovoPonto','gpsCancelarNovo','gpsNome'].map(el).filter(Boolean);
      const estados=controles.map(e=>[e,e.disabled]);
      try {
        if(restaurar && criando)return;
        if(!restaurar && pontos?.length===0)usarRaio();
        if(!restaurar && pontos && pontos.length<3)throw Error('Desenhe pelo menos três pontos ou escolha Usar raio.');
        const corpo=restaurar?{restaurar:true}:{perfil:el('gpsPerfil').value,lat:el('gpsLat').value,lng:el('gpsLng').value,raio_entrada_m:el('gpsEntrada').value,raio_saida_m:el('gpsSaida').value,poligono:pontos?.map(p=>[...p]) || null};
        if(novo){corpo.nome=el('gpsNome').value.trim();if(!corpo.nome)throw Error('Informe o nome do novo ponto.');}
        salvando=true;for(const e of controles)e.disabled=true;
        marcador?.dragging?.disable();if(botao)botao.textContent='Salvando…';mensagemArea('Salvando '+(loja()?.nome || codigo)+'…');
        if(carregando)await carregando;
        const resposta=await request(novo?'/frota/precisao/pontos':'/frota/precisao/lojas/'+encodeURIComponent(codigo),corpo);
        if(novo){
          if(!resposta.lugar?.codigo)throw Error('O servidor não confirmou o novo ponto. Atualize o diagnóstico antes de tentar novamente.');
          codigo=resposta.lugar.codigo;criando=false;
          dados={...dados,lugares:[...(dados?.lugares || []),resposta.lugar]};listarLugares(codigo);modoFormulario();
        }
        // Guarda o ponto aceito pelo servidor mesmo se a consulta seguinte falhar.
        if(!restaurar && dados)dados={...dados,lugares:(dados.lugares || []).map(l=>l.codigo!==codigo?l:{...l,...corpo,
          lat:Number(corpo.lat),lng:Number(corpo.lng),raio_entrada_m:Number(corpo.raio_entrada_m),raio_saida_m:Number(corpo.raio_saida_m),area_personalizada:true})};
        const salvaLocal=loja();
        const atualizado=await atualizar();
        const consultada=loja();
        const confirmado=atualizado && (restaurar || (consultada && Math.abs(Number(consultada.lat)-Number(corpo.lat))<1e-7 && Math.abs(Number(consultada.lng)-Number(corpo.lng))<1e-7));
        if(confirmado)preencherLoja();
        else if(!restaurar && dados){dados={...dados,lugares:[...(dados.lugares || []).filter(l=>l.codigo!==codigo),salvaLocal]};listarLugares(codigo);}
        window.frtAtualizar?.();
        const texto=(restaurar?'Cadastro restaurado.':novo?'Ponto '+(loja()?.nome || codigo)+' criado.':'Área de '+(loja()?.nome || codigo)+' salva.')
          +(confirmado?'':' O mapa ainda não confirmou a atualização; o ajuste foi gravado. Clique em Atualizar diagnóstico.');
        mensagemArea(texto);mensagem(texto);
      }catch(e){const texto=['TimeoutError','AbortError'].includes(e.name)?'O servidor demorou para responder. Atualize o diagnóstico para conferir se o ajuste foi gravado antes de tentar novamente.':e.message;mensagemArea(texto,true);mensagem(texto,true);}
      finally{salvando=false;for(const [e,disabled] of estados)e.disabled=disabled;modoFormulario();marcador?.dragging?.enable();}
    }
    el('gpsAreaForm').onsubmit=e=>{e.preventDefault();return salvar();};el('gpsRestaurar').onclick=()=>salvar(true);
  }
  async function abrirLoja(codigo) {
    if(salvando){mensagemArea('Aguarde o ajuste atual terminar.');return;}
    montar();
    const host=el('frtPrecisao');if(!host)return;
    const details=host.querySelector('details');details.open=true;
    if(!await atualizar())return;
    if(!(dados.lugares || []).some(l=>String(l.codigo)===String(codigo))){mensagem('Loja não encontrada nos ajustes do GPS.',true);return;}
    criando=false;modoFormulario();
    el('gpsLoja').value=String(codigo);
    try {
      await garantirMapa();preencherLoja();
      host.scrollIntoView({behavior:'smooth',block:'start'});
      mensagem('Ajustando '+(loja().nome || codigo)+'. Arraste o marcador até a descarga e clique em Salvar área.');
    }catch(e){mensagem(e.message,true);}
  }
  window.frtPrecisao={montar,abrirLoja};
})();
