(function(){
 'use strict';
 const $=id=>document.getElementById(id);
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const hoje=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
 const nome=s=>String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase().replace(/[^A-Z0-9]/g,'');
 let previa=null,pedido=null,seq=0,consulta=0,salvando=false;
 function status(s,erro=false){const e=$('ckwStatus');e.textContent=s;e.style.color=erro?'var(--vermelho)':'var(--text-secondary)';}
 async function api(url,opt={}){
  const r=await fetch(url,opt),j=await r.json().catch(()=>({}));
  if(!r.ok)throw Error(j.error||(r.status===401?'Entre no sistema para importar.':r.status===403?'Seu perfil não permite importar o checklist.':'Não foi possível concluir a consulta.'));
  return j;
 }
 function limparPrevia(){seq++;pedido?.abort();previa=null;$('ckwPrevia').innerHTML='';$('ckwConfirmar').disabled=true;}
 function viagensMotorista(id){const m=previa?.motoristas.find(m=>m.id===Number(id));return m?previa.viagens.filter(v=>nome(v.motorista)===nome(m.nome)):[];}
 function atualizarLinha(linha,inicial=false){
  const id=linha.querySelector('[data-motorista]').value,select=linha.querySelector('[data-viagem]'),anterior=select.value,vs=viagensMotorista(id);
  select.innerHTML='<option value="">Selecione a viagem do dia</option>'+vs.map(v=>'<option value="'+v.id+'">'+esc(v.placa||'Sem placa')+' · '+esc(v.rota||'Sem rota')+' · viagem '+v.id+'</option>').join('');
  if(vs.some(v=>String(v.id)===anterior))select.value=anterior;else if(vs.length===1)select.value=String(vs[0].id);
  const grupo=previa.grupos[Number(linha.dataset.indice)];
  linha.querySelector('[data-aviso]').textContent=!id?'Nome não identificado com segurança; selecione o motorista.':!vs.length?'Sem viagem no TMS para este motorista neste dia.':vs.length>1?'Escolha qual viagem corresponde ao checklist.':grupo.criterio_vinculo==='primeiro nome'?'Vínculo pelo primeiro nome; confira.':'Identificado no TMS.';
  if(!inicial)linha.querySelector('[data-selecionar]').checked=!!select.value;
 }
 function fotosHTML(fotos){return fotos.map(f=>'<button type="button" class="btn-ghost btn-sm" data-foto="'+esc(f.url||'/checklists-diarios/whatsapp/fotos/'+f.id)+'" data-nome="'+esc(f.nome)+'">Ver foto</button>').join(' ');}
 function bindFotos(host){host.querySelectorAll('[data-foto]').forEach(b=>b.onclick=()=>{$('ckwFoto').src=b.dataset.foto;$('ckwFotoLegenda').textContent=b.dataset.nome;$('ckwFotoModal').showModal();});}
 function renderPrevia(){
  const automaticos=previa.grupos.filter(g=>g.motorista_sugerido&&g.viagem_sugerida).length;
  $('ckwPrevia').innerHTML='<p><b>'+esc(previa.data.split('-').reverse().join('/'))+'</b> · '+previa.grupos.length+' remetentes · '+automaticos+' cruzados com o TMS · '+(previa.grupos.length-automaticos)+' para conferir.</p><p class="tms-subtitle">Cada motorista selecionado será registrado como checklist feito pelo envio no grupo. As fotos são opcionais.</p>'+
   '<div class="frt-tabela-wrap"><table class="frt-tabela ckw-tabela"><thead><tr><th>Salvar</th><th>Remetente / primeiro envio</th><th>Motorista</th><th>Carro / rota do TMS</th><th>Checklist</th></tr></thead><tbody>'+previa.grupos.map(g=>'<tr data-indice="'+g.indice+'"><td><input type="checkbox" data-selecionar'+(g.motorista_sugerido&&g.viagem_sugerida?' checked':'')+' aria-label="Registrar checklist de '+esc(g.remetente)+'"></td><td><b>'+esc(g.remetente)+'</b><br>'+esc(g.hora_inicio)+'<br><small>'+g.mensagens+' mensagem(ns) no dia</small></td><td><select data-motorista aria-label="Motorista de '+esc(g.remetente)+'"><option value="">Selecione o motorista</option>'+previa.motoristas.map(m=>'<option value="'+m.id+'"'+(g.motorista_sugerido===m.id?' selected':'')+'>'+esc(m.nome)+(g.motorista_sugerido!==m.id&&g.sugestoes.includes(m.id)?' (sugestão)':'')+'</option>').join('')+'</select><small data-aviso></small></td><td><select data-viagem aria-label="Viagem de '+esc(g.remetente)+'"></select></td><td><span style="color:var(--verde)">Feito pelo grupo</span>'+ (g.fotos.length?'<br>'+fotosHTML(g.fotos):'')+'</td></tr>').join('')+'</tbody></table></div>';
  for(const l of $('ckwPrevia').querySelectorAll('[data-indice]')){
   l.querySelector('[data-motorista]').onchange=()=>atualizarLinha(l);
   l.querySelector('[data-viagem]').onchange=()=>{l.querySelector('[data-selecionar]').checked=!!l.querySelector('[data-viagem]').value;};
   atualizarLinha(l,true);
  }
  bindFotos($('ckwPrevia'));$('ckwConfirmar').disabled=false;
 }
 async function lerArquivo(e){
  e.preventDefault();if(salvando)return;const arquivo=$('ckwArquivo').files[0];
  if(!arquivo){status('Escolha o ZIP exportado do grupo.',true);return;}
  if(arquivo.size>30*1024*1024){status('O ZIP deve ter até 30 MB.',true);return;}
  limparPrevia();const versao=seq;pedido=new AbortController();const controle=pedido,timer=setTimeout(()=>controle.abort(),45000);
  $('ckwLer').disabled=true;status('Lendo os remetentes e cruzando carro e rota com o TMS…');
  try{
   const j=await api('/checklists-diarios/whatsapp/previa?'+new URLSearchParams({data:$('ckwData').value,ordem:$('ckwOrdem').value}),{method:'POST',headers:{'Content-Type':'application/zip'},body:arquivo,signal:controle.signal});
   if(versao!==seq)return;previa=j;renderPrevia();status('Confira os vínculos e salve os checklists do dia. A prévia vale por 10 minutos.');
  }catch(err){if(versao===seq)status(err.name==='AbortError'?'A leitura demorou demais. Tente novamente.':err.message,true);}
  finally{clearTimeout(timer);if(pedido===controle)pedido=null;$('ckwLer').disabled=false;}
 }
 async function confirmar(){
  if(!previa||salvando)return;const selecoes=[];
  for(const l of $('ckwPrevia').querySelectorAll('[data-indice]'))if(l.querySelector('[data-selecionar]').checked){
   const motorista_id=Number(l.querySelector('[data-motorista]').value),viagem_id=Number(l.querySelector('[data-viagem]').value),v=viagensMotorista(motorista_id).find(v=>v.id===viagem_id);
   if(!motorista_id||!v?.placa){status('Confira motorista e viagem de cada linha selecionada.',true);return;}
   selecoes.push({indice:Number(l.dataset.indice),motorista_id,viagem_id,placa:v.placa});
  }
  if(!selecoes.length){status('Selecione pelo menos um motorista com viagem no TMS.',true);return;}
  salvando=true;const controles=[...$('ckwForm').querySelectorAll('input,select,button'),...$('ckwPrevia').querySelectorAll('input,select')];
  controles.forEach(c=>c.disabled=true);$('ckwConfirmar').disabled=true;status('Salvando os checklists do dia…');
  try{
   const data=previa.data,j=await api('/checklists-diarios/whatsapp/confirmar',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:previa.token,selecoes})});
   limparPrevia();$('ckwConsultaData').value=data;await listar();
   if(typeof window.carregarCachesVeiculos==='function')await window.carregarCachesVeiculos();
   window.renderizarListaChecklistDiario?.();window.atualizarBlocoStatusChecklist?.();window.dispararMudou?.('checklist');
   status('Checklist feito registrado para '+j.checklist_ids.length+' motorista(s). '+j.checklists_novos+' novo(s); os existentes foram reaproveitados.');
  }catch(e){status(e.message,true);$('ckwConfirmar').disabled=!previa;}
  finally{salvando=false;controles.forEach(c=>c.disabled=false);}
 }
 async function listar(){
  const versao=++consulta,data=$('ckwConsultaData').value;if(!data)return;
  try{
   const envios=await api('/checklists-diarios/whatsapp/envios?'+new URLSearchParams({data}));if(versao!==consulta)return;
   $('ckwEnvios').innerHTML=envios.length?'<div class="ckw-cards">'+envios.map(e=>'<article class="ckw-card"><b>'+esc(e.motorista)+' · '+esc(e.placa)+'</b><p>'+esc(e.rota||'Sem rota')+'<br>'+esc(e.remetente)+' · primeiro envio '+esc(e.hora_inicio)+'</p><p style="color:var(--'+(e.checklist_realizado?'verde':'laranja')+')">'+(e.checklist_realizado?'✅ Checklist feito pelo grupo':'Registro anterior; reimporte para contar como checklist')+'</p><div>'+fotosHTML(e.fotos)+'</div></article>').join('')+'</div>':'<p class="tms-subtitle">Nenhum checklist do grupo importado para este dia.</p>';
   bindFotos($('ckwEnvios'));
  }catch(e){if(versao===consulta)$('ckwEnvios').textContent=e.message;}
 }
 function montar(){
  const host=$('ckwHost');if(!host)return;
  host.innerHTML='<details class="ckw-box"><summary>Importar checklists do grupo de WhatsApp</summary><div class="ckw-corpo"><p class="tms-subtitle">Exporte a conversa e selecione o ZIP, mesmo sem fotos. Quem enviou mensagem no dia conta como checklist feito. O TMS preenche carro e rota; confira os nomes e as viagens antes de salvar.</p><form id="ckwForm" class="ckw-form"><label>Arquivo do grupo<input type="file" id="ckwArquivo" accept=".zip,application/zip" required></label><label>Dia do checklist<input id="ckwData" type="date" required></label><label>Datas no texto<select id="ckwOrdem"><option value="mdy">Mês/dia/ano — exemplo: 10/7 = 7 de outubro</option><option value="dmy">Dia/mês/ano — exemplo: 7/10 = 7 de outubro</option></select></label><button class="btn-blue" id="ckwLer" type="submit">Ler arquivo e cruzar com o TMS</button></form><p id="ckwStatus" role="status" aria-live="polite"></p><div id="ckwPrevia"></div><button id="ckwConfirmar" class="btn-green" type="button" disabled>Salvar checklists do dia</button></div></details><div class="ckw-registros"><h3>Checklists importados do grupo</h3><div class="ckw-filtros"><label>Dia<input type="date" id="ckwConsultaData"></label><button type="button" id="ckwAtualizar" class="btn-ghost btn-sm">Atualizar</button></div><div id="ckwEnvios"></div></div><dialog id="ckwFotoModal" class="ckw-modal"><button type="button" id="ckwFecharFoto" class="btn-ghost">Fechar</button><p id="ckwFotoLegenda"></p><img id="ckwFoto" alt="Foto enviada no grupo de checklist"></dialog>';
  $('ckwData').value=hoje();$('ckwConsultaData').value=hoje();$('ckwForm').onsubmit=lerArquivo;$('ckwConfirmar').onclick=confirmar;$('ckwAtualizar').onclick=listar;$('ckwConsultaData').onchange=listar;
  for(const id of ['ckwArquivo','ckwData','ckwOrdem'])$(id).onchange=()=>{limparPrevia();status('Leia o arquivo para cruzar os dados selecionados.');};
  host.querySelector('details').ontoggle=e=>{if(e.target.open)listar();};$('ckwFecharFoto').onclick=()=>$('ckwFotoModal').close();$('ckwFotoModal').addEventListener('close',()=>{$('ckwFoto').removeAttribute('src');});
  Promise.resolve(window.authReady).then(u=>{if(u)listar();});
 }
 window.ckWhatsApp={montar,listar};document.addEventListener('DOMContentLoaded',montar);
})();