const TEAM_KEY = "legacy-pigeon-forge";
const TEAM_NAME = "South Florida Legacy - Pigeon Forge";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function formEncode(values) {
  const form = new URLSearchParams();

  for (const [key, value] of Object.entries(values)) {
    if (
      value !== undefined &&
      value !== null &&
      value !== ""
    ) {
      form.append(key, String(value));
    }
  }

  return form.toString();
}

async function stripeRequest(env, path, params) {
  if (!env.STRIPE_SECRET_KEY) {
    throw new Error(
      "Missing server configuration: STRIPE_SECRET_KEY"
    );
  }

  const response = await fetch(
    `https://api.stripe.com/v1/${path}`,
    {
      method: "POST",

      headers: {
        authorization:
          `Bearer ${env.STRIPE_SECRET_KEY}`,

        "content-type":
          "application/x-www-form-urlencoded",
      },

      body:
        formEncode(params),
    }
  );

  const text =
    await response.text();

  let data = null;

  try {
    data =
      text
        ? JSON.parse(text)
        : null;
  } catch {
    throw new Error(
      `Stripe returned an invalid response (${response.status}).`
    );
  }

  if (!response.ok) {
    throw new Error(
      data?.error?.message ||
      `Stripe request failed (${response.status}).`
    );
  }

  return data;
}

export async function onRequestPost({
  request,
  env,
}) {
  try {
    const body =
      await request.json();

    const amount =
      Number(
        body.amount
      );

    const anonymous =
      Boolean(
        body.anonymous
      );

    const donorName =
      anonymous
        ? "Anonymous"
        : String(
            body.donor_name || ""
          ).trim();

    const donorEmail =
      String(
        body.donor_email || ""
      ).trim();


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


    if (!donorEmail) {
      return json(
        {
          success: false,
          error:
            "Please enter your email address.",
        },
        400
      );
    }


    if (
      !anonymous &&
      !donorName
    ) {
      return json(
        {
          success: false,
          error:
            "Please enter a donor name or choose Anonymous.",
        },
        400
      );
    }


    const amountCents =
      Math.round(
        amount * 100
      );


    const origin =
      new URL(
        request.url
      ).origin;


    const successUrl =
      `${origin}/road-to-pigeon-forge` +
      `?general_donation=success` +
      `&session_id={CHECKOUT_SESSION_ID}`;


    const cancelUrl =
      `${origin}/road-to-pigeon-forge` +
      `?general_donation=canceled`;


    const session =
      await stripeRequest(
        env,
        "checkout/sessions",
        {
          mode:
            "payment",

          "payment_method_types[0]":
            "card",

          "line_items[0][price_data][currency]":
            "usd",

          "line_items[0][price_data][product_data][name]":
            `${TEAM_NAME} — General Donation`,

          "line_items[0][price_data][product_data][description]":
            "Road to Pigeon Forge fundraiser",

          "line_items[0][price_data][unit_amount]":
            amountCents,

          "line_items[0][quantity]":
            1,

          success_url:
            successUrl,

          cancel_url:
            cancelUrl,

          customer_email:
            donorEmail,

          "metadata[team_key]":
            TEAM_KEY,

          "metadata[team_name]":
            TEAM_NAME,

          "metadata[donation_type]":
            "general",

          "metadata[donor_name]":
            donorName,

          "metadata[donor_email]":
            donorEmail,

          "metadata[anonymous]":
            anonymous
              ? "true"
              : "false",

          "metadata[amount_cents]":
            amountCents,
        }
      );


    if (!session?.url) {
      throw new Error(
        "Stripe Checkout URL was not returned."
      );
    }


    return json({
      success: true,
      url:
        session.url,
      sessionId:
        session.id,
    });


  } catch (error) {

    console.error(
      "create-team-donation error:",
      error
    );


    return json(
      {
        success: false,

        error:
          error?.message ||
          "Unable to create general donation checkout.",
      },
      500
    );
  }
}
