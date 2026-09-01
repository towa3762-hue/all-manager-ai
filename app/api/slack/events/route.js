import crypto from "crypto";
import { after } from "next/server";

export const runtime = "nodejs";

const ALL_TASKS_LIST_ID = "F0BT8TP1U5S";
const TASK_NAME_COLUMN_ID = "Col0BT57431PC";

// ========================================
// Slack署名確認
// ========================================

function verifySlackRequest(
  rawBody,
  timestamp,
  signature
) {
  const secret =
    process.env.SLACK_SIGNING_SECRET;

  if (
    !secret ||
    !timestamp ||
    !signature
  ) {
    return false;
  }

  const now =
    Math.floor(Date.now() / 1000);

  if (
    Math.abs(
      now - Number(timestamp)
    ) >
    60 * 5
  ) {
    return false;
  }

  const baseString =
    `v0:${timestamp}:${rawBody}`;

  const expectedSignature =
    "v0=" +
    crypto
      .createHmac(
        "sha256",
        secret
      )
      .update(
        baseString,
        "utf8"
      )
      .digest("hex");

  const a =
    Buffer.from(
      expectedSignature
    );

  const b =
    Buffer.from(signature);

  if (a.length !== b.length) {
    return false;
  }

  return crypto.timingSafeEqual(
    a,
    b
  );
}

// ========================================
// OpenAI
// ========================================

async function askOpenAI(userText) {
  const response =
    await fetch(
      "https://api.openai.com/v1/responses",
      {
        method: "POST",

        headers: {
          Authorization:
            `Bearer ${process.env.OPENAI_API_KEY}`,

          "Content-Type":
            "application/json",
        },

        body: JSON.stringify({
          model:
            "gpt-5.6-luna",

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

まだ通常のSlack Lists登録や
Google Calendar変更は行わないでください。

Slackのチャンネル上で
自然な会話になるよう、
簡潔に返答してください。
`,

          input: userText,

          max_output_tokens: 300,
        }),
      }
    );

  if (!response.ok) {
    const errorText =
      await response.text();

    console.error(
      "OpenAI error:",
      response.status,
      errorText
    );

    return "OpenAIとの通信でエラーが発生しました。";
  }

  const data =
    await response.json();

  const outputText =
    (data.output ?? [])
      .filter(
        (item) =>
          item.type === "message"
      )
      .flatMap(
        (item) =>
          item.content ?? []
      )
      .filter(
        (content) =>
          content.type ===
          "output_text"
      )
      .map(
        (content) =>
          content.text
      )
      .join("\n")
      .trim();

  return (
    outputText ||
    "内容を解析できませんでした。"
  );
}

// ========================================
// Slackへメッセージ投稿
// ========================================

async function postSlackMessage(
  channel,
  text
) {
  const response =
    await fetch(
      "https://slack.com/api/chat.postMessage",
      {
        method: "POST",

        headers: {
          Authorization:
            `Bearer ${process.env.SLACK_BOT_TOKEN}`,

          "Content-Type":
            "application/json",
        },

        body: JSON.stringify({
          channel,
          text,
        }),
      }
    );

  const data =
    await response.json();

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

async function processSlackEvent(
  event
) {
  // 通常メッセージだけ処理
  if (
    event.type !== "message"
  ) {
    return;
  }

  // Bot自身の投稿や
  // 特殊メッセージは無視
  if (
    event.bot_id ||
    event.subtype
  ) {
    return;
  }

  const userText =
    (event.text ?? "")
      .trim();

  if (!userText) {
    return;
  }

  const reply =
    await askOpenAI(
      userText
    );

  // スレッドではなく
  // チャンネルへ直接返信
  await postSlackMessage(
    event.channel,
    reply
  );
}

// ========================================
// Slack Events API
// ========================================

export async function POST(
  request
) {
  try {
    const rawBody =
      await request.text();

    const timestamp =
      request.headers.get(
        "x-slack-request-timestamp"
      );

    const signature =
      request.headers.get(
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

    const body =
      JSON.parse(rawBody);

    // SlackのRequest URL検証
    if (
      body.type ===
      "url_verification"
    ) {
      return new Response(
        body.challenge,
        {
          status: 200,

          headers: {
            "Content-Type":
              "text/plain",
          },
        }
      );
    }

    // Slackイベント処理
    if (
      body.type ===
      "event_callback"
    ) {
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
// ALL TASKS 書き込みテスト
// ========================================

export async function GET(
  request
) {
  try {
    const url =
      new URL(request.url);

    const action =
      url.searchParams.get(
        "action"
      );

    // 通常アクセス
    if (
      action !==
      "create-test"
    ) {
      return Response.json({
        ok: true,
        status:
          "ALL Manager AI is running",
        message:
          "Use ?action=create-test to test ALL TASKS writing",
      });
    }

    // ====================================
    // ALL TASKSに1件追加
    // ====================================

    const response =
      await fetch(
        "https://slack.com/api/slackLists.items.create",
        {
          method: "POST",

          headers: {
            Authorization:
              `Bearer ${process.env.SLACK_BOT_TOKEN}`,

            "Content-Type":
              "application/json",
          },

          body:
            JSON.stringify({
              list_id:
                ALL_TASKS_LIST_ID,

              initial_fields: [
                {
                  column_id:
                    TASK_NAME_COLUMN_ID,

                  rich_text: [
                    {
                      type:
                        "rich_text",

                      elements: [
                        {
                          type:
                            "rich_text_section",

                          elements: [
                            {
                              type:
                                "text",

                              text:
                                "【TEST】Slackから自動登録",
                            },
                          ],
                        },
                      ],
                    },
                  ],
                },
              ],
            }),
        }
      );

    const data =
      await response.json();

    if (!data.ok) {
      console.error(
        "Slack List create error:",
        data
      );

      return Response.json(
        {
          ok: false,

          error:
            data.error,

          needed:
            data.needed ??
            null,

          provided:
            data.provided ??
            null,
        },

        {
          status: 500,
        }
      );
    }

    return Response.json({
      ok: true,

      message:
        "テストタスクをALL TASKSに追加しました",

      item_id:
        data.item?.id ??
        null,
    });
  } catch (error) {
    console.error(
      "Slack List test error:",
      error
    );

    return Response.json(
      {
        ok: false,
        error:
          "test_create_failed",
      },

      {
        status: 500,
      }
    );
  }
}