import fs from "node:fs";

async function main() {
  const token = process.env["SUPABASE_MANAGEMENT_TOKEN"] ?? "";
  const ref = process.env["SUPABASE_PROJECT_REF"] ?? "";

  console.log("ref:", ref ? ref : "MISSING");
  console.log("token:", token ? token.slice(0, 8) + "…" : "MISSING");

  const sql = fs.readFileSync(
    new URL("../migrations/016_documento_classification.sql", import.meta.url),
    "utf8"
  );

  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ query: sql }),
  });

  const text = await res.text();
  console.log("status:", res.status);
  console.log("body:", text.slice(0, 800));

  if (!res.ok) {
    process.exit(1);
  }
  console.log("016 applied ✓");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
