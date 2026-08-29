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
      STEP 1:
      Find the Pigeon Forge team UUID
      using its team_key.
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
      STEP 2:
      Find the player using the team's
      UUID and the player's slug.
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

    /*
      Fallback for older rows that may
      use player_key instead of slug.
    */

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

    /*
      STEP 3:
      Get sold baseballs.

      baseballs.team_id is TEXT in this
      fundraiser architecture, so we use
      the team key here rather than the
      UUID.
    */

    const soldBalls =
      await supabaseGet(
        env,
        `baseballs?team_id=eq.${encodeURIComponent(
          TEAM_KEY
        )}&player_id=eq.${encodeURIComponent(
          player.id
        )}&status=eq.sold&select=ball_number,status,donor_name,donor_email,sold_at,stripe_session_id&order=ball_number.asc`
      );

    /*
      Return full sold-ball records so
      fundraiser.html can show donor names
      underneath sold baseballs.
    */

    return json({
      success: true,

      team: {
        id: team.id,
        team_key: team.team_key,
        team_name: team.team_name,
      },

      player: {
        id: player.id,
        slug:
          player.slug ||
          player.player_key ||
          playerSlug,

        name:
          player.player_name ||
          player.name ||
          "",

        number:
          player.player_number ?? null,
      },

      soldBalls,

      soldCount:
        soldBalls.length,

      totalBalls: 60,
    });
  } catch (error) {
    console.error(
      "fundraiser.js error:",
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
