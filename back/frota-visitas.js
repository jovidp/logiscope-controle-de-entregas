// ================================================================
// frota-visitas.js — registro de CHEGADA e SAIDA de cada veiculo em cada
// lugar conhecido (lojas, fabrica, CSG/filiais) no dia. Usado pela aba
// 🛰 Frota (back/frota.js -> GET /frota/painel, campo "visitas").
// ----------------------------------------------------------------
// E o MESMO detector dos avisos ao vivo (rastreador-ao-vivo.js) reprisado
// sobre o trajeto do dia, com as mesmas regras:
//   chegou = parado (< 3 km/h) a ate 250 m do lugar em 2 leituras seguidas
//            (horario = o da 1a leitura);
//   saiu   = 250 m andando ou 400 m em 2 leituras; horario = PARTIDA (1a leitura
//            depois da ultima parado no lugar) — ver rastreador-ao-vivo.js
// Reprisar, em vez de ler rastreador_eventos_loja:
//   - cobre qualquer dia dos 60 de historico (o ao vivo so existe desde
//     05/10/2026 10:39);
//   - nao herda erros do ao vivo: em 05/10 ele marcou "chegou no WEST III
//     12:48" para um carro que estava la desde 08:49 (a loja so entrou no mapa
//     as 11h) e um "voltou para a fabrica" falso depois de um ponto em SP.
// Lojas coladas (< 150 m): com viagem no TMS vale a proxima loja DA VIAGEM
// (fila na ordem das paradas, a mesma ideia do "pendente" do ao vivo); sem
// viagem, os nomes juntos ("SANTA CRUZ I / SANTA CRUZ II").
// Se o 1o sinal do dia ja esta dentro de um lugar, a chegada nao foi vista:
// chegada_vista = false ("ja estava la no 1o sinal").
// ================================================================
const aoVivo = require("./rastreador-ao-vivo");

const FABRICA = "FABRICA";
const FEITA = new Set(["Entregue", "Entregue com ocorrencia", "Recusada", "Ocorrencia"]);
const hhmm = (h) => (h ? String(h).slice(0, 5) : null);

// lista: trajeto do dia em ordem de tempo [{lat,lng,velocidade,posicao_em,fonte}]
// lugares: [{codigo,nome,lat,lng}] (loja_coordenadas)
// viagem: viagem do TMS do veiculo no dia (com paradas[].loja_codigo_pes) ou null
function visitasDoDia(lista, lugares, viagem) {
  const det = aoVivo.criarDetector();
  const paradas = viagem ? [...(viagem.paradas || [])].sort((a, b) => (a.ordem || 0) - (b.ordem || 0) || (a.id || 0) - (b.id || 0)) : [];
  const fila = paradas.map((p) => p.loja_codigo_pes).filter(Boolean);
  const visitas = [];
  let aberta = null;

  const abrir = (lugar, chegou, vista) => {
    // Lojas coladas: nome/codigos em ordem fixa (o detector junta pela
    // distancia, entao a mesma dupla saia "I / II" numa visita e "II / I" noutra).
    const ambigua = lugar.ambigua ? [...lugar.ambigua].sort() : null;
    const nome = ambigua ? String(lugar.nome || "").split(" / ").sort((a, b) => a.localeCompare(b, "pt-BR")).join(" / ") : lugar.nome || lugar.codigo;
    aberta = {
      codigo: ambigua ? ambigua[0] : lugar.codigo, nome, ambigua,
      fabrica: lugar.codigo === FABRICA, lat: lugar.lat, lng: lugar.lng,
      chegou: new Date(chegou).toISOString(), chegada_vista: vista, saiu: null, min: null,
    };
    visitas.push(aberta);
  };

  lista.forEach((p, i) => {
    const eventos = det.processar(
      { placa: "X", lat: p.lat, lng: p.lng, velocidade: p.velocidade, posicao_em: p.posicao_em, fonte: p.fonte, motor: p.motor, device_id: p.device_id },
      lugares, { preferidos: fila, historico:true },
    );
    if (i === 0) {
      const s = det.estado.get("X");
      if (s && s.dentro) abrir(s.dentro, p.posicao_em, false); // ja estava la no 1o sinal
    }
    for (const e of eventos) {
      if (e.tipo === "chegou_loja" || e.tipo === "voltou_fabrica" || e.tipo === "local_incerto") {
        abrir(e.lugar, e.em, true);
        const k = fila.indexOf(e.lugar.codigo);
        if (k >= 0 && !e.lugar.ambigua) fila.splice(k, 1);
      } else if ((e.tipo === "saiu_loja" || e.tipo === "saiu_fabrica" || e.tipo === "saiu_local_incerto") && aberta) {
        aberta.saiu = new Date(e.em).toISOString();
        if (aberta.chegada_vista) aberta.min = Math.round((new Date(e.em) - new Date(aberta.chegou)) / 60000);
        aberta = null;
      }
    }
  });

  // Liga cada visita a parada da viagem (horario previsto) e acrescenta as
  // paradas da viagem que o GPS nao registrou.
  const usadas = new Set();
  for (const v of visitas) {
    if (v.ambigua) {v.confirmacao_necessaria=true;continue;}
    const codigos = [v.codigo];
    const parada = paradas.find((p) => !usadas.has(p) && codigos.includes(p.loja_codigo_pes));
    if (!parada) continue;
    usadas.add(parada);
    v.na_viagem = true;
    v.prevista = hhmm(parada.hora_prevista);
  }
  const semRegistro = paradas
    .filter((p) => !usadas.has(p))
    .map((p) => ({
      codigo: p.loja_codigo_pes || null, nome: p.loja_nome || p.loja_codigo_pes || "Loja", sem_registro: true,
      na_viagem: true, prevista: hhmm(p.hora_prevista), feita: !!(p.ocorrencia_id || FEITA.has(p.status)),
    }));
  return visitas.concat(semRegistro);
}

module.exports = { visitasDoDia };
