import crypto from "crypto";
import { after } from "next/server";

export const runtime = "nodejs";

const ALL_TASKS_LIST_ID = "F0BT8TP1U5S";

// ========================================
// 入力に使うSlackチャンネル
// ========================================

const CHANNEL_AREA_MAP = {
  "10-main-work": "本業",
  "20-side-business": "副業",
  "30-training": "Training",
  "40-study": "Study",
  "50-life": "Life",
};

const INPUT_CHANNELS = new Set([
  "10-main-work",
  "20-side-business",
  "30-training",
  "40-study",
  "50-life",
  "90-inbox",
]);

// ========================================
// 日本時間の日付
// ========================================

function getTodayJST() {
  const parts = new Intl.DateTimeFormat(
    "en-US",
    {
      timeZone: "Asia/Tokyo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }
  ).formatToParts(new Date());

  const values = {};

  for (const part of parts) {
    values[part.type] = part.value;
  }

  return `${values.year}-${values.month}-${values.day}`;
}

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
// Slackチャンネル名取得
// ========================================

async function getChannelName(
  channelId
) {
  const url =
    new URL(
      "https://slack.com/api/conversations.info"
    );

  url.searchParams.set(
    "channel",
    channelId
  );

  const response =
    await fetch(
      url.toString(),
      {
        method: "GET",

        headers: {
          Authorization:
            `Bearer ${process.env.SLACK_BOT_TOKEN}`,
        },
      }
    );

  const data =
    await response.json();

  if (!data.ok) {
    console.error(
      "conversations.info error:",
      data
    );

    return null;
  }

  return (
    data.channel?.name ??
    null
  );
}

// ========================================
// OpenAIレスポンス取得
// ========================================

function getOpenAIOutputText(
  data
) {
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
        content.type ===
        "output_text"
    )
    .map(
      (content) =>
        content.text
    )
    .join("\n")
    .trim();
}

// ========================================
// 自然文解析
// ========================================

