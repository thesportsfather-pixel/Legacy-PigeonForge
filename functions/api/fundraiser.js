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
      --------------------------------
      1. FIND TEAM BY TEAM_KEY
      --------------------------------
    */

    const teams =
      await supabaseGet(
        env,
        [
          "teams",
          "?select=id,team_key,team_name",
          `&team_key=eq.${encodeURIComponent(
            env.TEAM_KEY
          )}`,
          "&limit=1",
        ].join("")
      );

    if (!teams.length) {
      return json(
        {
          success: false,
          error: "Team not found.",
        },
        404
      );
    }

    const team = teams[0];

    /*
      --------------------------------
      2. FIND PLAYER USING TEAM UUID
      --------------------------------

      players.team_id is UUID

      We support both:
      slug
      player_key
    */

    let players =
      await supabaseGet(
        env,
        [
          "players",
          "?select=id,player_key,player_name,player_number,slug,name",
          `&team_id=eq.${encodeURIComponent(
            team.id
          )}`,
          `&slug=eq.${encodeURIComponent(
            playerSlug
          )}`,
          "&limit=1",
        ].join("")
      );

    /*
      Fallback for older player records
      that may use player_key instead.
    */

    if (!players.length) {
      players =
        await supabaseGet(
          env,
          [
            "players",
            "?select=id,player_key,player_name,player_number,slug,name",
            `&team_id=eq.${encodeURIComponent(
              team.id
            )}`,
            `&player_key=eq.${encodeURIComponent(
              playerSlug
            )}`,
            "&limit=1",
          ].join("")
        );
    }

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
      --------------------------------
      3. LOAD SOLD BASEBALLS
      --------------------------------

      baseballs.team_id is TEXT,
      so here we use TEAM_KEY.
    */

    const baseballs =
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
          "&status=eq.sold",
          "&order=ball_number.asc",
        ].join("")
      );

    const soldBalls =
      baseballs
        .map(
          row =>
            Number(row.ball_number)
        )
        .filter(
          number =>
            Number.isInteger(number) &&
            number >= 1 &&
            number <= 60
        );

    const resolvedName =
      player.player_name ||
      player.name ||
      "";

    const resolvedSlug =
      player.slug ||
      player.player_key ||
      playerSlug;

    return json({
      success: true,

      team: {
        id: team.id,
        key: team.team_key,
        name: team.team_name,
      },

      player: {
        id: player.id,
        slug: resolvedSlug,
        name: resolvedName,
        number: player.player_number,
      },

      soldBalls,

      soldCount:
        soldBalls.length,

      totalBalls:
        60,
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
          error?.message ||
          "Unable to load fundraiser.",
      },
      500
    );
  }
}
