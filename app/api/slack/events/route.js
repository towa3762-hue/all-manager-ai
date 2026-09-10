import crypto from "crypto";
import { after } from "next/server";

export const runtime = "nodejs";

const ALL_TASKS_LIST_ID = "F0BT8TP1U5S";

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
// 日付
// ========================================

function getTodayJST() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());

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

  if (!secret || !timestamp || !signature) {
    return false;
  }

  const now =
    Math.floor(Date.now() / 1000);

  if (
    Math.abs(now - Number(timestamp)) >
    60 * 5
  ) {
    return false;
  }

  const baseString =
    `v0:${timestamp}:${rawBody}`;

  const expectedSignature =
    "v0=" +
    crypto
      .createHmac("sha256", secret)
      .update(baseString, "utf8")
      .digest("hex");

  const a =
    Buffer.from(expectedSignature);

  const b =
    Buffer.from(signature);

  if (a.length !== b.length) {
    return false;
  }

  return crypto.timingSafeEqual(a, b);
}

// ========================================
// チャンネル名取得
// ========================================

async function getChannelName(channelId) {
  const url =
    new URL(
      "https://slack.com/api/conversations.info"
    );

  url.searchParams.set(
    "channel",
    channelId
  );

  const response =
    await fetch(url.toString(), {
      headers: {
        Authorization:
          `Bearer ${process.env.SLACK_BOT_TOKEN}`,
      },
    });

  const data =
    await response.json();

  if (!data.ok) {
    console.error(
      "conversations.info error:",
      data
    );

    return null;
  }

  return data.channel?.name ?? null;
}

// ========================================
// 直近の会話履歴
// ========================================

async function getRecentConversationHistory(
  channelId,
  beforeTs,
  currentUserId
) {
  const url =
    new URL(
      "https://slack.com/api/conversations.history"
    );

  url.searchParams.set(
    "channel",
    channelId
  );

  url.searchParams.set(
    "latest",
    beforeTs
  );

  url.searchParams.set(
    "inclusive",
    "false"
  );

  url.searchParams.set(
    "limit",
    "20"
  );

  const response =
    await fetch(url.toString(), {
      headers: {
        Authorization:
          `Bearer ${process.env.SLACK_BOT_TOKEN}`,
      },
    });

  const data =
    await response.json();

  if (!data.ok) {
    console.error(
      "conversations.history error:",
      data
    );

    return [];
  }

  return (data.messages ?? [])
    .filter((message) => {
      if (!message.text) {
        return false;
      }

      if (message.bot_id) {
        return true;
      }

      return (
        message.user === currentUserId
      );
    })
    .reverse()
    .map((message) => ({
      role:
        message.bot_id
          ? "ALL Manager AI"
          : "ユーザー",

      text:
        message.text.trim(),
    }));
}

function historyToText(history) {
  if (!history.length) {
    return "（履歴なし）";
  }

  return history
    .map(
      (message) =>
        `[${message.role}] ${message.text}`
    )
    .join("\n");
}

// ========================================
// OpenAI出力
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
// 自然文解析
// ========================================

