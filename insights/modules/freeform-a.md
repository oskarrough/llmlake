---
id: freeform-a
heading: (chosen by the agent)
when: always
---

Open slot. Pick the most interesting thing you found that **none of the
fixed modules captured**. Examples of good fits:

- A specific pattern in which sessions go sideways (e.g. "tasks that start
  with broad 'analyze' verbs use 3× more tokens before producing code").
- A relationship between two columns that no single module exposes
  (e.g. model × cwd, or hour-of-day × error rate).
- A workflow hypothesis worth testing.

## Rules

- **You must cite at least one SQL query you ran.** Inline it in a
  `<details><summary>Query</summary><pre>...</pre></details>` block.
- Make the heading specific. "Observations" is not a heading; "Late-night
  sessions error twice as often" is.
- If you cannot find anything worth this slot, output a `<section>` with the
  heading "Nothing stood out" and one sentence saying so. Don't pad.
