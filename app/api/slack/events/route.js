import crypto from "crypto";
import { after } from "next/server";

export const runtime = "nodejs";

const ALL_TASKS_LIST_ID = "F0BT8TP1U5S";

// ========================================
// 入力チャンネル
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
// 日本時間
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
// チャンネル名取得
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
// OpenAI出力取得
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

現在の日付は日本時間で
${today}
です。

現在のSlackチャンネルは
#${channelName}
です。

固定Areaは
${fixedArea || "なし"}
です。

ユーザーの自然文を次の4種類に分類してください。

--------------------------------
task_create
--------------------------------

新しいタスクを登録する内容。

例:
「A社へ連絡する」
「9/12以降にA社へ連絡。期限9/15、15分、P1」

--------------------------------
task_complete
--------------------------------

既存タスクを完了したという内容。

例:
「A社へ連絡、完了」
「A社への連絡終わった」
「資料作成できた」
「○○をDoneにして」

この場合、
task_nameには
ALL TASKSから探すための
タスク名だけを入れてください。

例:

入力:
「A社へ連絡、完了」

task_name:
「A社へ連絡」

--------------------------------
conversation
--------------------------------

質問、相談、雑談、確認など。

例:
「今日何したらいい？」
「ありがとう」
「これ動いてる？」

--------------------------------
clarification
--------------------------------

何を完了したのか、
何を登録したいのかが
判断できない場合。

勝手に推測しないでください。

--------------------------------
Area
--------------------------------

固定Areaがある場合は
必ず固定Areaを使用してください。

候補:

本業
副業
Training
Study
Life

#90-inboxだけは
内容から判断してください。

--------------------------------
Project
--------------------------------

分かる場合だけ設定。

このALL Manager AIや
Slack管理システムの開発なら

副業管理ツール

としてください。

不明なら空文字。

--------------------------------
Status
--------------------------------

新規タスクは基本Ready。

今日やることが明確ならToday。

--------------------------------
Priority
--------------------------------

P1 = 最優先
P2 = 高め
P3 = 通常
P4 = 低め

指定なしならP3。

--------------------------------
Start
--------------------------------

開始日をYYYY-MM-DD。

指定なしなら
${today}

--------------------------------
Due
--------------------------------

期限がある場合だけ
YYYY-MM-DD。

なければ空文字。

--------------------------------
Estimate
--------------------------------

15
30
45
60
90
120

から選択。

指定なしなら現実的に推定。
不明なら30。

--------------------------------
reply
--------------------------------

conversation または
clarification の返答。