async function analyzeSlackMessage(
  userText,
  channelName,
  fixedArea,
  history
) {
  const today =
    getTodayJST();

  const recentHistory =
    historyToText(history);

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
          model: "gpt-5.6-luna",

          store: false,

          instructions: `
あなたは「ALL Manager AI」です。

Slack上でユーザーのタスクを管理します。

現在の日付:
${today}

現在のチャンネル:
#${channelName}

固定Area:
${fixedArea || "なし"}

直近の会話:
${recentHistory}

今回のユーザーメッセージと
直近の会話を合わせて判断してください。

--------------------------------
intent
--------------------------------

次の7種類です。

task_create
新しいタスクを作る。

task_complete
既存タスクを完了する。

task_complete_selection
完了候補を提示した後に
「1番」「P1のやつ」などで
候補を選択した。

task_postpone
既存タスクの開始日を延期・変更する。

例:
「A社へ連絡を明日に延期」
「資料作成を9/20に移動」
「A社のタスクを来週月曜日にして」

task_postpone_selection
延期対象の候補を提示した後に
「1番」
「期限9/15のやつ」
「P1のやつ」
などで候補を選択した。

conversation
質問、相談、雑談。

clarification
安全に判断できないため
ユーザーへの確認が必要。

--------------------------------
task_postpone
--------------------------------

task_name:
対象タスクの名前。

new_start_date:
変更後のStartを
YYYY-MM-DDで返す。

「明日」
「来週月曜」
などは
${today}
を基準に正確な日付へ変換する。

「来週」
「そのうち」
など日付を1日に特定できない場合は
勝手に決めずclarification。

new_due_date:
ユーザーが期限そのものも
変更すると明示した場合だけ設定。

例:

「A社を明日に延期」
→ new_start_date = 明日
→ new_due_date = ""

「A社を明日に延期、期限も9/20にして」
→ new_start_date = 明日
→ new_due_date = 9/20

重要:
単なる延期では期限を勝手に変更しない。

--------------------------------
task_postpone_selection
--------------------------------

直前の会話で延期対象の候補が
番号付きで表示されている場合に使う。

例:

ユーザー:
A社へ連絡を明日に延期

AI:
候補が3件あります...

ユーザー:
1番

この場合:

intent =
task_postpone_selection

selection_index =
1

task_name =
直前に延期しようとしていたタスク名

new_start_date =
直前の依頼で指定された変更後の日付

new_due_date =
直前の依頼で期限変更も明示されていた場合のみ設定

「期限9/15のやつ」
という候補選択は、
既存タスクを特定するための表現であり、
新しい期限指定ではありません。

--------------------------------
task_complete_selection
--------------------------------

直前に完了候補が表示されており、

「1番」
「2番」
「P1のやつ」

などで候補を選んだ場合。

selection_indexには
候補番号を入れる。

--------------------------------
Area
--------------------------------

候補:

本業
副業
Training
Study
Life

固定Areaがあるチャンネルでは
必ず固定Areaを使用。

#90-inboxだけ内容から判断。

判断できなければclarification。

--------------------------------
Project
--------------------------------

分かる場合だけ設定。

ALL Manager AIや
Slack管理システム、
この管理ツール開発なら

副業管理ツール

とする。

不明なら空文字。

--------------------------------
新規タスク
--------------------------------

Status:

通常 = Ready
今日実行 = Today

Priority:

P1 = 最優先
P2 = 高め
P3 = 通常
P4 = 低め

指定なし = P3

Start:

YYYY-MM-DD
指定なし = ${today}

Due:

期限がある場合だけ
YYYY-MM-DD

Estimate:

15
30
45
60
90
120

から選択。

指定なしなら推定。
不明なら30。

--------------------------------
重要
--------------------------------

・勝手に新規タスクを作らない
・勝手に期限を変更しない
・文脈が必要なら会話履歴を見る
・特定できない場合はclarification
・selectionでは直前の操作内容も引き継ぐ
`,

          input: userText,

          max_output_tokens: 500,

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
                      "task_complete_selection",
                      "task_postpone",
                      "task_postpone_selection",
                      "conversation",
                      "clarification",
                    ],
                  },

                  task_name: {
                    type: "string",
                  },

                  selection_index: {
                    type: "integer",

                    enum: [
                      0,
                      1,
                      2,
                      3,
                      4,
                      5,
                      6,
                      7,
                      8,
                    ],
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

                  new_start_date: {
                    type: "string",
                  },

                  new_due_date: {
                    type: "string",
                  },

                  reply: {
                    type: "string",
                  },
                },

                required: [
                  "intent",
                  "task_name",
                  "selection_index",
                  "area",
                  "project",
                  "status",
                  "priority",
                  "start_date",
                  "due_date",
                  "estimate_minutes",
                  "new_start_date",
                  "new_due_date",
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

  return JSON.parse(outputText);
}

// ========================================
// ALL TASKS取得
// ========================================

async function getAllTasksData() {
  let cursor = null;
  let items = [];
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

    items =
      items.concat(
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

    items,
  };
}

// ========================================
// 列ヘルパー
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
    column
      ?.options
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
        getChoiceLabels(column)
          .map(
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
  return (
    column
      ?.options
      ?.choices
      ?.find(
        (item) =>
          String(
            item.label ?? ""
          ).toLowerCase() ===
          String(
            label
          ).toLowerCase()
      )
      ?.value ??
    null
  );
}

function makeRichTextField(
  columnId,
  text
) {
  return {
    column_id: columnId,

    rich_text: [
      {
        type: "rich_text",

        elements: [
          {
            type:
              "rich_text_section",

            elements: [
              {
                type: "text",
                text: String(text),
              },
            ],
          },
        ],
      },
    ],
  };
}

