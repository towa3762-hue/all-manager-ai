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
// 直近のSlack会話履歴取得
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
    "12"
  );

  const response =
    await fetch(
      url.toString(),
      {
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
      "conversations.history error:",
      data
    );

    return [];
  }

  return (
    data.messages ?? []
  )
    .filter(
      (message) => {
        if (!message.text) {
          return false;
        }

        if (message.bot_id) {
          return true;
        }

        return (
          message.user ===
          currentUserId
        );
      }
    )
    .reverse()
    .map(
      (message) => ({
        role:
          message.bot_id
            ? "ALL Manager AI"
            : "ユーザー",

        text:
          message.text.trim(),
      })
    );
}

function historyToText(
  history
) {
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
// OpenAI
// ========================================

function getOpenAIOutputText(
  data
) {
  return (
    data.output ?? []
  )
    .filter(
      (item) =>
        item.type ===
        "message"
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

async function analyzeSlackMessage(
  userText,
  channelName,
  fixedArea,
  history
) {
  const today =
    getTodayJST();

  const recentHistory =
    historyToText(
      history
    );

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

Slackの同じチャンネルで続いている会話として理解してください。

現在の日付:
${today}

現在のチャンネル:
#${channelName}

固定Area:
${fixedArea || "なし"}

直近の会話履歴:
${recentHistory}

重要:
・今回のメッセージだけを単独で解釈せず、必要なら直近の履歴を使う
・新しいタスクを勝手に作らない
・曖昧なら clarification にする

intent は次の5種類です。

--------------------------------
task_create
--------------------------------

新しいタスクを登録する。

--------------------------------
task_complete
--------------------------------

既存タスクを完了する。

例:
「A社へ連絡、完了」
「資料作成終わった」

task_nameには
検索するタスク名を入れる。

selection_indexは0。

--------------------------------
task_complete_selection
--------------------------------

直前にALL Manager AIが
複数候補を番号付きで提示しており、
今回のメッセージが
その候補を選んでいる場合。

例:

「1番」
「一番上」
「2つ目」
「期限9/15のやつ」
「P1のやつ」

会話履歴から該当候補を判断し、
selection_index に候補番号を入れる。

番号は1から始まる。

task_nameには、
直前に完了しようとしていた
元のタスク名を入れる。

どれか特定できなければ
clarification。

--------------------------------
conversation
--------------------------------

質問、相談、雑談、確認など。

過去の話の続きなら、
履歴を踏まえてreplyを返す。

--------------------------------
clarification
--------------------------------

何を意味しているか
安全に特定できない場合。

--------------------------------
Area
--------------------------------

本業
副業
Training
Study
Life

固定Areaがある場合は
必ず固定Area。

#90-inboxの場合だけ
内容から判断する。

分からなければ
clarification。

--------------------------------
Project
--------------------------------

分かる場合だけ設定。

ALL Manager AIや
Slack管理システムの開発は

副業管理ツール

とする。

不明なら空文字。

--------------------------------
新規タスク
--------------------------------

Status:
基本Ready。
今日やるならToday。

Priority:
P1 = 最優先
P2 = 高め
P3 = 通常
P4 = 低め

指定なしならP3。

Start:
YYYY-MM-DD。
指定なしなら${today}。

Due:
期限がある場合だけ
YYYY-MM-DD。

Estimate:
15
30
45
60
90
120

指定なしなら推定。
不明なら30。

reply:
conversation / clarification
のときの短い返答。
`,

          input:
            userText,

          max_output_tokens:
            450,

          text: {
            format: {
              type:
                "json_schema",

              name:
                "all_manager_intent",

              strict:
                true,

              schema: {
                type:
                  "object",

                properties: {
                  intent: {
                    type:
                      "string",

                    enum: [
                      "task_create",
                      "task_complete",
                      "task_complete_selection",
                      "conversation",
                      "clarification",
                    ],
                  },

                  task_name: {
                    type:
                      "string",
                  },

                  selection_index: {
                    type:
                      "integer",

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
                    type:
                      "string",

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
                    type:
                      "string",
                  },

                  status: {
                    type:
                      "string",

                    enum: [
                      "",
                      "Ready",
                      "Today",
                    ],
                  },

                  priority: {
                    type:
                      "string",

                    enum: [
                      "",
                      "P1",
                      "P2",
                      "P3",
                      "P4",
                    ],
                  },

                  start_date: {
                    type:
                      "string",
                  },

                  due_date: {
                    type:
                      "string",
                  },

                  estimate_minutes: {
                    type:
                      "integer",

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
                    type:
                      "string",
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

      limit:
        100,

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

    if (
      !list &&
      data.list
    ) {
      list =
        data.list;
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

function normalizeTaskName(
  text
) {
  return String(
    text ?? ""
  )
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

function sortTaskRows(
  rows
) {
  return [
    ...rows,
  ].sort(
    (a, b) => {
      const dateDiff =
        Number(
          b.item
            .date_created ??
            0
        ) -
        Number(
          a.item
            .date_created ??
            0
        );

      if (
        dateDiff !== 0
      ) {
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

  if (
    exact.length
  ) {
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

      month:
        "numeric",

      day:
        "numeric",

      hour:
        "2-digit",

      minute:
        "2-digit",
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
      row.item
        .date_created
    );

  const details = [];

  if (status) {
    details.push(
      status
    );
  }

  if (priority) {
    details.push(
      priority
    );
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
    details.push(
      estimate
    );
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
      [
        "名前",
        "Name",
      ]
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

  if (
    lastUpdateColumn
  ) {
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
  requestedTaskName,
  selectionIndex = 0
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
      [
        "名前",
        "Name",
      ]
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

  const matches =
    findMatchingTaskRows(
      items,
      nameColumn.id,
      requestedTaskName
    );

  if (!matches.length) {
    return {
      status:
        "not_found",
    };
  }

  if (
    matches.length > 1 &&
    selectionIndex === 0
  ) {
    return {
      status:
        "multiple",

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

  let selectedRow;

  if (
    selectionIndex > 0
  ) {
    selectedRow =
      matches[
        selectionIndex - 1
      ];

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
  } else {
    selectedRow =
      matches[0];
  }

  const rowId =
    selectedRow.item.id;

  const cells = [];

  if (
    completedColumn
  ) {
    cells.push({
      row_id:
        rowId,

      column_id:
        completedColumn.id,

      checkbox: [
        true,
      ],
    });
  }

  if (
    statusColumn
  ) {
    const doneOption =
      findSelectOption(
        statusColumn,
        "Done"
      );

    if (
      doneOption
    ) {
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

  if (
    lastUpdateColumn
  ) {
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

  if (!cells.length) {
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
      selectedRow.name,
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
// 完了結果返信
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
      )}\n\n「1番」「期限9/15のやつ」のように返してください。`
    );

    return;
  }

  await postSlackMessage(
    channel,
    `✅ 完了にしました\n・${result.taskName}`
  );
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

    if (
      task.project
    ) {
      confirmation +=
        ` / ${task.project}`;
    }

    confirmation +=
      `\n・${task.status} / ${task.priority} / ${task.estimate_minutes}分`;

    confirmation +=
      `\n・Start: ${task.start_date}`;

    if (
      task.due_date
    ) {
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
      JSON.parse(
        rawBody
      );

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
      after(
        async () => {
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
        }
      );
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
      "conversation-memory-and-task-selection",

    date:
      getTodayJST(),
  });
}