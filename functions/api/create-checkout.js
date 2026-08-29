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
  SUPABASE GET
*/

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


/*
  CREATE STRIPE CHECKOUT SESSION
*/

async function createStripeCheckout(
  env,
  params
) {
  const body =
    new URLSearchParams();

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


  /*
    ONE LINE ITEM

    The amount is the combined value
    of all selected baseballs.
  */

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
    `Baseballs: ${params.baseballs.join(", ")}`
  );


  /*
    STRIPE METADATA

    This metadata will be read later
    by stripe-webhook.js after payment.
  */

  body.set(
    "metadata[donation_type]",
    "baseballs"
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
    "metadata[baseballs]",
    params.baseballs.join(",")
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


/*
  POST /api/create-checkout
*/

export async function onRequestPost({
  request,
  env,
}) {
  try {

    /*
      REQUIRED ENVIRONMENT VARIABLES
    */

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


    /*
      READ REQUEST
    */

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


    /*
      VALIDATE BASEBALL NUMBERS

      We only accept unique integers
      between 1 and 60.
    */

    if (
      !Array.isArray(
        body.baseballs
      )
    ) {
      return json(
        {
          success: false,
          error:
            "Please select at least one baseball.",
        },
        400
      );
    }


    const baseballs =
      [
        ...new Set(
          body.baseballs
            .map(Number)
            .filter(
              number =>
                Number.isInteger(
                  number
                ) &&
                number >= 1 &&
                number <= 60
            )
        ),
      ].sort(
        (a, b) => a - b
      );


    if (
      baseballs.length === 0
    ) {
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
      FIND PLAYER IN SUPABASE

      We do NOT trust the player name
      or number sent from the browser.
    */

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


    /*
      CHECK CURRENTLY SOLD BASEBALLS

      No baseball gets marked sold here.

      We only make sure the donor isn't
      attempting to purchase a ball that
      is already sold.
    */

    const selectedList =
      baseballs.join(",");


    const existing =
      await supabaseGet(
        env,
        [
          "baseballs",
          "?select=ball_number,status",
          `&team_id=eq.${encodeURIComponent(
            env.TEAM_KEY
          )}`,
          `&player_id=eq.${encodeURIComponent(
            player.id
          )}`,
          `&ball_number=in.(${selectedList})`,
          "&status=eq.sold",
        ].join("")
      );


    if (
      existing.length > 0
    ) {
      const unavailable =
        existing
          .map(
            row =>
              Number(
                row.ball_number
              )
          )
          .filter(
            Number.isInteger
          )
          .sort(
            (a, b) =>
              a - b
          );


      return json(
        {
          success: false,

          error:
            unavailable.length === 1
              ? `Baseball #${unavailable[0]} was just sold. Please choose another baseball.`
              : `Baseballs ${unavailable
                  .map(
                    number =>
                      `#${number}`
                  )
                  .join(", ")} are no longer available.`,

          unavailableBalls:
            unavailable,
        },
        409
      );
    }


    /*
      CALCULATE DONATION

      Ball #1 = $1
      Ball #25 = $25
      Ball #60 = $60
    */

    const amountDollars =
      baseballs.reduce(
        (total, number) =>
          total + number,
        0
      );


    const amountCents =
      amountDollars * 100;


    if (
      amountCents < 50
    ) {
      return json(
        {
          success: false,
          error:
            "Donation amount is too small.",
        },
        400
      );
    }


    /*
      BUILD RETURN URL

      Example:

      /fundraiser.html
      ?player=jack-lieberman
      &payment=success
    */

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


    /*
      CREATE STRIPE SESSION
    */

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

          baseballs,

          donorName,

          donorEmail,

          anonymous,

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

      baseballs,

      amount:
        amountDollars,
    });

  } catch (error) {

    console.error(
      "CREATE CHECKOUT ERROR:",
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
