function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}


/*
  -----------------------------------
  STRIPE SIGNATURE VERIFICATION
  -----------------------------------
*/

async function verifyStripeSignature(
  payload,
  signature,
  secret
) {
  if (!signature || !secret) {
    return false;
  }

  const parts = signature.split(",");

  const timestampPart =
    parts.find(
      part => part.startsWith("t=")
    );

  const signatureParts =
    parts
      .filter(
        part => part.startsWith("v1=")
      )
      .map(
        part => part.slice(3)
      );

  if (
    !timestampPart ||
    !signatureParts.length
  ) {
    return false;
  }

  const timestamp =
    timestampPart.slice(2);

  const signedPayload =
    `${timestamp}.${payload}`;

  const encoder =
    new TextEncoder();

  const key =
    await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      {
        name: "HMAC",
        hash: "SHA-256",
      },
      false,
      ["sign"]
    );

  const signatureBuffer =
    await crypto.subtle.sign(
      "HMAC",
      key,
      encoder.encode(
        signedPayload
      )
    );

  const expectedSignature =
    Array.from(
      new Uint8Array(
        signatureBuffer
      )
    )
      .map(
        byte =>
          byte
            .toString(16)
            .padStart(2, "0")
      )
      .join("");

  return signatureParts.some(
    value =>
      value === expectedSignature
  );
}


/*
  -----------------------------------
  SUPABASE HELPERS
  -----------------------------------
*/

async function supabaseGet(
  env,
  path
) {
  const response =
    await fetch(
      `${env.SUPABASE_URL}/rest/v1/${path}`,
      {
        method: "GET",
        headers: {
          apikey:
            env.SUPABASE_SERVICE_ROLE_KEY,

          authorization:
            `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,

          accept:
            "application/json",
        },
      }
    );

  const text =
    await response.text();

  if (!response.ok) {
    throw new Error(
      `Supabase GET ${response.status}: ${text}`
    );
  }

  return text
    ? JSON.parse(text)
    : [];
}


async function supabaseInsert(
  env,
  table,
  data
) {
  const response =
    await fetch(
      `${env.SUPABASE_URL}/rest/v1/${table}`,
      {
        method: "POST",
        headers: {
          apikey:
            env.SUPABASE_SERVICE_ROLE_KEY,

          authorization:
            `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,

          "content-type":
            "application/json",

          prefer:
            "return=representation",
        },

        body:
          JSON.stringify(data),
      }
    );

  const text =
    await response.text();

  if (!response.ok) {
    throw new Error(
      `Supabase INSERT ${response.status}: ${text}`
    );
  }

  return text
    ? JSON.parse(text)
    : [];
}


