// Evita que a roda do mouse altere inputs type=number sem querer.
// Extraido de public/html/index.html.

document.addEventListener(
  "wheel",
  (e) => {
    const el = document.activeElement;
    if (el && el.tagName === "INPUT" && el.type === "number") {
      el.blur();
    }
  },
  { passive: true },
);
