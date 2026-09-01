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
// OpenAI出力テキスト取得
// ========================================

function getOpenAIOutputText(data) {
  return (data.output ?? [])
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
        content.type === "output_text"
    )
    .map(
      (content) =>
        content.text
    )
    .join("\n")
    .trim();
}

// ========================================
// 自然文を判定
// ========================================

async function analyzeSlackMessage(
  userText
) {
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

          store: false,

          instructions: `
あなたは「ALL Manager AI」です。

Slack上のユーザーの自然文を読み、
次のどちらかに分類してください。

1. task_create
新しいタスクとしてALL TASKSに登録すべき内容。

例:
「A社に連絡する」
「明日資料を作る」
「9/6以降にA社へ連絡。期限9/9」
「請求書を確認しておく」
「Slackの自動登録機能を作る」

2. conversation
質問、相談、雑談、確認、説明依頼など。
新しいタスクとして登録すべきではない内容。

例:
「今日どうしよう？」
「これはどういう意味？」
「ありがとう」
「今のタスク何がある？」
「これってできる？」

重要ルール:

・新しい行動や作業をやる意思が明確なら task_create
・単なる質問や会話なら conversation
・判断が曖昧なら conversation にする
・勝手にタスク登録しない
・task_name は実際にやる行動を短くまとめる
・日時、期限、優先度などは今はtask_nameに無理に含めなくてよい
・conversation の場合 task_name は空文字にする
・reply はSlackでユーザーに返す短い自然な日本語
`,

          input: userText,

          max_output_tokens: 300,

          text: {
            format: {
              type: "json_schema",

              name:
                "slack_message_intent",

              strict: true,

              schema: {
                type: "object",

                properties: {
                  intent: {
                    type: "string",

                    enum: [
                      "task_create",
                      "conversation",
                    ],
                  },

                  task_name: {
                    type: "string",
                  },

                  reply: {
                    type: "string",
                  },
                },

                required: [
                  "intent",
                  "task_name",
                  "reply",
                ],

                additionalProperties:
                  false,
              },
            },
          },
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

    throw new Error(
      "OpenAI request failed"
    );
  }

  const data =
    await response.json();

  const outputText =
    getOpenAIOutputText(data);

  if (!outputText) {
    throw new Error(
      "OpenAI returned empty output"
    );
  }

  return JSON.parse(
    outputText
  );
}

// ========================================
// ALL TASKSへタスク追加
// ========================================

async function createTaskInSlackList(
  taskName
) {
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

        body: JSON.stringify({
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
                            taskName,
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

    throw new Error(
      `Slack List error: ${data.error}`
    );
  }

  return data.item;
}

// ========================================
// Slackへ返信
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

  // Bot自身の投稿・特殊メッセージは無視
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

  try {
    const result =
      await analyzeSlackMessage(
        userText
      );

    // ====================================
    // タスク登録
    // ====================================

    if (
      result.intent ===
        "task_create" &&
      result.task_name
    ) {
      await createTaskInSlackList(
        result.task_name
      );

      await postSlackMessage(
        event.channel,
        `✅ ALL TASKSに登録しました\n・${result.task_name}`
      );

      return;
    }

    // ====================================
    // 普通の会話
    // ====================================

    await postSlackMessage(
      event.channel,
      result.reply ||
        "もう少し詳しく教えてください。"
    );
  } catch (error) {
    console.error(
      "Message processing error:",
      error
    );

    await postSlackMessage(
      event.channel,
      "処理中にエラーが発生しました。"
    );
  }
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

    // Slack Request URL検証
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

    // Slackイベント
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
// 動作確認用
// ========================================

export async function GET() {
  return Response.json({
    ok: true,
    status:
      "ALL Manager AI is running",
    mode:
      "natural-language-task-create",
  });
}