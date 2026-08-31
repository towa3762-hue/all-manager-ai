export const runtime = "nodejs";

export async function POST(request) {
  try {
    const body = await request.json();

    // SlackのRequest URL確認
    if (body.type === "url_verification") {
      return new Response(body.challenge, {
        status: 200,
        headers: {
          "Content-Type": "text/plain",
        },
      });
    }

    // 通常のSlackイベント
    if (body.type === "event_callback") {
      console.log("Slack event received:", body.event);
    }

    return new Response("OK", {
      status: 200,
      headers: {
        "Content-Type": "text/plain",
      },
    });
  } catch (error) {
    console.error("Slack event error:", error);

    return new Response("Error", {
      status: 500,
    });
  }
}

export async function GET() {
  return Response.json({
    status: "ALL Manager AI is running",
  });
}