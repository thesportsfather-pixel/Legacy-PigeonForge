function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

async function supabaseGet(env, path) {
  const response = await fetch(
    `${env.SUPABASE_URL}/rest/v1/${path}`,
    {
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        accept: "application/json",
      },
    }
  );

  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      `Supabase ${response.status}: ${text}`
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
      !env.STRIPE_SECRET_KEY
    ) {
      return json(
        {
          success: false,
          error: "Missing required environment variables.",
        },
        500
      );
    }

    const TEAM_KEY = "legacy-pigeon-forge";

    const body = await request.json();

    const playerSlug =
      String(body.player_slug || "").trim();

    const donorNameRaw =
      String(body.donor_name || "").trim();

    const anonymous =
      body.anonymous === true;

    const donorName =
      anonymous || !donorNameRaw
        ? "Anonymous"
        : donorNameRaw;

    const amount =
      Number(body.amount);

    if (!playerSlug) {
      return json(
        {
          success: false,
          error: "Player is required.",
        },
        400
      );
    }

    if (
      !Number.isFinite(amount) ||
      amount < 1
    ) {
      return json(
        {
          success: false,
          error:
            "Please enter a valid donation amount.",
        },
        400
      );
    }

    const amountCents =
      Math.round(amount * 100);

    /*
      Resolve team.
    */

    const teams =
      await supabaseGet(
        env,
        `teams?team_key=eq.${encodeURIComponent(
          TEAM_KEY
        )}&select=id,team_key,team_name&limit=1`
      );

    if (!teams.length) {
      return json(
        {
          success: false,
          error:
            "Pigeon Forge team not found.",
        },
        404
      );
    }

    const team = teams[0];

    /*
      Resolve player.
    */

    let players =
      await supabaseGet(
        env,
        `players?team_id=eq.${encodeURIComponent(
          team.id
        )}&slug=eq.${encodeURIComponent(
          playerSlug
        )}&select=id,slug,player_key,name,player_name,player_number&limit=1`
      );

    if (!players.length) {
      players =
        await supabaseGet(
          env,
          `players?team_id=eq.${encodeURIComponent(
            team.id
          )}&player_key=eq.${encodeURIComponent(
            playerSlug
          )}&select=id,slug,player_key,name,player_name,player_number&limit=1`
        );
    }

    if (!players.length) {
      return json(
        {
          success: false,
          error:
            "Player not found.",
        },
        404
      );
    }

    const player = players[0];

    const playerName =
      player.player_name ||
      player.name ||
      body.player_name ||
      "";

    const playerNumber =
      player.player_number ??
      body.player_number ??
      null;

    const requestUrl =
      new URL(request.url);

    const siteUrl =
      (
        env.SITE_URL ||
        requestUrl.origin
      ).replace(/\/+$/, "");

    /*
      Create Stripe Checkout Session.
    */

    const stripeBody =
      new URLSearchParams();

    stripeBody.set(
      "mode",
      "payment"
    );

    stripeBody.set(
      "success_url",
      `${siteUrl}/fundraiser.html?player=${encodeURIComponent(
        playerSlug
      )}&payment=success&session_id={CHECKOUT_SESSION_ID}`
    );

    stripeBody.set(
      "cancel_url",
      `${siteUrl}/fundraiser.html?player=${encodeURIComponent(
        playerSlug
      )}&payment=cancelled`
    );

    stripeBody.set(
      "line_items[0][quantity]",
      "1"
    );

    stripeBody.set(
      "line_items[0][price_data][currency]",
      "usd"
    );

    stripeBody.set(
      "line_items[0][price_data][unit_amount]",
      String(amountCents)
    );

    stripeBody.set(
      "line_items[0][price_data][product_data][name]",
      `${playerName} - General Donation`
    );

    stripeBody.set(
      "line_items[0][price_data][product_data][description]",
      "South Florida Legacy - Road to Pigeon Forge"
    );

    /*
      Session metadata.
    */

    stripeBody.set(
      "metadata[donation_type]",
      "general"
    );

    stripeBody.set(
      "metadata[team_key]",
      TEAM_KEY
    );

    stripeBody.set(
      "metadata[player_id]",
      String(player.id)
    );

    stripeBody.set(
      "metadata[player_slug]",
      playerSlug
    );

    stripeBody.set(
      "metadata[player_name]",
      playerName
    );

    stripeBody.set(
      "metadata[player_number]",
      String(playerNumber ?? "")
    );

    stripeBody.set(
      "metadata[donor_name]",
      donorName
    );

    stripeBody.set(
      "metadata[anonymous]",
      anonymous ||
      donorName === "Anonymous"
        ? "true"
        : "false"
    );

    stripeBody.set(
      "metadata[amount_dollars]",
      String(amount)
    );

    stripeBody.set(
      "metadata[amount_cents]",
      String(amountCents)
    );

    /*
      PaymentIntent metadata.
    */

    stripeBody.set(
      "payment_intent_data[metadata][donation_type]",
      "general"
    );

    stripeBody.set(
      "payment_intent_data[metadata][team_key]",
      TEAM_KEY
    );

    stripeBody.set(
      "payment_intent_data[metadata][player_slug]",
      playerSlug
    );

    stripeBody.set(
      "payment_intent_data[metadata][player_name]",
      playerName
    );

    stripeBody.set(
      "payment_intent_data[metadata][donor_name]",
      donorName
    );

    const stripeResponse =
      await fetch(
        "https://api.stripe.com/v1/checkout/sessions",
        {
          method: "POST",
          headers: {
            authorization:
              `Bearer ${env.STRIPE_SECRET_KEY}`,
            "content-type":
              "application/x-www-form-urlencoded",
          },
          body:
            stripeBody.toString(),
        }
      );

    const stripeData =
      await stripeResponse.json();

    if (!stripeResponse.ok) {
      console.error(
        "Stripe error:",
        stripeData
      );

      return json(
        {
          success: false,
          error:
            stripeData?.error?.message ||
            "Unable to create Stripe checkout.",
        },
        stripeResponse.status
      );
    }

    if (!stripeData.url) {
      return json(
        {
          success: false,
          error:
            "Stripe did not return a checkout URL.",
        },
        500
      );
    }

    return json({
      success: true,
      url: stripeData.url,
      session_id: stripeData.id,
      amount,
    });

  } catch (error) {
    console.error(
      "create-general-donation error:",
      error
    );

    return json(
      {
        success: false,
        error:
          error?.message ||
          "Unable to create checkout.",
      },
      500
    );
  }
}
