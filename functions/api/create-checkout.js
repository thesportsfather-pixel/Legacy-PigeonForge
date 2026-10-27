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

    const TEAM_KEY =
      "legacy-pigeon-forge";

    const body =
      await request.json();

    const playerSlug =
      String(
        body.player_slug || ""
      ).trim();

    const donorNameRaw =
      String(
        body.donor_name || ""
      ).trim();

    const anonymous =
      body.anonymous === true;

    const donorName =
      anonymous || !donorNameRaw
        ? "Anonymous"
        : donorNameRaw;

    const baseballs =
      Array.from(
        new Set(
          Array.isArray(body.baseballs)
            ? body.baseballs.map(Number)
            : []
        )
      )
        .filter(
          (number) =>
            Number.isInteger(number) &&
            number >= 1 &&
            number <= 60
        )
        .sort((a, b) => a - b);

    if (!playerSlug) {
      return json(
        {
          success: false,
          error: "Player is required.",
        },
        400
      );
    }

    if (!baseballs.length) {
      return json(
        {
          success: false,
          error:
            "Please select at least one baseball.",
        },
        400
      );
    }

    /*
      Find team UUID.
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

    const team =
      teams[0];

    /*
      Find player.
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

    const player =
      players[0];

    const playerName =
      player.player_name ||
      player.name ||
      body.player_name ||
      "";

    const playerNumber =
      player.player_number ??
      body.player_number ??
      null;

    /*
      Make sure none of the selected
      baseballs are already sold.
    */

    const selectedNumbers =
      baseballs.join(",");

    const unavailable =
      await supabaseGet(
        env,
        `baseballs?player_id=eq.${encodeURIComponent(
          player.id
        )}&ball_number=in.(${selectedNumbers})&status=eq.sold&select=ball_number`
      );

    if (unavailable.length) {
      return json(
        {
          success: false,
          error:
            "One or more selected baseballs were already purchased.",
          unavailableBalls:
            unavailable.map(
              (row) =>
                Number(row.ball_number)
            ),
        },
        409
      );
    }

    /*
      Ball number equals donation amount.
    */

    const totalDollars =
      baseballs.reduce(
        (sum, number) =>
          sum + number,
        0
      );

    const totalCents =
      totalDollars * 100;

    const requestUrl =
      new URL(request.url);

    const siteUrl =
      (
        env.SITE_URL ||
        requestUrl.origin
      ).replace(/\/+$/, "");

    /*
      Build Stripe Checkout Session.
    */

    const stripeBody =
      new URLSearchParams();

    stripeBody.set(
      "mode",
      "payment"
    );

    stripeBody.set(
      "payment_method_types[0]",
      "card"
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
      String(totalCents)
    );

    stripeBody.set(
      "line_items[0][price_data][product_data][name]",
      `${playerName} - Road to Pigeon Forge`
    );

    stripeBody.set(
      "line_items[0][price_data][product_data][description]",
      `Baseballs: ${baseballs.join(", ")}`
    );

    /*
      Stripe metadata used by webhook.
    */

    stripeBody.set(
      "metadata[donation_type]",
      "baseballs"
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
      String(
        playerNumber ?? ""
      )
    );

    stripeBody.set(
      "metadata[baseballs]",
      baseballs.join(",")
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
      String(totalDollars)
    );

    stripeBody.set(
      "metadata[amount_cents]",
      String(totalCents)
    );

    /*
      Also attach useful metadata to the
      PaymentIntent itself.
    */

    stripeBody.set(
      "payment_intent_data[metadata][donation_type]",
      "baseballs"
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
      "payment_intent_data[metadata][baseballs]",
      baseballs.join(",")
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
      total: totalDollars,
      baseballs,
    });

  } catch (error) {
    console.error(
      "create-checkout error:",
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
