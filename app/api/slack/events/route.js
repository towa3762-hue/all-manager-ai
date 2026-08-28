export const runtime = "nodejs";

export async function POST(request) {
  try {
    const body = await request.json();

    // SlackがURLの存在確認をするとき
    if (body.type === "url_verification") {
      return Response.json({
        challenge: body.challenge,
      });
    }

    // Slackから通常のイベントが届いたとき
    if (body.type === "event_callback") {
      const event = body.event;

      // 後でここにAI処理を追加する
      console.log("Slack event received:", event);
    }

    return Response.json({ ok: true });
  } catch (error) {
    console.error("Slack event error:", error);

    return Response.json(
      { ok: false },
      { status: 500 }
    );
  }
}

export async function GET() {
  return Response.json({
    status: "ALL Manager AI is running",
  });
}