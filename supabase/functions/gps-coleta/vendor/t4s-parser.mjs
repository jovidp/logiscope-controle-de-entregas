// Gerado por tools/preparar-gps-vendor.cjs.
const LETRA_MERCOSUL = "ABCDEFGHIJ";
function placaMercosul(placa) {
  const p = String(placa || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (/^[A-Z]{3}\d{4}$/.test(p)) return p.slice(0, 4) + LETRA_MERCOSUL[Number(p[4])] + p.slice(5);
  return p;
}

const numeroBR = (s) => Number(String(s || "").trim().replace(",", "."));
const textoHtml = (s) =>
  String(s || "")
    .replace(/<[^>]*>/g, "")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

// "05/10/2026 09:49:34 -03:00" -> Date
function lerDataT4s(txt) {
  const m = String(txt || "").match(/(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2}):(\d{2})\s*([+-]\d{2}:\d{2})?/);
  if (!m) return null;
  const d = new Date(`${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}:${m[6]}${m[7] || "-03:00"}`);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Uma <tr class="linha_grid"> -> aparelho no formato GPSWOX.
function lerLinha(tr) {
  const valor = (tr.match(/class="checkboxVehicle" value="([^"]+)"/) || [])[1];
  if (!valor) return null;
  const [aparelho, , lat, lng, quando, placa] = valor.split("|");
  const celulas = [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => textoHtml(m[1]));
  // Colunas: 0 check, 1 placa, 2 rastreador, 3 blindagem, 4 trava, 5 cliente,
  // 6 endereco, 7 modelo, 8 ultima comunicacao, 9 data GPS, 10 lat/long,
  // 11 ignicao, 12 violacao, 13 bloqueio, 14 velocidade, ...
  const ignicao = celulas[11];
  const modelo = celulas[7] || "";
  return {
    device_id: Number(aparelho),
    nome: `${placa} - ${modelo}`.trim(),
    placa: placaMercosul(placa),
    lat: numeroBR(lat),
    lng: numeroBR(lng),
    velocidade: Number((celulas[14] || "").replace(/[^\d.,]/g, "").replace(",", ".")) || 0,
    rumo: 0,
    // O checkbox usa a comunicação; a coluna 9 é a hora da posição GPS.
    posicao_em: lerDataT4s(celulas[9]) || lerDataT4s(quando),
    online: "",
    motor: ignicao === "On" ? "ligado" : ignicao === "Off" ? "desligado" : null,
    parado_seg: 0,
    fonte: "t4s",
    endereco: celulas[6] || "",
  };
}


export { lerLinha, lerDataT4s };
