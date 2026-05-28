import fs from "node:fs";

async function main() {
  const token = process.env["SUPABASE_MANAGEMENT_TOKEN"] ?? "";
  const ref = process.env["SUPABASE_PROJECT_REF"] ?? "";

  const sql = fs.readFileSync(
    new URL("../migrations/016_documento_classification.sql", import.meta.url),
    "utf8"
  );

  // Strip SQL comments so the query is cleaner for the API.
  const cleanSql = sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  console.log("Applying migration 016 via Management API...");
  console.log("ref:", ref);
  console.log("token prefix:", token.slice(0, 10));

  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ query: cleanSql }),
  });

  const text = await res.text();
  console.log("status:", res.status);
  console.log("response:", text.slice(0, 1000));

  if (!res.ok) {
    console.error("\nManagement API 401 — token is expired or invalid.");
    console.error("Action needed: refresh SUPABASE_MANAGEMENT_TOKEN in .env.local");
    console.error("Get a new token at: https://app.supabase.com/account/tokens");
    console.error("\nThe migration SQL is ready at: migrations/016_documento_classification.sql");
    console.error("Apply manually via Supabase SQL editor or a valid management token.");
    process.exit(1);
  }

  console.log("016 applied ✓");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
