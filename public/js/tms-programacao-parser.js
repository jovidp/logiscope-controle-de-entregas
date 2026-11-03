// ================================================================
// tms-programacao-parser.js  —  LEITOR da planilha de PROGRAMACAO DE ROTAS
// ----------------------------------------------------------------
// A operacao monta o dia numa planilha com um BLOCO por rota:
//
//   ROTA | Z. NORTE I |            ...            | HORARIO DE SAIDA | 05:00
//   ATD  | PES | LOJAS | EMP | HORARIO DA LOJA | 434 | 3386 | ALMOXARIFADO |
//        SACOLA | RT | CX | FRETE ENVIO | FRETE RETORNO | CARGA WMS | MOTORISTA | VEICULO
//   1o   |     | FABRICA |   |      | GEOVANA  (quem responde pela carga na fabrica)
//   2o   | 237 | MADUREIRA II | 211 | 06:20 | 446 | 454 | 12048802 | 12048646 | 5 | 67 | R$ 862,99 | | 3315 | RENATO MORAES | FKA0C10
//   3o   | ...                                                           | AJUDANTE(S):    | R:57
//   4o   | ...                                                           | IAGO C/ ELIAS |
//   ...
//   11o  |     | FABRICA |                                               | 1243656         |
//
// Este arquivo so LE: transforma a matriz de celulas (SheetJS header:1) em
// blocos estruturados. Casar nome com cadastro e com viagem ja existente e
// trabalho do servidor (back/tms-programacao.js) — la ficam os normalizadores
// canonicos de loja/rota.
//
// Tolerante a variacao de layout: as colunas sao achadas pelo NOME do
// cabecalho (nao pela posicao), blocos podem vir empilhados ou lado a lado,
// celulas mescladas e com quebra de linha funcionam, e colunas numericas no
// cabecalho (434, 3386 ...) viram "documentos" pelo codigo que tiverem.
//
// DUPLA FACE (Node + navegador), igual ao kpi-ocorrencia.js: o navegador usa
// para montar a previa e o Node usa nos testes. Sem sintaxe que o navegador
// nao entenda e sem dependencia externa.
// ================================================================
(function (raiz, fabrica) {
  const api = fabrica();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else raiz.TmsProgramacao = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const MAX_BLOCOS = 60;
  const MAX_PARADAS = 60;

  // ── normalizacao de texto ─────────────────────────────────────
  function semAcento(s) {
    return String(s).normalize("NFD").replace(/[̀-ͯ]/g, "");
  }

  // Texto "limpo" para exibir/gravar: sem espacos duplicados nem quebra de linha.
  function texto(v) {
    if (v === null || v === undefined) return "";
    if (typeof v === "number") {
      if (!Number.isFinite(v)) return "";
      return Number.isInteger(v) ? String(v) : String(Math.round(v * 1e6) / 1e6);
    }
    return String(v).replace(/\s+/g, " ").trim();
  }

  // Chave de COMPARACAO de cabecalho/rotulo: sem acento, maiuscula, sem ":" final.
  function norm(v) {
    return semAcento(texto(v)).toUpperCase().replace(/[º°ª]/g, "").replace(/\s*:\s*$/, "").trim();
  }

  // ── conversores de valor ──────────────────────────────────────
  // Hora -> "HH:MM". Aceita "5:00", "05:00:00", "5:00 PM", "5h", "05H30" e o
  // numero de fracao de dia que o Excel guarda (0.2083 = 05:00).
  function hora(v) {
    if (v === null || v === undefined || v === "") return null;
    if (typeof v === "number") {
      if (!Number.isFinite(v) || v < 0) return null;
      const fracao = v >= 1 ? v - Math.floor(v) : v;
      let minutos = Math.round(fracao * 1440);
      if (minutos >= 1440) minutos = 0;
      return `${String(Math.floor(minutos / 60)).padStart(2, "0")}:${String(minutos % 60).padStart(2, "0")}`;
    }
    const t = norm(v);
    if (/^\d*[.,]\d+$/.test(t)) return hora(Number(t.replace(",", ".")));
    let m = t.match(/^(\d{1,2})\s*[:H]\s*(\d{2})(?:\s*:\s*\d{2})?\s*(AM|PM)?$/);
    let h;
    let mi;
    if (m) {
      h = Number(m[1]);
      mi = Number(m[2]);
      if (m[3] === "PM" && h < 12) h += 12;
      if (m[3] === "AM" && h === 12) h = 0;
    } else {
      m = t.match(/^(\d{1,2})\s*H$/);
      if (!m) return null;
      h = Number(m[1]);
      mi = 0;
    }
    if (h > 23 || mi > 59) return null;
    return `${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}`;
  }

  // Numero em formato BR ("1.675,33"), US ("1,675.33") ou ja numerico.
  function numero(v) {
    if (v === null || v === undefined || v === "") return null;
    if (typeof v === "number") return Number.isFinite(v) ? v : null;
    let t = String(v).replace(/[^\d,.\-]/g, "");
    if (!t || !/\d/.test(t)) return null;
    const ultVirg = t.lastIndexOf(",");
    const ultPonto = t.lastIndexOf(".");
    if (ultVirg >= 0 && ultPonto >= 0) {
      // O separador que aparece por ULTIMO e o decimal.
      if (ultVirg > ultPonto) t = t.replace(/\./g, "").replace(",", ".");
      else t = t.replace(/,/g, "");
    } else if (ultVirg >= 0) {
      // So virgula: "862,99" e decimal; "1,675" (3 digitos depois) e milhar.
      const depois = t.length - ultVirg - 1;
      t = depois === 3 && (t.match(/,/g) || []).length >= 1 && !/^-?0,/.test(t)
        ? t.replace(/,/g, "")
        : t.replace(/,/g, ".");
    } else if ((t.match(/\./g) || []).length > 1) {
      t = t.replace(/\./g, ""); // "1.234.567" = milhar
    }
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }

  function dinheiro(v) {
    const n = numero(v);
    return n === null ? null : Math.round(n * 100) / 100;
  }

  function inteiro(v) {
    const n = numero(v);
    if (n === null) return null;
    const r = Math.round(n);
    return r >= 0 ? r : null;
  }

  // ── placa ─────────────────────────────────────────────────────
  // Placa antiga (ABC1234) ou Mercosul (ABC1D23); aceita hifen e espaco.
  function placa(v) {
    const t = norm(v).replace(/[^A-Z0-9]/g, "");
    return /^[A-Z]{3}\d[A-Z0-9]\d{2}$/.test(t) ? t : null;
  }

  // ── data ──────────────────────────────────────────────────────
  const MESES = {
    JAN: 1, JANEIRO: 1, FEV: 2, FEVEREIRO: 2, MAR: 3, MARCO: 3, ABR: 4, ABRIL: 4,
    MAI: 5, MAIO: 5, JUN: 6, JUNHO: 6, JUL: 7, JULHO: 7, AGO: 8, AGOSTO: 8,
    SET: 9, SETEMBRO: 9, OUT: 10, OUTUBRO: 10, NOV: 11, NOVEMBRO: 11, DEZ: 12, DEZEMBRO: 12,
  };

  function isoValida(a, m, d) {
    const dt = new Date(Date.UTC(a, m - 1, d));
    if (dt.getUTCFullYear() !== a || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
    return `${a}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }

  // Sem ano escrito: escolhe o ano que deixa a data mais perto de "hoje"
  // (planilha de 02/01 aberta em 30/12 e do ano que vem).
  function comAnoMaisProximo(m, d, hojeISO) {
    const base = Number(String(hojeISO || "").slice(0, 4)) || new Date().getFullYear();
    const hoje = Date.parse(`${hojeISO || `${base}-01-01`}T00:00:00Z`);
    let melhor = null;
    let dist = Infinity;
    [base - 1, base, base + 1].forEach((a) => {
      const iso = isoValida(a, m, d);
      if (!iso) return;
      const delta = Math.abs(Date.parse(`${iso}T00:00:00Z`) - hoje);
      if (delta < dist) { dist = delta; melhor = iso; }
    });
    return melhor;
  }

  function dataDeTexto(v, hojeISO) {
    if (typeof v === "number") {
      // Serial de data do Excel (1 = 1900-01-01). So confia na faixa 2009..2091.
      if (v < 40000 || v > 70000) return null;
      const ms = Date.UTC(1899, 11, 30) + Math.floor(v) * 86400000;
      return new Date(ms).toISOString().slice(0, 10);
    }
    const t = norm(v);
    if (!t) return null;
    let m = t.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
    if (m) return isoValida(Number(m[1]), Number(m[2]), Number(m[3]));
    m = t.match(/(?:^|[^\d/.\-])(\d{1,2})[/.\-](\d{1,2})(?:[/.\-](\d{2}|\d{4}))?(?![\d/])/);
    if (m) {
      const d = Number(m[1]);
      const mes = Number(m[2]);
      if (m[3]) {
        const a = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
        return isoValida(a, mes, d);
      }
      return comAnoMaisProximo(mes, d, hojeISO);
    }
    m = t.match(/\b(\d{1,2})\s*(?:DE\s+)?([A-Z]{3,9})\b(?:\s*(?:DE\s+)?(\d{4}))?/);
    if (m && MESES[m[2]]) {
      if (m[3]) return isoValida(Number(m[3]), MESES[m[2]], Number(m[1]));
      return comAnoMaisProximo(MESES[m[2]], Number(m[1]), hojeISO);
    }
    return null;
  }

  // Primeira data reconhecivel numa lista de textos (nome do arquivo, da aba,
  // titulo da planilha). null quando nenhuma serve.
  function detectarData(textos, hojeISO) {
    for (const t of textos || []) {
      const iso = dataDeTexto(t, hojeISO);
      if (iso) return iso;
    }
    return null;
  }

  // ── cabecalho ─────────────────────────────────────────────────
  const CABECALHOS = [
    ["atd", ["ATD", "ORDEM", "SEQ", "SEQUENCIA"]],
    ["pes", ["PES", "COD LOJA", "CODIGO LOJA"]],
    ["loja", ["LOJAS", "LOJA", "DESTINO"]],
    ["emp", ["EMP", "EMPRESA"]],
    ["hora_loja", ["HORARIO DA LOJA", "HORARIO LOJA", "HORARIO", "HORA", "HORA MARCADA", "HORA LOJA"]],
    ["almoxarifado", ["ALMOXARIFADO", "ALMOX", "PEDIDO ALMOXARIFADO"]],
    ["sacola", ["SACOLA", "SACOLAS", "PEDIDO SACOLA"]],
    ["rt", ["RT", "RETIRADA RT"]],
    ["cx", ["CX", "RETIRADA CX", "CAIXAS"]],
    ["frete_envio", ["FRETE ENVIO", "FRETE IDA", "FRETE"]],
    ["frete_retorno", ["FRETE RETORNO", "FRETE VOLTA"]],
    ["carga_wms", ["CARGA WMS", "WMS", "CARGA"]],
    ["motorista", ["MOTORISTA", "MOTORISTA / AJUDANTES", "EQUIPE"]],
    ["veiculo", ["VEICULO", "PLACA", "CARRO"]],
  ];
  const CAMPO_POR_ROTULO = new Map();
  CABECALHOS.forEach(([campo, rotulos]) => rotulos.forEach((r) => CAMPO_POR_ROTULO.set(r, campo)));

  function ehAncoraRota(v) {
    const n = norm(v);
    return n === "ROTA" || /^ROTA\s*[:\-]\s*\S/.test(n);
  }

  function ehRotuloSaida(v) {
    return /^(HORARIO|HORA)\s+(DE\s+)?SAIDA\b|^SAIDA\b/.test(norm(v));
  }

  function ehFabrica(v) {
    const n = norm(v).replace(/[^A-Z ]/g, "").trim();
    return /^(FABRICA|CD|CENTRO DE DISTRIBUICAO|RETORNO FABRICA)\b/.test(n);
  }

  function linhaVazia(linha, ini, fim) {
    for (let c = ini; c < fim; c += 1) if (texto(linha[c]) !== "") return false;
    return true;
  }

  // Mapa campo -> coluna para o cabecalho do bloco, dentro de [ini, fim).
  function mapearCabecalho(linha, ini, fim) {
    const mapa = { docs: [] };
    for (let c = ini; c < fim; c += 1) {
      const bruto = linha[c];
      const n = norm(bruto);
      if (!n) continue;
      if (/^\d{2,6}$/.test(n)) { mapa.docs.push({ codigo: n, col: c }); continue; }
      const campo = CAMPO_POR_ROTULO.get(n);
      if (campo && mapa[campo] === undefined) mapa[campo] = c;
    }
    return mapa;
  }

  // ── coluna MOTORISTA: nome, "AJUDANTE(S):", nomes, codigo do rodape ──
  function linhasDaCelula(v) {
    if (v === null || v === undefined) return [];
    if (typeof v === "number") return [texto(v)];
    return String(v).split(/\r?\n/).map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean);
  }

  function separarNomes(s) {
    return String(s || "")
      .split(/\s*(?:\/+|,|;|\+|&|\s+E\s+)\s*/i)
      .map((x) => x.replace(/\s+/g, " ").trim())
      .filter((x) => x && !/^[-–.]+$/.test(x));
  }

  function lerEquipe(linhas) {
    const r = { motorista: "", ajudantes: [], codigos: [], notas: [] };
    let estado = "motorista";
    linhas.forEach((linha) => {
      const n = norm(linha);
      let m = n.match(/^AJUDANTES?\s*(?:\(S\))?\s*:?\s*(.*)$/);
      if (m) {
        estado = "ajudantes";
        const resto = linha.replace(/^[^:]*:?/, "").trim();
        if (m[1] && resto) separarNomes(resto).forEach((a) => r.ajudantes.push(a));
        return;
      }
      m = n.match(/^MOTORISTA\s*:\s*(.*)$/);
      if (m) {
        r.motorista = linha.replace(/^[^:]*:/, "").trim();
        estado = "ajudantes-ou-nada";
        return;
      }
      if (/^\d{4,}$/.test(n.replace(/[\s.\-]/g, ""))) { r.codigos.push(n.replace(/\s/g, "")); return; }
      if (estado === "motorista" && !r.motorista) { r.motorista = linha; estado = "depois-motorista"; return; }
      if (estado === "ajudantes") { separarNomes(linha).forEach((a) => r.ajudantes.push(a)); return; }
      r.notas.push(linha);
    });
    return r;
  }

  function lerVeiculo(linhas) {
    const r = { placa: null, refs: [] };
    linhas.forEach((linha) => {
      const p = placa(linha);
      if (p && !r.placa) { r.placa = p; return; }
      if (hora(linha)) return; // o "05:00" da linha da ROTA nunca e referencia do carro
      r.refs.push(linha);
    });
    return r;
  }

  // ── leitura de um bloco ───────────────────────────────────────
  function lerBloco(matriz, r0, c0, cFim, linhaBase, opcoes) {
    const avisos = [];
    const linhaRota = matriz[r0] || [];
    const linhaPlanilha = (r) => r + linhaBase;

    // Nome da rota: inline ("ROTA: X") ou a primeira celula nao vazia a direita.
    let rota = "";
    let horaSaida = null;
    const inline = texto(linhaRota[c0]).match(/^\s*rota\s*[:\-]\s*(.+)$/i);
    if (inline) rota = inline[1].trim();
    for (let c = c0 + 1; c < cFim; c += 1) {
      const v = linhaRota[c];
      const t = texto(v);
      if (!t) continue;
      if (ehRotuloSaida(v)) {
        const mesma = t.match(/sa[ií]da\s*[:\-]?\s*(\d{1,2}\s*[:hH]\s*\d{2})/i);
        if (mesma) horaSaida = hora(mesma[1]);
        for (let c2 = c + 1; c2 < cFim && !horaSaida; c2 += 1) {
          if (texto(linhaRota[c2]) !== "") horaSaida = hora(linhaRota[c2]);
        }
        break;
      }
      if (!rota) rota = t;
    }

    // Cabecalho: ate 3 linhas abaixo da ROTA, a que tiver LOJA(S).
    let rCab = -1;
    let mapa = null;
    for (let r = r0 + 1; r <= r0 + 3 && r < matriz.length; r += 1) {
      const m = mapearCabecalho(matriz[r] || [], c0, cFim);
      if (m.loja !== undefined) { rCab = r; mapa = m; break; }
    }
    if (!mapa) {
      return { erro: `Rota "${rota || "?"}" (linha ${linhaPlanilha(r0)}): não achei o cabeçalho com a coluna LOJAS logo abaixo.` };
    }
    if (mapa.motorista === undefined) avisos.push("Sem coluna MOTORISTA no cabeçalho.");

    const paradas = [];
    const linhasEquipe = [];
    const linhasVeiculo = [];
    let responsavelFabrica = [];
    let vistaFabricaInicial = false;
    let vazias = 0;
    let rFim = rCab;

    for (let r = rCab + 1; r < matriz.length; r += 1) {
      const linha = matriz[r] || [];
      let outraRota = false;
      for (let c = c0; c < cFim; c += 1) if (ehAncoraRota(linha[c])) { outraRota = true; break; }
      if (outraRota) break;
      if (linhaVazia(linha, c0, cFim)) {
        vazias += 1;
        if (vazias >= 2) break;
        continue;
      }
      vazias = 0;
      rFim = r;

      if (mapa.motorista !== undefined) linhasDaCelula(linha[mapa.motorista]).forEach((l) => linhasEquipe.push(l));
      if (mapa.veiculo !== undefined) linhasDaCelula(linha[mapa.veiculo]).forEach((l) => linhasVeiculo.push(l));

      const lojaTxt = texto(linha[mapa.loja]);
      if (!lojaTxt) continue;

      if (ehFabrica(lojaTxt)) {
        // Na FABRICA de saida a operacao anota quem responde pela carga
        // (celula amarela, ex. GEOVANA / JAPA). Guardamos o que nao for numero.
        if (!vistaFabricaInicial && paradas.length === 0) {
          vistaFabricaInicial = true;
          for (let c = c0; c < cFim; c += 1) {
            if ([mapa.atd, mapa.loja, mapa.motorista, mapa.veiculo].includes(c)) continue;
            const t = texto(linha[c]);
            if (t && !/^[\d\s.,:/\-R$]+$/.test(t)) responsavelFabrica.push(t);
          }
        }
        continue;
      }

      if (paradas.length >= MAX_PARADAS) {
        avisos.push(`Mais de ${MAX_PARADAS} lojas; o excedente foi ignorado.`);
        break;
      }

      const val = (campo) => (mapa[campo] === undefined ? "" : linha[mapa[campo]]);
      const docs = {};
      mapa.docs.forEach(({ codigo, col }) => {
        const t = texto(linha[col]);
        if (t) docs[codigo] = t;
      });
      const horaBruta = val("hora_loja");
      const horaLoja = hora(horaBruta);
      if (texto(horaBruta) && !horaLoja) avisos.push(`${lojaTxt}: horário "${texto(horaBruta)}" não reconhecido (linha ${linhaPlanilha(r)}).`);
      const atdNum = Number((texto(val("atd")).match(/\d+/) || [])[0]) || null;

      paradas.push({
        ordem: paradas.length + 1,
        atd: atdNum,
        loja: lojaTxt,
        pes: texto(val("pes")) || null,
        emp: texto(val("emp")) || null,
        hora_loja: horaLoja,
        docs,
        almoxarifado: texto(val("almoxarifado")) || null,
        sacola: texto(val("sacola")) || null,
        rt: inteiro(val("rt")),
        cx: inteiro(val("cx")),
        frete_envio: dinheiro(val("frete_envio")),
        frete_retorno: dinheiro(val("frete_retorno")),
        carga_wms: texto(val("carga_wms")) || null,
        linha: linhaPlanilha(r),
      });
    }

    const equipe = lerEquipe(linhasEquipe);
    const veiculo = lerVeiculo(linhasVeiculo);
    if (!rota) avisos.push("Bloco sem nome de rota.");
    if (!paradas.length) avisos.push("Nenhuma loja encontrada no bloco.");
    if (!equipe.motorista) avisos.push("Motorista não informado.");
    if (!veiculo.placa) avisos.push(linhasVeiculo.length ? `Placa não reconhecida em "${linhasVeiculo.join(" ")}".` : "Placa não informada.");

    return {
      bloco: {
        linha: linhaPlanilha(r0),
        rota,
        hora_saida: horaSaida,
        motorista: equipe.motorista || null,
        ajudantes: equipe.ajudantes,
        placa: veiculo.placa,
        ref_veiculo: veiculo.refs.join(" ") || null,
        responsavel_fabrica: responsavelFabrica.join(" / ") || null,
        codigo_rodape: equipe.codigos.join(" / ") || null,
        notas: equipe.notas,
        colunas_docs: mapa.docs.map((d) => d.codigo),
        paradas,
        avisos,
      },
      rFim,
    };
  }

  // ── entrada principal ─────────────────────────────────────────
  // matriz: array de linhas (arrays de celulas), como o
  //   XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: "", blankrows: true })
  // opcoes.linhaInicial: numero (1-based) da primeira linha da matriz na planilha,
  //   so para as mensagens apontarem a linha certa.
  function lerMatriz(matriz, opcoes = {}) {
    const linhaBase = Number(opcoes.linhaInicial) || 1;
    const blocos = [];
    const avisos = [];
    if (!Array.isArray(matriz)) return { blocos, avisos: ["Planilha vazia ou ilegível."], textos_topo: [] };

    // Ancoras "ROTA" em qualquer coluna (blocos empilhados ou lado a lado).
    const ancoras = [];
    matriz.forEach((linha, r) => {
      (linha || []).forEach((v, c) => { if (ehAncoraRota(v)) ancoras.push({ r, c }); });
    });

    // Textos acima da primeira ROTA (titulo com a data, em geral).
    const primeira = ancoras.length ? Math.min(...ancoras.map((a) => a.r)) : Math.min(matriz.length, 5);
    const textosTopo = [];
    for (let r = 0; r < primeira; r += 1) (matriz[r] || []).forEach((v) => { if (texto(v) !== "") textosTopo.push(v); });
    matriz.forEach((linha) => (linha || []).forEach((v, c) => {
      if (/^DATA\b/.test(norm(v))) {
        textosTopo.push(v);
        if (linha[c + 1] !== undefined && texto(linha[c + 1]) !== "") textosTopo.push(linha[c + 1]);
      }
    }));

    if (!ancoras.length) {
      avisos.push('Não encontrei nenhum bloco "ROTA" nesta aba.');
      return { blocos, avisos, textos_topo: textosTopo };
    }

    ancoras.forEach((a) => {
      if (blocos.length >= MAX_BLOCOS) return;
      const mesmaLinha = ancoras.filter((o) => o.r === a.r && o.c > a.c).map((o) => o.c);
      const larguraLinha = Math.max(...matriz.slice(a.r, a.r + 4).map((l) => (l || []).length), a.c + 1);
      const cFim = mesmaLinha.length ? Math.min(...mesmaLinha) : larguraLinha;
      const lido = lerBloco(matriz, a.r, a.c, cFim, linhaBase, opcoes);
      if (lido.erro) { avisos.push(lido.erro); return; }
      blocos.push(lido.bloco);
    });
    if (ancoras.length > MAX_BLOCOS) avisos.push(`A aba tem mais de ${MAX_BLOCOS} rotas; só as primeiras ${MAX_BLOCOS} foram lidas.`);

    blocos.forEach((b, i) => { b.indice = i; });
    return { blocos, avisos, textos_topo: textosTopo };
  }

  return { lerMatriz, detectarData, hora, numero, dinheiro, placa, norm, separarNomes, MAX_BLOCOS, MAX_PARADAS };
});
