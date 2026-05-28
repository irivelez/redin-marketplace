import { createServerClient } from "@redin/shared";
const sb = createServerClient();
const phone = "+573005557777";
// Ensure exactly one outstanding rating request exists (clean up any stale)
await sb.from("outbound_messages").delete().eq("phone", phone);
const TEST_OT_ID = "POLL_TEST_OT_" + Date.now();
const { data: ob } = await sb.from("outbound_messages").insert({
  phone, body: "(poll)", channel: "whatsapp", kind: "text", status: "pending",
  meta: { type: "customer_rating_request", ot_id: TEST_OT_ID, tecnico_id: "POLL_T" },
}).select("id").single();
let active = false;
for (let i = 0; i < 15; i++) {
  const res = await fetch("https://dashboard-mp-production-1ef3.up.railway.app/api/chat", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ phone: "+57 300 555 7777", text: "5 buen trabajo" }),
  });
  const parsed = await res.json();
  const isNew = parsed.session_id === "";
  console.log(`[${new Date().toISOString()}] try ${i+1}: session_id=${JSON.stringify(parsed.session_id)} reply="${parsed.reply?.slice(0,50)}"`);
  if (isNew) {
    active = true;
    const { data: r } = await sb.from("ratings").select("stars,notes").eq("ot_id", TEST_OT_ID);
    console.log("ratings row:", r);
    break;
  }
  await new Promise((r) => setTimeout(r, 25_000));
}
console.log("C7 active?", active);
// Cleanup
await sb.from("ratings").delete().eq("ot_id", TEST_OT_ID);
await sb.from("eventos").delete().eq("entity_id", TEST_OT_ID);
await sb.from("outbound_messages").delete().eq("id", ob?.id ?? "");
