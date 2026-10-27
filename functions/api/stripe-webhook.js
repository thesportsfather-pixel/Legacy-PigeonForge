function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);

  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }

  return bytes;
}

function bytesToHex(bytes) {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function verifyStripeSignature(
  payload,
  signatureHeader,
  secret
) {
  if (!signatureHeader || !secret) {
    return false;
  }

  const parts = signatureHeader.split(",");

  let timestamp = null;
  const signatures = [];

  for (const part of parts) {
    const [key, value] = part.split("=");

    if (key === "t") {
      timestamp = value;
    }

    if (key === "v1") {
      signatures.push(value);
    }
  }

  if (!timestamp || !signatures.length) {
    return false;
  }

  const signedPayload =
    `${timestamp}.${payload}`;

  const encoder = new TextEncoder();

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    {
      name: "HMAC",
      hash: "SHA-256",
    },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(signedPayload)
  );

  const expected =
    bytesToHex(
      new Uint8Array(signature)
    );

  return signatures.some(
    (sig) =>
      sig.length === expected.length &&
      sig.toLowerCase() === expected.toLowerCase()
  );
}

async function supabaseInsert(
  env,
  table,
  data
) {
  const response = await fetch(
    `${env.SUPABASE_URL}/rest/v1/${table}`,
    {
      method: "POST",
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        authorization:
          `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        "content-type": "application/json",
        prefer: "return=representation",
      },
      body: JSON.stringify(data),
    }
  );

  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      `Supabase insert ${response.status}: ${text}`
    );
  }

  return text ? JSON.parse(text) : [];
}

async function supabasePatch(
  env,
  path,
  data
) {
  const response = await fetch(
    `${env.SUPABASE_URL}/rest/v1/${path}`,
    {
      method: "PATCH",
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        authorization:
          `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        "content-type": "application/json",
        prefer: "return=representation",
      },
      body: JSON.stringify(data),
    }
  );

  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      `Supabase update ${response.status}: ${text}`
    );
  }

  return text ? JSON.parse(text) : [];
}