async function analyzeSlackMessage(
  userText,
  channelName,
  fixedArea
) {
  const today =
    getTodayJST();

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

Slack上の自然文を解析してください。

現在の日付は日本時間で
${today}
です。

現在のSlackチャンネルは
#${channelName}
です。

このチャンネルの固定Areaは
${fixedArea || "なし"}
です。

--------------------------------
■ intent
--------------------------------

次の3種類です。

task_create
= 新しいタスクを登録する内容

conversation
= 質問、相談、雑談、確認など

clarification
= タスクらしいが情報が曖昧で、
勝手に登録すべきでない場合

判断に迷った場合は
conversation または clarification
にしてください。

--------------------------------
■ Area
--------------------------------

固定Areaがある場合は、
必ずそのAreaを使ってください。

Area候補:

本業
副業
Training
Study
Life

#90-inbox の場合だけ
文章からAreaを判断してください。

#90-inbox でAreaを
確信できない場合は
clarification にしてください。

--------------------------------
■ Project
--------------------------------

具体的なProjectが分かる場合だけ
設定してください。

例えば、
ALL Manager AI、
Slack管理システム、
副業管理ツールの開発に関する内容なら

副業管理ツール

としてください。

分からない場合は空文字です。

--------------------------------
■ Status
--------------------------------

新規タスクは基本 Ready。

ユーザーが

「今日やる」
「今日中」
「今からやる」
「今日のタスク」

など明確に今日実行する場合は
Today。

--------------------------------
■ Priority
--------------------------------

P1 = 最優先、緊急、絶対に落とせない
P2 = 優先度高め、重要
P3 = 通常
P4 = 低優先度、余裕があれば

明記も推測材料もなければ
P3。

--------------------------------
■ Start
--------------------------------

開始日が明記されていれば
YYYY-MM-DD にしてください。

「明日」
「来週月曜」
なども現在日付を基準に
変換してください。

開始日の指定がなければ
${today}
です。

--------------------------------
■ Due
--------------------------------

期限が明記されている場合だけ
YYYY-MM-DD。

期限がない場合は空文字。

--------------------------------
■ Estimate
--------------------------------

必ず次から選んでください。

15
30
45
60
90
120

明示されていればその値。

明示されていない場合は
作業内容から現実的に推定してください。

判断できなければ30。

--------------------------------
■ task_name
--------------------------------

実際にやる行動を、
短く分かりやすくまとめてください。

--------------------------------
■ reply
--------------------------------

conversation または clarification
の場合にSlackへ返す
短い自然な日本語です。

task_create の場合は
空文字で構いません。
`,

          input: userText,

          max_output_tokens: 400,

          text: {
            format: {
              type: "json_schema",

              name:
                "all_manager_task",

              strict: true,

              schema: {
                type: "object",

                properties: {
                  intent: {
                    type: "string",

                    enum: [
                      "task_create",
                      "conversation",
                      "clarification",
                    ],
                  },

                  task_name: {
                    type: "string",
                  },

                  area: {
                    type: "string",

                    enum: [
                      "",
                      "本業",
                      "副業",
                      "Training",
                      "Study",
                      "Life",
                    ],
                  },

                  project: {
                    type: "string",
                  },

                  status: {
                    type: "string",

                    enum: [
                      "",
                      "Ready",
                      "Today",
                    ],
                  },

                  priority: {
                    type: "string",

                    enum: [
                      "",
                      "P1",
                      "P2",
                      "P3",
                      "P4",
                    ],
                  },

                  start_date: {
                    type: "string",
                  },

                  due_date: {
                    type: "string",
                  },

                  estimate_minutes: {
                    type: "integer",

                    enum: [
                      0,
                      15,
                      30,
                      45,
                      60,
                      90,
                      120,
                    ],
                  },

                  reply: {
                    type: "string",
                  },
                },

                required: [
                  "intent",
                  "task_name",
                  "area",
                  "project",
                  "status",
                  "priority",
                  "start_date",
                  "due_date",
                  "estimate_minutes",
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
    getOpenAIOutputText(
      data
    );

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
// ALL TASKSの列構成取得
// ========================================

async function getAllTasksSchema() {
  const response =
    await fetch(
      "https://slack.com/api/slackLists.items.list",
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

          limit: 1,

          include_list:
            true,
        }),
      }
    );

  const data =
    await response.json();

  if (!data.ok) {
    console.error(
      "List schema error:",
      data
    );

    throw new Error(
      `List schema error: ${data.error}`
    );
  }

  return (
    data.list
      ?.list_metadata
      ?.schema ??
    []
  );
}

// ========================================
// 列検索ヘルパー
// ========================================

function findColumnByKey(
  schema,
  key
) {
  return schema.find(
    (column) =>
      column.key === key
  );
}

function findColumnByNames(
  schema,
  names
) {
  const lowered =
    names.map(
      (name) =>
        name.toLowerCase()
    );

  return schema.find(
    (column) =>
      lowered.includes(
        String(
          column.name ?? ""
        ).toLowerCase()
      )
  );
}

function getChoiceLabels(
  column
) {
  return (
    column?.options
      ?.choices ??
    []
  ).map(
    (choice) =>
      String(
        choice.label ?? ""
      )
  );
}

function findSelectColumn(
  schema,
  requiredLabels
) {
  return schema.find(
    (column) => {
      if (
        column.type !==
        "select"
      ) {
        return false;
      }

      const labels =
        getChoiceLabels(
          column
        ).map(
          (label) =>
            label.toLowerCase()
        );

      return requiredLabels.every(
        (required) =>
          labels.includes(
            required.toLowerCase()
          )
      );
    }
  );
}

function findSelectOption(
  column,
  label
) {
  const choice =
    column
      ?.options
      ?.choices
      ?.find(
        (item) =>
          String(
            item.label ?? ""
          ).toLowerCase() ===
          String(label)
            .toLowerCase()
      );

  return (
    choice?.value ??
    null
  );
}

// ========================================
// Rich Text作成
// ========================================

function makeRichTextField(
  columnId,
  text
) {
  return {
    column_id: columnId,

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
                  String(text),
              },
            ],
          },
        ],
      },
    ],
  };
}

// ========================================
// ALL TASKSに登録
// ========================================

async function createTaskInSlackList(
  task,
  slackUserId,
  originalText
) {
  const schema =
    await getAllTasksSchema();

  // 名前
  const nameColumn =
    findColumnByKey(
      schema,
      "name"
    ) ||
    findColumnByNames(
      schema,
      ["名前", "Name"]
    );

  // 担当者
  const assigneeColumn =
    findColumnByKey(
      schema,
      "todo_assignee"
    );

  // 期限日
  const dueColumn =
    findColumnByKey(
      schema,
      "todo_due_date"
    );

  // Area
  const areaColumn =
    findColumnByNames(
      schema,
      ["Area"]
    );

  // Project
  const projectColumn =
    findColumnByNames(
      schema,
      ["Project"]
    );

  // Status
  const statusColumn =
    findSelectColumn(
      schema,
      [
        "Ready",
        "Today",
        "Doing",
        "Done",
      ]
    );

  // Priority
  const priorityColumn =
    findSelectColumn(
      schema,
      [
        "P1",
        "P2",
        "P3",
        "P4",
      ]
    );

  // Start
  const startColumn =
    findColumnByNames(
      schema,
      ["Start"]
    );

  // Estimate
  const estimateColumn =
    findSelectColumn(
      schema,
      [
        "15分",
        "30分",
        "60分",
      ]
    ) ||
    findColumnByNames(
      schema,
      ["Estimate"]
    );

  // Last Update / 最終更新
  const lastUpdateColumn =
    findColumnByNames(
      schema,
      [
        "Last Update",
        "最終更新",
      ]
    );

  // Notes
  const notesColumn =
    findColumnByNames(
      schema,
      ["Notes", "メモ"]
    );

  if (!nameColumn) {
    throw new Error(
      "名前列が見つかりません"
    );
  }

  const fields = [];

  // 名前
  fields.push(
    makeRichTextField(
      nameColumn.id,
      task.task_name
    )
  );

  // 担当者
  if (
    assigneeColumn &&
    slackUserId
  ) {
    fields.push({
      column_id:
        assigneeColumn.id,

      user: [
        slackUserId,
      ],
    });
  }

  // 期限日
  if (
    dueColumn &&
    task.due_date
  ) {
    fields.push({
      column_id:
        dueColumn.id,

      date: [
        task.due_date,
      ],
    });
  }

  // Area
  if (
    areaColumn &&
    task.area
  ) {
    fields.push(
      makeRichTextField(
        areaColumn.id,
        task.area
      )
    );
  }

  // Project
  if (
    projectColumn &&
    task.project
  ) {
    fields.push(
      makeRichTextField(
        projectColumn.id,
        task.project
      )
    );
  }

  // Status
  if (
    statusColumn &&
    task.status
  ) {
    const option =
      findSelectOption(
        statusColumn,
        task.status
      );

    if (option) {
      fields.push({
        column_id:
          statusColumn.id,

        select: [
          option,
        ],
      });
    }
  }

  // Priority
  if (
    priorityColumn &&
    task.priority
  ) {
    const option =
      findSelectOption(
        priorityColumn,
        task.priority
      );

    if (option) {
      fields.push({
        column_id:
          priorityColumn.id,

        select: [
          option,
        ],
      });
    }
  }

  // Start
  if (
    startColumn &&
    task.start_date
  ) {
    fields.push({
      column_id:
        startColumn.id,

      date: [
        task.start_date,
      ],
    });
  }

  // Estimate
  if (
    estimateColumn &&
    task.estimate_minutes
  ) {
    const estimateLabel =
      `${task.estimate_minutes}分`;

    const option =
      findSelectOption(
        estimateColumn,
        estimateLabel
      );

    if (option) {
      fields.push({
        column_id:
          estimateColumn.id,

        select: [
          option,
        ],
      });
    }
  }

  // 最終更新
  if (lastUpdateColumn) {
    fields.push({
      column_id:
        lastUpdateColumn.id,

      date: [
        getTodayJST(),
      ],
    });
  }

  // Notes
  if (
    notesColumn &&
    originalText
  ) {
    fields.push(
      makeRichTextField(
        notesColumn.id,
        originalText
      )
    );
  }

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

          initial_fields:
            fields,
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
      `Slack List create error: ${data.error}`
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
  // 通常メッセージだけ
  if (
    event.type !==
    "message"
  ) {
    return;
  }

  // Bot自身・特殊投稿を無視
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

  // チャンネル名取得
  const channelName =
    await getChannelName(
      event.channel
    );

  if (!channelName) {
    return;
  }

  // 入力用チャンネル以外では
  // AIは反応しない
  if (
    !INPUT_CHANNELS.has(
      channelName
    )
  ) {
    return;
  }

  const fixedArea =
    CHANNEL_AREA_MAP[
      channelName
    ] ?? null;

  try {
    const result =
      await analyzeSlackMessage(
        userText,
        channelName,
        fixedArea
      );

    // 普通の会話
    if (
      result.intent ===
      "conversation"
    ) {
      await postSlackMessage(
        event.channel,
        result.reply ||
          "はい。"
      );

      return;
    }

    // 確認が必要
    if (
      result.intent ===
      "clarification"
    ) {
      await postSlackMessage(
        event.channel,
        result.reply ||
          "どのAreaの内容か教えてください。"
      );

      return;
    }

    // Area決定
    const finalArea =
      fixedArea ||
      result.area;

    // InboxでArea不明なら
    // 勝手に登録しない
    if (!finalArea) {
      await postSlackMessage(
        event.channel,
        "本業・副業・Training・Study・Lifeのどれに入れる内容ですか？"
      );

      return;
    }

    const task = {
      task_name:
        result.task_name,

      area:
        finalArea,

      project:
        result.project || "",

      status:
        result.status ||
        "Ready",

      priority:
        result.priority ||
        "P3",

      start_date:
        result.start_date ||
        getTodayJST(),

      due_date:
        result.due_date || "",

      estimate_minutes:
        result.estimate_minutes ||
        30,
    };

    await createTaskInSlackList(
      task,
      event.user,
      userText
    );

    let confirmation =
      `✅ ALL TASKSに登録しました\n` +
      `・${task.task_name}\n` +
      `・${task.area}`;

    if (task.project) {
      confirmation +=
        ` / ${task.project}`;
    }

    confirmation +=
      `\n・${task.status}` +
      ` / ${task.priority}` +
      ` / ${task.estimate_minutes}分`;

    confirmation +=
      `\n・Start: ${task.start_date}`;

    if (task.due_date) {
      confirmation +=
        ` / 期限: ${task.due_date}`;
    }

    await postSlackMessage(
      event.channel,
      confirmation
    );
  } catch (error) {
    console.error(
      "Message processing error:",
      error
    );

    await postSlackMessage(
      event.channel,
      "処理中にエラーが発生しました。Vercelのログを確認してください。"
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

    // Slack URL検証
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
// ブラウザ動作確認
// ========================================

export async function GET() {
  return Response.json({
    ok: true,
    status:
      "ALL Manager AI is running",
    mode:
      "full-task-create",
    date:
      getTodayJST(),
  });
}