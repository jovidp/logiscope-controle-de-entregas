// Gerado por tools/preparar-gps-vendor.cjs.
const LETRA_MERCOSUL = "ABCDEFGHIJ";
function placaMercosul(placa) {
  const p = String(placa || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (/^[A-Z]{3}\d{4}$/.test(p)) return p.slice(0, 4) + LETRA_MERCOSUL[Number(p[4])] + p.slice(5);
  return p;
}

function erroSessao(msg) {
  const e = new Error(msg);
  e.sessaoExpirada = true;
  return e;
}

// Um item do JSON -> aparelho no formato GPSWOX.
function lerVeiculo(v) {
  const e = v && v.last_state;
  if (!e) return null;
  const lat = Number(e.latitude), lng = Number(e.longitude);
  const quando = e.timestamp ? new Date(e.timestamp) : null;
  return {
    device_id: Number(v.id),
    nome: `${v.registration_plate || ""} - ${v.description || ""}`.trim(),
    placa: placaMercosul(v.registration_plate),
    lat, lng,
    velocidade: Number(e.speed) || 0,
    rumo: Number(e.heading) || 0,
    posicao_em: quando && !Number.isNaN(quando.getTime()) ? quando : null,
    online: e.gprs_active ? "online" : "",
    motor: e.ignition === true ? "ligado" : e.ignition === false ? "desligado" : null,
    parado_seg: 0,
    fonte: "sat",
    endereco: e.address || "",
  };
}


export { lerVeiculo };