export async function onRequestPost({
  request,
  env,
}) {
  try {
    if (
      !env.SUPABASE_URL ||
      !env.SUPABASE_SERVICE_ROLE_KEY ||
      !env.STRIPE_WEBHOOK_SECRET
    ) {
      return json(
        {
          success: false,
          error:
            "Missing required environment variables.",
        },
        500
      );
    }

    const TEAM_KEY =
      "legacy-pigeon-forge";

    const teamResponse = await fetch(
      `${env.SUPABASE_URL}/rest/v1/teams?team_key=eq.${encodeURIComponent(TEAM_KEY)}&select=id&limit=1`,
      {
        headers: {
          apikey: env.SUPABASE_SERVICE_ROLE_KEY,
          authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
          accept: "application/json",
        },
      }
    );

    const teamText = await teamResponse.text();

    if (!teamResponse.ok) {
      throw new Error(`Unable to resolve Legacy team: ${teamText}`);
    }

    const teamRows = teamText ? JSON.parse(teamText) : [];

    if (!teamRows.length) {
      throw new Error("Legacy Pigeon Forge team not found.");
    }

    const TEAM_ID = teamRows[0].id;

    const rawBody =
      await request.text();

    const stripeSignature =
      request.headers.get(
        "stripe-signature"
      );

    const validSignature =
      await verifyStripeSignature(
        rawBody,
        stripeSignature,
        env.STRIPE_WEBHOOK_SECRET
      );

    if (!validSignature) {
      return json(
        {
          success: false,
          error:
            "Invalid Stripe signature.",
        },
        400
      );
    }

    const event =
      JSON.parse(rawBody);

    if (
      event.type !==
      "checkout.session.completed"
    ) {
      return json({
        success: true,
        ignored: true,
      });
    }

    const session =
      event.data?.object;

    if (!session) {
      return json(
        {
          success: false,
          error:
            "Missing Stripe session.",
        },
        400
      );
    }

    if (
      session.payment_status !== "paid"
    ) {
      return json({
        success: true,
        ignored: true,
        reason: "Session is not paid.",
      });
    }

    const metadata =
      session.metadata || {};

    const donationType =
      String(
        metadata.donation_type || ""
      ).trim();

    const teamKey =
      String(
        metadata.team_key || TEAM_KEY
      ).trim();

    if (teamKey !== TEAM_KEY) {
      return json({
        success: true,
        ignored: true,
        reason:
          "Webhook is not for Pigeon Forge.",
      });
    }

    const playerId =
      String(
        metadata.player_id || ""
      ).trim();

    const playerSlug =
      String(
        metadata.player_slug || ""
      ).trim();

    const playerName =
      String(
        metadata.player_name || ""
      ).trim();

    const playerNumberRaw =
      String(
        metadata.player_number || ""
      ).trim();

    const playerNumber =
      playerNumberRaw
        ? Number(playerNumberRaw)
        : null;

    const anonymous =
      metadata.anonymous === "true";

    const donorName =
      anonymous
        ? "Anonymous"
        : (
            String(
              metadata.donor_name || ""
            ).trim() ||
            "Anonymous"
          );

    const amountCents =
      Number(
        session.amount_total ||
        metadata.amount_cents ||
        0
      );

    const amount =
      amountCents / 100;

    const stripeSessionId =
      String(session.id || "");

    const stripePaymentIntent =
      typeof session.payment_intent === "string"
        ? session.payment_intent
        : session.payment_intent?.id || null;

    /*
      BASEBALL DONATION
    */

    if (
      donationType === "baseballs"
    ) {
      if (!playerId) {
        throw new Error(
          "Missing player_id in Stripe metadata."
        );
      }

      const baseballNumbers =
        String(
          metadata.baseballs || ""
        )
          .split(",")
          .map(Number)
          .filter(
            (number) =>
              Number.isInteger(number) &&
              number >= 1 &&
              number <= 60
          );

      if (!baseballNumbers.length) {
        throw new Error(
          "Missing baseball numbers in Stripe metadata."
        );
      }

      const soldAt =
        new Date().toISOString();

      for (
        const ballNumber of baseballNumbers
      ) {
        const updated =
          await supabasePatch(
            env,
            `baseballs?player_id=eq.${encodeURIComponent(
              playerId
            )}&ball_number=eq.${ballNumber}&status=neq.sold`,
            {
              status: "sold",
              donor_name: donorName,
              donor_email: null,
              sold_at: soldAt,
              stripe_session_id:
                stripeSessionId,
              reserved_until: null,
              reservation_id: null,
            }
          );

        if (!updated.length) {
          console.warn(
            `Baseball ${ballNumber} was not updated. It may already be sold.`
          );
        }
      }

      /*
        Store completed order.
      */

      await supabaseInsert(
        env,
        "orders",
        {
          player_id: playerId,
          stripe_session_id:
            stripeSessionId,
          stripe_payment_intent_id:
            stripePaymentIntent,
          stripe_payment_intent:
            stripePaymentIntent,
          total_cents:
            amountCents,
          status: "paid",
          customer_email: null,
          paid_at:
            new Date().toISOString(),
          team_id:
            TEAM_ID,
          player_slug:
            playerSlug || null,
          player_name:
            playerName || null,
          player_number:
            Number.isFinite(playerNumber)
              ? playerNumber
              : null,
          donation_type:
            "baseballs",
          baseballs:
            baseballNumbers,
          donor_name:
            donorName,
          donor_email:
            null,
          anonymous:
            anonymous,
          amount:
            amount,
          amount_cents:
            amountCents,
          payment_status:
            session.payment_status,
        }
      );

      return json({
        success: true,
        donation_type:
          "baseballs",
        updatedBalls:
          baseballNumbers,
      });
    }

    /*
      PLAYER GENERAL DONATION
    */

    if (
      donationType === "general"
    ) {
      await supabaseInsert(
        env,
        "orders",
        {
          player_id:
            playerId || null,
          stripe_session_id:
            stripeSessionId,
          stripe_payment_intent_id:
            stripePaymentIntent,
          stripe_payment_intent:
            stripePaymentIntent,
          total_cents:
            amountCents,
          status:
            "paid",
          customer_email:
            null,
          paid_at:
            new Date().toISOString(),
          team_id:
            TEAM_ID,
          player_slug:
            playerSlug || null,
          player_name:
            playerName || null,
          player_number:
            Number.isFinite(playerNumber)
              ? playerNumber
              : null,
          donation_type:
            "general",
          baseballs:
            null,
          donor_name:
            donorName,
          donor_email:
            null,
          anonymous:
            anonymous,
          amount:
            amount,
          amount_cents:
            amountCents,
          payment_status:
            session.payment_status,
        }
      );

      return json({
        success: true,
        donation_type:
          "general",
      });
    }

    /*
      Unknown donation type:
      acknowledge webhook so Stripe
      does not continuously retry it.
    */

    return json({
      success: true,
      ignored: true,
      reason:
        "Unknown donation type.",
    });

  } catch (error) {
    console.error(
      "stripe-webhook error:",
      error
    );

    return json(
      {
        success: false,
        error:
          error?.message ||
          "Webhook processing failed.",
      },
      500
    );
  }
}
