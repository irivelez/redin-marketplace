// Provision a new Supabase Auth user (pre-confirmed) so they can log in
// via the existing OTP flow. The HR login page uses
// signInWithOtp({shouldCreateUser:false}) so an unprovisioned email
// silently fails (Supabase responds 200 but never sends the OTP).
//
// Usage: npx tsx --env-file=.env.local scripts/provision-auth-user.ts <email>

import { createServerClient } from "@redin/shared";

const email = process.argv[2];
if (!email || !email.includes("@")) {
  console.error("Usage: provision-auth-user.ts <email>");
  process.exit(1);
}

const supa = createServerClient();

const { data, error } = await supa.auth.admin.createUser({
  email,
  email_confirm: true, // Skip email verification — the OTP flow itself
                       // proves email ownership on first login.
});
if (error) {
  console.error("createUser failed:", error.message);
  process.exit(1);
}

console.log(`Provisioned ${email}`);
console.log(`  id:           ${data.user?.id}`);
console.log(`  confirmed_at: ${data.user?.email_confirmed_at}`);
console.log(`\nUser can now log in at the dashboard /login page — typing`);
console.log(`their email will deliver a 6-digit OTP code.`);