task_create / task_completeなら
空文字で構いません。
`,

          input: userText,

          max_output_tokens: 400,

          text: {
            format: {
              type: "json_schema",

              name:
                "all_manager_intent",

              strict: true,

              schema: {
                type: "object",

                properties: {
                  intent: {
                    type: "string",

                    enum: [
                      "task_create",
                      "task_complete",
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
// ALL TASKS取得
// ========================================

async function getAllTasksData() {
  let cursor = null;

  let allItems = [];

  let list = null;

  do {
    const requestBody = {
      list_id:
        ALL_TASKS_LIST_ID,

      limit: 100,

      include_list:
        list === null,
    };

    if (cursor) {
      requestBody.cursor =
        cursor;
    }

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

          body:
            JSON.stringify(
              requestBody
            ),
        }
      );

    const data =
      await response.json();

    if (!data.ok) {
      console.error(
        "List read error:",
        data
      );

      throw new Error(
        `List read error: ${data.error}`
      );
    }

    if (!list && data.list) {
      list = data.list;
    }

    allItems =
      allItems.concat(
        data.items ?? []
      );

    cursor =
      data.response_metadata
        ?.next_cursor ||
      null;
  } while (cursor);

  return {
    schema:
      list
        ?.list_metadata
        ?.schema ??
      [],

    items:
      allItems,
  };
}

// ========================================
// 列検索
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
// Rich Text
// ========================================

function makeRichTextField(
  columnId,
  text
) {
  return {
    column_id:
      columnId,

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
// タスク名取得
// ========================================

function getItemTaskName(
  item,
  nameColumnId
) {
  const field =
    (item.fields ?? [])
      .find(
        (field) =>
          field.column_id ===
          nameColumnId
      );

  if (!field) {
    return "";
  }

  if (field.text) {
    return field.text.trim();
  }

  if (
    typeof field.value ===
    "string"
  ) {
    return field.value.trim();
  }

  return "";
}

// ========================================
// タスク名比較用
// ========================================

function normalizeTaskName(
  text
) {
  return String(text ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(
      /[\s　。、,.!！?？「」『』（）()・\-ー]/g,
      ""
    )
    .replace(
      /(しました|します|しておく|する|終わった|完了した|完了)$/g,
      ""
    );
}

// ========================================
// 対象タスク検索
// ========================================

function findMatchingTask(
  items,
  nameColumnId,
  requestedName
) {
  const requested =
    normalizeTaskName(
      requestedName
    );

  const taskRows =
    items
      .map(
        (item) => ({
          item,
          name:
            getItemTaskName(
              item,
              nameColumnId
            ),
        })
      )
      .filter(
        (row) =>
          row.name
      );

  // 完全一致
  const exact =
    taskRows.filter(
      (row) =>
        normalizeTaskName(
          row.name
        ) === requested
    );

  if (
    exact.length === 1
  ) {
    return {
      type: "found",
      row: exact[0],
    };
  }

  if (
    exact.length > 1
  ) {
    return {
      type: "multiple",
      rows: exact,
    };
  }

  // 部分一致
  const partial =
    taskRows.filter(
      (row) => {
        const normalized =
          normalizeTaskName(
            row.name
          );

        return (
          normalized.includes(
            requested
          ) ||
          requested.includes(
            normalized
          )
        );
      }
    );

  if (
    partial.length === 1
  ) {
    return {
      type: "found",
      row: partial[0],
    };
  }

  if (
    partial.length > 1
  ) {
    return {
      type: "multiple",
      rows: partial,
    };
  }

  return {
    type: "not_found",
  };
}

// ========================================
// 新規タスク登録
// ========================================

async function createTaskInSlackList(
  task,
  slackUserId,
  originalText
) {
  const {
    schema,
  } =
    await getAllTasksData();

  const nameColumn =
    findColumnByKey(
      schema,
      "name"
    ) ||
    findColumnByNames(
      schema,
      ["名前", "Name"]
    );

  const assigneeColumn =
    findColumnByKey(
      schema,
      "todo_assignee"
    );

  const dueColumn =
    findColumnByKey(
      schema,
      "todo_due_date"
    );

  const areaColumn =
    findColumnByNames(
      schema,
      ["Area"]
    );

  const projectColumn =
    findColumnByNames(
      schema,
      ["Project"]
    );

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

  const startColumn =
    findColumnByNames(
      schema,
      ["Start"]
    );

  const estimateColumn =
    findColumnByNames(
      schema,
      ["Estimate"]
    );

  const lastUpdateColumn =
    findColumnByNames(
      schema,
      [
        "Last Update",
        "最終更新",
      ]
    );

  const notesColumn =
    findColumnByNames(
      schema,
      [
        "Notes",
        "メモ",
      ]
    );

  if (!nameColumn) {
    throw new Error(
      "名前列が見つかりません"
    );
  }

  const fields = [];

  fields.push(
    makeRichTextField(
      nameColumn.id,
      task.task_name
    )
  );

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

  if (
    estimateColumn &&
    task.estimate_minutes
  ) {
    const option =
      findSelectOption(
        estimateColumn,
        `${task.estimate_minutes}分`
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

  if (lastUpdateColumn) {
    fields.push({
      column_id:
        lastUpdateColumn.id,

      date: [
        getTodayJST(),
      ],
    });
  }

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

        body:
          JSON.stringify({
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
      "List create error:",
      data
    );

    throw new Error(
      `List create error: ${data.error}`
    );
  }

  return data.item;
}

// ========================================
// タスク完了
// ========================================

async function completeTask(
  requestedTaskName
) {
  const {
    schema,
    items,
  } =
    await getAllTasksData();

  const nameColumn =
    findColumnByKey(
      schema,
      "name"
    ) ||
    findColumnByNames(
      schema,
      ["名前", "Name"]
    );

  const completedColumn =
    findColumnByKey(
      schema,
      "todo_completed"
    );

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

  const lastUpdateColumn =
    findColumnByNames(
      schema,
      [
        "Last Update",
        "最終更新",
      ]
    );

  if (!nameColumn) {
    throw new Error(
      "名前列が見つかりません"
    );
  }

  const match =
    findMatchingTask(
      items,
      nameColumn.id,
      requestedTaskName
    );

  if (
    match.type ===
    "not_found"
  ) {
    return {
      status:
        "not_found",
    };
  }

  if (
    match.type ===
    "multiple"
  ) {
    return {
      status:
        "multiple",

      names:
        match.rows
          .slice(0, 5)
          .map(
            (row) =>
              row.name
          ),
    };
  }

  const rowId =
    match.row.item.id;

  const cells = [];

  // Slack標準の完了チェック
  if (completedColumn) {
    cells.push({
      row_id:
        rowId,

      column_id:
        completedColumn.id,

      checkbox:
        true,
    });
  }

  // StatusをDoneに
  if (statusColumn) {
    const doneOption =
      findSelectOption(
        statusColumn,
        "Done"
      );

    if (doneOption) {
      cells.push({
        row_id:
          rowId,

        column_id:
          statusColumn.id,

        select: [
          doneOption,
        ],
      });
    }
  }

  // 最終更新を今日に
  if (lastUpdateColumn) {
    cells.push({
      row_id:
        rowId,

      column_id:
        lastUpdateColumn.id,

      date: [
        getTodayJST(),
      ],
    });
  }

  if (
    cells.length === 0
  ) {
    throw new Error(
      "更新できる列が見つかりません"
    );
  }

  const response =
    await fetch(
      "https://slack.com/api/slackLists.items.update",
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

            cells,
          }),
      }
    );

  const data =
    await response.json();

  if (!data.ok) {
    console.error(
      "List update error:",
      data
    );

    throw new Error(
      `List update error: ${data.error}`
    );
  }

  return {
    status:
      "completed",

    taskName:
      match.row.name,
  };
}

// ========================================
// Slack返信
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

        body:
          JSON.stringify({
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
  if (
    event.type !==
    "message"
  ) {
    return;
  }

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

  const channelName =
    await getChannelName(
      event.channel
    );

  if (!channelName) {
    return;
  }

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

    // ====================================
    // 普通の会話
    // ====================================

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

    // ====================================
    // 確認が必要
    // ====================================

    if (
      result.intent ===
      "clarification"
    ) {
      await postSlackMessage(
        event.channel,
        result.reply ||
          "もう少し詳しく教えてください。"
      );

      return;
    }

    // ====================================
    // 完了処理
    // ====================================

    if (
      result.intent ===
      "task_complete"
    ) {
      const completeResult =
        await completeTask(
          result.task_name
        );

      if (
        completeResult.status ===
        "not_found"
      ) {
        await postSlackMessage(
          event.channel,
          `⚠️「${result.task_name}」に一致するタスクが見つかりませんでした。`
        );

        return;
      }

      if (
        completeResult.status ===
        "multiple"
      ) {
        const names =
          completeResult.names
            .map(
              (name) =>
                `・${name}`
            )
            .join("\n");

        await postSlackMessage(
          event.channel,
          `候補が複数あります。どれを完了しますか？\n${names}`
        );

        return;
      }

      await postSlackMessage(
        event.channel,
        `✅ 完了にしました\n・${completeResult.taskName}`
      );

      return;
    }

    // ====================================
    // 新規タスク
    // ====================================

    const finalArea =
      fixedArea ||
      result.area;

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
        result.due_date ||
        "",

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
// 動作確認
// ========================================

export async function GET() {
  return Response.json({
    ok: true,
    status:
      "ALL Manager AI is running",
    mode:
      "task-create-and-complete",
    date:
      getTodayJST(),
  });
}