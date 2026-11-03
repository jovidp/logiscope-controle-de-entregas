// Historico de ate cinco dias, separado do acompanhamento ao vivo.
(function(){
  'use strict';
  const el=id=>document.getElementById(id);
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const hoje=()=>new Intl.DateTimeFormat('sv-SE',{timeZone:'America/Sao_Paulo'}).format(new Date());
  const data=s=>String(s).split('-').reverse().join('/');
  const instante=em=>new Date(em).toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'});
  const num=n=>Number(n||0).toLocaleString('pt-BR',{maximumFractionDigits:1});
  const dur=m=>{m=Math.round(m||0);return m<60?m+' min':Math.floor(m/60)+' h'+(m%60?' '+String(m%60).padStart(2,'0'):'');};
  const CORES=['#2563eb','#16a34a','#9333ea','#d97706','#0891b2'];
  const st={montado:false,veiculos:[],baseEm:0,baseP:null,resultado:null,mapa:null,cam:null,replay:null,timer:null,seq:0,abertura:0,consulta:null};
  function mensagem(t,erro=false){const x=el('fhhStatus');if(x){x.textContent=t;x.classList.toggle('fhh-erro',erro);}}
  async function json(url,signal){const r=await fetch(url,{headers:{Accept:'application/json'},signal});const b=await r.json().catch(()=>({}));if(!r.ok)throw Error(b.error || 'Não foi possível carregar o histórico (HTTP '+r.status+').');return b;}
  function montar(){
    const raiz=el('frtParteHistorico');if(!raiz || st.montado)return;st.montado=true;
    raiz.innerHTML=`<div id="fhhPainel" class="fhh-painel">
      <section class="section-shell fhh-topo">
        <div class="section-head"><div><h2>Histórico de rotas</h2><p class="tms-subtitle">Veja o percurso pelo GPS, os horários e as chegadas e saídas registradas nas lojas. Até 5 dias por consulta, de 00:00 do primeiro dia até 23:59 do último.</p></div><div class="frt-acoes"><button type="button" id="fhhVoltarBtn" class="btn-ghost btn-sm" aria-controls="frtVivo">← Voltar à frota</button><button type="button" id="fhhTelaCheiaBtn" class="btn-ghost btn-sm" aria-controls="fhhPainel" aria-pressed="false">⛶ Tela cheia</button></div></div>
        <form id="fhhForm" class="fhh-form">
          <label class="fhh-campo fhh-veiculo">Veículo<select id="fhhVeiculo" required aria-label="Veículo do histórico"><option value="">Carregando veículos…</option></select></label>
          <label class="fhh-campo">De · 00:00<input id="fhhInicio" type="date" required aria-label="Data inicial do histórico"></label>
          <label class="fhh-campo">Até · 23:59<input id="fhhFim" type="date" required aria-label="Data final do histórico"></label>
          <button type="submit" id="fhhConsultar" class="btn-primary">Consultar rastro</button>
        </form>
        <p id="fhhDisponivel" class="fhh-nota"></p><p id="fhhStatus" class="fhh-status" role="status" aria-live="polite">Escolha um veículo e o período para consultar.</p>
      </section>
      <div id="fhhResultados" class="fhh-resultados" aria-busy="false">
        <section class="section-shell fhh-mapa-box"><div class="frt-mapa-cabecalho"><div class="frt-mapa-titulo"><strong id="fhhMapaTitulo">Trajeto registrado pelo GPS</strong><span id="fhhMapaResumo">O histórico aparecerá após a consulta.</span></div><button type="button" id="fhhEnquadrar" class="frt-enquadrar-btn" disabled>⌖ Enquadrar</button></div>
          <div class="frt-mapa-area"><div id="fhhMapa" class="frt-mapa" aria-label="Mapa do histórico de rastros"></div><button type="button" id="fhhTelaCheiaMapaBtn" class="frt-tela-cheia-mapa" aria-controls="fhhPainel" aria-pressed="false">⛶ Tela cheia</button></div>
          <div id="fhhLegenda" class="fhh-legenda"></div>
          <div class="fhh-replay"><button type="button" class="btn-ghost btn-sm" id="fhhPlay" disabled>▶ Reproduzir</button><input type="range" id="fhhBarra" min="0" max="1" step="1" value="0" aria-label="Hora do histórico" disabled><select id="fhhVel" aria-label="Velocidade da reprodução"><option value="30">30×</option><option value="120" selected>120×</option><option value="600">600×</option></select><span id="fhhHora" class="fhh-hora">—</span></div>
          <p class="fhh-nota">Linhas ligam leituras do GPS; tracejado indica sinal espaçado e caminho aproximado. Lacunas e dias diferentes ficam separados. Distâncias são aproximadas.</p><p id="fhhMapaAviso" class="fhh-nota fhh-erro"></p>
        </section>
        <aside class="section-shell fhh-lateral"><h3>Resumo do período</h3><div id="fhhResumo" class="fhh-resumo"><p class="frt-vazio">Nenhuma consulta ainda.</p></div><div id="fhhCobertura" class="fhh-cobertura"></div><h3>Por dia</h3><div id="fhhDias" class="fhh-dias"></div><details id="fhhEventos" open><summary>Chegadas e saídas registradas</summary><div id="fhhEventosLista"></div></details></aside>
      </div>
    </div>`;
    el('fhhInicio').value=el('fhhFim').value=hoje();el('fhhInicio').max=el('fhhFim').max=hoje();
    el('fhhForm').onsubmit=e=>{e.preventDefault();return consultar();};
    el('fhhVoltarBtn').onclick=()=>window.frtApi.voltarAoVivo();
    el('fhhVeiculo').onchange=disponibilidade;
    for(const id of ['fhhInicio','fhhFim'])el(id).onchange=()=>{limites();if(st.resultado)mensagem('Período alterado. Clique em Consultar rastro para atualizar o mapa.');};
    el('fhhPlay').onclick=reproduzir;el('fhhBarra').oninput=()=>{pausar();mostrar(Number(el('fhhBarra').value));};el('fhhEnquadrar').onclick=enquadrar;
    document.addEventListener('visibilitychange',()=>{if(document.hidden)pausar();});
    window.frtTelaCheia?.montar(()=>st.mapa?.invalidateSize({pan:false}),{painel:'fhhPainel',botao:'fhhTelaCheiaBtn',botaoMapa:'fhhTelaCheiaMapaBtn',mapa:'fhhMapa',classe:'fhh-tela-cheia',parte:'frtParteHistorico'});
  }
  function limites(){
    const ini=el('fhhInicio').value,lim=hoje();let max=lim;
    if(/^\d{4}-\d{2}-\d{2}$/.test(ini)){const d=new Date(ini+'T00:00:00Z');if(Number.isFinite(d.getTime()))max=new Date(d.getTime()+4*86400000).toISOString().slice(0,10);}
    el('fhhInicio').max=lim;el('fhhFim').min=ini;el('fhhFim').max=max<lim?max:lim;
  }
  function disponibilidade(){const v=st.veiculos.find(x=>x.placa===el('fhhVeiculo').value);el('fhhDisponivel').textContent=v?'Leituras disponíveis de '+instante(v.primeira)+' até '+instante(v.ultima)+'. Alguns dias podem estar sem sinal.':'';if(st.resultado && st.resultado.placa!==el('fhhVeiculo').value)mensagem('Veículo alterado. Clique em Consultar rastro para atualizar o mapa.');}
  async function carregarBase(){
    if(st.baseP)return st.baseP;if(st.baseEm && Date.now()-st.baseEm<60000)return;
    st.baseP=(async()=>{try{
      const b=await json('/frota/historico/veiculos');st.veiculos=b.veiculos||[];st.baseEm=Date.now();
      const sel=el('fhhVeiculo'),antes=sel.value;
      sel.innerHTML='<option value="">Escolha um veículo…</option>'+st.veiculos.map(v=>`<option value="${esc(v.placa)}">${esc(v.placa)}${v.modelo?' · '+esc(v.modelo):''}</option>`).join('');
      if(st.veiculos.some(v=>v.placa===antes))sel.value=antes;
      disponibilidade();if(!st.veiculos.length)mensagem('Ainda não há leituras de GPS salvas para consultar.');
    }catch(e){mensagem(e.message,true);}finally{st.baseP=null;}})();return st.baseP;
  }
  async function garantirMapa(){
    if(st.mapa)return true;
    try{await window.frtApi.carregarLeaflet();if(st.mapa)return true;const L=window.L;
      st.mapa=L.map(el('fhhMapa')).setView([-22.9,-43.4],9);
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'© OpenStreetMap',referrerPolicy:'strict-origin-when-cross-origin'}).on('tileerror',()=>{el('fhhMapaAviso').textContent='Fundo do mapa indisponível. Os pontos e o trajeto continuam disponíveis.';}).addTo(st.mapa);
      L.control.scale({imperial:false,maxWidth:100}).addTo(st.mapa);st.cam=L.layerGroup().addTo(st.mapa);st.renderer=L.canvas({padding:0.3});
      return true;
    }catch(e){mensagem('Não foi possível abrir o mapa: '+e.message,true);return false;}
  }
  function validar(inicio,fim){
    const real=s=>/^\d{4}-\d{2}-\d{2}$/.test(s)&&Number.isFinite(Date.parse(s))&&new Date(s+'T00:00:00Z').toISOString().slice(0,10)===s;
    if(!real(inicio)||!real(fim))throw Error('Informe datas válidas.');
    const dias=(Date.parse(fim)-Date.parse(inicio))/86400000+1;
    if(dias<1 || dias>5)throw Error('Escolha de 1 a 5 dias, contando o primeiro e o último.');
    if(fim>hoje())throw Error('O período deve terminar até hoje.');
  }
  async function consultar(){
    const placa=el('fhhVeiculo').value,inicio=el('fhhInicio').value,fim=el('fhhFim').value;
    try{if(!placa)throw Error('Escolha um veículo.');validar(inicio,fim);}catch(e){mensagem(e.message,true);return;}
    pausar();st.consulta?.abort();const seq=++st.seq,controle=new AbortController();st.consulta=controle;
    const limite=setTimeout(()=>controle.abort(),20000);
    el('fhhConsultar').disabled=true;el('fhhResultados').setAttribute('aria-busy','true');mensagem('Consultando o GPS de '+placa+'…');
    try{
      const q=new URLSearchParams({placa,inicio,fim});const r=await json('/frota/historico?'+q,controle.signal);
      if(seq!==st.seq || el('frtParteHistorico').hidden)return;
      st.resultado=r;render();
      if(await garantirMapa() && seq===st.seq){desenhar();enquadrar();}
    }catch(e){if(seq===st.seq)mensagem(e.name==='AbortError'?'A consulta demorou demais. Tente novamente ou escolha menos dias.':e.message,true);}
    finally{clearTimeout(limite);if(seq===st.seq){st.consulta=null;el('fhhConsultar').disabled=false;el('fhhResultados').setAttribute('aria-busy','false');}}
  }
  function render(){
    const r=st.resultado,s=r.resumo;
    el('fhhMapaTitulo').textContent=r.placa+' · histórico do GPS';el('fhhMapaResumo').textContent=data(r.inicio)+' 00:00 → '+data(r.fim)+' 23:59';
    const card=(k,v)=>`<div class="frt-stat"><span>${k}</span><b>${v}</b></div>`;
    el('fhhResumo').innerHTML=card('Km pelo GPS',num(s.km))+card('Rodando observado',dur(s.movendo_min))+card('Parado observado',dur(s.parado_min))+card('Vel. máxima',num(s.vel_max)+' km/h');
    el('fhhCobertura').textContent=r.primeira?s.pontos_validos+' leituras válidas · primeiro sinal: '+instante(r.primeira)+' · último: '+instante(r.ultima):'Nenhuma leitura válida nesse período.';
    const diaCor=d=>CORES[r.dias.findIndex(x=>x.data===d)%CORES.length];
    el('fhhDias').innerHTML=r.dias.map((d,i)=>`<button type="button" class="fhh-dia${d.sem_dados?' fhh-dia-vazio':''}" data-dia="${esc(d.data)}"${d.sem_dados?' disabled':''}><span class="fhh-dia-titulo"><i style="background:${CORES[i%CORES.length]}"></i><b>${esc(data(d.data))}</b><strong>${d.sem_dados?'Sem posições válidas':num(d.km)+' km'}</strong></span><span>${d.sem_dados?(d.pontos_brutos?'Leituras rejeitadas pelas verificações do GPS.':'Nenhuma leitura de GPS registrada.'):(d.pontos_validos+' leituras · '+esc(String(d.fonte||'').toUpperCase()))}</span>${d.primeira?'<small>'+esc(instante(d.primeira))+' → '+esc(instante(d.ultima))+'</small>':''}</button>`).join('');
    el('fhhDias').querySelectorAll('[data-dia]').forEach(b=>{b.onclick=()=>verDia(b.dataset.dia);});
    el('fhhLegenda').innerHTML=r.dias.filter(d=>!d.sem_dados).map(d=>`<span><i style="background:${diaCor(d.data)}"></i>${esc(data(d.data))}</span>`).join('');
    const tipos={chegou_loja:'Chegou à loja',saiu_loja:'Saiu da loja',saiu_fabrica:'Saiu da fábrica',voltou_fabrica:'Voltou à fábrica',local_incerto:'Local incerto'};
    el('fhhEventosLista').innerHTML=(r.eventos||[]).map(e=>`<div class="fhh-evento"><time>${esc(instante(e.em))}</time><strong>${esc(tipos[e.tipo]||e.tipo)}</strong><span>${esc(e.lugar_nome||e.lugar_codigo||'')}</span></div>`).join('') || '<p class="frt-vazio">Nenhum evento registrado nesse período.</p>';
    if(r.eventos_truncados)el('fhhEventosLista').innerHTML+='<p class="fhh-nota">Mostrando os primeiros 2.000 eventos.</p>';
    const P=r.pontos,barra=el('fhhBarra');barra.disabled=!P.length;el('fhhPlay').disabled=P.length<2;el('fhhEnquadrar').disabled=!P.length;
    barra.min=P.length?P[0][3]:0;barra.max=P.length?P[P.length-1][3]:1;barra.value=barra.min;el('fhhHora').textContent=P.length?instante(Date.parse(r.dia_inicio)+P[0][3]*1000):'Sem sinais no período';
    mensagem(!P.length?'Nenhum trajeto disponível nesse período.':r.sem_dados.length?'Consulta concluída. Sem posições válidas em: '+r.sem_dados.map(data).join(', ')+'.':'Consulta concluída. Clique em um dia para enquadrar seu trajeto.');
  }
  function diaDoPonto(p){return new Date(Date.parse(st.resultado.dia_inicio)+p[3]*1000-3*3600000).toISOString().slice(0,10);}
  function desenhar(){
    if(!st.mapa || !st.resultado)return;const L=window.L,r=st.resultado,P=r.pontos;st.cam.clearLayers();st.replay=null;st.mapa.invalidateSize();
    let trecho=null;const cor=dia=>CORES[Math.max(0,r.dias.findIndex(x=>x.data===dia))%CORES.length];
    const fechar=()=>{if(trecho?.coords.length>1)L.polyline(trecho.coords,{renderer:st.renderer,color:cor(trecho.dia),weight:4,opacity:0.85,dashArray:trecho.lig===1?'5 7':null}).bindTooltip(esc(r.placa)+' · '+data(trecho.dia)+(trecho.lig===1?'<br>Sinal espaçado: caminho aproximado':''),{sticky:true}).addTo(st.cam);trecho=null;};
    for(let i=1;i<P.length;i++){const a=P[i-1],b=P[i],dia=diaDoPonto(b);if(b[4]===2){fechar();continue;}if(!trecho || trecho.lig!==b[4] || trecho.dia!==dia){fechar();trecho={dia,lig:b[4],coords:[[a[0],a[1]]]};}trecho.coords.push([b[0],b[1]]);}fechar();
    for(const d of r.dias){const pts=P.filter(p=>diaDoPonto(p)===d.data);if(!pts.length)continue;for(const [p,rotulo] of [[pts[0],'Primeiro sinal'],...(pts.length>1?[[pts[pts.length-1],'Último sinal']]:[])])L.circleMarker([p[0],p[1]],{radius:6,color:cor(d.data),weight:2,fillColor:cor(d.data),fillOpacity:0.7}).bindTooltip(rotulo+' · '+instante(Date.parse(r.dia_inicio)+p[3]*1000),{direction:'top'}).addTo(st.cam);}
  }
  function enquadrar(){const P=st.resultado?.pontos;if(st.mapa && P?.length)st.mapa.fitBounds(window.L.latLngBounds(P.map(p=>[p[0],p[1]])),{maxZoom:16,padding:[30,30]});}
  function verDia(dia){const pts=st.resultado?.pontos.filter(p=>diaDoPonto(p)===dia);if(!st.mapa || !pts?.length)return;pausar();st.mapa.fitBounds(window.L.latLngBounds(pts.map(p=>[p[0],p[1]])),{maxZoom:16,padding:[30,30]});mostrar(pts[0][3]);}
  function mostrar(s){
    if(!st.mapa || !st.resultado?.pontos.length)return;const p=window.frtRastroUtils.posicaoReplay(st.resultado.pontos,s);if(!p)return;
    const L=window.L,em=Date.parse(st.resultado.dia_inicio)+s*1000;
    const texto=instante(em)+' · '+(p.semSinal?'Sem sinal. Última posição conhecida em '+instante(Date.parse(st.resultado.dia_inicio)+p.em*1000):Math.round(p.vel||0)+' km/h'+(p.aproximado?' · estimado entre sinais':''));
    if(!st.replay)st.replay=L.circleMarker([p.lat,p.lng],{radius:9,weight:3,color:'#fff',fillColor:'#2563eb',fillOpacity:1}).bindTooltip('').addTo(st.cam);
    st.replay.setLatLng([p.lat,p.lng]).setStyle({fillColor:p.semSinal?'#94a3b8':'#2563eb',fillOpacity:p.semSinal?0.5:1}).setTooltipContent(esc(texto));
    el('fhhBarra').value=s;el('fhhHora').textContent=texto;
  }
  function pausar(){if(st.timer)clearInterval(st.timer);st.timer=null;if(el('fhhPlay'))el('fhhPlay').textContent='▶ Reproduzir';}
  function reproduzir(){
    if(st.timer){pausar();return;}const P=st.resultado?.pontos;if(!P?.length)return;
    const barra=el('fhhBarra'),fim=Number(barra.max);let s=Number(barra.value);if(s>=fim)s=Number(barra.min);mostrar(s);el('fhhPlay').textContent='⏸ Pausar';
    st.timer=setInterval(()=>{if(el('frtParteHistorico').hidden||document.hidden){pausar();return;}s=Math.min(fim,s+Number(el('fhhVel').value)/10);mostrar(s);if(s>=fim)pausar();},100);
  }
  function ocultar(){st.abertura++;pausar();if(st.consulta){st.consulta.abort();st.consulta=null;st.seq++;el('fhhConsultar').disabled=false;el('fhhResultados').setAttribute('aria-busy','false');mensagem('Consulta interrompida. Clique em Consultar rastro para tentar novamente.');}}
  async function abrir(placa,opcoes={}){
    montar();if(!st.montado)return;
    if(opcoes.data || opcoes.consultar)ocultar();
    const abertura=++st.abertura;
    if(opcoes.data){
      try{validar(opcoes.data,opcoes.data);}catch(e){mensagem(e.message,true);return;}
      el('fhhInicio').value=el('fhhFim').value=opcoes.data;
    }
    limites();await carregarBase();if(abertura!==st.abertura)return;
    if(placa){
      const disponivel=st.veiculos.some(v=>v.placa===placa);
      el('fhhVeiculo').value=disponivel?placa:'';disponibilidade();
      if(!disponivel){mensagem('Não há leituras de GPS salvas para '+placa+'. Escolha outro veículo.',true);return;}
    }
    if(opcoes.consultar && placa)return consultar();
    if(opcoes.data)mensagem('Escolha um veículo e clique em Consultar rastro para ver a rota deste dia.');
    if(await garantirMapa() && abertura===st.abertura)setTimeout(()=>st.mapa.invalidateSize(),60);
  }
  window.frtHistorico={abrir,ocultar};
})();
