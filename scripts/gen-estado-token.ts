import crypto from "node:crypto";

function sign(id: string, secret: string): string {
  return crypto
    .createHmac("sha256", secret)
    .update("estado:" + id)
    .digest("base64url")
    .slice(0, 16);
}

const id = process.argv[2] ?? "redin-2026";
const secret = process.env.SUPABASE_SECRET_KEY;
if (!secret) {
  console.error("SUPABASE_SECRET_KEY is required");
  process.exit(1);
}
const token = `${encodeURIComponent(id)}.${sign(id, secret)}`;
const base = process.env.DASHBOARD_BASE_URL ?? "http://localhost:3000";
const path = `/publico/estado/${token}`;
const url = `${base}${path}`;

console.log("ID    :", id);
console.log("Token :", token);
console.log("Path  :", path);
console.log("URL   :", url);
