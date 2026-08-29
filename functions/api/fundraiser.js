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

    const url = new URL(request.url);

    const playerSlug =
      (
        url.searchParams.get("player") || ""
      ).trim();

    if (!playerSlug) {
      return json(
        {
          success: false,
          error: "Missing player.",
        },
        400
      );
    }

    /*
      FIND PLAYER

      Expected players columns:
      id
      team_id
      name
      player_number
      slug
    */

    const players = await supabaseGet(
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

    if (!players.length) {
      return json(
        {
          success: false,
          error: "Player not found.",
        },
        404
      );
    }

    const player = players[0];

    /*
      FIND SOLD BASEBALLS

      Expected baseballs columns:
      id
      team_id
      player_id
      ball_number
      status

      Only baseballs with status = sold
      are disabled on the fundraiser page.
    */

    const baseballs = await supabaseGet(
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
        "&status=eq.sold",
        "&order=ball_number.asc",
      ].join("")
    );

    const soldBalls = baseballs
      .map(
        (row) =>
          Number(row.ball_number)
      )
      .filter(
        (number) =>
          Number.isInteger(number) &&
          number >= 1 &&
          number <= 60
      );

    return json({
      success: true,

      player: {
        id: player.id,
        slug: player.slug,
        name: player.name,
        number: player.player_number,
      },

      soldBalls,

      soldCount: soldBalls.length,

      totalBalls: 60,
    });
  } catch (error) {
    console.error(
      "FUNDRAISER API ERROR:",
      error
    );

    return json(
      {
        success: false,
        error:
          "Unable to load fundraiser.",
      },
      500
    );
  }
}
