const TEAM_KEY = "legacy-pigeon-forge";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

async function patchBaseballs(env, playerId, baseballNumbers, donorName, sessionId) {
  const response = await fetch(
    `${env.SUPABASE_URL}/rest/v1/baseballs?player_id=eq.${encodeURIComponent(playerId)}&ball_number=in.(${baseballNumbers.join(",")})&status=neq.sold`,
    {
      method: "PATCH",
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        "content-type": "application/json",
        prefer: "return=representation",
        accept: "application/json",
      },
      body: JSON.stringify({
        status: "sold",
        donor_name: donorName,
        donor_email: null,
        sold_at: new Date().toISOString(),
        stripe_session_id: sessionId,
        reserved_until: null,
        reservation_id: null,
      }),
    }
  );

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Supabase update ${response.status}: ${text}`);
  }
  return text ? JSON.parse(text) : [];
}

export async function onRequestGet({ request, env }) {
  try {
    if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY || !env.STRIPE_SECRET_KEY) {
      return json({ success: false, error: "Missing required environment variables." }, 500);
    }

    const url = new URL(request.url);
    const sessionId = String(url.searchParams.get("session_id") || "").trim();

    if (!sessionId.startsWith("cs_")) {
      return json({ success: false, error: "A valid Stripe session_id is required." }, 400);
    }

    const stripeResponse = await fetch(
      `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`,
      {
        headers: {
          authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
          accept: "application/json",
        },
      }
    );

    const stripeText = await stripeResponse.text();
    let session;
    try {
      session = JSON.parse(stripeText);
    } catch {
      throw new Error(`Stripe returned an invalid response: ${stripeText}`);
    }

    if (!stripeResponse.ok) {
      throw new Error(session?.error?.message || "Unable to retrieve Stripe checkout session.");
    }

    if (session.payment_status !== "paid") {
      return json({ success: false, paid: false, error: "Stripe has not marked this checkout session as paid." }, 409);
    }

    const metadata = session.metadata || {};
    if (String(metadata.team_key || "") !== TEAM_KEY) {
      return json({ success: false, error: "This payment does not belong to the Legacy Pigeon Forge fundraiser." }, 400);
    }

    if (String(metadata.donation_type || "") !== "baseballs") {
      return json({ success: true, paid: true, ignored: true, reason: "Not a baseball donation." });
    }

    const playerId = String(metadata.player_id || "").trim();
    const playerSlug = String(metadata.player_slug || "").trim();
    const baseballNumbers = String(metadata.baseballs || "")
      .split(",")
      .map((v) => Number(v.trim()))
      .filter((n) => Number.isInteger(n) && n >= 1 && n <= 60);

    if (!playerId || !baseballNumbers.length) {
      return json({ success: false, error: "Stripe payment is missing player or baseball metadata." }, 400);
    }

    const anonymous = metadata.anonymous === "true";
    const donorName = anonymous
      ? "Anonymous"
      : (String(metadata.donor_name || "").trim() || "Anonymous");

    const updated = await patchBaseballs(env, playerId, baseballNumbers, donorName, session.id);

    return json({
      success: true,
      paid: true,
      playerSlug,
      baseballNumbers,
      updatedRows: updated.length,
    });
  } catch (error) {
    console.error("verify-payment error:", error);
    return json({ success: false, error: error?.message || "Unable to verify payment." }, 500);
  }
}
