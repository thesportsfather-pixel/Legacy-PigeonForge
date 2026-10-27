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

export async function onRequestGet({
  request,
  env,
}) {
  try {
    if (
      !env.SUPABASE_URL ||
      !env.SUPABASE_SERVICE_ROLE_KEY
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

    const GOAL_AMOUNT =
      1830;

    const url =
      new URL(request.url);

    const playerSlug =
      String(
        url.searchParams.get("player") || ""
      ).trim();

    if (!playerSlug) {
      return json(
        {
          success: false,
          error:
            "Player is required.",
        },
        400
      );
    }

    /*
      Find the Pigeon Forge team.
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
      "";

    /*
      Get sold baseballs.
    */

    const soldBalls =
      await supabaseGet(
        env,
        `baseballs?player_id=eq.${encodeURIComponent(
          player.id
        )}&status=eq.sold&select=ball_number,status,donor_name,donor_email,sold_at,stripe_session_id&order=ball_number.asc`
      );

    /*
      Since each ball number equals its
      donation amount, the sold-ball total
      is simply the sum of the ball numbers.
    */

    const baseballAmountRaised =
      soldBalls.reduce(
        (total, row) => {
          const ballNumber =
            Number(row.ball_number);

          return (
            total +
            (
              Number.isFinite(ballNumber)
                ? ballNumber
                : 0
            )
          );
        },
        0
      );

    /*
      Get PAID player general donations.

      Do NOT include baseball orders here,
      because those amounts are already
      calculated from the sold baseballs.
    */

    const generalOrders =
      await supabaseGet(
        env,
        `orders?player_id=eq.${encodeURIComponent(
          player.id
        )}&donation_type=eq.general&status=eq.paid&select=amount,amount_cents,total_cents`
      );

    const generalDonationAmount =
      generalOrders.reduce(
        (total, order) => {
          /*
            Prefer amount_cents.

            Fall back to total_cents,
            then amount.
          */

          const amountCents =
            Number(
              order.amount_cents ??
              order.total_cents ??
              0
            );

          if (
            Number.isFinite(amountCents) &&
            amountCents > 0
          ) {
            return (
              total +
              amountCents / 100
            );
          }

          const amount =
            Number(order.amount || 0);

          return (
            total +
            (
              Number.isFinite(amount)
                ? amount
                : 0
            )
          );
        },
        0
      );

    /*
      Total player progress.
    */

    const amountRaised =
      Number(
        (
          baseballAmountRaised +
          generalDonationAmount
        ).toFixed(2)
      );

    const progressPercent =
      Math.min(
        100,
        Math.max(
          0,
          Number(
            (
              amountRaised /
              GOAL_AMOUNT *
              100
            ).toFixed(1)
          )
        )
      );

    return json({
      success: true,

      team: {
        id: team.id,
        team_key:
          team.team_key,
        team_name:
          team.team_name,
      },

      player: {
        id: player.id,
        slug:
          player.slug ||
          player.player_key ||
          playerSlug,
        name:
          playerName,
        number:
          player.player_number,
      },

      soldBalls,

      soldCount:
        soldBalls.length,

      totalBalls:
        60,

      baseballAmountRaised,

      generalDonationAmount,

      amountRaised,

      goalAmount:
        GOAL_AMOUNT,

      progressPercent,
    });

  } catch (error) {
    console.error(
      "fundraiser error:",
      error
    );

    return json(
      {
        success: false,
        error:
          error?.message ||
          "Unable to load fundraiser.",
      },
      500
    );
  }
}
