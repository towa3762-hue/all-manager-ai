import crypto from "crypto";
import { after } from "next/server";

export const runtime = "nodejs";

function verifySlackRequest(rawBody, timestamp, signature) {
  const secret = process.env.SLACK_SIGNING_SECRET;

  if (!secret || !timestamp || !signature) {
    return false;
  }

  const now = Math.floor(Date.now() / 1000);

  if (Math.abs(now - Number(timestamp)) > 60 * 5) {
    return false;
  }

  const baseString = `v0:${timestamp}:${rawBody}`;

  const expectedSignature =
    "v0=" +
    crypto
      .createHmac("sha256", secret)
      .update(baseString, "utf8")
      .digest("hex");

  const a = Buffer.from(expectedSignature);
  const b = Buffer.from(signature);

  if (a.length !== b.length) {
    return false;
  }

  return crypto.timingSafeEqual(a, b);
}

async function askOpenAI(userText) {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-5.6-luna",
      instructions: `
あなたは「ALL Manager AI」です。

現在は接続テスト段階です。
ユーザーの自然文を理解して、短く日本語で返答してください。

以下を分かる範囲で整理してください。
・何をしたいのか
・対象領域
・日時や期限
・所要時間
・優先度

まだSlack ListsやGoogle Calendarは変更しないでください。
`,
      input: userText,
      max_output_tokens: 300,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error("OpenAI error:", response.status, errorText);
    return "OpenAIとの通信でエラーが発生しました。";
  }

  const data = await response.json();

  const outputText = (data.output ?? [])
    .filter((item) => item.type === "message")
    .flatMap((item) => item.content ?? [])
    .filter((content) => content.type === "output_text")
    .map((content) => content.text)
    .join("\n")
    .trim();

  return outputText || "内容を解析できませんでした。";
}

async function postSlackMessage(channel, text, threadTs) {
  const response = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      channel,
      text,
      thread_ts: threadTs,
    }),
  });

  const data = await response.json();

  if (!data.ok) {
    console.error("Slack post error:", data);
  }
}

async function processSlackEvent(event) {
  // まずは @ALL Manager AI へのメンションだけAI処理
  if (event.type !== "app_mention") {
    return;
  }

  // Bot自身の投稿などは無視
  if (event.bot_id || event.subtype) {
    return;
  }

  const userText = (event.text ?? "")
    .replace(/<@[A-Z0-9]+>/g, "")
    .trim();

  if (!userText) {
    return;
  }

  const reply = await askOpenAI(userText);

  await postSlackMessage(
    event.channel,
    reply,
    event.ts
  );
}

export async function POST(request) {
  try {
    const rawBody = await request.text();

    const timestamp = request.headers.get(
      "x-slack-request-timestamp"
    );
    const signature = request.headers.get(
      "x-slack-signature"
    );

    if (!verifySlackRequest(rawBody, timestamp, signature)) {
      return new Response("Invalid Slack signature", {
        status: 401,
      });
    }

    const body = JSON.parse(rawBody);

    if (body.type === "url_verification") {
      return new Response(body.challenge, {
        status: 200,
        headers: {
          "Content-Type": "text/plain",
        },
      });
    }

    if (body.type === "event_callback") {
      after(async () => {
        try {
          await processSlackEvent(body.event);
        } catch (error) {
          console.error("Background processing error:", error);
        }
      });
    }

    return new Response("OK", {
      status: 200,
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