function getItemField(
  item,
  columnId
) {
  return (
    item.fields ?? []
  ).find(
    (field) =>
      field.column_id ===
      columnId
  );
}

function getItemTaskName(
  item,
  nameColumnId
) {
  const field =
    getItemField(
      item,
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

function getItemDate(
  item,
  column
) {
  if (!column) {
    return "";
  }

  const field =
    getItemField(
      item,
      column.id
    );

  return (
    field?.date?.[0] ??
    ""
  );
}

function getItemSelectLabel(
  item,
  column
) {
  if (!column) {
    return "";
  }

  const field =
    getItemField(
      item,
      column.id
    );

  const optionId =
    field?.select?.[0];

  if (!optionId) {
    return "";
  }

  return (
    column
      .options
      ?.choices
      ?.find(
        (choice) =>
          choice.value ===
          optionId
      )
      ?.label ??
    ""
  );
}

// ========================================
// タスク検索
// ========================================

function normalizeTaskName(text) {
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

function sortTaskRows(rows) {
  return [...rows].sort(
    (a, b) => {
      const dateDiff =
        Number(
          b.item.date_created ?? 0
        ) -
        Number(
          a.item.date_created ?? 0
        );

      if (dateDiff !== 0) {
        return dateDiff;
      }

      return String(
        a.item.id
      ).localeCompare(
        String(
          b.item.id
        )
      );
    }
  );
}

function findMatchingTaskRows(
  items,
  nameColumnId,
  requestedName
) {
  const requested =
    normalizeTaskName(
      requestedName
    );

  const rows =
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

  const exact =
    rows.filter(
      (row) =>
        normalizeTaskName(
          row.name
        ) === requested
    );

  if (exact.length) {
    return sortTaskRows(
      exact
    );
  }

  const partial =
    rows.filter(
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

  return sortTaskRows(
    partial
  );
}

// ========================================
// 候補表示
// ========================================

function formatCreatedAtJST(
  unixSeconds
) {
  if (!unixSeconds) {
    return "";
  }

  return new Intl.DateTimeFormat(
    "ja-JP",
    {
      timeZone:
        "Asia/Tokyo",

      month: "numeric",
      day: "numeric",

      hour: "2-digit",
      minute: "2-digit",
    }
  ).format(
    new Date(
      Number(
        unixSeconds
      ) * 1000
    )
  );
}

function buildCandidateLine(
  row,
  schema,
  index
) {
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

  const dueColumn =
    findColumnByKey(
      schema,
      "todo_due_date"
    );

  const estimateColumn =
    findColumnByNames(
      schema,
      ["Estimate"]
    );

  const status =
    getItemSelectLabel(
      row.item,
      statusColumn
    );

  const priority =
    getItemSelectLabel(
      row.item,
      priorityColumn
    );

  const start =
    getItemDate(
      row.item,
      startColumn
    );

  const due =
    getItemDate(
      row.item,
      dueColumn
    );

  const estimate =
    getItemSelectLabel(
      row.item,
      estimateColumn
    );

  const created =
    formatCreatedAtJST(
      row.item.date_created
    );

  const details = [];

  if (status) {
    details.push(status);
  }

  if (priority) {
    details.push(priority);
  }

  if (start) {
    details.push(
      `Start ${start}`
    );
  }

  if (due) {
    details.push(
      `期限 ${due}`
    );
  }

  if (estimate) {
    details.push(estimate);
  }

  if (created) {
    details.push(
      `登録 ${created}`
    );
  }

  return (
    `${index}. ${row.name}` +
    (
      details.length
        ? ` ｜ ${details.join(" ｜ ")}`
        : ""
    )
  );
}

// ========================================
// 新規タスク登録
// ========================================

async function createTaskInSlackList(
  task,
  slackUserId,
  originalText
) {
  const { schema } =
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
      ["Notes", "メモ"]
    );

  if (!nameColumn) {
    throw new Error(
      "名前列が見つかりません"
    );
  }

  const fields = [
    makeRichTextField(
      nameColumn.id,
      task.task_name
    ),
  ];

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
// 共通: タスク候補取得
// ========================================

async function getTaskMatches(
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

  if (!nameColumn) {
    throw new Error(
      "名前列が見つかりません"
    );
  }

  const matches =
    findMatchingTaskRows(
      items,
      nameColumn.id,
      requestedTaskName
    );

  return {
    schema,
    matches,
  };
}

// ========================================
// 完了処理
// ========================================

async function completeTask(
  requestedTaskName,
  selectionIndex = 0
) {
  const {
    schema,
    matches,
  } =
    await getTaskMatches(
      requestedTaskName
    );

  if (!matches.length) {
    return {
      status: "not_found",
    };
  }

  if (
    matches.length > 1 &&
    selectionIndex === 0
  ) {
    return {
      status: "multiple",

      candidates:
        matches
          .slice(0, 8)
          .map(
            (row, index) =>
              buildCandidateLine(
                row,
                schema,
                index + 1
              )
          ),
    };
  }

  const selectedRow =
    selectionIndex > 0
      ? matches[
          selectionIndex - 1
        ]
      : matches[0];

  if (!selectedRow) {
    return {
      status:
        "invalid_selection",

      count:
        Math.min(
          matches.length,
          8
        ),
    };
  }

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

  const cells = [];

  if (completedColumn) {
    cells.push({
      row_id:
        selectedRow.item.id,

      column_id:
        completedColumn.id,

      checkbox: true,
    });
  }

  if (statusColumn) {
    const doneOption =
      findSelectOption(
        statusColumn,
        "Done"
      );

    if (doneOption) {
      cells.push({
        row_id:
          selectedRow.item.id,

        column_id:
          statusColumn.id,

        select: [
          doneOption,
        ],
      });
    }
  }

  if (lastUpdateColumn) {
    cells.push({
      row_id:
        selectedRow.item.id,

      column_id:
        lastUpdateColumn.id,

      date: [
        getTodayJST(),
      ],
    });
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

        body: JSON.stringify({
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
      "Complete task error:",
      data
    );

    throw new Error(
      `Complete error: ${data.error}`
    );
  }

  return {
    status: "completed",
    taskName: selectedRow.name,
  };
}

// ========================================
// 延期処理
// ========================================

async function postponeTask(
  requestedTaskName,
  selectionIndex,
  newStartDate,
  newDueDate
) {
  if (!newStartDate) {
    return {
      status: "date_required",
    };
  }

  const {
    schema,
    matches,
  } =
    await getTaskMatches(
      requestedTaskName
    );

  if (!matches.length) {
    return {
      status: "not_found",
    };
  }

  if (
    matches.length > 1 &&
    selectionIndex === 0
  ) {
    return {
      status: "multiple",

      candidates:
        matches
          .slice(0, 8)
          .map(
            (row, index) =>
              buildCandidateLine(
                row,
                schema,
                index + 1
              )
          ),
    };
  }

  const selectedRow =
    selectionIndex > 0
      ? matches[
          selectionIndex - 1
        ]
      : matches[0];

  if (!selectedRow) {
    return {
      status:
        "invalid_selection",

      count:
        Math.min(
          matches.length,
          8
        ),
    };
  }

  const startColumn =
    findColumnByNames(
      schema,
      ["Start"]
    );

  const dueColumn =
    findColumnByKey(
      schema,
      "todo_due_date"
    );

  const lastUpdateColumn =
    findColumnByNames(
      schema,
      [
        "Last Update",
        "最終更新",
      ]
    );

  if (!startColumn) {
    throw new Error(
      "Start列が見つかりません"
    );
  }

  const cells = [
    {
      row_id:
        selectedRow.item.id,

      column_id:
        startColumn.id,

      date: [
        newStartDate,
      ],
    },
  ];

  // 期限は明示された時だけ変更
  if (
    newDueDate &&
    dueColumn
  ) {
    cells.push({
      row_id:
        selectedRow.item.id,

      column_id:
        dueColumn.id,

      date: [
        newDueDate,
      ],
    });
  }

  if (lastUpdateColumn) {
    cells.push({
      row_id:
        selectedRow.item.id,

      column_id:
        lastUpdateColumn.id,

      date: [
        getTodayJST(),
      ],
    });
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

        body: JSON.stringify({
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
      "Postpone task error:",
      data
    );

    throw new Error(
      `Postpone error: ${data.error}`
    );
  }

  return {
    status: "postponed",

    taskName:
      selectedRow.name,

    startDate:
      newStartDate,

    dueDate:
      newDueDate || "",
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
// 完了結果
// ========================================

async function handleCompletionResult(
  channel,
  result
) {
  if (
    result.status ===
    "not_found"
  ) {
    await postSlackMessage(
      channel,
      "⚠️ 一致するタスクが見つかりませんでした。"
    );

    return;
  }

  if (
    result.status ===
    "invalid_selection"
  ) {
    await postSlackMessage(
      channel,
      `その番号はありません。1〜${result.count}番から選んでください。`
    );

    return;
  }

  if (
    result.status ===
    "multiple"
  ) {
    await postSlackMessage(
      channel,
      `候補が複数あります。どれを完了しますか？\n${result.candidates.join(
        "\n"
      )}\n\n「1番」のように返してください。`
    );

    return;
  }

  await postSlackMessage(
    channel,
    `✅ 完了にしました\n・${result.taskName}`
  );
}

// ========================================
// 延期結果
// ========================================

async function handlePostponeResult(
  channel,
  result
) {
  if (
    result.status ===
    "date_required"
  ) {
    await postSlackMessage(
      channel,
      "いつに延期しますか？"
    );

    return;
  }

  if (
    result.status ===
    "not_found"
  ) {
    await postSlackMessage(
      channel,
      "⚠️ 一致するタスクが見つかりませんでした。"
    );

    return;
  }

  if (
    result.status ===
    "invalid_selection"
  ) {
    await postSlackMessage(
      channel,
      `その番号はありません。1〜${result.count}番から選んでください。`
    );

    return;
  }

  if (
    result.status ===
    "multiple"
  ) {
    await postSlackMessage(
      channel,
      `候補が複数あります。どれを延期しますか？\n${result.candidates.join(
        "\n"
      )}\n\n「1番」のように返してください。`
    );

    return;
  }

  let message =
    `✅ 延期しました\n` +
    `・${result.taskName}\n` +
    `・Start: ${result.startDate}`;

  if (result.dueDate) {
    message +=
      `\n・期限: ${result.dueDate}`;
  }

  await postSlackMessage(
    channel,
    message
  );
}

// ========================================
// Slackメッセージ処理
// ========================================

async function processSlackEvent(
  event
) {
  if (
    event.type !== "message"
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

  if (
    !channelName ||
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
    const history =
      await getRecentConversationHistory(
        event.channel,
        event.ts,
        event.user
      );

    const result =
      await analyzeSlackMessage(
        userText,
        channelName,
        fixedArea,
        history
      );

    // ------------------------------------
    // 普通の会話
    // ------------------------------------

    if (
      result.intent ===
      "conversation"
    ) {
      await postSlackMessage(
        event.channel,
        result.reply || "はい。"
      );

      return;
    }

    // ------------------------------------
    // 確認
    // ------------------------------------

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

    // ------------------------------------
    // 完了
    // ------------------------------------

    if (
      result.intent ===
      "task_complete"
    ) {
      const completeResult =
        await completeTask(
          result.task_name,
          0
        );

      await handleCompletionResult(
        event.channel,
        completeResult
      );

      return;
    }

    // ------------------------------------
    // 完了候補選択
    // ------------------------------------

    if (
      result.intent ===
      "task_complete_selection"
    ) {
      const completeResult =
        await completeTask(
          result.task_name,
          result.selection_index
        );

      await handleCompletionResult(
        event.channel,
        completeResult
      );

      return;
    }

    // ------------------------------------
    // 延期
    // ------------------------------------

    if (
      result.intent ===
      "task_postpone"
    ) {
      const postponeResult =
        await postponeTask(
          result.task_name,
          0,
          result.new_start_date,
          result.new_due_date
        );

      await handlePostponeResult(
        event.channel,
        postponeResult
      );

      return;
    }

    // ------------------------------------
    // 延期候補選択
    // ------------------------------------

    if (
      result.intent ===
      "task_postpone_selection"
    ) {
      const postponeResult =
        await postponeTask(
          result.task_name,
          result.selection_index,
          result.new_start_date,
          result.new_due_date
        );

      await handlePostponeResult(
        event.channel,
        postponeResult
      );

      return;
    }

    // ------------------------------------
    // 新規タスク
    // ------------------------------------

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
      `\n・${task.status} / ${task.priority} / ${task.estimate_minutes}分`;

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
      "create-complete-postpone",

    date:
      getTodayJST(),
  });
}