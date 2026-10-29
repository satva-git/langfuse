// Backstop rubric: the allowlist of JEV decision-model questions the
// low-confidence eval backstop is permitted to re-judge.
//
// Canonical source of truth for option text and instructions is the evaluator's
// `questions` array (type DECISION_MODEL), whose shape is defined by
// `DecisionModelQuestionsSchema` in
// `packages/shared/src/features/evals/decisionModel.ts`. The entries below are a
// local, hand-maintained mirror (options, scoreName and instructions copied
// verbatim from the live evaluator definitions) so the worker can re-ask a
// single question without loading the full evaluator. When an evaluator
// definition changes, update the matching entry here.
//
// Scope rules:
//   * Only TURN-LEVEL questions belong here. The backstop fetches a single
//     "Conversational Turn" observation's input/output, not a whole session, so
//     session-scoped questions (e.g. `session_outcome`, which judges a full
//     `session_transcript`) are deliberately excluded.
//   * NEVER list the effort-hour questionIds here (effort_estimate_hours,
//     effort_saved_hours, effort_saved_hours_num, effort_actual_hours). Those are
//     owned by the dedicated LLM-as-judge evaluator and must not be touched by
//     the backstop.
//
// Note: `scoreName` is NOT always equal to the questionId (e.g.
// `engineering_task_type` -> `jev_engineering_task_type`). The backstop matches a
// candidate score by BOTH its questionId (metadata.typesafe.questionId) and its
// `name` === this `scoreName`, so both must be correct.

export type BackstopRubricEntry = {
  /** The score name produced for this question (JEV `scoreName`). */
  scoreName: string;
  /** Whether the question resolves to a categorical choice or a numeric score. */
  kind: "choice" | "score";
  /** Langfuse score data type written for the rescued score. */
  dataType: "CATEGORICAL" | "NUMERIC";
  /** Allowed option values for a choice question. The LLM answer must be one of these. */
  options?: string[];
  /** Human-readable level descriptions for a score question (index = numeric value). */
  levels?: string[];
  /** The rubric prompt / instructions shown to the judge (verbatim from the evaluator). */
  instructions: string;
};

// Effort-hour questions the backstop must never cover. Kept as an explicit
// guard so a future edit that accidentally adds one is easy to catch.
export const EFFORT_HOUR_QUESTION_IDS = [
  "effort_estimate_hours",
  "effort_saved_hours",
  "effort_saved_hours_num",
  "effort_actual_hours",
] as const;