async function supabasePatch(
  env,
  path,
  data
) {
  const response =
    await fetch(
      `${env.SUPABASE_URL}/rest/v1/${path}`,
      {
        method: "PATCH",
        headers: {
          apikey:
            env.SUPABASE_SERVICE_ROLE_KEY,

          authorization:
            `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,

          "content-type":
            "application/json",

          prefer:
            "return=representation",
        },

        body:
          JSON.stringify(data),
      }
    );

  const text =
    await response.text();

  if (!response.ok) {
    throw new Error(
      `Supabase PATCH ${response.status}: ${text}`
    );
  }

  return text
    ? JSON.parse(text)
    : [];
}


/*
  -----------------------------------
  BASEBALL PARSER
  -----------------------------------
*/

function parseBaseballs(value) {
  if (!value) {
    return [];
  }

  return String(value)
    .split(",")
    .map(
      value =>
        Number(
          value.trim()
        )
    )
    .filter(
      number =>
        Number.isInteger(number) &&
        number >= 1 &&
        number <= 60
    );
}


/*
  -----------------------------------
  PROCESS COMPLETED CHECKOUT
  -----------------------------------
*/

async function handleCheckoutCompleted(
  env,
  session
) {
  const metadata =
    session.metadata || {};

  const donationType =
    metadata.donation_type || "";

  const playerId =
    metadata.player_id || "";

  const playerSlug =
    metadata.player_slug || "";

  const playerName =
    metadata.player_name || "";

  const playerNumber =
    Number(
      metadata.player_number || 0
    ) || null;

  const anonymous =
    metadata.anonymous === "true";

  const donorName =
    anonymous
      ? "Anonymous"
      : (
          metadata.donor_name ||
          "Anonymous"
        );

  const donorEmail =
    metadata.donor_email ||
    session.customer_details?.email ||
    session.customer_email ||
    "";

  const totalCents =
    Number(
      session.amount_total || 0
    );

  const amountDollars =
    totalCents / 100;

  const paymentIntentId =
    typeof session.payment_intent === "string"
      ? session.payment_intent
      : (
          session.payment_intent?.id ||
          null
        );

  const paidAt =
    new Date().toISOString();


  /*
    -----------------------------------
    DUPLICATE WEBHOOK PROTECTION
    -----------------------------------
  */

  const existingOrders =
    await supabaseGet(
      env,
      [
        "orders",
        "?select=id",
        `&stripe_session_id=eq.${encodeURIComponent(
          session.id
        )}`,
        "&limit=1",
      ].join("")
    );

  if (existingOrders.length) {
    console.log(
      "Already processed:",
      session.id
    );

    return;
  }


  /*
    -----------------------------------
    BASEBALL DONATION
    -----------------------------------
  */

  if (
    donationType === "baseballs"
  ) {
    const baseballs =
      parseBaseballs(
        metadata.baseballs
      );

    if (
      !playerId ||
      !baseballs.length
    ) {
      throw new Error(
        "Missing baseball payment metadata."
      );
    }

    /*
      Confirm these rows actually exist
      for this team/player.
    */

    const selectedList =
      baseballs.join(",");

    const baseballRows =
      await supabaseGet(
        env,
        [
          "baseballs",
          "?select=id,ball_number,status",
          `&team_id=eq.${encodeURIComponent(
            env.TEAM_KEY
          )}`,
          `&player_id=eq.${encodeURIComponent(
            playerId
          )}`,
          `&ball_number=in.(${selectedList})`,
        ].join("")
      );

    if (
      baseballRows.length !==
      baseballs.length
    ) {
      throw new Error(
        "One or more baseball records could not be found."
      );
    }

    const alreadySold =
      baseballRows.filter(
        row =>
          row.status === "sold"
      );

    if (alreadySold.length) {
      console.error(
        "PAID BALL CONFLICT:",
        alreadySold
      );
    }


    /*
      RECORD ORDER

      We populate both the older schema
      columns and the newer fundraiser
      columns that now exist.
    */

    await supabaseInsert(
      env,
      "orders",
      {
        team_id:
          env.TEAM_KEY,

        player_id:
          playerId,

        player_slug:
          playerSlug,

        player_name:
          playerName,

        player_number:
          playerNumber,

        donation_type:
          "baseballs",

        baseballs:
          baseballs,

        donor_name:
          donorName,

        donor_email:
          donorEmail,

        anonymous:
          anonymous,

        amount:
          amountDollars,

        amount_cents:
          totalCents,

        total_cents:
          totalCents,

        stripe_session_id:
          session.id,

        stripe_payment_intent:
          paymentIntentId,

        stripe_payment_intent_id:
          paymentIntentId,

        payment_status:
          session.payment_status ||
          "paid",

        status:
          "paid",

        customer_email:
          donorEmail,

        paid_at:
          paidAt,
      }
    );


    /*
      MARK EACH BASEBALL SOLD
    */

    for (
      const ballNumber of baseballs
    ) {
      const path =
        [
          "baseballs",
          "?team_id=eq.",
          encodeURIComponent(
            env.TEAM_KEY
          ),
          "&player_id=eq.",
          encodeURIComponent(
            playerId
          ),
          "&ball_number=eq.",
          encodeURIComponent(
            ballNumber
          ),
        ].join("");

      await supabasePatch(
        env,
        path,
        {
          status:
            "sold",

          donor_name:
            donorName,

          donor_email:
            donorEmail,

          stripe_session_id:
            session.id,

          sold_at:
            paidAt,

          reserved_until:
            null,

          reservation_id:
            null,
        }
      );
    }


    console.log(
      "Baseball order completed:",
      session.id
    );

    return;
  }


  /*
    -----------------------------------
    GENERAL DONATION
    -----------------------------------
  */

  if (
    donationType === "general"
  ) {
    if (!playerId) {
      throw new Error(
        "Missing player metadata."
      );
    }

    await supabaseInsert(
      env,
      "orders",
      {
        team_id:
          env.TEAM_KEY,

        player_id:
          playerId,

        player_slug:
          playerSlug,

        player_name:
          playerName,

        player_number:
          playerNumber,

        donation_type:
          "general",

        baseballs:
          null,

        donor_name:
          donorName,

        donor_email:
          donorEmail,

        anonymous:
          anonymous,

        amount:
          amountDollars,

        amount_cents:
          totalCents,

        total_cents:
          totalCents,

        stripe_session_id:
          session.id,

        stripe_payment_intent:
          paymentIntentId,

        stripe_payment_intent_id:
          paymentIntentId,

        payment_status:
          session.payment_status ||
          "paid",

        status:
          "paid",

        customer_email:
          donorEmail,

        paid_at:
          paidAt,
      }
    );


    console.log(
      "General donation completed:",
      session.id
    );

    return;
  }


  console.log(
    "Ignored checkout with donation type:",
    donationType
  );
}


/*
  -----------------------------------
  WEBHOOK ENDPOINT
  -----------------------------------
*/

export async function onRequestPost({
  request,
  env,
}) {
  try {
    if (
      !env.STRIPE_WEBHOOK_SECRET ||
      !env.SUPABASE_URL ||
      !env.SUPABASE_SERVICE_ROLE_KEY ||
      !env.TEAM_KEY
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

    /*
      Stripe verification must use
      the raw request body.
    */

    const payload =
      await request.text();

    const stripeSignature =
      request.headers.get(
        "stripe-signature"
      );

    const valid =
      await verifyStripeSignature(
        payload,
        stripeSignature,
        env.STRIPE_WEBHOOK_SECRET
      );

    if (!valid) {
      return json(
        {
          success: false,
          error:
            "Invalid Stripe signature.",
        },
        400
      );
    }

    let event;

    try {
      event =
        JSON.parse(payload);
    } catch {
      return json(
        {
          success: false,
          error:
            "Invalid webhook payload.",
        },
        400
      );
    }

    if (
      event.type ===
      "checkout.session.completed"
    ) {
      const session =
        event.data?.object;

      if (!session) {
        throw new Error(
          "Missing Stripe checkout session."
        );
      }

      if (
        session.payment_status ===
        "paid"
      ) {
        await handleCheckoutCompleted(
          env,
          session
        );
      }
    }

    return json({
      received: true,
    });

  } catch (error) {
    console.error(
      "STRIPE WEBHOOK ERROR:",
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
