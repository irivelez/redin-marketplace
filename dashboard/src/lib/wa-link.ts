// Builds a wa.me deep-link so the public CTA opens WhatsApp with a pre-typed
// greeting, which in turn bootstraps a conversation with Toño.

export function buildWaLink(params?: { text?: string }): string {
  const number = (process.env.WA_NUMBER || process.env.NEXT_PUBLIC_WA_NUMBER || "+573224347117")
    .replace(/[^\d]/g, "");
  const text = encodeURIComponent(params?.text ?? "Hola Toño, vengo del sitio de Redin.");
  return `https://wa.me/${number}?text=${text}`;
}
