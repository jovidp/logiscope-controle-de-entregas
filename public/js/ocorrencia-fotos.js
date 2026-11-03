// ================================================================
// FOTOS DA OCORRÊNCIA
// ----------------------------------------------------------------
// Anexar imagem ao registrar uma ocorrência (avaria, lacre violado,
// divergência). Resolve a discussão de "foi assim que chegou".
//
// TRES DECISOES QUE MANDAM AQUI:
//
// 1. COMPRIME NA HORA DE ESCOLHER, nao na hora de salvar. Foto de
//    celular chega com 3-8 MB; o sistema recusava acima de 1,5 MB e a
//    pessoa nao entendia por que. Comprimindo na selecao, o arquivo
//    cabe, a previa ja mostra o resultado e o salvar continua
//    sincrono — sem esperar leitura de arquivo no meio do envio.
//
// 2. A LISTAGEM NUNCA CARREGA FOTO. O front busca /ocorrencias sem
//    limite e guarda tudo em memoria; se a foto viesse junto, abrir a
//    tela baixaria todas as fotos ja registradas. A listagem traz so
//    fotos_qtd; o conteudo vem por GET /ocorrencias/:id/fotos quando
//    o usuario clica. Ver o comentario no server.js.
//
// 3. GUARDA COMO LISTA JSON numa coluna TEXT que ja existia
//    (ocorrencia_fotos). Sem tabela nova e sem upload de arquivo —
//    a producao roda de um share de rede que oscila, e gravar binario
//    la seria trocar um problema por outro.
// ================================================================
(function () {
  "use strict";

  var MAX_FOTOS = 10;
  // 1600px atende zoom em etiqueta e lacre sem virar arquivo gigante.
  var MAX_LADO = 1600;
  var QUALIDADE = 0.72;
  // Teto por foto DEPOIS de comprimir. Se estourar, e imagem fora do
  // comum (print de tela enorme, foto de documento).
  var MAX_BYTES = 800 * 1024;
  // Teto do CONJUNTO, que e o que realmente importa: o payload vai como
  // JSON e o express aceita 10mb. base64 infla ~33%, entao 10 fotos de
  // 800 KB dariam ~10,7 MB e o servidor devolveria 413 — o usuario
  // perderia o lancamento inteiro depois de preencher tudo. 5 MB
  // somados viram ~6,7 MB no envio, com folga para o resto do
  // formulario.
  var MAX_TOTAL_BYTES = 5 * 1024 * 1024;

  var fotos = []; // data-URIs, na ordem em que a pessoa anexou

  function $(id) {
    return document.getElementById(id);
  }

  function avisar(msg) {
    if (typeof alertar === "function") alertar(msg);
    else window.alert(msg);
  }

  // Redesenha a imagem num canvas menor e reexporta em JPEG. PNG de
  // print vira JPEG tambem: aqui o objetivo e evidencia, nao arte.
  function comprimir(arquivo) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(arquivo);
      var img = new Image();
      img.onload = function () {
        URL.revokeObjectURL(url);
        var escala = Math.min(1, MAX_LADO / Math.max(img.width, img.height));
        var l = Math.round(img.width * escala);
        var a = Math.round(img.height * escala);
        var cv = document.createElement("canvas");
        cv.width = l;
        cv.height = a;
        var ctx = cv.getContext("2d");
        // Fundo branco: JPEG nao tem transparencia, e sem isso PNG
        // transparente sai com fundo preto.
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, l, a);
        ctx.drawImage(img, 0, 0, l, a);
        resolve(cv.toDataURL("image/jpeg", QUALIDADE));
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error("Não foi possível ler a imagem."));
      };
      img.src = url;
    });
  }

  function tamanhoDataUri(dataUri) {
    var base64 = String(dataUri).split(",")[1] || "";
    return Math.round((base64.length * 3) / 4);
  }

  function totalBytes() {
    return fotos.reduce(function (soma, f) {
      return soma + tamanhoDataUri(f);
    }, 0);
  }

  function desenharPreview() {
    var alvo = $("ocorrenciaFotosPreview");
    if (!alvo) return;
    if (!fotos.length) {
      alvo.innerHTML = "";
      return;
    }
    alvo.innerHTML =
      fotos
        .map(function (src, i) {
          return (
            '<figure style="margin:0;position:relative;">' +
            '<img src="' +
            src +
            '" alt="Foto ' +
            (i + 1) +
            '" style="width:86px;height:70px;object-fit:cover;border-radius:7px;border:1px solid var(--border);display:block;">' +
            '<button type="button" data-remover-foto="' +
            i +
            '" title="Remover" style="position:absolute;top:-6px;right:-6px;width:20px;height:20px;border-radius:50%;border:1px solid var(--border);background:var(--bg-elevated);color:var(--text-heading);font-size:12px;line-height:1;cursor:pointer;padding:0;">×</button>' +
            "</figure>"
          );
        })
        .join("") +
      '<span style="align-self:center;font-size:11px;color:var(--text-muted);font-weight:700;">' +
      fotos.length +
      "/" +
      MAX_FOTOS +
      "</span>";
  }

  async function aoEscolher(e) {
    var entrada = e.target;
    var escolhidos = Array.prototype.slice.call(entrada.files || []);
    if (!escolhidos.length) return;

    var espaco = MAX_FOTOS - fotos.length;
    if (espaco <= 0) {
      avisar("Limite de " + MAX_FOTOS + " fotos por ocorrência já atingido.");
      entrada.value = "";
      return;
    }
    if (escolhidos.length > espaco) {
      avisar(
        "Só cabem mais " +
          espaco +
          " foto(s). As demais foram ignoradas.",
      );
      escolhidos = escolhidos.slice(0, espaco);
    }

    for (var i = 0; i < escolhidos.length; i++) {
      var arq = escolhidos[i];
      if (!/^image\//.test(arq.type)) {
        avisar('"' + arq.name + '" não é imagem e foi ignorado.');
        continue;
      }
      try {
        var comprimida = await comprimir(arq);
        var bytes = tamanhoDataUri(comprimida);
        if (bytes > MAX_BYTES) {
          avisar('"' + arq.name + '" ficou grande demais mesmo comprimida e foi ignorada.');
          continue;
        }
        if (totalBytes() + bytes > MAX_TOTAL_BYTES) {
          avisar(
            'O conjunto de fotos chegou ao limite de tamanho. "' +
              arq.name +
              '" e as seguintes não foram anexadas.',
          );
          break;
        }
        fotos.push(comprimida);
      } catch (erro) {
        avisar('Falha ao processar "' + arq.name + '".');
      }
    }

    // Zera o input: sem isso, escolher o MESMO arquivo de novo nao
    // dispara change e parece que o sistema travou.
    entrada.value = "";
    desenharPreview();
  }

  document.addEventListener("change", function (e) {
    if (e.target && e.target.id === "ocorrenciaFotos") aoEscolher(e);
  });

  document.addEventListener("click", function (e) {
    var btn = e.target && e.target.closest("[data-remover-foto]");
    if (!btn) return;
    e.preventDefault();
    fotos.splice(parseInt(btn.getAttribute("data-remover-foto"), 10), 1);
    desenharPreview();
  });

  // ---- API usada pelo formulario ----

  // Valor para o payload. null (e nao "[]") quando nao ha foto, para
  // o vazioParaNull do backend gravar NULL e a coluna nao encher de
  // string vazia.
  window.ocorrenciaFotosValor = function () {
    return fotos.length ? JSON.stringify(fotos) : null;
  };

  window.ocorrenciaFotosLimpar = function () {
    fotos = [];
    var i = $("ocorrenciaFotos");
    if (i) i.value = "";
    desenharPreview();
  };

  // Modo edicao: as fotos nao vem na listagem, entao busca as do
  // registro antes de abrir o formulario.
  window.ocorrenciaFotosCarregar = async function (id) {
    fotos = [];
    desenharPreview();
    if (!id) return;
    try {
      var r = await fetch("/ocorrencias/" + id + "/fotos", {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (!r.ok) return;
      var d = await r.json();
      if (Array.isArray(d.fotos)) {
        fotos = d.fotos.slice(0, MAX_FOTOS);
        desenharPreview();
      }
    } catch (_) {
      /* sem foto na tela e melhor do que travar a edicao */
    }
  };

  // ---- Visualizacao no historico ----

  // Botao que aparece no card. So renderiza se houver foto: fotos_qtd
  // vem da listagem justamente para permitir essa decisao sem baixar
  // o conteudo.
  window.ocorrenciaFotosBotao = function (o) {
    var n = Number(o && o.fotos_qtd) || 0;
    if (!n) return "";
    return (
      '<div id="fotosOco' +
      o.id +
      '" style="margin-bottom:14px;">' +
      '<button type="button" class="btn-sm" onclick="ocorrenciaFotosVer(' +
      o.id +
      ', this)" style="background:var(--bg-overlay);border:1px solid var(--border);color:var(--text-heading);font-weight:700;">' +
      "Ver " +
      n +
      (n > 1 ? " fotos" : " foto") +
      "</button></div>"
    );
  };

  window.ocorrenciaFotosVer = async function (id, botao) {
    var caixa = $("fotosOco" + id);
    if (!caixa) return;
    botao.disabled = true;
    botao.textContent = "Carregando...";
    try {
      var r = await fetch("/ocorrencias/" + id + "/fotos", {
        credentials: "same-origin",
        cache: "no-store",
      });
      var d = r.ok ? await r.json() : { fotos: [] };
      var lista = Array.isArray(d.fotos) ? d.fotos : [];
      if (!lista.length) {
        caixa.innerHTML =
          '<span style="font-size:12px;color:var(--text-muted);">Nenhuma foto encontrada.</span>';
        return;
      }
      caixa.innerHTML =
        '<div style="display:flex;flex-wrap:wrap;gap:8px;">' +
        lista
          .map(function (src, i) {
            return (
              '<img src="' +
              src +
              '" alt="Foto ' +
              (i + 1) +
              '" onclick="ocorrenciaFotosAmpliar(this.src)" style="width:96px;height:78px;object-fit:cover;border-radius:7px;border:1px solid var(--border);cursor:zoom-in;">'
            );
          })
          .join("") +
        "</div>";
    } catch (_) {
      caixa.innerHTML =
        '<span style="font-size:12px;color:var(--vermelho);">Falha ao carregar as fotos.</span>';
    }
  };

  // Lightbox proprio: data-URI nao abre em aba nova (o Chrome bloqueia
  // navegacao de topo para data:), entao ampliar tem que ser na pagina.
  window.ocorrenciaFotosAmpliar = function (src) {
    var fundo = document.createElement("div");
    fundo.style.cssText =
      "position:fixed;inset:0;background:rgba(0,0,0,.82);z-index:100000;display:flex;align-items:center;justify-content:center;padding:24px;cursor:zoom-out;";
    fundo.innerHTML =
      '<img src="' +
      src +
      '" alt="Foto ampliada" style="max-width:100%;max-height:100%;border-radius:8px;">';
    function fechar() {
      fundo.remove();
      document.removeEventListener("keydown", aoTeclar);
    }
    function aoTeclar(ev) {
      if (ev.key === "Escape") fechar();
    }
    fundo.addEventListener("click", fechar);
    document.addEventListener("keydown", aoTeclar);
    document.body.appendChild(fundo);
  };
})();
