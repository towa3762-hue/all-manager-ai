import crypto from "crypto";
import { after } from "next/server";

export const runtime = "nodejs";

const ALL_TASKS_LIST_ID = "F0BT8TP1U5S";

// ========================================
// Slack署名確認
// ========================================

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

// ========================================
// OpenAI
// ========================================

async function askOpenAI(userText) {
  const response = await fetch(
    "https://api.openai.com/v1/responses",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-5.6-luna",

        instructions: `
あなたは「ALL Manager AI」です。

ユーザーのSlack上の自然文を理解して、
短く自然な日本語で返答してください。

現在は会話テスト段階です。

以下を分かる範囲で理解してください。

・何をしたいのか
・対象領域
・日時や期限
・所要時間
・優先度

まだSlack ListsやGoogle Calendarは変更しないでください。

Slackのチャンネル上で自然な会話になるよう、
簡潔に返答してください。
`,

        input: userText,

        max_output_tokens: 300,
      }),
    }
  );

  if (!response.ok) {
    const errorText = await response.text();

    console.error(
      "OpenAI error:",
      response.status,
      errorText
    );

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

// ========================================
// Slackへメッセージ投稿
// ========================================

async function postSlackMessage(channel, text) {
  const response = await fetch(
    "https://slack.com/api/chat.postMessage",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
        "Content-Type": "application/json",
      },

      body: JSON.stringify({
        channel,
        text,
      }),
    }
  );

  const data = await response.json();

  if (!data.ok) {
    console.error(
      "Slack post error:",
      data
    );
  }
}

// ========================================
// Slackメッセージ処理
// ========================================

async function processSlackEvent(event) {
  // 通常メッセージだけ処理
  if (event.type !== "message") {
    return;
  }

  // Bot自身の投稿・特殊メッセージは無視
  if (event.bot_id || event.subtype) {
    return;
  }

  const userText = (event.text ?? "").trim();

  if (!userText) {
    return;
  }

  const reply = await askOpenAI(userText);

  // スレッドではなくチャンネルへ直接返信
  await postSlackMessage(
    event.channel,
    reply
  );
}

// ========================================
// Slack Events API
// ========================================

export async function POST(request) {
  try {
    const rawBody = await request.text();

    const timestamp = request.headers.get(
      "x-slack-request-timestamp"
    );

    const signature = request.headers.get(
      "x-slack-signature"
    );

    if (
      !verifySlackRequest(
        rawBody,
        timestamp,
        signature
      )
    ) {
      return new Response(
        "Invalid Slack signature",
        {
          status: 401,
        }
      );
    }

    const body = JSON.parse(rawBody);

    // Slack Request URL検証
    if (body.type === "url_verification") {
      return new Response(
        body.challenge,
        {
          status: 200,
          headers: {
            "Content-Type": "text/plain",
          },
        }
      );
    }

    // Slackイベント処理
    if (body.type === "event_callback") {
      after(async () => {
        try {
          await processSlackEvent(
            body.event
          );
        } catch (error) {
          console.error(
            "Background processing error:",
            error
          );
        }
      });
    }

    return new Response(
      "OK",
      {
        status: 200,
      }
    );
  } catch (error) {
    console.error(
      "Slack event error:",
      error
    );

    return new Response(
      "Error",
      {
        status: 500,
      }
    );
  }
}

// ========================================
// ALL TASKS の列情報確認
// ========================================

export async function GET() {
  try {
    const response = await fetch(
      "https://slack.com/api/slackLists.items.list",
      {
        method: "POST",

        headers: {
          Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
          "Content-Type": "application/json",
        },

        body: JSON.stringify({
          list_id: ALL_TASKS_LIST_ID,
          limit: 1,
          include_list: true,
        }),
      }
    );

    const data = await response.json();

    if (!data.ok) {
      console.error(
        "Slack List API error:",
        data
      );

      return Response.json(
        {
          ok: false,
          error: data.error,
          needed: data.needed ?? null,
          provided: data.provided ?? null,
        },
        {
          status: 500,
        }
      );
    }

    const schema =
      data.list?.list_metadata?.schema ?? [];

    const columns = schema.map(
      (column) => ({
        id: column.id,
        name: column.name,
        key: column.key,
        type: column.type,

        is_primary_column:
          column.is_primary_column ?? false,

        options:
          column.options ?? null,
      })
    );

    return Response.json({
      ok: true,

      list_id: ALL_TASKS_LIST_ID,

      title:
        data.list?.title ??
        data.list?.name ??
        "ALL TASKS",

      columns,
    });
  } catch (error) {
    console.error(
      "Slack List error:",
      error
    );

    return Response.json(
      {
        ok: false,
        error: "list_read_failed",
      },
      {
        status: 500,
      }
    );
  }
}