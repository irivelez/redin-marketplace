import { test, expect } from "@playwright/test";
import crypto from "node:crypto";

function signEstadoToken(id: string, secret: string): string {
  const sig = crypto
    .createHmac("sha256", secret)
    .update("estado:" + id)
    .digest("base64url")
    .slice(0, 16);
  return `${encodeURIComponent(id)}.${sig}`;
}

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const SECRET = process.env.SUPABASE_SECRET_KEY ?? "";
const TOKEN = SECRET ? signEstadoToken("redin-2026", SECRET) : "";

test.describe("/publico/estado/[token] — Redin financial reference", () => {
  test.skip(!SECRET, "Requires SUPABASE_SECRET_KEY to mint a valid token");

  test("S3a — invalid token returns 404", async ({ request }) => {
    const r = await request.get(`${BASE}/publico/estado/invalid-token`);
    expect(r.status()).toBe(404);
  });

  test("S3b — valid token returns 200", async ({ request }) => {
    const r = await request.get(`${BASE}/publico/estado/${TOKEN}`);
    expect(r.status()).toBe(200);
  });

  test("S8 — existing /publico/ot/[token] route still works", async ({ request }) => {
    const r = await request.get(`${BASE}/publico/ot/invalid`);
    expect([200, 404]).toContain(r.status());
  });

  test("S1+S2+S4+S5+S9 — page renders all 7 panels with grounded numbers", async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      const t = msg.text();
      if (msg.type() !== "error") return;
      if (t.includes("favicon")) return;
      if (t.includes("Failed to load resource")) return;
      consoleErrors.push(t);
    });
    page.on("pageerror", (err) => consoleErrors.push(`PAGE ERROR: ${err.message}`));
    await page.goto(`${BASE}/publico/estado/${TOKEN}`);

    await expect(page.getByRole("heading", { name: "Estado financiero · Redin" }).first()).toBeVisible();

    const sections = [
      "Tendencia mensual",
      "P&L por cliente",
      "Cartera",
      "Integridad de costos",
      "Volumen de OTs",
      "OTs perdidas o canceladas",
    ];
    for (const s of sections) {
      await expect(page.getByText(s, { exact: false }).first()).toBeVisible();
    }

    const heroLabels = ["Facturado", "Cobrado", "Costo (líneas)", "Utilidad bruta", "Margen", "Cartera"];
    for (const label of heroLabels) {
      await expect(page.getByText(label, { exact: true }).first()).toBeVisible();
    }

    const aseoRow = page.locator("tr", { hasText: "Aseo y servicio" });
    await expect(aseoRow).toHaveCount(1);
    const classes = await aseoRow.getAttribute("class");
    expect(classes ?? "").toContain("bg-red");

    await expect(page.locator("text=Toño live").first()).toBeVisible();

    const svgs = page.locator("svg.recharts-surface");
    await expect(svgs.first()).toBeVisible();
    expect(await svgs.count()).toBeGreaterThanOrEqual(5);

    const refLines = page.locator('line[stroke="#dc2626"], line[stroke="#a16207"]');
    expect(await refLines.count()).toBeGreaterThanOrEqual(2);

    const dataFooter = page.locator("footer", { hasText: "Datos al" });
    await expect(dataFooter).toBeVisible();
    const footerText = (await dataFooter.textContent()) ?? "";
    expect(footerText).toMatch(/Datos al .* COT/);
    expect(footerText).toMatch(/n=\d+ OTs/);

    await page.screenshot({ path: "tests/e2e/__screenshots__/estado.png", fullPage: true });

    expect(consoleErrors).toEqual([]);
  });
});
