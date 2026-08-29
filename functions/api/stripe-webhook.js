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

  const parts =
    signature.split(",");

  const timestampPart =
    parts.find(
      part =>
        part.startsWith("t=")
    );

  const signatureParts =
    parts
      .filter(
        part =>
          part.startsWith("v1=")
      )
      .map(
        part =>
          part.slice(3)
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
      value ===
      expectedSignature
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
  PARSE BASEBALL NUMBERS
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
        Number.isInteger(
          number
        ) &&
        number >= 1 &&
        number <= 60
    );
}


/*
  -----------------------------------
  HANDLE COMPLETED PAYMENT
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
    metadata.player_number || "";

  const donorName =
    metadata.donor_name ||
    "Anonymous";

  const donorEmail =
    metadata.donor_email ||
    session.customer_details?.email ||
    session.customer_email ||
    "";

  const anonymous =
    metadata.anonymous ===
    "true";

  const amountTotal =
    Number(
      session.amount_total || 0
    );

  const amountDollars =
    amountTotal / 100;


  /*
    -----------------------------------
    IDEMPOTENCY CHECK

    Prevent duplicate processing if Stripe
    sends the webhook more than once.

    Expected orders column:
    stripe_session_id
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

  if (
    existingOrders.length > 0
  ) {
    console.log(
      "Stripe session already processed:",
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
    donationType ===
    "baseballs"
  ) {
    const baseballs =
      parseBaseballs(
        metadata.baseballs
      );

    if (
      !playerId ||
      baseballs.length === 0
    ) {
      throw new Error(
        "Missing player or baseball metadata."
      );
    }


    /*
      DOUBLE-CHECK THAT NONE OF THESE
      BASEBALLS ARE ALREADY SOLD
    */

    const selectedList =
      baseballs.join(",");

    const soldCheck =
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
          "&status=eq.sold",
        ].join("")
      );


    /*
      Normally this should never happen because
      checkout validates availability first.

      If a race condition happens, we still record
      the paid order, but we log the conflict.
    */

    if (
      soldCheck.length > 0
    ) {
      console.error(
        "PAID BASEBALL CONFLICT:",
        soldCheck
      );
    }


    /*
      RECORD ORDER
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
          Number(
            playerNumber
          ) || null,

        donation_type:
          "baseballs",

        baseballs:
          baseballs,

        donor_name:
          anonymous
            ? "Anonymous"
            : donorName,

        donor_email:
          donorEmail,

        anonymous:
          anonymous,

        amount:
          amountDollars,

        amount_cents:
          amountTotal,

        stripe_session_id:
          session.id,

        stripe_payment_intent:
          session.payment_intent ||
          null,

        payment_status:
          session.payment_status ||
          "paid",
      }
    );


    /*
      MARK EACH BASEBALL SOLD
    */

    for (
      const ballNumber
      of baseballs
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


      const updated =
        await supabasePatch(
          env,
          path,
          {
            status:
              "sold",

            donor_name:
              anonymous
                ? "Anonymous"
                : donorName,

            donor_email:
              donorEmail,

            stripe_session_id:
              session.id,

            sold_at:
              new Date()
                .toISOString(),
          }
        );


      /*
        If the baseball row does not exist yet,
        create it.
      */

      if (
        !updated ||
        updated.length === 0
      ) {
        await supabaseInsert(
          env,
          "baseballs",
          {
            team_id:
              env.TEAM_KEY,

            player_id:
              playerId,

            ball_number:
              ballNumber,

            status:
              "sold",

            donor_name:
              anonymous
                ? "Anonymous"
                : donorName,

            donor_email:
              donorEmail,

            stripe_session_id:
              session.id,

            sold_at:
              new Date()
                .toISOString(),
          }
        );
      }
    }


    console.log(
      "Baseball donation processed:",
      session.id,
      baseballs
    );

    return;
  }


  /*
    -----------------------------------
    GENERAL DONATION
    -----------------------------------
  */

  if (
    donationType ===
    "general"
  ) {
    if (!playerId) {
      throw new Error(
        "Missing player metadata for general donation."
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
          Number(
            playerNumber
          ) || null,

        donation_type:
          "general",

        donor_name:
          anonymous
            ? "Anonymous"
            : donorName,

        donor_email:
          donorEmail,

        anonymous:
          anonymous,

        amount:
          amountDollars,

        amount_cents:
          amountTotal,

        stripe_session_id:
          session.id,

        stripe_payment_intent:
          session.payment_intent ||
          null,

        payment_status:
          session.payment_status ||
          "paid",
      }
    );


    console.log(
      "General donation processed:",
      session.id
    );

    return;
  }


  console.log(
    "Unknown donation type:",
    donationType
  );
}


/*
  -----------------------------------
  STRIPE WEBHOOK ENDPOINT
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
      IMPORTANT:
      Stripe signature verification requires
      the ORIGINAL raw request body.
    */

    const payload =
      await request.text();

    const stripeSignature =
      request.headers.get(
        "stripe-signature"
      );


    const validSignature =
      await verifyStripeSignature(
        payload,
        stripeSignature,
        env.STRIPE_WEBHOOK_SECRET
      );


    if (!validSignature) {
      console.error(
        "Invalid Stripe webhook signature."
      );

      return json(
        {
          success: false,
          error:
            "Invalid signature.",
        },
        400
      );
    }


    let event;

    try {
      event =
        JSON.parse(
          payload
        );
    } catch {
      return json(
        {
          success: false,
          error:
            "Invalid Stripe payload.",
        },
        400
      );
    }


    /*
      WE ONLY NEED COMPLETED
      CHECKOUT SESSIONS
    */

    if (
      event.type ===
      "checkout.session.completed"
    ) {
      const session =
        event.data?.object;

      if (
        !session
      ) {
        throw new Error(
          "Missing checkout session."
        );
      }


      /*
        Only process successful payments.
      */

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


    /*
      Stripe expects a fast 2xx response.
    */

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