export const BACKSTOP_RUBRIC: Record<string, BackstopRubricEntry> = {
  rework_reason: {
    scoreName: "rework_reason",
    kind: "choice",
    dataType: "CATEGORICAL",
    options: [
      "Not rework",
      "Misunderstood",
      "Buggy result",
      "Incomplete",
      "Ignored instruction",
      "Changed mind",
    ],
    instructions:
      "If `user_prompt` is correcting or redoing the assistant's previous work, what is the main reason? If it is not rework (including system notifications, task events, slash commands, or new tasks), choose 'Not rework'.",
  },
  task_complexity: {
    scoreName: "task_complexity",
    kind: "choice",
    dataType: "CATEGORICAL",
    options: ["Trivial", "Simple", "Moderate", "Complex"],
    instructions:
      "How hard was the task in `user_request`, judged by what `turn_output` shows it took (files and systems involved, steps, unknowns, risk)? Judge the task, not the quality of the answer.",
  },
  effort_work_item: {
    scoreName: "effort_work_item",
    kind: "choice",
    dataType: "CATEGORICAL",
    options: [
      "Code shipped",
      "Bug fix",
      "Investigation",
      "Document",
      "Analysis",
      "Test",
      "Config / DevOps",
      "Tracker / admin",
      "Answer only",
    ],
    instructions:
      "Identify the main work this turn actually delivered, judging from `turn_output` (use `user_request` only for context). Judge what was delivered, not what was asked: if the user asked for a plan but the turn changed code or configuration, it is a code or config deliverable, not Analysis. Pick the one that best describes the deliverable.",
  },
  sensitive_data_type: {
    scoreName: "sensitive_data_type",
    kind: "choice",
    dataType: "CATEGORICAL",
    options: ["None", "Credential", "Personal data", "Client financial"],
    instructions:
      "Which type of sensitive data appears in clear text in `user_prompt` or `turn_output`? Apply the same rules as for detecting sensitive data: record IDs, tenant/realm/company IDs, usernames, work emails, placeholders, masked values, env var names without values, code that handles financial data, test account emails (if they show test/staging/QA indicators or numbered aliases), system-injected metadata, and any amounts or records from sandbox, test, QA or sample companies are NOT sensitive and mean 'None'. Choose 'None' unless a real secret, real personal data of a non-test individual, or real financial data of a real named client is actually shown.",
  },
  engineering_task_type: {
    scoreName: "jev_engineering_task_type",
    kind: "choice",
    dataType: "CATEGORICAL",
    options: [
      "Implementation",
      "Bug fixing",
      "Code review",
      "Planning",
      "Documentation",
      "Migrations & upgrades",
      "Code quality",
      "CI/CD & DevOps",
      "Unit test generation",
      "Data & automation",
      "Research & exploration",
      "Refactoring",
      "Security",
      "Other",
    ],
    instructions:
      "Which engineering task type best represents the primary requested deliverable in `task_text`? Implementation that includes tests is Implementation unless tests are the main ask. Bug fixing is for an existing defect; Refactoring is structural change without a defect. Planning is a design or proposal without implementation.\n\nIMPORTANT — conversational follow-ups: if `task_text` is purely asking what was already done, asking for an explanation of prior changes, or asking for context (e.g. 'what did you change', 'what is happening', 'tell me what you changed', 'what should happen', 'what have you done', 'explain this', 'describe the fix'), classify as 'Research & exploration' — the request is for explanation, not a new engineering deliverable.\n\nIMPORTANT — knowledge questions: if `task_text` asks how something works, what a code construct means, or what the impact of a change is (e.g. 'what is the use of this', 'what does X do', 'what is the impact'), classify as 'Research & exploration'.",
  },
  missed_opportunity: {
    scoreName: "missed_opportunity",
    kind: "choice",
    dataType: "CATEGORICAL",
    options: [
      "None",
      "Skill",
      "MCP",
      "Plan mode",
      "Subagent",
      "Tests",
      "Context file",
    ],
    instructions:
      "Looking at `user_request` and `turn_output`, was there one Claude Code capability that, if used, would clearly have made this turn faster, safer or better? Choose 'None' when the turn was already done well, was too small to benefit, or the evidence is unclear. Only pick a capability when the turn shows a concrete sign it was missing (e.g. a long manual multi-step change with no plan, repeated copy-pasting of context that a context file would hold, manual work an available MCP does, code changes with no tests on logic that needs them).\n\nIMPORTANT — Tests signal for security and bug fixes: if `turn_output` describes implementing or modifying authentication, authorization, data isolation, permission checks, or a security fix, AND no test code or test run is mentioned anywhere in `turn_output`, choose 'Tests'. A security change without a test is a high-confidence missed opportunity because the regression risk is high.\n\nIMPORTANT — Tests signal for general bug fixes: if the turn fixes a defect but the output contains no test code and no mention of running tests (e.g. no pass count, no test file name, no 'the test passes'), choose 'Tests' when the defect is one that could silently regress — especially logic branches, conditional flows, or data-transformation rules. Choose 'None' only when tests would clearly add no value (e.g. trivial one-line typo fix, config-only change, purely additive new endpoint with no edge cases).",
  },
  department_usage: {
    scoreName: "jev_department_usage",
    kind: "choice",
    dataType: "CATEGORICAL",
    options: [
      "Engineering",
      "Sales",
      "Marketing",
      "Legal",
      "HR",
      "Finance",
      "Operations",
      "Other",
    ],
    instructions:
      "Which department does the task in `task_text` most directly serve? Classify the primary business outcome, not the author. Not every technical task is Engineering. Use Other when evidence is insufficient.",
  },
};
