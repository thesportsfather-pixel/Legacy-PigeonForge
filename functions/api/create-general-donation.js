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
      method: "GET",
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        authorization:
          `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
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

async function createStripeCheckout(
  env,
  params
) {
  const body = new URLSearchParams();

  body.set(
    "mode",
    "payment"
  );

  body.set(
    "customer_email",
    params.donorEmail
  );

  body.set(
    "success_url",
    params.successUrl
  );

  body.set(
    "cancel_url",
    params.cancelUrl
  );

  body.set(
    "line_items[0][quantity]",
    "1"
  );

  body.set(
    "line_items[0][price_data][currency]",
    "usd"
  );

  body.set(
    "line_items[0][price_data][unit_amount]",
    String(params.amountCents)
  );

  body.set(
    "line_items[0][price_data][product_data][name]",
    `${params.playerName} - Road to Pigeon Forge`
  );

  body.set(
    "line_items[0][price_data][product_data][description]",
    "General Donation"
  );

  body.set(
    "metadata[donation_type]",
    "general"
  );

  body.set(
    "metadata[team_key]",
    env.TEAM_KEY
  );

  body.set(
    "metadata[player_id]",
    String(params.playerId)
  );

  body.set(
    "metadata[player_slug]",
    params.playerSlug
  );

  body.set(
    "metadata[player_name]",
    params.playerName
  );

  body.set(
    "metadata[player_number]",
    String(params.playerNumber)
  );

  body.set(
    "metadata[donor_name]",
    params.donorName
  );

  body.set(
    "metadata[donor_email]",
    params.donorEmail
  );

  body.set(
    "metadata[anonymous]",
    params.anonymous
      ? "true"
      : "false"
  );

  body.set(
    "metadata[amount_dollars]",
    String(params.amountDollars)
  );

  const response = await fetch(
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
        body.toString(),
    }
  );

  const text =
    await response.text();

  let data;

  try {
    data =
      text
        ? JSON.parse(text)
        : {};
  } catch {
    data = {};
  }

  if (!response.ok) {
    console.error(
      "STRIPE ERROR:",
      text
    );

    throw new Error(
      data?.error?.message ||
      "Unable to create Stripe checkout."
    );
  }

  return data;
}

export async function onRequestPost({
  request,
  env,
}) {
  try {
    if (
      !env.SUPABASE_URL ||
      !env.SUPABASE_SERVICE_ROLE_KEY ||
      !env.TEAM_KEY ||
      !env.STRIPE_SECRET_KEY
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

    let body;

    try {
      body =
        await request.json();
    } catch {
      return json(
        {
          success: false,
          error:
            "Invalid request body.",
        },
        400
      );
    }

    const playerSlug =
      String(
        body.player_slug || ""
      ).trim();

    const donorEmail =
      String(
        body.donor_email || ""
      ).trim();

    const anonymous =
      body.anonymous === true;

    const donorName =
      anonymous
        ? "Anonymous"
        : (
            String(
              body.donor_name || ""
            ).trim()
            ||
            "Anonymous"
          );

    const amountDollars =
      Number(
        body.amount
      );

    if (!playerSlug) {
      return json(
        {
          success: false,
          error:
            "Missing player.",
        },
        400
      );
    }

    if (!donorEmail) {
      return json(
        {
          success: false,
          error:
            "Email is required.",
        },
        400
      );
    }

    if (
      !Number.isFinite(
        amountDollars
      ) ||
      amountDollars < 1
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
      Math.round(
        amountDollars * 100
      );

    if (
      amountCents < 100
    ) {
      return json(
        {
          success: false,
          error:
            "Minimum donation is $1.",
        },
        400
      );
    }

    const players =
      await supabaseGet(
        env,
        [
          "players",
          "?select=id,name,player_number,slug",
          `&team_id=eq.${encodeURIComponent(
            env.TEAM_KEY
          )}`,
          `&slug=eq.${encodeURIComponent(
            playerSlug
          )}`,
          "&limit=1",
        ].join("")
      );

    if (
      !players.length
    ) {
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

    const requestUrl =
      new URL(
        request.url
      );

    const siteOrigin =
      env.SITE_URL
        ? String(
            env.SITE_URL
          ).replace(
            /\/+$/,
            ""
          )
        : requestUrl.origin;

    const successUrl =
      `${siteOrigin}/fundraiser.html` +
      `?player=${encodeURIComponent(
        player.slug
      )}` +
      `&payment=success` +
      `&session_id={CHECKOUT_SESSION_ID}`;

    const cancelUrl =
      `${siteOrigin}/fundraiser.html` +
      `?player=${encodeURIComponent(
        player.slug
      )}` +
      `&payment=cancelled`;

    const session =
      await createStripeCheckout(
        env,
        {
          playerId:
            player.id,

          playerSlug:
            player.slug,

          playerName:
            player.name,

          playerNumber:
            player.player_number,

          donorName,

          donorEmail,

          anonymous,

          amountDollars,

          amountCents,

          successUrl,

          cancelUrl,
        }
      );

    if (
      !session.url
    ) {
      throw new Error(
        "Stripe did not return a checkout URL."
      );
    }

    return json({
      success: true,

      url:
        session.url,

      sessionId:
        session.id,

      amount:
        amountDollars,
    });

  } catch (error) {
    console.error(
      "CREATE GENERAL DONATION ERROR:",
      error
    );

    return json(
      {
        success: false,
        error:
          error?.message ||
          "Unable to create donation checkout.",
      },
      500
    );
  }
}
